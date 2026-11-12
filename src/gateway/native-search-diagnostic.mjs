import { TextDecoder } from "node:util";
import { parse } from "../../native-wire/protobuf.mjs";
import { NativeDirectProvider } from "../native-provider.mjs";
import { decodeNativeSearchMetadata } from "./native-search-metadata.mjs";

const MAX_FRAMES = 4096;
const MAX_WIRE_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_METADATA_FRAMES = 128;
const MAX_METADATA_ITEMS = 256;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
function validUtf8Query(value) {
  try {
    return strictUtf8.decode(Buffer.from(value)) === value;
  } catch {
    return false;
  }
}
const fail = (code, extra = {}) => ({
  ok: false,
  errorCode: code,
  stopRound: [
    "NATIVE_RATE_LIMITED",
    "NATIVE_AUTH_REJECTED",
    "NATIVE_PERMISSION_REJECTED",
    "NATIVE_PERMISSION_OR_AUTH",
    "NATIVE_QUOTA_EXHAUSTED",
    "NATIVE_AUTH_FAILED",
    "NATIVE_PRECONDITION_REQUIRED",
    "ACCOUNT_LOGIN_REQUIRED",
    "OAUTH_REFRESH_FAILED",
    "NATIVE_TURN_ABORTED",
    "NATIVE_STREAM_RESET",
  ].includes(code),
  citations: [],
  webSources: [],
  citationCount: 0,
  webSourceCount: 0,
  searchExecuted: null,
  ...extra,
});
function one(fields, n, wire = 2) {
  const found = fields.filter((field) => field.number === n);
  if (found.length > 1 || found.some((field) => field.wire !== wire))
    throw Object.assign(new Error(), { code: "INVALID_NATIVE_RESPONSE" });
  return found[0];
}

/** Bounded diagnostic over the same validation path as product native turns.
 * Requires explicit model completion and stable response identity for whole-text updates.
 * Metadata is withheld unless NativeDirectProvider validates the whole turn.
 */
export async function runNativeSearchDiagnostic({
  getAccessToken,
  openTurn,
  query,
  signal,
  timeoutMs = 180000,
  allowNativeTools = false,
} = {}) {
  if (
    typeof getAccessToken !== "function" ||
    typeof openTurn !== "function" ||
    typeof query !== "string" ||
    !query.trim() ||
    !validUtf8Query(query) ||
    Buffer.byteLength(query, "utf8") > 16 * 1024 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 180000 ||
    typeof allowNativeTools !== "boolean"
  )
    return fail("INVALID_DIAGNOSTIC_INPUT");
  if (signal?.aborted) return fail("NATIVE_TURN_ABORTED");

  const metadataFrames = [];
  const googleEvents = [];
  let toolStatusCount = 0,
    otherToolStatusCount = 0;
  let frameCount = 0;
  let totalBytes = 0;
  let citationCount = 0;
  let sourceCount = 0;
  let wrapperFailure = null;
  const authManager = { getValidAccessToken: () => getAccessToken() };
  const diagnosticTransport = (token, options) => {
    const turn = openTurn(token, {
      ...options,
      messages: [{ role: "user", content: query }],
      allowNativeTools,
    });
    const events = (async function* () {
      for await (const event of turn.events) {
        if (event?.type === "frame") {
          frameCount++;
          const bytes = event.bytes;
          if (
            !Buffer.isBuffer(bytes) ||
            bytes.length > MAX_FRAME_BYTES ||
            frameCount > MAX_FRAMES ||
            (totalBytes += bytes.length) > MAX_WIRE_BYTES
          ) {
            wrapperFailure = "NATIVE_RESPONSE_LIMIT";
            throw Object.assign(new Error(), { code: wrapperFailure });
          }
          try {
            const outer = parse(bytes);
            const wrapper = one(outer, 1003);
            if (wrapper) {
              const client = one(parse(wrapper.payload), 1);
              if (client) {
                const fields = parse(client.payload);
                one(fields, 6);
                for (const status of fields.filter(
                  (f) => f.number === 6 || f.number === 8,
                )) {
                  if (status.wire !== 2 || ++toolStatusCount > 256)
                    throw Object.assign(new Error(), {
                      code: "NATIVE_TOOL_STATUS_LIMIT",
                    });
                  const processing = one(parse(status.payload), 2);
                  if (!processing) continue;
                  const toolFields = parse(processing.payload),
                    idField = one(toolFields, 1),
                    stateField = one(toolFields, 3, 0);
                  if (idField?.payload.length > 128)
                    throw Object.assign(new Error(), {
                      code: "INVALID_NATIVE_RESPONSE",
                    });
                  const toolId = idField
                    ? strictUtf8.decode(idField.payload)
                    : null;
                  let stateEnum = null;
                  if (stateField) {
                    let value = 0n,
                      shift = 0n;
                    for (const byte of stateField.payload) {
                      value |= BigInt(byte & 127) << shift;
                      shift += 7n;
                    }
                    if (value > 2147483647n)
                      throw Object.assign(new Error(), {
                        code: "INVALID_NATIVE_RESPONSE",
                      });
                    stateEnum = Number(value);
                  }
                  if (toolId === "google")
                    googleEvents.push({
                      frameIndex: frameCount,
                      channel:
                        status.number === 8
                          ? "finalToolInvocations"
                          : "statusUpdate",
                      stateEnum,
                    });
                  else if (toolId !== null) otherToolStatusCount++;
                }
                const model = one(fields, 1);
                if (model) {
                  const metadata = decodeNativeSearchMetadata(model.payload);
                  if (metadata.citations.length || metadata.webSources.length) {
                    if (metadataFrames.length >= MAX_METADATA_FRAMES)
                      throw Object.assign(new Error(), {
                        code: "NATIVE_METADATA_LIMIT",
                      });
                    citationCount += metadata.citations.length;
                    sourceCount += metadata.webSources.length;
                    if (
                      citationCount > MAX_METADATA_ITEMS ||
                      sourceCount > MAX_METADATA_ITEMS
                    )
                      throw Object.assign(new Error(), {
                        code: "NATIVE_METADATA_LIMIT",
                      });
                    metadataFrames.push({
                      frameIndex: frameCount,
                      citations: metadata.citations,
                      webSources: metadata.webSources,
                    });
                  }
                }
              }
            }
          } catch (error) {
            wrapperFailure =
              error?.code && /^[A-Z0-9_]{1,80}$/.test(error.code)
                ? error.code
                : "INVALID_NATIVE_RESPONSE";
            throw Object.assign(new Error(), { code: wrapperFailure });
          }
        }
        yield event;
      }
    })();
    return { ...turn, events };
  };

  const provider = new NativeDirectProvider(authManager, {
    openTurn: diagnosticTransport,
    timeoutMs,
    allowTextSnapshotReplacement: true,
  });
  try {
    const result = await provider.runTurn(
      "diagnostic",
      {
        model: "gemini-argon",
        messages: [{ role: "user", content: query }],
        thinking_level: 2,
      },
      () => {},
      { signal },
    );
    if (result.resolvedModeCategory !== 8 || result.thinkingLevel !== 2)
      return fail("NATIVE_THINKING_MISMATCH");
    return {
      ok: true,
      answer: result.content,
      query,
      requestedModel: "gemini-argon",
      revisionCount: result.revisionCount,
      resolvedModeCategory: result.resolvedModeCategory,
      requestedThinkingLevel: 2,
      thinkingLevel: result.thinkingLevel,
      nativeToolsRequested: allowNativeTools,
      searchExecuted: null,
      googleToolReported: googleEvents.some(
        (event) => event.channel === "finalToolInvocations",
      ),
      googleToolStatusCount: googleEvents.length,
      googleFinalInvocationCount: googleEvents.filter(
        (event) => event.channel === "finalToolInvocations",
      ).length,
      googleToolEvents: googleEvents,
      otherToolStatusCount,
      toolEvidenceKind:
        "validated-upstream-tool-report; state-enum-semantics-unmapped",
      framesWithMetadata: metadataFrames.map(({ frameIndex }) => frameIndex),
      citations: metadataFrames.flatMap(({ frameIndex, citations }) =>
        citations.map((item) => ({ ...item, frameIndex })),
      ),
      webSources: metadataFrames.flatMap(({ frameIndex, webSources }) =>
        webSources.map((item) => ({ ...item, frameIndex })),
      ),
      citationCount: metadataFrames.reduce(
        (n, item) => n + item.citations.length,
        0,
      ),
      webSourceCount: metadataFrames.reduce(
        (n, item) => n + item.webSources.length,
        0,
      ),
      quotaObservation: result.quotaObservation,
    };
  } catch (error) {
    const code =
      wrapperFailure ??
      (typeof error?.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code)
        ? error.code
        : "NATIVE_TURN_FAILED");
    const evidence = error?.nativeEvidence;
    return fail(code, evidence ? { nativeEvidence: evidence } : {});
  }
}
