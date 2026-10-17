/**
 * 管理员粘贴的条目引用：网站条目链接（#offer-<ID>、#admin-offer-<ID>）、Agent 接口链接（/api/agent/offers/<ID>）、
 * “[2r48]” 形式的短码，或直接的短码 / 完整 ID。返回其中的短码或 ID，交给服务端查找；认不出就原样返回。
 */
export function offerRefFromInput(input: string): string {
  const value = input.trim().replace(/^\[([a-z0-9]{4})\]$/i, '$1');
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    const hash = /^#(?:admin-)?offer-(.+)$/.exec(url.hash)?.[1];
    if (hash) return decodeURIComponent(hash);
    const path = /\/offers\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    if (path) return decodeURIComponent(path);
  } catch { /* 不是合法网址时按原样查找 */ }
  return value;
}
