import { BlockList, isIP } from 'node:net';
import { protocolError } from './tool-protocol.mjs';

export const MAX_REMOTE_IMAGE_URL_BYTES = 8192;
const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) blocked.addSubnet(address, prefix, 'ipv6');
export function isPublicImageAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
export function parseRemoteImageUrl(value) {
  const fail = () => { throw protocolError('UNSAFE_IMAGE_URL', 400); };
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > MAX_REMOTE_IMAGE_URL_BYTES || value.includes('#') || /[\s\\\x00-\x1f\x7f]/.test(value)) fail();
  let url; try { url = new URL(value); } catch { fail(); }
  if (!['http:', 'https:'].includes(url.protocol) || !/^https?:\/\//i.test(value) || url.username || url.password || url.hash || url.port || !url.hostname) fail();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if ((isIP(host) && !isPublicImageAddress(host)) || host.endsWith('.') || (!host.includes('.') && !isIP(host)) || /(?:^|\.)(?:localhost|local|internal|home|lan|invalid|test|onion)$/.test(host)) fail();
  return url;
}
