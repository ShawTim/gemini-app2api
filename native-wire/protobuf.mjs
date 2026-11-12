// Wire-only editor: no generated schema, reflection, network, or native loading.
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_FIELDS = 100000;
const MAX_DEPTH = 32;
const MAX_FIELD = 0x1fffffff;

function bytes(input) {
  if (!Buffer.isBuffer(input)) throw new TypeError('Expected Buffer');
  if (input.length > MAX_MESSAGE_BYTES) throw new RangeError('Message exceeds 16 MiB');
  return input;
}

export function varint(value) {
  if (typeof value !== 'bigint' && !Number.isSafeInteger(value)) throw new RangeError('Invalid integer');
  let n = BigInt(value);
  if (n < 0n || n > 0xffffffffffffffffn) throw new RangeError('Outside uint64');
  const out = [];
  do {
    out.push(Number(n & 127n) | (n > 127n ? 128 : 0));
    n >>= 7n;
  } while (n);
  return Buffer.from(out);
}

function readVarint(input, start) {
  let n = 0n;
  for (let i = 0; i < 10; i++) {
    if (start + i >= input.length) throw new Error('Truncated varint');
    const b = input[start + i];
    if (i === 9 && b > 1) throw new Error('Varint overflows uint64');
    n |= BigInt(b & 127) << BigInt(i * 7);
    if (!(b & 128)) return { value: n, end: start + i + 1 };
  }
  throw new Error('Invalid varint');
}

export function lengthDelimited(number, value) {
  bytes(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_FIELD) throw new RangeError('Invalid field number');
  const result = Buffer.concat([varint(BigInt(number) * 8n + 2n), varint(value.length), value]);
  return bytes(result);
}

export function varintField(number, value) {
  if (!Number.isInteger(number) || number < 1 || number > MAX_FIELD) throw new RangeError('Invalid field number');
  return Buffer.concat([varint(BigInt(number) * 8n + 0n), varint(BigInt(value))]);
}

// Unknown fields retain their original key/length/value bytes, even noncanonical
// (but valid) varints. Legacy groups are opaque and bounded, not dropped.
export function parse(input) {
  bytes(input);
  let count = 0;
  function sequence(start, group, depth) {
    if (depth > MAX_DEPTH) throw new Error('Group nesting exceeds limit');
    const fields = [];
    let pos = start;
    while (pos < input.length) {
      if (++count > MAX_FIELDS) throw new Error('Too many fields');
      const begin = pos;
      const key = readVarint(input, pos);
      pos = key.end;
      const number = Number(key.value >> 3n), wire = Number(key.value & 7n);
      if (number < 1 || number > MAX_FIELD) throw new Error('Invalid field number');
      if (wire === 4) {
        if (number !== group) throw new Error('Unmatched end group');
        return { fields, end: pos, contentEnd: begin };
      }
      let payloadStart = pos, payloadEnd;
      if (wire === 0) pos = readVarint(input, pos).end;
      else if (wire === 1) pos += 8;
      else if (wire === 5) pos += 4;
      else if (wire === 2) {
        const size = readVarint(input, pos);
        if (size.value > BigInt(MAX_MESSAGE_BYTES)) throw new Error('Oversized length');
        payloadStart = size.end;
        pos = payloadStart + Number(size.value);
      } else if (wire === 3) {
        const nested = sequence(pos, number, depth + 1);
        payloadEnd = nested.contentEnd;
        pos = nested.end;
      } else throw new Error('Unsupported wire type');
      if (pos > input.length) throw new Error('Truncated field');
      payloadEnd ??= pos;
      fields.push({ number, wire, raw: input.subarray(begin, pos),
        payload: input.subarray(payloadStart, payloadEnd) });
    }
    if (group !== null) throw new Error('Unterminated group');
    return { fields, end: pos };
  }
  return sequence(0, null, 0).fields;
}

export function singular(input, number, { required = false } = {}) {
  const found = parse(input).filter(f => f.number === number);
  // Protobuf singular messages may merge duplicates. Reject rather than silently
  // choose a fragment or accidentally alter merge/oneof semantics.
  if (found.length > 1) throw new Error(`Ambiguous duplicate singular field ${number}`);
  if (!found.length) {
    if (required) throw new Error(`Missing required existing field ${number}`);
    return undefined;
  }
  if (found[0].wire !== 2) throw new Error(`Field ${number} must be length-delimited`);
  return found[0].payload;
}

export function replaceFields(input, number, values) {
  if (!Array.isArray(values)) throw new TypeError('Expected replacement array');
  let replacementSize = 0;
  for (const value of values) {
    bytes(value);
    replacementSize += value.length + varint(value.length).length + varint(BigInt(number) * 8n + 2n).length;
    if (replacementSize > MAX_MESSAGE_BYTES) throw new RangeError('Replacements exceed 16 MiB');
  }
  const replacements = values.map(v => lengthDelimited(number, v));
  const fields = parse(input), out = [];
  let inserted = false;
  for (const field of fields) {
    if (field.number === number) {
      if (field.wire !== 2) throw new Error(`Field ${number} has wrong wire type`);
      if (!inserted) out.push(...replacements);
      inserted = true;
    } else out.push(field.raw);
  }
  if (!inserted) out.push(...replacements);
  if (out.reduce((size, part) => size + part.length, 0) > MAX_MESSAGE_BYTES)
    throw new RangeError('Edited message exceeds 16 MiB');
  return bytes(Buffer.concat(out));
}

export function removeFields(input, numbers) {
  return bytes(Buffer.concat(parse(input).filter(f => !numbers.includes(f.number)).map(f => f.raw)));
}
