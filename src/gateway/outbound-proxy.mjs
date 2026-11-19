/** Zero-dependency outbound HTTP(S) proxy helper for Node HTTP/2 and HTTPS fetch.
 * Respects HTTPS_PROXY / HTTP_PROXY / ALL_PROXY and NO_PROXY without logging proxy credentials.
 */
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import { Duplex, Readable } from 'node:stream';

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

function stripBrackets(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function defaultPort(protocol) {
  return protocol === 'https:' ? '443' : '80';
}

function isBypassed(target, noProxyRaw) {
  if (typeof noProxyRaw !== 'string' || !noProxyRaw.trim()) return false;
  const host = stripBrackets(target.hostname).toLowerCase();
  const port = target.port || defaultPort(target.protocol);
  for (const rawEntry of noProxyRaw.split(',')) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    let entryHost = entry;
    let entryPort = null;
    if (entry.startsWith('[')) {
      const end = entry.indexOf(']');
      if (end < 0) continue;
      entryHost = entry.slice(1, end);
      if (entry[end + 1] === ':') entryPort = entry.slice(end + 2);
    } else {
      const colon = entry.lastIndexOf(':');
      if (colon > 0 && /^\d+$/.test(entry.slice(colon + 1))) {
        entryHost = entry.slice(0, colon);
        entryPort = entry.slice(colon + 1);
      }
    }
    if (entryPort && entryPort !== port) continue;
    const normalized = entryHost.startsWith('.') ? entryHost.slice(1) : entryHost;
    if (!normalized) continue;
    if (host === normalized || host.endsWith('.' + normalized)) return true;
  }
  return false;
}

export function resolveOutboundProxy(targetUrl, env = process.env) {
  if (!env || typeof env !== 'object') return null;
  let target;
  try { target = targetUrl instanceof URL ? targetUrl : new URL(targetUrl); } catch { return null; }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return null;
  if (isBypassed(target, env.NO_PROXY ?? env.no_proxy ?? '')) return null;
  const raw = target.protocol === 'https:'
    ? (env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || '')
    : (env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || '');
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed || /[\r\n\0]/.test(trimmed)) return null;
  let proxy;
  try { proxy = new URL(trimmed); } catch { return null; }
  if ((proxy.protocol !== 'http:' && proxy.protocol !== 'https:') || !proxy.hostname) return null;
  return proxy;
}

function formatAuthority(host, port) {
  const bare = stripBrackets(host);
  return bare.includes(':') ? `[${bare}]:${port}` : `${bare}:${port}`;
}

export function createConnectTunnel(
  proxyUrl,
  targetHost,
  targetPort,
  { timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS, signal, rejectUnauthorized = true, ca } = {},
) {
  const authority = formatAuthority(targetHost, targetPort);
  const headers = { Host: authority };
  if (proxyUrl.username || proxyUrl.password) {
    const user = decodeURIComponent(proxyUrl.username || '');
    const pass = decodeURIComponent(proxyUrl.password || '');
    headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
  }
  let rawSocket = null;
  let connected = false;
  let finished = false;
  let finalCallback = null;
  const pendingWrites = [];

  const failPending = (err) => {
    while (pendingWrites.length) {
      const item = pendingWrites.shift();
      try { item.callback(err); } catch {}
    }
    if (finalCallback) {
      const cb = finalCallback;
      finalCallback = null;
      try { cb(err); } catch {}
    }
  };

  const tunnel = new Duplex({
    read() {
      rawSocket?.resume();
    },
    write(chunk, encoding, callback) {
      if (connected && rawSocket) {
        if (rawSocket.destroyed) { callback(new Error('PROXY_TUNNEL_CLOSED')); return; }
        rawSocket.write(chunk, encoding, callback);
        return;
      }
      pendingWrites.push({ chunk, encoding, callback });
    },
    final(callback) {
      finished = true;
      if (connected && rawSocket) {
        rawSocket.end(callback);
        return;
      }
      finalCallback = callback;
    },
    destroy(err, callback) {
      signal?.removeEventListener('abort', onAbort);
      try { req.destroy(); } catch {}
      try { rawSocket?.destroy(); } catch {}
      failPending(err || new Error('PROXY_TUNNEL_DESTROYED'));
      callback(err);
    },
  });

  const onAbort = () => tunnel.destroy(new Error('PROXY_CONNECT_ABORTED'));
  signal?.addEventListener('abort', onAbort, { once: true });

  const transport = proxyUrl.protocol === 'https:' ? https : http;
  const req = transport.request({
    host: stripBrackets(proxyUrl.hostname),
    port: Number(proxyUrl.port) || Number(defaultPort(proxyUrl.protocol)),
    method: 'CONNECT',
    path: authority,
    headers,
    timeout: timeoutMs,
    ...(proxyUrl.protocol === 'https:' ? { rejectUnauthorized, ...(ca ? { ca } : {}) } : {}),
  });

  req.on('connect', (res, socket, head) => {
    signal?.removeEventListener('abort', onAbort);
    if (tunnel.destroyed) {
      try { socket.destroy(); } catch {}
      return;
    }
    if (res.statusCode !== 200) {
      try { socket.destroy(); } catch {}
      tunnel.destroy(new Error(`PROXY_CONNECT_REJECTED_${res.statusCode || 0}`));
      return;
    }
    rawSocket = socket;
    connected = true;
    try { socket.setKeepAlive?.(true, 15_000); } catch {}
    try { socket.setNoDelay?.(true); } catch {}
    socket.on('data', (chunk) => {
      if (!tunnel.destroyed && !tunnel.push(chunk)) socket.pause();
    });
    socket.on('end', () => {
      if (!tunnel.destroyed) tunnel.push(null);
    });
    socket.on('error', (err) => {
      if (!tunnel.destroyed) tunnel.destroy(err);
    });
    socket.on('close', () => {
      if (!tunnel.destroyed) tunnel.destroy();
    });
    if (head && head.length > 0 && !tunnel.push(head)) socket.pause();
    while (pendingWrites.length) {
      const item = pendingWrites.shift();
      socket.write(item.chunk, item.encoding, item.callback);
    }
    if (finished) {
      const cb = finalCallback;
      finalCallback = null;
      socket.end(cb || undefined);
    }
  });

  req.on('response', (res) => {
    res.resume();
    if (!tunnel.destroyed) tunnel.destroy(new Error(`PROXY_CONNECT_REJECTED_${res.statusCode || 0}`));
  });
  req.on('timeout', () => {
    req.destroy();
    if (!tunnel.destroyed) tunnel.destroy(new Error('PROXY_CONNECT_TIMEOUT'));
  });
  req.on('error', (err) => {
    if (!tunnel.destroyed) tunnel.destroy(err);
  });
  req.end();

  return tunnel;
}

export function connectHttp2(origin, options = {}, { env = process.env } = {}) {
  const proxyUrl = resolveOutboundProxy(origin, env);
  if (!proxyUrl) return http2.connect(origin, options);
  const target = origin instanceof URL ? origin : new URL(origin);
  if (target.protocol !== 'https:') return http2.connect(origin, options);
  const targetHost = stripBrackets(target.hostname);
  const targetPort = Number(target.port) || 443;
  return http2.connect(origin, {
    ...options,
    createConnection: () => {
      const tunnel = createConnectTunnel(proxyUrl, targetHost, targetPort, {
        rejectUnauthorized: options?.proxyRejectUnauthorized ?? true,
        ...(options?.proxyCa ? { ca: options.proxyCa } : {}),
      });
      return tls.connect({
        socket: tunnel,
        servername: net.isIP(targetHost) ? undefined : targetHost,
        ALPNProtocols: ['h2'],
        rejectUnauthorized: options?.rejectUnauthorized ?? true,
        ...(options?.ca ? { ca: options.ca } : {}),
      });
    },
  });
}

function normalizeRequestBody(body) {
  if (body === undefined || body === null) return null;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  return Buffer.from(String(body), 'utf8');
}

function normalizeHeaders(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => { out[key] = value; });
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export async function fetchWithProxy(url, init = {}, { env = process.env, fetchImpl = fetch, tlsOptions = {} } = {}) {
  const proxyUrl = fetchImpl === fetch ? resolveOutboundProxy(url, env) : null;
  if (!proxyUrl) return fetchImpl(url, init);
  const target = url instanceof URL ? url : new URL(url);
  if (target.protocol !== 'https:') return fetchImpl(url, init);
  const targetHost = stripBrackets(target.hostname);
  const targetPort = Number(target.port) || 443;
  const body = normalizeRequestBody(init.body);
  const headers = normalizeHeaders(init.headers);
  if (body && headers['content-length'] === undefined && headers['Content-Length'] === undefined) {
    headers['Content-Length'] = String(body.length);
  }
  if (init.signal?.aborted) throw init.signal.reason || new DOMException('Aborted', 'AbortError');
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      init.signal?.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve(value);
    };
    const tunnel = createConnectTunnel(proxyUrl, targetHost, targetPort, {
      signal: init.signal,
      rejectUnauthorized: tlsOptions.proxyRejectUnauthorized ?? true,
      ...(tlsOptions.proxyCa ? { ca: tlsOptions.proxyCa } : {}),
    });
    const socket = tls.connect({
      socket: tunnel,
      servername: net.isIP(targetHost) ? undefined : targetHost,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: tlsOptions.rejectUnauthorized ?? true,
      ...(tlsOptions.ca ? { ca: tlsOptions.ca } : {}),
    });
    const req = https.request({
      host: targetHost,
      port: targetPort,
      path: target.pathname + target.search,
      method: init.method || 'GET',
      headers,
      agent: false,
      createConnection: () => socket,
    }, (res) => {
      const status = res.statusCode || 502;
      if (init.redirect === 'error' && status >= 300 && status < 400 && res.headers.location) {
        res.destroy();
        done(new TypeError('Unexpected redirect'));
        return;
      }
      const responseHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) for (const item of v) responseHeaders.append(k, item);
        else responseHeaders.set(k, String(v));
      }
      const webBody = status === 204 || status === 304 || init.method === 'HEAD' ? null : Readable.toWeb(res);
      done(null, new Response(webBody, { status, headers: responseHeaders }));
    });
    const onAbort = () => {
      req.destroy();
      socket.destroy();
      tunnel.destroy();
      done(init.signal?.reason || new DOMException('Aborted', 'AbortError'));
    };
    init.signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (err) => {
      socket.destroy();
      tunnel.destroy();
      done(err);
    });
    if (body) req.write(body);
    req.end();
  });
}
