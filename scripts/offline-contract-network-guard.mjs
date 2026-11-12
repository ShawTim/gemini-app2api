// Defense in depth for the reviewed fixed-list Node probes, not an OS sandbox
// for untrusted test code. No external TCP/fetch or UDP paths are allowed.
import net from 'node:net';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
let denied = 0;
const reject = () => { denied++; throw Object.assign(Error('OFFLINE_NETWORK_DENIED'), { code: 'OFFLINE_NETWORK_DENIED' }); };
const local = host => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host).toLowerCase());
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  let options = args[0];
  if (Array.isArray(options)) options = options[0];
  const host = typeof options === 'object' && options !== null ? options.host ?? 'localhost' : typeof args[1] === 'string' ? args[1] : 'localhost';
  const port = typeof options === 'object' && options !== null ? options.port : options;
  if (!local(host) || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) return reject();
  return connect.apply(this, args);
};
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['http:', 'https:'].includes(url.protocol) || !local(url.hostname)) return reject();
  return fetchOriginal(input, init);
};
dgram.createSocket = reject;
syncBuiltinESMExports();
process.on('exit', () => {
  if (denied) { console.error(`OFFLINE_NETWORK_DENIED: ${denied} blocked attempt(s)`); process.exitCode = 1; }
});
