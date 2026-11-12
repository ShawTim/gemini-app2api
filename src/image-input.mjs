import { parseRemoteImageUrl } from './image-url.mjs';
import { protocolError } from './tool-protocol.mjs';

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_URL_BYTES = Math.ceil(MAX_TOTAL_IMAGE_BYTES / 3) * 4 + 1024;
const MAX_PIXELS = 40_000_000;
const fail = (code, status = 400) => { throw protocolError(code, status); };
const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
// Structural checks only: the gateway never decompresses or renders caller images.
function dimensions(bytes, mimeType) {
  if (mimeType === 'image/png') {
    if (bytes.length < 57 || !bytes.subarray(0, 8).equals(pngMagic) || bytes.readUInt32BE(8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR') fail('INVALID_IMAGE_BYTES');
    let offset = 8, ended = false, chunks = 0, hasData = false;
    while (offset + 12 <= bytes.length) {
      if (++chunks > 2048) fail('INVALID_IMAGE_BYTES');
      const length = bytes.readUInt32BE(offset), type = bytes.toString('latin1', offset + 4, offset + 8);
      if (!/^[A-Za-z]{4}$/.test(type) || length > bytes.length - offset - 12) fail('INVALID_IMAGE_BYTES');
      if (['acTL', 'fcTL', 'fdAT'].includes(type)) fail('UNSUPPORTED_ANIMATED_IMAGE');
      if ((type === 'IHDR' && offset !== 8) || bytes.readUInt32BE(offset + 8 + length) !== crc32(bytes.subarray(offset + 4, offset + 8 + length))) fail('INVALID_IMAGE_BYTES');
      if (type === 'IDAT' && length) hasData = true;
      offset += length + 12;
      if (type === 'IEND') { if (length || offset !== bytes.length || !hasData) fail('INVALID_IMAGE_BYTES'); ended = true; break; }
    }
    if (!ended) fail('INVALID_IMAGE_BYTES');
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (mimeType === 'image/jpeg') {
    if (bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) fail('INVALID_IMAGE_BYTES');
    let offset = 2, result;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) fail('INVALID_IMAGE_BYTES');
      while (offset < bytes.length && bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) fail('INVALID_IMAGE_BYTES');
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || length > bytes.length - offset) fail('INVALID_IMAGE_BYTES');
      if (marker === 218) {
        if (!result || length < 6 || offset + length >= bytes.length - 2) fail('INVALID_IMAGE_BYTES');
        return result;
      }
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (result || length < 8 || !bytes[offset + 7] || length !== 8 + 3 * bytes[offset + 7]) fail('INVALID_IMAGE_BYTES');
        result = [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
      }
      offset += length;
    }
    fail('INVALID_IMAGE_BYTES');
  }
  if (mimeType === 'image/webp') {
    if (bytes.length < 26 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) fail('INVALID_IMAGE_BYTES');
    let offset = 12, chunks = 0, canvas, pixels;
    while (offset + 8 <= bytes.length) {
      if (++chunks > 2048) fail('INVALID_IMAGE_BYTES');
      const kind = bytes.toString('latin1', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
      if (size > bytes.length - start || start + size + (size & 1) > bytes.length) fail('INVALID_IMAGE_BYTES');
      if (kind === 'ANIM' || kind === 'ANMF') fail('UNSUPPORTED_ANIMATED_IMAGE');
      if (kind === 'VP8X') {
        if (offset !== 12 || size !== 10) fail('INVALID_IMAGE_BYTES');
        if (bytes[start] & 2) fail('UNSUPPORTED_ANIMATED_IMAGE');
        canvas = [bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1];
      } else if (kind === 'VP8 ' || kind === 'VP8L') {
        if (pixels || (!canvas && offset !== 12)) fail('INVALID_IMAGE_BYTES');
        if (kind === 'VP8 ' && size >= 10 && !(bytes[start] & 1) && bytes[start + 3] === 157 && bytes[start + 4] === 1 && bytes[start + 5] === 42) pixels = [bytes.readUInt16LE(start + 6) & 16383, bytes.readUInt16LE(start + 8) & 16383];
        else if (kind === 'VP8L' && size >= 5 && bytes[start] === 47) pixels = [1 + bytes[start + 1] + ((bytes[start + 2] & 63) << 8), 1 + (bytes[start + 2] >> 6) + (bytes[start + 3] << 2) + ((bytes[start + 4] & 15) << 10)];
        else fail('INVALID_IMAGE_BYTES');
      }
      offset = start + size + (size & 1);
    }
    if (offset !== bytes.length || !pixels || (canvas && (canvas[0] !== pixels[0] || canvas[1] !== pixels[1]))) fail('INVALID_IMAGE_BYTES');
    return pixels;
  }
  fail('UNSUPPORTED_IMAGE_FORMAT');
}
/** Inline decoder only; remote downloads separately reuse decodeImageBytes. */
export function decodeImageDataUrl(url) {
  if (typeof url !== 'string') fail('INVALID_IMAGE_URL');
  if (!url.startsWith('data:')) fail('UNSUPPORTED_IMAGE_URL');
  if (Buffer.byteLength(url) > MAX_IMAGE_URL_BYTES) fail('IMAGE_TOO_LARGE', 413);
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(url);
  if (!match || !match[2].length || match[2].length % 4) fail('INVALID_IMAGE_DATA_URL');
  const mimeType = match[1].toLowerCase(), data = Buffer.from(match[2], 'base64');
  if (!data.length || data.toString('base64') !== match[2]) fail('INVALID_IMAGE_DATA_URL');
  return { ...decodeImageBytes(data, mimeType), url: `data:${mimeType};base64,${match[2]}` };
}
export function decodeImageBytes(data, mimeType) {
  if (!Buffer.isBuffer(data) || !data.length) fail('INVALID_IMAGE_BYTES');
  if (data.length > MAX_IMAGE_BYTES) fail('IMAGE_TOO_LARGE', 413);
  const [width, height] = dimensions(data, mimeType);
  if (!width || !height || width > 32768 || height > 32768 || width * height > MAX_PIXELS) fail('IMAGE_DIMENSIONS_TOO_LARGE', 413);
  return { mimeType, data, width, height };
}
export function normalizeImageUrl(url, detail) {
  if (detail !== undefined && detail !== 'auto') fail('UNSUPPORTED_IMAGE_DETAIL');
  if (typeof url === 'string' && /^https?:/i.test(url)) return parseRemoteImageUrl(url).href;
  return decodeImageDataUrl(url).url;
}
export function collectImageInputs(messages, resolvedImages) {
  let total = 0;
  const images = [], transcript = messages.map(message => {
    if (!Array.isArray(message.content)) return message;
    const content = message.content.map(part => {
      if (part.type === 'text') return part.text;
      if (message.role !== 'user' || part.type !== 'image_url') fail('UNSUPPORTED_IMAGE_ROLE');
      if (images.length >= MAX_IMAGES) fail('IMAGE_COUNT_EXCEEDED', 413);
      const url = part.image_url?.url;
      const decoded = resolvedImages ? resolvedImages[images.length] : /^https?:/i.test(url) ? { url: parseRemoteImageUrl(url).href } : decodeImageDataUrl(url);
      const { data, mimeType, width, height } = decoded;
      if ((total += (data?.length ?? 0)) > MAX_TOTAL_IMAGE_BYTES) fail('IMAGES_TOO_LARGE', 413);
      images.push(data ? { data, mimeType, width, height } : decoded);
      const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType?.slice(6) ?? 'image';
      return `\n[Attached user image ${images.length}: image-${images.length}.${extension}]\n`;
    }).join('');
    return { ...message, content };
  });
  return { messages: transcript, images };
}
