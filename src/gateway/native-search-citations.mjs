import { canonicalWebUrlKey, isSafeWebUrl } from './native-search-metadata.mjs';

export const CITATION_LIMITS = Object.freeze({
  MAX_ANNOTATIONS: 64,
  MAX_TITLE_CHARS: 512,
});

function sliceCodeUnitsSafe(text, maxChars = CITATION_LIMITS.MAX_TITLE_CHARS) {
  if (text.length <= maxChars) return text;
  let cut = text.slice(0, maxChars);
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

function cleanPlainTitle(value, { stripHtml = false } = {}) {
  if (typeof value !== 'string' || !value.isWellFormed()) return '';
  let text = stripHtml ? value.replace(/<[^>]*>/g, '') : value;
  text = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return sliceCodeUnitsSafe(text, CITATION_LIMITS.MAX_TITLE_CHARS);
}

function hostnameFallback(url) {
  try {
    return sliceCodeUnitsSafe(new URL(url).hostname, CITATION_LIMITS.MAX_TITLE_CHARS) || 'source';
  } catch {
    return 'source';
  }
}

function filterReportMetadata(report) {
  const minFrame = Number.isInteger(report?.lastTextFrameIndex) ? report.lastTextFrameIndex : 0;
  const frameOk = (item) => (minFrame === 0
    ? (item?.frameIndex === undefined || (Number.isInteger(item.frameIndex) && item.frameIndex >= 0))
    : (Number.isInteger(item?.frameIndex) && item.frameIndex >= minFrame));

  const rawSources = Array.isArray(report?.webSources) ? report.webSources : [];
  const excludedUrls = new Set();
  const excludedBaseUrls = new Set();
  const addExcludedUrl = (url) => {
    if (typeof url !== 'string' || !url) return;
    excludedUrls.add(canonicalWebUrlKey(url));
    try {
      const parsed = new URL(url.trim());
      if (!parsed.hash) excludedBaseUrls.add(canonicalWebUrlKey(url, { stripHash: true }));
    } catch {}
  };
  for (const src of rawSources) {
    if (typeof src?.url === 'string' && src.forceAccount === true) {
      addExcludedUrl(src.url);
    }
  }
  for (const url of Array.isArray(report?.excludedUrls) ? report.excludedUrls : []) {
    addExcludedUrl(url);
  }
  const isExcludedUrl = (url) => (
    excludedUrls.has(canonicalWebUrlKey(url))
    || excludedBaseUrls.has(canonicalWebUrlKey(url, { stripHash: true }))
  );

  const webSources = [];
  for (const src of rawSources) {
    if (!frameOk(src) || typeof src?.url !== 'string') continue;
    if (src.forceAccount === true || isExcludedUrl(src.url)) continue;
    if (isSafeWebUrl(src.url)) webSources.push(src);
  }

  const citations = [];
  for (const cit of Array.isArray(report?.citations) ? report.citations : []) {
    if (!frameOk(cit) || !isSafeWebUrl(cit?.link) || isExcludedUrl(cit.link)) continue;
    citations.push(cit);
  }

  const sourceTitles = new Map();
  for (const src of webSources) {
    const key = canonicalWebUrlKey(src.url);
    if (sourceTitles.has(key)) continue;
    const title = cleanPlainTitle(src.sourceTitle)
      || cleanPlainTitle(src.title)
      || cleanPlainTitle(src.attributionTitle);
    if (title) sourceTitles.set(key, title);
  }

  return { citations, webSources, sourceTitles };
}

function resolveTitle(url, { sourceTitles, directTitle, untrustedHtmlTitle } = {}) {
  return cleanPlainTitle(directTitle)
    || sourceTitles?.get(canonicalWebUrlKey(url))
    || cleanPlainTitle(untrustedHtmlTitle, { stripHtml: true })
    || hostnameFallback(url);
}

function resolveSpan(answerText, answerBuf, citation, url) {
  const literalIndex = answerText.indexOf(url);
  const fallback = literalIndex >= 0
    ? [literalIndex, literalIndex + url.length]
    : [answerText.length, answerText.length];

  const start = citation?.startIndex;
  const end = citation?.endIndex;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    return fallback;
  }

  const byteLen = answerBuf.length;
  if (byteLen === answerText.length) {
    return end <= answerText.length ? [start, end] : fallback;
  }

  if (end > byteLen) return fallback;
  const isUtf8Boundary = (offset) => offset === 0 || offset === byteLen || (answerBuf[offset] & 0xc0) !== 0x80;
  if (!isUtf8Boundary(start) || !isUtf8Boundary(end)) return fallback;

  const startUtf16 = answerBuf.subarray(0, start).toString('utf8').length;
  const endUtf16 = answerBuf.subarray(0, end).toString('utf8').length;
  if (endUtf16 < startUtf16 || endUtf16 > answerText.length) return fallback;
  return [startUtf16, endUtf16];
}

/** Map safe, final-frame native_search citations and webSources to bounded OpenAI url_citation objects. */
export function mapNativeSearchAnnotations(answerText, report) {
  const text = typeof answerText === 'string' ? answerText : '';
  const answerBuf = Buffer.from(text, 'utf8');
  const { citations, webSources, sourceTitles } = filterReportMetadata(report);

  const out = [];
  const seen = new Set();
  const citedUrls = new Set();

  const pushAnnotation = (url, title, [start_index, end_index]) => {
    if (out.length >= CITATION_LIMITS.MAX_ANNOTATIONS) return;
    const canonicalUrl = canonicalWebUrlKey(url);
    const key = `${canonicalUrl}\0${start_index}\0${end_index}`;
    if (seen.has(key)) return;
    seen.add(key);
    citedUrls.add(canonicalUrl);
    out.push({ type: 'url_citation', url, title, start_index, end_index });
  };

  for (const citation of citations) {
    if (out.length >= CITATION_LIMITS.MAX_ANNOTATIONS) break;
    const url = citation.link;
    const title = resolveTitle(url, {
      sourceTitles,
      directTitle: citation.title,
      untrustedHtmlTitle: citation.untrustedHtmlTitle,
    });
    pushAnnotation(url, title, resolveSpan(text, answerBuf, citation, url));
  }

  for (const src of webSources) {
    if (out.length >= CITATION_LIMITS.MAX_ANNOTATIONS) break;
    if (citedUrls.has(canonicalWebUrlKey(src.url))) continue;
    const title = resolveTitle(src.url, {
      sourceTitles,
      directTitle: src.sourceTitle || src.title || src.attributionTitle,
    });
    pushAnnotation(src.url, title, resolveSpan(text, answerBuf, null, src.url));
  }

  return out;
}

/** Extract sanitized public web sources list (<= 64 unique URLs) from final-frame metadata. */
export function extractNativeSearchSources(report) {
  const { citations, webSources, sourceTitles } = filterReportMetadata(report);
  const sources = [];
  const seenUrls = new Set();

  const pushSource = (url, title) => {
    const canonicalUrl = canonicalWebUrlKey(url);
    if (sources.length >= CITATION_LIMITS.MAX_ANNOTATIONS || seenUrls.has(canonicalUrl)) return;
    seenUrls.add(canonicalUrl);
    sources.push({ url, title });
  };

  for (const citation of citations) {
    if (sources.length >= CITATION_LIMITS.MAX_ANNOTATIONS) break;
    pushSource(citation.link, resolveTitle(citation.link, {
      sourceTitles,
      directTitle: citation.title,
      untrustedHtmlTitle: citation.untrustedHtmlTitle,
    }));
  }

  for (const src of webSources) {
    if (sources.length >= CITATION_LIMITS.MAX_ANNOTATIONS) break;
    pushSource(src.url, resolveTitle(src.url, {
      sourceTitles,
      directTitle: src.sourceTitle || src.title || src.attributionTitle,
    }));
  }

  return sources;
}
