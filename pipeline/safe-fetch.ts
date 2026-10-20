import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';

export class UnsafeTargetError extends Error {}

const isFakeProxyAddress = (address: string) => /^198\.(18|19)\./.test(address);
let trustedFakeDns: Promise<boolean> | undefined;
function usesTrustedMacFakeDns(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return trustedFakeDns ??= Promise.all(['example.com', 'cloudflare.com'].map(host => lookup(host, { all: true })))
    .then(results => results.every(addresses => addresses.length > 0 && addresses.every(item => isFakeProxyAddress(item.address))))
    .catch(() => false);
}

export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      // 192.0.0/24 and 192.0.2/24 are special-use; 192.0/16 is not (github.blog uses 192.0.66.2).
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(ip) === 6) {
    const first = Number.parseInt(ip.split(':')[0], 16);
    return first >= 0x2000 && first <= 0x3fff && !ip.startsWith('2001:db8:');
  }
  return false;
}

export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new UnsafeTargetError('无效的抓取地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new UnsafeTargetError('抓取地址必须是公开 HTTP(S) 网页');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host) || !host.includes('.') || ['localhost', 'local', 'internal', 'lan', 'home.arpa', 'test', 'invalid'].some(suffix => host === suffix || host.endsWith('.' + suffix))) {
    if (!isIP(host) || !isPublicAddress(host)) throw new UnsafeTargetError('不允许抓取本地或私有地址');
  }
  return url;
}

const publicAgent = new Agent({ connect: {
  lookup(hostname, options, callback) {
    Promise.all([lookup(hostname, { all: true, family: options.family }), usesTrustedMacFakeDns()]).then(([addresses, fakeDns]) => {
      if (!addresses.length || addresses.some(item => !isPublicAddress(item.address) && !(fakeDns && isFakeProxyAddress(item.address)))) {
        callback(new UnsafeTargetError('目标域名解析到了私有或保留地址'), '', 0);
        return;
      }
      // Node 26 的 Happy Eyeballs 会以 all:true 调用 lookup，此时回调必须返回地址数组。
      if (options.all) (callback as unknown as (error: Error | null, result: unknown) => void)(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    }).catch(error => callback(error as Error, '', 0));
  },
} });

/** 每一跳重新校验 URL；自定义 DNS lookup 同时将连接固定到已检查的公网 IP。 */
export async function fetchPublic(raw: string, init: RequestInit = {}): Promise<Response> {
  let url = raw;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const checked = assertSafeUrl(url);
    const response = await fetch(checked, { ...init, redirect: 'manual', dispatcher: publicAgent } as RequestInit);
    if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.get('location')) return response;
    if (redirects === 5) throw new UnsafeTargetError('抓取地址重定向次数过多');
    url = new URL(response.headers.get('location')!, checked).toString();
  }
  throw new UnsafeTargetError('抓取地址重定向次数过多');
}
