import test from "node:test";
import assert from "node:assert/strict";
import { lengthDelimited, varintField } from "../native-wire/protobuf.mjs";
import {
  decodeNativeSearchMetadata,
  isSafeWebUrl,
  METADATA_ERROR_CODES,
  NativeSearchMetadataError,
} from "../src/gateway/native-search-metadata.mjs";

const str = (n, value) => lengthDelimited(n, Buffer.from(value));
const msg = (...fields) => Buffer.concat(fields);
const citation = (...fields) => lengthDelimited(6, msg(...fields));
const source = (...fields) => lengthDelimited(14, msg(...fields));
const action = (...fields) => str(8, msg(...fields));
const urlAction = (url, ...extra) => action(str(1, url), ...extra);

function expectCode(fn, code) {
  assert.throws(
    fn,
    (error) =>
      error instanceof NativeSearchMetadataError && error.code === code,
  );
}

test("decodes citation and renderable web-source descriptor mappings", () => {
  const data = msg(
    citation(
      varintField(1, 0),
      varintField(2, 8),
      str(3, "https://public.box/page"),
      varintField(4, 2),
      str(5, "<b>untrusted</b>"),
      str(6, "cid"),
      str(7, "https://cdn.example/icon"),
    ),
    source(
      str(1, "sid"),
      str(2, "https://cdn.example/icon"),
      str(3, "By"),
      str(4, "Subtitle"),
      str(5, "Title"),
      str(6, "Snippet"),
      str(7, "web"),
      urlAction("https://public.box/result", varintField(2, 1)),
    ),
  );
  const result = decodeNativeSearchMetadata(data);
  assert.equal(result.citations[0].startIndex, 0);
  assert.equal(result.citations[0].endIndex, 8);
  assert.equal(result.citations[0].indexUnits, "unknown");
  assert.equal(result.citations[0].untrustedHtmlTitle, "<b>untrusted</b>");
  assert.equal(result.webSources[0].url, "https://public.box/result");
  assert.equal(result.webSources[0].forceAccount, true);
  assert.equal(result.webSources[0].snippet, "Snippet");
  assert.equal(result.searchEvidence.searchExecuted, null);
  assert.equal(result.searchEvidence.executionProof, false);
});

test("empty and unrelated/thought fields are ignored", () => {
  const result = decodeNativeSearchMetadata(
    msg(str(12, "thought"), str(3, "unrelated")),
  );
  assert.deepEqual(result.citations, []);
  assert.deepEqual(result.webSources, []);
  assert.equal(result.searchEvidence.metadataPresent, false);
});

test("preserves absent offsets separately from explicit zero and validates ranges", () => {
  assert.equal(
    decodeNativeSearchMetadata(citation(varintField(2, 0))).citations[0]
      .startIndex,
    null,
  );
  assert.equal(
    decodeNativeSearchMetadata(citation(varintField(1, 0))).citations[0]
      .startIndex,
    0,
  );
  expectCode(
    () =>
      decodeNativeSearchMetadata(
        citation(varintField(1, 2), varintField(2, 1)),
      ),
    METADATA_ERROR_CODES.INVALID_RANGE,
  );
  expectCode(
    () => decodeNativeSearchMetadata(citation(varintField(1, 0xffffffff))),
    METADATA_ERROR_CODES.INVALID_RANGE,
  );
  expectCode(
    () => decodeNativeSearchMetadata(citation(varintField(1, 0x80000000))),
    METADATA_ERROR_CODES.INVALID_RANGE,
  );
});

test("rejects known wrong wire types and duplicate singular fields, including nested action fields", () => {
  expectCode(
    () => decodeNativeSearchMetadata(msg(varintField(6, 1))),
    METADATA_ERROR_CODES.INVALID_WIRE_TYPE,
  );
  expectCode(
    () =>
      decodeNativeSearchMetadata(
        citation(str(3, "https://a.example"), str(3, "https://b.example")),
      ),
    METADATA_ERROR_CODES.DUPLICATE_FIELD,
  );
  expectCode(
    () =>
      decodeNativeSearchMetadata(
        source(
          urlAction("https://a.example", varintField(2, 0), varintField(2, 1)),
        ),
      ),
    METADATA_ERROR_CODES.DUPLICATE_FIELD,
  );
  expectCode(
    () => decodeNativeSearchMetadata(source(str(8, varintField(1, 1)))),
    METADATA_ERROR_CODES.INVALID_WIRE_TYPE,
  );
});

test("rejects malformed wire data and invalid UTF-8", () => {
  expectCode(
    () => decodeNativeSearchMetadata(Buffer.from([0x80])),
    METADATA_ERROR_CODES.MALFORMED_SEARCH_METADATA,
  );
  expectCode(
    () => decodeNativeSearchMetadata(citation(str(6, Buffer.from([0xff])))),
    METADATA_ERROR_CODES.INVALID_UTF8,
  );
});

test("bounds size and repeated descriptors before metadata decoding", () => {
  expectCode(
    () => decodeNativeSearchMetadata(Buffer.alloc(1024 * 1024 + 1)),
    METADATA_ERROR_CODES.INPUT_TOO_LARGE,
  );
  expectCode(
    () =>
      decodeNativeSearchMetadata(msg(citation(), citation()), {
        maxCitations: 1,
      }),
    METADATA_ERROR_CODES.COUNT_EXCEEDED,
  );
  expectCode(
    () =>
      decodeNativeSearchMetadata(msg(source(), source()), { maxSources: 1 }),
    METADATA_ERROR_CODES.COUNT_EXCEEDED,
  );
  expectCode(
    () => decodeNativeSearchMetadata(citation(), { maxCitations: 0 }),
    METADATA_ERROR_CODES.COUNT_EXCEEDED,
  );
});

test("rejects invalid custom bounds with a fixed safe error", () => {
  for (const options of [
    { maxInputBytes: Infinity },
    { maxCitations: NaN },
    { maxSources: -1 },
    { maxSources: "2" },
    { extra: 1 },
    null,
    { maxInputBytes: null },
    { maxSources: undefined },
  ]) {
    expectCode(
      () => decodeNativeSearchMetadata(Buffer.alloc(0), options),
      METADATA_ERROR_CODES.MALFORMED_SEARCH_METADATA,
    );
  }
  expectCode(
    () => decodeNativeSearchMetadata(Buffer.alloc(1), { maxInputBytes: 0 }),
    METADATA_ERROR_CODES.INPUT_TOO_LARGE,
  );
});

test("filters unsafe URL forms while allowing syntactic public-looking domains", () => {
  assert.equal(isSafeWebUrl("https://public.box/path"), true);
  for (const value of [
    " https://example.com",
    "https://example.com ",
    "https:\\\\example.com",
    "https://u:p@example.com",
    "http://127.0.0.1",
    "http://[::1]/",
    "http://localhost",
    "javascript:alert(1)",
    "https://example.com/\n",
  ])
    assert.equal(isSafeWebUrl(value), false, value);
  const result = decodeNativeSearchMetadata(
    citation(str(3, "https://127.0.0.1")),
  );
  assert.equal(result.citations[0].link, null);
});

test("excludes non-web and mixed-action sources", () => {
  const result = decodeNativeSearchMetadata(
    msg(
      source(str(5, "nonweb"), str(9, "opaque")),
      source(
        urlAction("https://example.com", varintField(2, 0)),
        str(9, "mixed"),
      ),
    ),
  );
  assert.deepEqual(result.webSources, []);
  assert.equal(result.counts.totalRawSources, 2);
});

test("accepts Buffer and Uint8Array, rejects other input types", () => {
  const bytes = citation(varintField(1, 0));
  assert.equal(decodeNativeSearchMetadata(bytes).citations.length, 1);
  assert.equal(
    decodeNativeSearchMetadata(new Uint8Array(bytes)).citations.length,
    1,
  );
  expectCode(
    () => decodeNativeSearchMetadata("not bytes"),
    METADATA_ERROR_CODES.MALFORMED_SEARCH_METADATA,
  );
});
