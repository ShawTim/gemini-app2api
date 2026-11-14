import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGateway } from "../src/gateway/app.mjs";
import { StateStore } from "../src/gateway/state.mjs";
import { Accounts } from "../src/gateway/accounts.mjs";
import {
  lengthDelimited as m,
  varintField as v,
} from "../native-wire/protobuf.mjs";
import {
  normalizeChatRequest,
  normalizeResponsesRequest,
  buildCanonicalPrompt,
} from "../src/openai-contract.mjs";
import {
  mapNativeSearchAnnotations,
  extractNativeSearchSources,
} from "../src/gateway/native-search-citations.mjs";
const str = (n, value) => m(n, Buffer.from(value));
const citationMsg = ({ url, start, end, title } = {}) =>
  m(
    6,
    Buffer.concat([
      ...(start !== undefined ? [v(1, start)] : []),
      ...(end !== undefined ? [v(2, end)] : []),
      ...(url !== undefined ? [str(3, url)] : []),
      ...(title !== undefined ? [str(5, title)] : []),
    ]),
  );
const webSourceMsg = ({ url, sourceTitle, attributionTitle, forceAccount } = {}) =>
  m(
    14,
    Buffer.concat([
      ...(attributionTitle !== undefined ? [str(3, attributionTitle)] : []),
      ...(sourceTitle !== undefined ? [str(5, sourceTitle)] : []),
      m(
        8,
        Buffer.concat([
          str(1, url),
          ...(forceAccount !== undefined ? [v(2, Number(forceAccount))] : []),
        ]),
      ),
    ]),
  );
const frame = ({
  text = "Final source https://example.org/",
  tool = "google",
  complete = true,
  mode = 8,
  id = "synthetic-response",
  modelExtra = [],
} = {}) => ({
  type: "frame",
  bytes: m(
    1003,
    m(
      1,
      Buffer.concat([
        m(
          1,
          Buffer.concat([
            ...(id === null ? [] : [str(1, id)]),
            ...(text === null ? [] : [m(2, str(1, text))]),
            ...modelExtra,
          ]),
        ),
        v(9, Number(complete)),
        v(41, mode),
        v(42, 2),
        ...(tool ? [m(8, m(2, Buffer.concat([str(1, tool), v(3, 4)])))] : []),
      ]),
    ),
  ),
});
const end = { type: "end", httpStatus: 200, grpcStatus: 0 };
async function setup(t, events = [frame({ text: "draft" }), frame(), end]) {
  const directory = fs.mkdtempSync(
    path.join(
      process.env.PI_SCRATCH_DIR || fs.realpathSync(os.tmpdir()),
      "native-api-fixture-",
    ),
  );
  const store = new StateStore({
    directory,
    adminPassword: "synthetic-search-api-password",
  });
  store.data.profile = {
    clientId: "synthetic-client",
    clientSecret: "synthetic-secret",
    scopes: [],
  };
  store.data.accounts = [
    {
      id: "acc-synthetic",
      enabled: true,
      status: "ready",
      refreshToken: "synthetic-refresh",
    },
  ];
  store.save();
  const seen = [];
  const app = createGateway({
    store,
    allowFailover: false,
    accounts: new Accounts(store, {
      refresh: async () => ({
        accessToken: "synthetic-token",
        expiresInSeconds: 3600,
      }),
    }),
    openTurn: (_token, options) => {
      seen.push(options);
      return {
        cancel() {},
        events: (async function* () {
          for (const event of events) {
            if (event instanceof Error) throw event;
            yield event;
          }
        })(),
      };
    },
  });
  const base = await app.listen({ host: "127.0.0.1", port: 0 }),
    key = store.createKey("synthetic");
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    seen,
    request: (api, body) =>
      fetch(
        base + (api === "chat" ? "/v1/chat/completions" : "/v1/responses"),
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + key.key,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      ),
  };
}
const body = (api, stream = false, extra = {}) => ({
  model: "gemini-argon",
  thinking_level: 2,
  native_search: true,
  stream,
  ...(api === "chat"
    ? {
        messages: [
          { role: "system", content: "Keep source URLs." },
          { role: "user", content: "Find public sources." },
        ],
      }
    : { instructions: "Keep source URLs.", input: "Find public sources." }),
  ...extra,
});
for (const api of ["chat", "responses"])
  for (const stream of [false, true])
    test(`native search HTTP ${api} ${stream ? "SSE" : "JSON"} preserves validated answer and typed evidence`, async (t) => {
      const f = await setup(t),
        r = await f.request(api, body(api, stream));
      assert.equal(r.status, 200);
      assert.equal(f.seen.length, 1);
      assert.equal(f.seen[0].allowNativeTools, true);
      assert.equal(f.seen[0].modeCategory, 8);
      assert.equal(f.seen[0].thinkingLevel, 2);
      assert.match(f.seen[0].messages[0].content, /Keep source URLs/);
      const raw = await r.text();
      assert.doesNotMatch(
        raw,
        /synthetic-response|"tool_calls"|"function_call"|"web_search_call"/,
      );
      let result;
      if (!stream) result = JSON.parse(raw);
      else {
        const events = raw
          .split("\n")
          .filter((x) => x.startsWith("data: "))
          .map((x) => x.slice(6));
        if (api === "chat") {
          assert.equal(events.at(-1), "[DONE]");
          const objects = events.slice(0, -1).map(JSON.parse);
          assert.equal(objects.filter((x) => x.native_search).length, 1);
          result = objects.find((x) => x.native_search);
        } else {
          const objects = events.map(JSON.parse);
          assert.equal(objects.at(-1).type, "response.completed");
          result = objects.at(-1).response;
        }
      }
      assert.equal(result.native_search.googleToolReported, true);
      assert.equal(result.native_search.provider, "gemini");
      assert.equal(result.native_search.revisionCount, 1);
      assert.equal(result.native_search.structuredCitationCount, 0);
      assert.equal(result.native_search.mappedAnnotationCount, 0);
      assert.deepEqual(result.native_search.sources, []);
      assert.equal(
        result.native_search.sourceFormat,
        "answer_text; no_public_web_annotations",
      );
      if (api === "chat" && !stream) {
        assert.equal(result.choices[0].message.annotations, undefined);
      } else if (api === "responses") {
        assert.deepEqual(result.output[0].content[0].annotations, []);
      }
      assert.match(raw, /Final source https/);
    });
test("native opt-in rejects mixed tools/history, invalid modes/types and oversize before transport", async (t) => {
  const f = await setup(t);
  for (const extra of [
    { native_search: "true" },
    { model: "gemini-flash-lite" },
    { model: "gemini-hydrogen" },
    { thinking_level: 1 },
    { tool_choice: "none" },
    { parallel_tool_calls: false },
    { tools: [{ type: "function", function: { name: "x" } }] },
    { messages: [{ role: "tool", tool_call_id: "x", content: "x" }] },
    { messages: [{ role: "user", content: "x".repeat(16384) }] },
  ]) {
    const r = await f.request("chat", body("chat", false, extra));
    assert.ok(r.status >= 400 && r.status < 500);
    await r.text();
  }
  assert.equal(f.seen.length, 0);
  assert.throws(() =>
    normalizeResponsesRequest({
      input: "q",
      native_search: true,
      tools: [{ type: "web_search" }],
    }),
  );
  assert.throws(() =>
    normalizeResponsesRequest({
      native_search: true,
      input: [
        {
          type: "function_call",
          name: "x",
          call_id: "call_x",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "call_x", output: "x" },
      ],
    }),
  );
});
test("ordinary/default false requests retain original prompt and do not request native permission", async (t) => {
  const payload = { messages: [{ role: "user", content: "plain" }] };
  assert.deepEqual(
    normalizeChatRequest({ ...payload, native_search: false }),
    normalizeChatRequest(payload),
  );
  assert.deepEqual(
    buildCanonicalPrompt(
      normalizeChatRequest({ ...payload, native_search: false }),
    ),
    buildCanonicalPrompt(normalizeChatRequest(payload)),
  );
  const f = await setup(t, [frame({ tool: null }), end]);
  const r = await f.request("chat", { ...payload, native_search: false });
  assert.equal(r.status, 200);
  assert.equal(f.seen[0].allowNativeTools, undefined);
  assert.equal((await r.json()).native_search, undefined);
});
test("missing Google evidence, other tools and reset/permission failures withhold success JSON and SSE", async (t) => {
  const cases = [
    [[frame({ tool: null }), end], "NATIVE_SEARCH_NOT_OBSERVED"],
    [
      [frame({ tool: "other-private-tool" }), end],
      "UNSUPPORTED_NATIVE_TOOL_REPORT",
    ],
    [
      [
        frame(),
        Object.assign(Error("private"), { code: "NATIVE_STREAM_RESET" }),
      ],
      "NATIVE_STREAM_RESET",
    ],
    [[frame(), { ...end, grpcStatus: 9 }], "NATIVE_PRECONDITION_REQUIRED"],
    [[frame({ mode: 6 }), end], "MODEL_DOWNGRADE_REJECTED"],
  ];
  for (const [events, code] of cases)
    for (const api of ["chat", "responses"]) {
      const f = await setup(t, events),
        r = await f.request(api, body(api, true));
      assert.equal(r.status, 502);
      assert.match(r.headers.get("content-type"), /application\/json/);
      const raw = await r.text();
      assert.equal(JSON.parse(raw).error.code, code);
      assert.doesNotMatch(
        raw,
        /Final source|other-private-tool|googleToolReported|response\.completed|data:/,
      );
      assert.equal(f.seen.length, 1);
    }
});

test("native search medium effort keeps requested echo and level2 restriction", async (t) => {
  for (const api of ["chat", "responses"]) {
    const f = await setup(t);
    const request = body(api);
    delete request.thinking_level;
    Object.assign(
      request,
      api === "chat"
        ? { reasoning_effort: "medium" }
        : { reasoning: { effort: "medium" } },
    );
    const response = await f.request(api, request);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-requested-thinking-level"), "2");
    assert.equal(response.headers.get("x-thinking-level"), "2");
    assert.equal(response.headers.get("x-reasoning-effort"), "medium");
    assert.equal(f.seen[0].thinkingLevel, 2);
    const data = await response.json();
    assert.equal(data.native_search.googleToolReported, true);
    assert.equal(
      api === "chat" ? data.reasoning_effort : data.reasoning.effort,
      "medium",
    );
  }
});

test("mapNativeSearchAnnotations handles draft filtering, UTF-16 spans, sanitization, dedupe and 64 cap", () => {
  const multibyte = "🌍 你好 Example docs https://sub.example.org/page";
  const prefixBytes = Buffer.byteLength("🌍 你好 ");
  const spanBytes = Buffer.byteLength("Example");
  const expectedStart = "🌍 你好 ".length;
  const expectedEnd = expectedStart + "Example".length;

  const annotations = mapNativeSearchAnnotations(multibyte, {
    lastTextFrameIndex: 2,
    citations: [
      { frameIndex: 1, link: "https://stale.example.org/", startIndex: 0, endIndex: 3, untrustedHtmlTitle: "Stale draft" },
      { frameIndex: 2, link: "https://example.org/a", startIndex: prefixBytes, endIndex: prefixBytes + spanBytes, untrustedHtmlTitle: "<b>Example</b>\x07 <i>Title</i>" },
      { frameIndex: 2, link: "https://example.org/a", startIndex: prefixBytes, endIndex: prefixBytes + spanBytes, untrustedHtmlTitle: "Duplicate ignored" },
      { frameIndex: 2, link: "https://example.org/a", startIndex: 0, endIndex: Buffer.byteLength("🌍") }, // distinct valid UTF-8 span for same URL is preserved
      { frameIndex: 2, link: "https://sub.example.org/page", startIndex: 1, endIndex: 4, untrustedHtmlTitle: "<b></b>" }, // unaligned byte offset -> literal URL fallback
      { frameIndex: 2, link: "https://oob.example.org/page", startIndex: 0, endIndex: 9999, untrustedHtmlTitle: "<b>OOB</b>" }, // out-of-bounds offset -> [len, len] fallback
      { frameIndex: 2, link: "javascript:alert(1)", startIndex: 0, endIndex: 2 },
    ],
    webSources: [
      { frameIndex: 1, url: "https://stale-src.example.org/", sourceTitle: "Stale Source" },
      { frameIndex: 2, url: "https://private.example.org/", sourceTitle: "Account Source", forceAccount: true },
      { frameIndex: 2, url: "https://extra.example.org/guide", sourceTitle: "Extra\x00 Guide " + "x".repeat(600) },
      { frameIndex: 2, url: "https://example.org/a", sourceTitle: "Clean Source Title" },
    ],
  });

  const urlStart = multibyte.indexOf("https://sub.example.org/page");
  assert.equal(annotations.length, 5);
  assert.deepEqual(annotations[0], {
    type: "url_citation",
    url: "https://example.org/a",
    title: "Clean Source Title",
    start_index: expectedStart,
    end_index: expectedEnd,
  });
  assert.equal(
    multibyte.slice(annotations[0].start_index, annotations[0].end_index),
    "Example",
  );
  assert.deepEqual(annotations[1], {
    type: "url_citation",
    url: "https://example.org/a",
    title: "Clean Source Title",
    start_index: 0,
    end_index: "🌍".length,
  });
  assert.deepEqual(annotations[2], {
    type: "url_citation",
    url: "https://sub.example.org/page",
    title: "sub.example.org",
    start_index: urlStart,
    end_index: urlStart + "https://sub.example.org/page".length,
  });
  assert.deepEqual(annotations[3], {
    type: "url_citation",
    url: "https://oob.example.org/page",
    title: "OOB",
    start_index: multibyte.length,
    end_index: multibyte.length,
  });
  assert.equal(annotations[4].url, "https://extra.example.org/guide");
  assert.equal(annotations[4].title.length, 512);
  assert.ok(annotations[4].title.startsWith("Extra Guide "));
  assert.equal(annotations[4].start_index, multibyte.length);
  assert.equal(annotations[4].end_index, multibyte.length);

  // HTML tag stripping when falling back to untrustedHtmlTitle (no plain sourceTitle)
  const htmlOnly = mapNativeSearchAnnotations("Answer", {
    lastTextFrameIndex: 1,
    citations: [{ frameIndex: 1, link: "https://docs.example.org/", untrustedHtmlTitle: "<b>Docs</b> &amp; Guide\n" }],
    webSources: [],
  });
  assert.equal(htmlOnly[0].title, "Docs &amp; Guide");
  assert.deepEqual([htmlOnly[0].start_index, htmlOnly[0].end_index], [6, 6]);

  // Bounded cap <= 64
  const manyCitations = Array.from({ length: 80 }, (_, i) => ({
    frameIndex: 1,
    link: `https://example.org/p/${i}`,
    startIndex: 0,
    endIndex: 1,
    untrustedHtmlTitle: `Title ${i}`,
  }));
  const capped = mapNativeSearchAnnotations("Answer text", { lastTextFrameIndex: 1, citations: manyCitations, webSources: [] });
  assert.equal(capped.length, 64);
  const cappedSources = extractNativeSearchSources({ lastTextFrameIndex: 1, citations: manyCitations, webSources: [] });
  assert.equal(cappedSources.length, 64);
});

for (const api of ["chat", "responses"])
  for (const stream of [false, true])
    test(`native search HTTP ${api} ${stream ? "SSE" : "JSON"} emits url_citation annotations and sanitized sources`, async (t) => {
      const finalText = "Node.js docs at https://nodejs.org/api/ and Guide.";
      const events = [
        frame({
          text: "draft answer",
          complete: false,
          modelExtra: [
            citationMsg({ url: "https://stale-draft.example.org/", start: 0, end: 5, title: "Draft" }),
            webSourceMsg({ url: "https://stale-draft.example.org/", sourceTitle: "Draft" }),
          ],
        }),
        frame({
          text: finalText,
          complete: true,
          modelExtra: [
            citationMsg({ url: "https://nodejs.org/api/", start: 0, end: 12, title: "<b>Node.js API</b>" }),
            webSourceMsg({ url: "https://guide.example.org/", sourceTitle: "Public Guide" }),
            webSourceMsg({ url: "https://private.example.org/", sourceTitle: "Private", forceAccount: true }),
          ],
        }),
        end,
      ];
      const f = await setup(t, events);
      const r = await f.request(api, body(api, stream));
      assert.equal(r.status, 200);
      const raw = await r.text();
      assert.doesNotMatch(raw, /stale-draft|private\.example\.org|<b>/);

      const expected = [
        { type: "url_citation", url: "https://nodejs.org/api/", title: "Node.js API", start_index: 0, end_index: 12 },
        { type: "url_citation", url: "https://guide.example.org/", title: "Public Guide", start_index: finalText.length, end_index: finalText.length },
      ];

      if (!stream) {
        const result = JSON.parse(raw);
        assert.equal(result.native_search.sourceFormat, "url_citation_annotations");
        assert.equal(result.native_search.mappedAnnotationCount, 2);
        assert.deepEqual(result.native_search.sources, [
          { url: "https://nodejs.org/api/", title: "Node.js API" },
          { url: "https://guide.example.org/", title: "Public Guide" },
        ]);
        if (api === "chat") {
          assert.deepEqual(
            result.choices[0].message.annotations,
            expected.map((a) => ({ type: "url_citation", url_citation: { url: a.url, title: a.title, start_index: a.start_index, end_index: a.end_index } })),
          );
        } else {
          assert.deepEqual(result.output[0].content[0].annotations, expected);
        }
      } else if (api === "chat") {
        const objects = raw.split("\n").filter((x) => x.startsWith("data: ") && x !== "data: [DONE]").map((x) => JSON.parse(x.slice(6)));
        const finishChunk = objects.find((x) => x.choices[0]?.finish_reason === "stop");
        assert.equal(finishChunk.native_search.sourceFormat, "url_citation_annotations");
        assert.equal(finishChunk.native_search.mappedAnnotationCount, 2);
        assert.deepEqual(
          finishChunk.choices[0].delta.annotations,
          expected.map((a) => ({ type: "url_citation", url_citation: { url: a.url, title: a.title, start_index: a.start_index, end_index: a.end_index } })),
        );
      } else {
        const objects = raw.split("\n").filter((x) => x.startsWith("data: ")).map((x) => JSON.parse(x.slice(6)));
        const types = objects.map((e) => e.type);
        const partAdded = objects.find((e) => e.type === "response.content_part.added");
        assert.deepEqual(partAdded.part.annotations, []);
        const addedEvents = objects.filter((e) => e.type === "response.output_text.annotation.added");
        assert.equal(addedEvents.length, 2);
        assert.deepEqual(addedEvents.map((e) => e.annotation_index), [0, 1]);
        assert.deepEqual(addedEvents.map((e) => e.annotation), expected);
        const firstAnnIdx = types.indexOf("response.output_text.annotation.added");
        const lastAnnIdx = types.lastIndexOf("response.output_text.annotation.added");
        const textDoneIdx = types.indexOf("response.output_text.done");
        assert.ok(firstAnnIdx > types.indexOf("response.output_text.delta") && lastAnnIdx < textDoneIdx);
        const completed = objects.at(-1);
        assert.equal(completed.type, "response.completed");
        assert.equal(completed.response.native_search.sourceFormat, "url_citation_annotations");
        assert.deepEqual(completed.response.output[0].content[0].annotations, expected);
      }
    });

test("native search with only forceAccount webSource emits empty public annotations", async (t) => {
  const f = await setup(t, [
    frame({
      text: "Internal answer.",
      complete: true,
      modelExtra: [webSourceMsg({ url: "https://private.example.org/", sourceTitle: "Private", forceAccount: true })],
    }),
    end,
  ]);
  const r = await f.request("chat", body("chat", false));
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.choices[0].message.annotations, undefined);
  assert.equal(data.native_search.mappedAnnotationCount, 0);
  assert.deepEqual(data.native_search.sources, []);
  assert.equal(data.native_search.sourceFormat, "answer_text; no_public_web_annotations");
});

test("duplicate webSources and metadata frames apply deny-wins for forceAccount URLs across citations, sources, and titles", async (t) => {
  const secretUrl = "https://private-dup.example.org/item";
  const secretTitle = "Account Bound Title";

  // Unit cases: both source orders and earlier-frame vs trailing-frame duplicates.
  const unitCases = [
    {
      lastTextFrameIndex: 2,
      citations: [{ frameIndex: 2, link: secretUrl, startIndex: 0, endIndex: 5, title: secretTitle }],
      webSources: [
        { frameIndex: 2, url: secretUrl, sourceTitle: secretTitle, forceAccount: false },
        { frameIndex: 2, url: secretUrl, sourceTitle: secretTitle, forceAccount: true },
      ],
    },
    {
      lastTextFrameIndex: 2,
      citations: [{ frameIndex: 2, link: secretUrl, startIndex: 0, endIndex: 5, untrustedHtmlTitle: `<b>${secretTitle}</b>` }],
      webSources: [
        { frameIndex: 2, url: secretUrl, sourceTitle: secretTitle, forceAccount: true },
        { frameIndex: 2, url: secretUrl, sourceTitle: secretTitle },
      ],
    },
    {
      lastTextFrameIndex: 2,
      citations: [{ frameIndex: 2, link: secretUrl, startIndex: 0, endIndex: 5 }],
      webSources: [
        { frameIndex: 1, url: secretUrl, sourceTitle: secretTitle, forceAccount: true },
        { frameIndex: 2, url: secretUrl, sourceTitle: secretTitle, forceAccount: false },
      ],
    },
  ];
  for (const report of unitCases) {
    assert.deepEqual(mapNativeSearchAnnotations("Hello world", report), []);
    assert.deepEqual(extractNativeSearchSources(report), []);
  }

  // HTTP cases: duplicate same-frame sources in both orders + trailing duplicate metadata frame across Chat & Responses.
  const eventSets = [
    [
      frame({
        text: "Answer text",
        complete: true,
        modelExtra: [
          citationMsg({ url: secretUrl, start: 0, end: 6, title: secretTitle }),
          webSourceMsg({ url: secretUrl, sourceTitle: secretTitle, forceAccount: false }),
          webSourceMsg({ url: secretUrl, sourceTitle: secretTitle, forceAccount: true }),
        ],
      }),
      end,
    ],
    [
      frame({
        text: "Answer text",
        complete: true,
        modelExtra: [
          citationMsg({ url: secretUrl, start: 0, end: 6, title: secretTitle }),
          webSourceMsg({ url: secretUrl, sourceTitle: secretTitle, forceAccount: true }),
          webSourceMsg({ url: secretUrl, sourceTitle: secretTitle, forceAccount: false }),
        ],
      }),
      end,
    ],
    [
      frame({
        text: "Answer text",
        complete: false,
        modelExtra: [
          citationMsg({ url: secretUrl, start: 0, end: 6, title: secretTitle }),
          webSourceMsg({ url: secretUrl, sourceTitle: secretTitle, forceAccount: false }),
        ],
      }),
      {
        type: "frame",
        bytes: m(
          1003,
          m(
            1,
            Buffer.concat([
              m(1, Buffer.concat([str(1, "synthetic-response"), webSourceMsg({ url: secretUrl, sourceTitle: secretTitle, forceAccount: true })])),
              v(9, 1),
              v(41, 8),
              v(42, 2),
            ]),
          ),
        ),
      },
      end,
    ],
  ];

  for (const events of eventSets) {
    for (const kind of ["chat", "responses"]) {
      const f = await setup(t, events);
      const r = await f.request(kind, body(kind, false));
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.equal(data.native_search.mappedAnnotationCount, 0);
      assert.deepEqual(data.native_search.sources, []);
      assert.equal(data.native_search.sourceFormat, "answer_text; no_public_web_annotations");
      if (kind === "chat") {
        assert.equal(data.choices[0].message.annotations, undefined);
      } else {
        assert.deepEqual(data.output[0].content[0].annotations, []);
      }
      assert.doesNotMatch(JSON.stringify(data), /private-dup\.example\.org|Account Bound Title/);
    }
  }
});

test("canonical URL identity enforces forceAccount exclusion, source title lookup, and dedup across host casing and default ports", async (t) => {
  const answer = "Root https://example.org:443/ and distinct case.";
  const report = {
    lastTextFrameIndex: 1,
    citations: [
      { frameIndex: 1, link: "https://EXAMPLE.org/private", startIndex: 0, endIndex: 4, title: "Bypass Case" },
      { frameIndex: 1, link: "https://example.org:443/private", startIndex: 0, endIndex: 4, title: "Bypass Port" },
      { frameIndex: 1, link: "https://EXAMPLE.org/private#frag", startIndex: 0, endIndex: 4, title: "Bypass Hash" },
      { frameIndex: 1, link: "https://example.org:443/", startIndex: 5, endIndex: 5 + "https://example.org:443/".length },
      { frameIndex: 1, link: "http://EXAMPLE.ORG/guide", startIndex: 0, endIndex: 4 },
      { frameIndex: 1, link: "https://example.org/Private", startIndex: 0, endIndex: 4, title: "Public Case Path" },
    ],
    webSources: [
      { frameIndex: 1, url: "https://example.org/private", sourceTitle: "Secret", forceAccount: true },
      { frameIndex: 1, url: "https://EXAMPLE.org", sourceTitle: "Canonical Root" },
      { frameIndex: 1, url: "http://example.org:80/guide", sourceTitle: "HTTP Guide" },
    ],
  };

  const annotations = mapNativeSearchAnnotations(answer, report);
  assert.deepEqual(
    annotations.map((item) => ({ url: item.url, title: item.title })),
    [
      { url: "https://example.org:443/", title: "Canonical Root" },
      { url: "http://EXAMPLE.ORG/guide", title: "HTTP Guide" },
      { url: "https://example.org/Private", title: "Public Case Path" },
    ],
  );
  const sources = extractNativeSearchSources(report);
  assert.deepEqual(sources, [
    { url: "https://example.org:443/", title: "Canonical Root" },
    { url: "http://EXAMPLE.ORG/guide", title: "HTTP Guide" },
    { url: "https://example.org/Private", title: "Public Case Path" },
  ]);

  const events = [
    frame({
      text: "Check docs.",
      tool: "google",
      modelExtra: [
        citationMsg({ url: "https://EXAMPLE.org/private#s1", start: 0, end: 5, title: "Secret Cite" }),
        citationMsg({ url: "https://example.org:443/", start: 6, end: 10 }),
        webSourceMsg({ url: "https://example.org/private", sourceTitle: "Secret", forceAccount: true }),
        webSourceMsg({ url: "https://EXAMPLE.org", sourceTitle: "Canonical Root" }),
      ],
    }),
    end,
  ];
  for (const kind of ["chat", "responses"]) {
    const f = await setup(t, events);
    const r = await f.request(kind, body(kind, false));
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.deepEqual(data.native_search.sources, [
      { url: "https://example.org:443/", title: "Canonical Root" },
    ]);
    const serialized = JSON.stringify(data);
    assert.doesNotMatch(serialized, /private|Secret/);
  }
});
