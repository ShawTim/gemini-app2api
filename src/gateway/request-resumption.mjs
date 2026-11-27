import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fault } from './state.mjs';

// Bounded RAM replay plus live fan-out. Streaming subscribers receive bytes as
// written; interrupted responses are not retained as successful resumptions.
class SharedResponse extends EventEmitter {
  headers = {}; headersSent = false; writableEnded = false; statusCode = 200;
  chunks = []; bytes = 0; incomplete = false; subscribers = new Set();
  setHeader(name, value) { this.headers[name.toLowerCase()] = String(value); }
  #head(sink) {
    if (sink.started || sink.res.destroyed || !this.headersSent) return;
    sink.res.setHeader('X-Gemini-Request-Resumed', String(sink.resumed));
    sink.res.writeHead(this.statusCode, this.headers); sink.started = true;
  }
  #send(sink, bytes) {
    if (sink.res.destroyed || sink.res.writableEnded) { this.subscribers.delete(sink); return; }
    try {
      this.#head(sink); sink.res.write(bytes);
      // The same explicit response-size bound applies to a slow follower's
      // socket queue. It cannot grow without bound or stall every other caller.
      if (sink.res.writableLength > 8 * 1024 * 1024) { this.subscribers.delete(sink); sink.res.destroy(); }
    } catch { this.subscribers.delete(sink); sink.res.destroy?.(); }
  }
  attach(res, resumed) {
    const sink = { res, resumed, started: false }; this.subscribers.add(sink);
    this.#head(sink);
    if (this.headersSent) for (const bytes of this.chunks) this.#send(sink, bytes);
    if (this.writableEnded && !res.destroyed && !res.writableEnded) { this.#head(sink); res.end(); }
    return () => this.subscribers.delete(sink);
  }
  writeHead(status, headers = {}) {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    this.headersSent = true; for (const sink of this.subscribers) this.#head(sink); return this;
  }
  flushHeaders() { for (const sink of this.subscribers) this.#head(sink); }
  write(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.bytes + bytes.length > 8 * 1024 * 1024) throw fault('RESUMABLE_OUTPUT_LIMIT', 502);
    this.bytes += bytes.length; this.chunks.push(bytes);
    for (const sink of this.subscribers) this.#send(sink, bytes);
    return true;
  }
  writeKeepalive(chunk) {
    if (this.writableEnded || !this.headersSent) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    for (const sink of this.subscribers) this.#send(sink, bytes);
  }
  discard() {
    if (this.subscribers.size && this.headersSent) throw fault('OUTPUT_ALREADY_STARTED', 502);
    this.chunks = []; this.bytes = 0; this.headersSent = false; this.writableEnded = false; this.incomplete = false;
  }
  end(chunk) {
    if (this.writableEnded) return;
    if (chunk !== undefined) this.write(chunk);
    this.writableEnded = true;
    for (const sink of this.subscribers) if (!sink.res.destroyed && !sink.res.writableEnded) { this.#head(sink); sink.res.end(); }
    this.emit('finish');
  }
  snapshot() { return { status: this.statusCode, headers: this.headers, body: Buffer.concat(this.chunks), incomplete: this.incomplete }; }
}
export class RequestResumption {
  #secret = crypto.randomBytes(32);
  #entries = new Map();
  #bodyCounts = new Map();
  #bodyScopes = new WeakMap();
  #bytes = 0;
  #resumed = 0;
  #detached = 0;
  constructor({ maxEntries = 64, maxBytes = 32 * 1024 * 1024, ttlMs = 60000 } = {}) {
    this.maxEntries = maxEntries; this.maxBytes = maxBytes; this.ttlMs = ttlMs;
  }
  #drop(key, entry) {
    if (this.#entries.get(key) !== entry) return;
    clearTimeout(entry.timer); this.#entries.delete(key); this.#bytes -= entry.bytes;
    const count = (this.#bodyCounts.get(entry.bodyKey) ?? 0) - 1;
    if (count > 0) this.#bodyCounts.set(entry.bodyKey, count);
    else this.#bodyCounts.delete(entry.bodyKey);
  }
  // Private request-scoped lazy digest token bound strictly to this registry AND
  // exact `body` object identity. Preserves JSON.stringify equivalence and key order.
  scopeBody(body) {
    const token = Object.freeze({});
    this.#bodyScopes.set(token, { body, digest: null });
    return token;
  }
  #digestOf(body, bodyScope) {
    const rec = bodyScope && typeof bodyScope === 'object' ? this.#bodyScopes.get(bodyScope) : undefined;
    if (rec && Object.is(rec.body, body)) {
      if (rec.digest === null) {
        rec.digest = crypto.createHmac('sha256', this.#secret)
          .update(JSON.stringify(body === undefined ? null : body))
          .digest('hex');
      }
      return rec.digest;
    }
    return crypto.createHmac('sha256', this.#secret)
      .update(JSON.stringify(body === undefined ? null : body))
      .digest('hex');
  }
  #key(owner, sessionId, route, body, bodyScope) {
    return crypto.createHmac('sha256', this.#secret)
      .update(JSON.stringify(['session', owner, sessionId, route, this.#digestOf(body, bodyScope)]))
      .digest('hex');
  }
  #bodyKey(owner, route, body, bodyScope) {
    return crypto.createHmac('sha256', this.#secret)
      .update(JSON.stringify(['body', owner, route, this.#digestOf(body, bodyScope)]))
      .digest('hex');
  }
  get size() { return this.#entries.size; }
  has({ owner, sessionId, route, body, bodyScope }) {
    return this.#entries.has(this.#key(owner, sessionId, route, body, bodyScope));
  }
  hasBodyCandidate({ owner, route, body, bodyScope }) {
    return this.#bodyCounts.has(this.#bodyKey(owner, route, body, bodyScope));
  }
  snapshot() { return { pending: [...this.#entries.values()].filter(e => !e.settled).length,
    retained: this.#entries.size, retainedBytes: this.#bytes, resumed: this.#resumed, detached: this.#detached }; }
  close() { for (const [key, entry] of this.#entries) this.#drop(key, entry); }
  async run({ req, res, owner, sessionId, route, body, bodyScope }, execute) {
    if (req.aborted || res.destroyed) return;
    const rec = bodyScope && typeof bodyScope === 'object' ? this.#bodyScopes.get(bodyScope) : undefined;
    const scope = rec && Object.is(rec.body, body) ? bodyScope : this.scopeBody(body);
    const key = this.#key(owner, sessionId, route, body, scope), streaming = body.stream === true;
    let entry = this.#entries.get(key), resumed = !!entry;
    if (!entry) {
      if (this.#entries.size >= this.maxEntries) throw fault('RESUMABLE_REQUEST_CAPACITY', 503);
      const response = new SharedResponse();
      const bodyKey = this.#bodyKey(owner, route, body, scope);
      entry = { settled: false, attachments: new Set(), bytes: 0, timer: null, promise: null, response, delivered: false, bodyKey };
      this.#entries.set(key, entry);
      this.#bodyCounts.set(bodyKey, (this.#bodyCounts.get(bodyKey) ?? 0) + 1);
      const request = new EventEmitter(); request.headers = { ...req.headers };
      // Run execute's synchronous prefix immediately (e.g. body-budget ownership transfer)
      // before awaiting Promise.race so a same-tick leader disconnect cannot release early.
      entry.promise = (async () => execute(request, response))().then(() => {
        const result = response.snapshot();
        if (this.#entries.get(key) !== entry) return result;
        if (result.status >= 400 || result.incomplete) { this.#drop(key, entry); return result; }
        entry.bytes = result.body.length;
        for (const [otherKey, other] of this.#entries) {
          if (this.#bytes + entry.bytes <= this.maxBytes) break;
          if (other !== entry && other.settled && other.attachments.size === 0) this.#drop(otherKey, other);
        }
        if (this.#bytes + entry.bytes > this.maxBytes) { entry.bytes = 0; throw fault('RESUMABLE_CACHE_LIMIT', 503); }
        this.#bytes += entry.bytes; return result;
      }).catch(error => {
        this.#drop(key, entry); throw error;
      }).finally(() => {
        entry.settled = true;
        if (entry.delivered && entry.attachments.size === 0) this.#drop(key, entry);
        if (this.#entries.get(key) === entry) {
          entry.timer = setTimeout(() => this.#drop(key, entry), this.ttlMs); entry.timer.unref();
        }
      });
      entry.promise.catch(() => {});
    } else this.#resumed++;
    const attachment = Symbol(); entry.attachments.add(attachment);
    let detached, detachOutput = () => {};
    const lost = new Promise(resolve => { detached = resolve; });
    const disconnect = () => {
      if (res.writableEnded) return;
      detachOutput();
      if (entry.attachments.delete(attachment)) this.#detached++;
      detached(null);
    };
    const finish = () => {
      entry.delivered = true; entry.attachments.delete(attachment);
      if (entry.settled && entry.attachments.size === 0) this.#drop(key, entry);
    };
    req.once('aborted', disconnect); res.once('close', disconnect); res.once('finish', finish);
    try {
      if (streaming) detachOutput = entry.response.attach(res, resumed);
      const result = await Promise.race([entry.promise, lost]);
      if (!result || res.destroyed || streaming) return;
      res.setHeader('X-Gemini-Request-Resumed', String(resumed));
      res.writeHead(result.status, result.headers); res.end(result.body);
    } finally {
      req.off('aborted', disconnect); res.off('close', disconnect);
      detachOutput(); entry.attachments.delete(attachment);
    }
  }
}
