// ヘッダ/Cookie の正規化ロジック（ブラウザらしい振る舞い + サイト別Cookie分離）
import { decodeProxyUrl, PREFIX } from './rewrite.js';

// --- Accept-Encoding: クライアントを尊重しつつ復号可能なものに限定 -------
const DECODABLE = ['gzip', 'deflate', 'br'];
export function safeAcceptEncoding(clientAE) {
  if (!clientAE) return 'gzip, deflate, br';
  const parts = clientAE.split(',')
    .map(s => s.trim().split(';')[0].toLowerCase())
    .filter(x => DECODABLE.includes(x)); // zstd等の復号不能なものは落とす
  return parts.length ? parts.join(', ') : 'gzip, deflate, br';
}

// --- Referer / Origin: 元サイト基準に復元 -------------------------------
// クライアントが送る Referer/Origin はプロキシ自身のURL。元サイト基準に直す。
export function deriveRefererOrigin(headers, targetUrl) {
  const out = {};
  const r = headers['referer'];
  if (r) {
    const i = r.indexOf(PREFIX);
    if (i !== -1) {
      try { out.referer = decodeProxyUrl(r.slice(i + PREFIX.length)); } catch {}
    }
  }
  // Origin はクライアントが送ってきた時だけ付ける（CORS/POST等）
  if (headers['origin'] !== undefined) {
    out.origin = out.referer ? new URL(out.referer).origin : targetUrl.origin;
  }
  return out;
}

// --- Cookie のサイト別名前空間化 ---------------------------------------
// 複数サイトを同一プロキシ origin で扱うとCookieが混線するため、
// Cookie名を「サイト固有プレフィックス」で名前空間化する。
function hostKey(host) {
  return 'cp_' + Buffer.from(host, 'utf8').toString('base64url') + '_';
}

// 上流の Set-Cookie をプロキシ用に書き換え（名前にプレフィックス付与、属性正規化）
export function namespaceSetCookies(setCookies, host) {
  const pfx = hostKey(host);
  const arr = Array.isArray(setCookies) ? setCookies : [setCookies];
  return arr.map(c => {
    const eq = c.indexOf('=');
    if (eq === -1) return c;
    const name = c.slice(0, eq).trim();
    const rest = c.slice(eq); // "=value; Path=...; ..."
    let out = pfx + name + rest;
    // ドメイン/SameSite/Secure を外し、Path=/ に統一（プロキシ配下で確実に届く）
    out = out.replace(/;\s*domain=[^;]+/ig, '')
             .replace(/;\s*samesite=[^;]+/ig, '')
             .replace(/;\s*secure/ig, '')
             .replace(/;\s*path=[^;]+/ig, '');
    out += '; Path=/; SameSite=Lax';
    return out;
  });
}

// クライアントからの Cookie のうち、この対象ホスト宛のものだけを抽出して
// プレフィックスを外し、上流へ送る Cookie ヘッダを組み立てる。
export function upstreamCookie(cookieHeader, host) {
  if (!cookieHeader) return null;
  const pfx = hostKey(host);
  const out = [];
  for (const part of cookieHeader.split(';')) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    const name = eq === -1 ? s : s.slice(0, eq);
    if (name.startsWith(pfx)) {
      const realName = name.slice(pfx.length);
      out.push(eq === -1 ? realName : realName + s.slice(eq));
    }
  }
  return out.length ? out.join('; ') : null;
}
