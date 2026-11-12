// Bounded native search/citation metadata decoder for inner ROBINModelResponse bytes.
// Safe pure decoding only: does NOT enable, advertise, or execute search.
// No network access, no HTML execution, no SSRF fetching.

import { parse } from "../../native-wire/protobuf.mjs";

/** Budget and length limits for metadata parsing. */
export const METADATA_LIMITS = Object.freeze({
  MAX_INPUT_BYTES: 1024 * 1024, // 1 MiB default maximum input
  MAX_CITATIONS: 64, // <= 64 citations
  MAX_SOURCES: 64, // <= 64 renderable sources
  MAX_URL_LENGTH: 4096, // <= 4096 bytes for URLs
  MAX_TITLE_LENGTH: 1024, // bounded title string length
  MAX_SNIPPET_LENGTH: 4096, // bounded snippet string length
  MAX_ID_LENGTH: 512, // bounded id string length
  MAX_CATEGORY_LENGTH: 256, // bounded category name length
});

/** Standard fixed safe error codes (no raw payloads leaked). */
export const METADATA_ERROR_CODES = Object.freeze({
  MALFORMED_SEARCH_METADATA: "MALFORMED_SEARCH_METADATA",
  INPUT_TOO_LARGE: "METADATA_INPUT_TOO_LARGE",
  INVALID_WIRE_TYPE: "METADATA_INVALID_WIRE_TYPE",
  DUPLICATE_FIELD: "METADATA_DUPLICATE_FIELD",
  INVALID_UTF8: "METADATA_INVALID_UTF8",
  INVALID_RANGE: "METADATA_INVALID_RANGE",
  COUNT_EXCEEDED: "METADATA_COUNT_EXCEEDED",
  STRING_TOO_LONG: "METADATA_STRING_TOO_LONG",
});

/** Safe error class with fixed safe error code and generic message. */
export class NativeSearchMetadataError extends Error {
  constructor(
    code = METADATA_ERROR_CODES.MALFORMED_SEARCH_METADATA,
    message = "Malformed native search metadata",
  ) {
    super(message);
    this.name = "NativeSearchMetadataError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new NativeSearchMetadataError(code, message);
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Decode a varint from raw varint bytes.
 * Validates length (<= 10 bytes), uint64 overflow, and trailing bytes.
 */
function decodeVarint(bytes) {
  if (!bytes || !bytes.length) {
    fail(
      METADATA_ERROR_CODES.MALFORMED_SEARCH_METADATA,
      "Empty varint payload",
    );
  }
  let value = 0n;
  let shift = 0n;
  for (let i = 0; i < bytes.length; i++) {
    if (i > 9) {
      fail(
        METADATA_ERROR_CODES.MALFORMED_SEARCH_METADATA,
        "Varint exceeds 10 bytes",
      );
    }
    const b = bytes[i];
    if (i === 9 && b > 1) {
      fail(
        METADATA_ERROR_CODES.MALFORMED_SEARCH_METADATA,
        "Varint overflows uint64",
      );
    }
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      if (i !== bytes.length - 1) {
        fail(
          METADATA_ERROR_CODES.MALFORMED_SEARCH_METADATA,
          "Trailing bytes in varint payload",
        );
      }
      return value;
    }
    shift += 7n;
  }
  fail(
    METADATA_ERROR_CODES.MALFORMED_SEARCH_METADATA,
    "Unterminated varint payload",
  );
}

/**
 * Decode an int32 offset.
 * Rejects negative values (including 64-bit sign-extended two's complement)
 * and values exceeding int32 maximum (2147483647).
 */
function decodeInt32Offset(bytes) {
  const raw = decodeVarint(bytes);
  const signed64 = BigInt.asIntN(64, raw);
  if (signed64 < 0n || raw > 2147483647n) {
    fail(
      METADATA_ERROR_CODES.INVALID_RANGE,
      "Offset is negative or exceeds int32 range",
    );
  }
  return Number(raw);
}

/**
 * Decode an int32 enum value.
 */
function decodeEnum(bytes) {
  const raw = decodeVarint(bytes);
  const signed64 = BigInt.asIntN(64, raw);
  if (signed64 < 0n || raw > 2147483647n) {
    fail(
      METADATA_ERROR_CODES.INVALID_RANGE,
      "Enum value is negative or exceeds int32 range",
    );
  }
  return Number(raw);
}

/**
 * Decode a boolean varint. Must be 0 or 1.
 */
function decodeBool(bytes) {
  const raw = decodeVarint(bytes);
  if (raw === 0n) return false;
  if (raw === 1n) return true;
  fail(
    METADATA_ERROR_CODES.MALFORMED_SEARCH_METADATA,
    "Invalid boolean varint value",
  );
}

/**
 * Decode a UTF-8 string with fatal validation and byte length check.
 * Never includes raw payload bytes in error messages.
 */
function decodeString(bytes, maxLength, fieldName) {
  if (bytes.length > maxLength) {
    fail(
      METADATA_ERROR_CODES.STRING_TOO_LONG,
      `${fieldName} exceeds maximum byte length`,
    );
  }
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    fail(
      METADATA_ERROR_CODES.INVALID_UTF8,
      `Invalid UTF-8 sequence in ${fieldName}`,
    );
  }
}

/**
 * Syntactic safe HTTP(S) URL validation.
 *
 * Enforces:
 * - Scheme must be http: or https:
 * - No credentials (username / password)
 * - Rejects IP literals (IPv4 and IPv6) syntactically
 * - Rejects local/reserved hostnames (localhost, .local, .internal, .lan, .test, .example, etc.)
 * - Rejects single-label hostnames without a dot
 * - Bounded length (<= 4096 bytes)
 *
 * NOTE: This is purely syntactic formatting validation for metadata hygiene.
 * It performs NO DNS requests and must NOT be claimed to be an SSRF-safe fetcher.
 */
/**
 * Syntactic public-looking HTTP(S) URL validation only; this is not DNS or SSRF protection.
 */
export function isSafeWebUrl(urlString) {
  if (typeof urlString !== "string" || !urlString) return false;
  if (
    /[\\\\\u0000-\u001f\u007f]/.test(urlString) ||
    urlString.trim() !== urlString
  )
    return false;
  if (Buffer.byteLength(urlString) > METADATA_LIMITS.MAX_URL_LENGTH)
    return false;
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname.startsWith("[") || !hostname.includes("."))
    return false;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) || /^\d+$/.test(hostname))
    return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
  const labels = hostname.split(".");
  return labels.every(
    (label) =>
      label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  );
}

/** Schema definition for known ROBINCitation fields. */
const CITATION_FIELD_SCHEMA = Object.freeze({
  1: { name: "startIndex", expectedWire: 0, maxCount: 1 },
  2: { name: "endIndex", expectedWire: 0, maxCount: 1 },
  3: { name: "link", expectedWire: 2, maxCount: 1 },
  4: { name: "citationType", expectedWire: 0, maxCount: 1 },
  5: { name: "htmlTitle", expectedWire: 2, maxCount: 1 },
  6: { name: "citationId", expectedWire: 2, maxCount: 1 },
  7: { name: "faviconURL", expectedWire: 2, maxCount: 1 },
});

/** Schema definition for known ROBINRenderableSource fields. */
const SOURCE_FIELD_SCHEMA = Object.freeze({
  1: { name: "sourceId", expectedWire: 2, maxCount: 1 },
  2: { name: "iconURL", expectedWire: 2, maxCount: 1 },
  3: { name: "attributionTitle", expectedWire: 2, maxCount: 1 },
  4: { name: "attributionSubtitle", expectedWire: 2, maxCount: 1 },
  5: { name: "sourceTitle", expectedWire: 2, maxCount: 1 },
  6: { name: "snippet", expectedWire: 2, maxCount: 1 },
  7: { name: "categoryName", expectedWire: 2, maxCount: 1 },
  8: { name: "webAction", expectedWire: 2, maxCount: 1 },
  9: { name: "openConversation", expectedWire: 2, maxCount: 1 },
  10: { name: "previewUploadedFile", expectedWire: 2, maxCount: 1 },
  11: { name: "openGmailAction", expectedWire: 2, maxCount: 1 },
  12: { name: "openByAppFunctionsAction", expectedWire: 2, maxCount: 1 },
  18: {
    name: "navigateToGeminiManageExtensions",
    expectedWire: 2,
    maxCount: 1,
  },
  25: {
    name: "openPersonalCurationDocumentAction",
    expectedWire: 2,
    maxCount: 1,
  },
});

/** Schema definition for known ROBINLinkAction_WebAction fields. */
const WEB_ACTION_FIELD_SCHEMA = Object.freeze({
  1: { name: "URL", expectedWire: 2, maxCount: 1 },
  2: { name: "forceAccount", expectedWire: 0, maxCount: 1 },
});

/** Non-web action field numbers on ROBINRenderableSource. */
const NON_WEB_ACTION_FIELD_NUMBERS = new Set([9, 10, 11, 12, 18, 25]);

/**
 * Validate field wire types and check for illegal duplicates against a known schema.
 * Unknown field numbers are tolerated without error and without recursion.
 */
function validateFields(fields, schema, containerName) {
  const counts = new Map();
  for (const f of fields) {
    const rule = schema[f.number];
    if (rule) {
      if (f.wire !== rule.expectedWire) {
        fail(
          METADATA_ERROR_CODES.INVALID_WIRE_TYPE,
          `Field ${rule.name} (number ${f.number}) in ${containerName} has invalid wire type ${f.wire}, expected ${rule.expectedWire}`,
        );
      }
      const count = (counts.get(f.number) || 0) + 1;
      if (count > rule.maxCount) {
        fail(
          METADATA_ERROR_CODES.DUPLICATE_FIELD,
          `Duplicate field ${rule.name} (number ${f.number}) in ${containerName}`,
        );
      }
      counts.set(f.number, count);
    }
  }
}

/**
 * Decode a single ROBINCitation message.
 */
function decodeCitation(payload) {
  let fields;
  try {
    fields = parse(payload);
  } catch {
    fail(
      METADATA_ERROR_CODES.MALFORMED_SEARCH_METADATA,
      "Failed to parse citation protobuf message",
    );
  }

  validateFields(fields, CITATION_FIELD_SCHEMA, "ROBINCitation");

  let startIndex = null;
  let endIndex = null;
  let link = null;
  let citationType = null;
  let untrustedHtmlTitle = null;
  let citationId = null;
  let faviconURL = null;

  for (const f of fields) {
    switch (f.number) {
      case 1:
        startIndex = decodeInt32Offset(f.payload);
        break;
      case 2:
        endIndex = decodeInt32Offset(f.payload);
        break;
      case 3: {
        const decoded = decodeString(
          f.payload,
          METADATA_LIMITS.MAX_URL_LENGTH,
          "citation link",
        );
        link = isSafeWebUrl(decoded) ? decoded : null;
        break;
      }
      case 4:
        citationType = decodeEnum(f.payload);
        break;
      case 5:
        // Plain untrusted string data; never treated as safe HTML markup
        untrustedHtmlTitle = decodeString(
          f.payload,
          METADATA_LIMITS.MAX_TITLE_LENGTH,
          "citation htmlTitle",
        );
        break;
      case 6:
        citationId = decodeString(
          f.payload,
          METADATA_LIMITS.MAX_ID_LENGTH,
          "citation citationId",
        );
        break;
      case 7: {
        const decoded = decodeString(
          f.payload,
          METADATA_LIMITS.MAX_URL_LENGTH,
          "citation faviconURL",
        );
        faviconURL = isSafeWebUrl(decoded) ? decoded : null;
        break;
      }
      default:
        // Unknown unrelated field: tolerated without recursion
        break;
    }
  }

  // Reject end < start when both offsets are given
  if (startIndex !== null && endIndex !== null && endIndex < startIndex) {
    fail(
      METADATA_ERROR_CODES.INVALID_RANGE,
      "endIndex cannot be less than startIndex",
    );
  }

  return {
    startIndex,
    endIndex,
    indexUnits: "unknown",
    indexProvenance: "raw_native_unknown_units",
    link,
    citationType,
    untrustedHtmlTitle,
    citationId,
    faviconURL,
  };
}

/**
 * Decode ROBINLinkAction_WebAction.
 */
function decodeWebAction(payload) {
  let fields;
  try {
    fields = parse(payload);
  } catch {
    fail(
      METADATA_ERROR_CODES.MALFORMED_SEARCH_METADATA,
      "Failed to parse webAction protobuf message",
    );
  }

  validateFields(fields, WEB_ACTION_FIELD_SCHEMA, "ROBINLinkAction_WebAction");

  let rawUrl = null;
  let forceAccount = null;

  for (const f of fields) {
    switch (f.number) {
      case 1:
        rawUrl = decodeString(
          f.payload,
          METADATA_LIMITS.MAX_URL_LENGTH,
          "webAction URL",
        );
        break;
      case 2:
        forceAccount = decodeBool(f.payload);
        break;
      default:
        break;
    }
  }

  if (!rawUrl || !isSafeWebUrl(rawUrl)) {
    return null;
  }

  return {
    url: rawUrl,
    forceAccount,
  };
}

/**
 * Decode a single ROBINRenderableSource message.
 * Returns decoded source if it is a valid, safe public web source.
 * Excludes non-web sources and mixed/action-ambiguous sources.
 */
function decodeRenderableSource(payload) {
  let fields;
  try {
    fields = parse(payload);
  } catch {
    fail(
      METADATA_ERROR_CODES.MALFORMED_SEARCH_METADATA,
      "Failed to parse renderable source protobuf message",
    );
  }

  validateFields(fields, SOURCE_FIELD_SCHEMA, "ROBINRenderableSource");

  let webActionField = null;
  let hasNonWebAction = false;
  let sourceId = null;
  let iconURL = null;
  let attributionTitle = null;
  let attributionSubtitle = null;
  let sourceTitle = null;
  let snippet = null;
  let categoryName = null;

  for (const f of fields) {
    if (f.number === 8) {
      webActionField = f;
    } else if (NON_WEB_ACTION_FIELD_NUMBERS.has(f.number)) {
      hasNonWebAction = true;
    } else {
      switch (f.number) {
        case 1:
          sourceId = decodeString(
            f.payload,
            METADATA_LIMITS.MAX_ID_LENGTH,
            "sourceId",
          );
          break;
        case 2: {
          const decoded = decodeString(
            f.payload,
            METADATA_LIMITS.MAX_URL_LENGTH,
            "iconURL",
          );
          iconURL = isSafeWebUrl(decoded) ? decoded : null;
          break;
        }
        case 3:
          attributionTitle = decodeString(
            f.payload,
            METADATA_LIMITS.MAX_TITLE_LENGTH,
            "attributionTitle",
          );
          break;
        case 4:
          attributionSubtitle = decodeString(
            f.payload,
            METADATA_LIMITS.MAX_TITLE_LENGTH,
            "attributionSubtitle",
          );
          break;
        case 5:
          sourceTitle = decodeString(
            f.payload,
            METADATA_LIMITS.MAX_TITLE_LENGTH,
            "sourceTitle",
          );
          break;
        case 6:
          snippet = decodeString(
            f.payload,
            METADATA_LIMITS.MAX_SNIPPET_LENGTH,
            "snippet",
          );
          break;
        case 7:
          categoryName = decodeString(
            f.payload,
            METADATA_LIMITS.MAX_CATEGORY_LENGTH,
            "categoryName",
          );
          break;
        default:
          // Unknown / uninspected field tolerated without recursion
          break;
      }
    }
  }

  // Non-web only or mixed actions (action-ambiguous): never turn into web results
  if (!webActionField || hasNonWebAction) {
    return null;
  }

  const webAction = decodeWebAction(webActionField.payload);
  if (!webAction) {
    // Missing, invalid, or unsafe URL: excluded from web sources
    return null;
  }

  return {
    sourceId,
    url: webAction.url,
    sourceTitle,
    snippet,
    attributionTitle,
    attributionSubtitle,
    categoryName,
    iconURL,
    forceAccount: webAction.forceAccount,
  };
}

/**
 * Decode citations and web sources metadata from inner ROBINModelResponse bytes.
 *
 * Requirements & semantics:
 * - Pure bounded parsing; does NOT perform network requests or HTML execution.
 * - Unknown unrelated fields tolerated without recursion.
 * - Preserves bounded raw citation index values with explicit unknown-unit provenance.
 * - Excludes non-web actions and action-ambiguous sources from webSources.
 * - Distinguishes omitted fields from explicit 0.
 * - Rejects negative/out-of-range offsets or end < start when both are given.
 * - Explicitly avoids `searchExecuted=true`; metadata presence is descriptor-only.
 *
 * @param {Buffer|Uint8Array} modelResponseBytes - Raw serialized protobuf bytes.
 * @param {object} [options] - Optional custom bounds (defaults to METADATA_LIMITS).
 * @returns {object} Decoded metadata containing citations, webSources, counts, and descriptor evidence.
 */
function boundedOptions(options) {
  if (options === undefined) options = {};
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail(
      METADATA_ERROR_CODES.MALFORMED_SEARCH_METADATA,
      "Invalid metadata limits",
    );
  }
  const allowed = {
    maxInputBytes: METADATA_LIMITS.MAX_INPUT_BYTES,
    maxCitations: METADATA_LIMITS.MAX_CITATIONS,
    maxSources: METADATA_LIMITS.MAX_SOURCES,
  };
  for (const key of Object.keys(options)) {
    if (!Object.hasOwn(allowed, key))
      fail(
        METADATA_ERROR_CODES.MALFORMED_SEARCH_METADATA,
        "Invalid metadata limits",
      );
  }
  const result = {};
  for (const [key, hardLimit] of Object.entries(allowed)) {
    const value = Object.hasOwn(options, key) ? options[key] : hardLimit;
    if (!Number.isSafeInteger(value) || value < 0 || value > hardLimit) {
      fail(
        METADATA_ERROR_CODES.MALFORMED_SEARCH_METADATA,
        "Invalid metadata limits",
      );
    }
    result[key] = value;
  }
  return result;
}

export function decodeNativeSearchMetadata(modelResponseBytes, options = {}) {
  options = boundedOptions(options);
  let bytes = modelResponseBytes;
  if (!Buffer.isBuffer(bytes)) {
    if (bytes instanceof Uint8Array) {
      bytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } else {
      fail(
        METADATA_ERROR_CODES.MALFORMED_SEARCH_METADATA,
        "Expected Buffer or Uint8Array for modelResponseBytes",
      );
    }
  }

  const maxInputBytes = options.maxInputBytes;
  if (bytes.length > maxInputBytes) {
    fail(
      METADATA_ERROR_CODES.INPUT_TOO_LARGE,
      "Input exceeds maximum byte budget",
    );
  }

  let fields;
  try {
    fields = parse(bytes);
  } catch {
    fail(
      METADATA_ERROR_CODES.MALFORMED_SEARCH_METADATA,
      "Failed to parse model response protobuf wire format",
    );
  }

  const maxCitations = options.maxCitations;
  const maxSources = options.maxSources;

  let rawCitationCount = 0;
  let rawSourceCount = 0;

  // Pre-count repeated fields to enforce limits before expensive decoding
  for (const f of fields) {
    if (f.number === 6) {
      if (f.wire !== 2) {
        fail(
          METADATA_ERROR_CODES.INVALID_WIRE_TYPE,
          `ModelResponse citation field 6 has invalid wire type ${f.wire}, expected 2`,
        );
      }
      if (++rawCitationCount > maxCitations) {
        fail(
          METADATA_ERROR_CODES.COUNT_EXCEEDED,
          "Citation count exceeds maximum allowed limit",
        );
      }
    } else if (f.number === 14) {
      if (f.wire !== 2) {
        fail(
          METADATA_ERROR_CODES.INVALID_WIRE_TYPE,
          `ModelResponse renderable source field 14 has invalid wire type ${f.wire}, expected 2`,
        );
      }
      if (++rawSourceCount > maxSources) {
        fail(
          METADATA_ERROR_CODES.COUNT_EXCEEDED,
          "Renderable source count exceeds maximum allowed limit",
        );
      }
    }
    // Fields 3 (attributionMetadata), 12 (thoughts), 16 (structuredThoughtHeader),
    // and other unrelated fields are deliberately ignored without inspection or recursion.
  }

  const citations = [];
  const webSources = [];

  for (const f of fields) {
    if (f.number === 6) {
      citations.push(decodeCitation(f.payload));
    } else if (f.number === 14) {
      const source = decodeRenderableSource(f.payload);

      if (source !== null) {
        webSources.push(source);
      }
    }
  }

  const hasMetadata = citations.length > 0 || webSources.length > 0;

  return {
    citations,
    webSources,
    counts: {
      citations: citations.length,
      webSources: webSources.length,
      totalRawCitations: rawCitationCount,
      totalRawSources: rawSourceCount,
    },
    evidenceLevel: "METADATA_DESCRIPTOR_ONLY",
    searchEvidence: {
      evidenceLevel: "METADATA_DESCRIPTOR_ONLY",
      metadataPresent: hasMetadata,
      searchExecuted: null,
      executionProof: false,
      provenance: "passive_metadata_descriptor_only",
      note: "Presence of citations or renderable sources is passive metadata evidence only and does NOT constitute proof that an external search was executed.",
    },
  };
}
