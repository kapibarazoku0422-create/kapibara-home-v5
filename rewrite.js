// URL書き換えロジック
export const PREFIX = '/p/';

// 絶対URL -> プロキシURL（Base64url難読化）
export function encodeProxyUrl(absUrl) {
  return PREFIX + Buffer.from(absUrl, 'utf8').toString('base64url');
}

// プロキシのパスセグメント -> 元の絶対URL
export function decodeProxyUrl(seg) {
  // クエリやハッシュが付いていても落とす（基本付かない想定）
  const clean = seg.replace(/[?#].*$/, '');
  return Buffer.from(clean, 'base64url').toString('utf8');
}

// 相対/絶対URLを base で解決し、プロキシ経由URLに変換
function toProxy(u, base) {
  if (!u) return u;
  const s = u.trim();
  if (s === '' ) return u;
  // 書き換え不要なスキーム
  if (/^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i.test(s)) return u;
  if (s.startsWith(PREFIX)) return u; // 二重変換防止
  try {
    const abs = new URL(s, base).href;
    return encodeProxyUrl(abs);
  } catch {
    return u;
  }
}

// srcset (a.jpg 1x, b.jpg 2x) を変換
function rewriteSrcset(val, base) {
  return val.split(',').map(part => {
    const m = part.trim().match(/^(\S+)(\s+.+)?$/);
    if (!m) return part;
    return toProxy(m[1], base) + (m[2] || '');
  }).join(', ');
}

const URL_ATTRS = ['href', 'src', 'poster', 'action', 'formaction', 'data-src', 'data-href', 'background'];

export function rewriteHtml(html, base) {
  // CSP / SRI を無効化
  html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/ig, '');
  html = html.replace(/\sintegrity=(["'])[^"']*\1/ig, '');
  html = html.replace(/\snonce=(["'])[^"']*\1/ig, '');

  // 各URL属性
  for (const attr of URL_ATTRS) {
    const re = new RegExp(`(<[^>]+\\b${attr}\\s*=\\s*)(["'])(.*?)\\2`, 'ig');
    html = html.replace(re, (m, pre, q, val) => pre + q + toProxy(val, base) + q);
  }

  // srcset
  html = html.replace(/(<[^>]+\bsrcset\s*=\s*)(["'])(.*?)\2/ig,
    (m, pre, q, val) => pre + q + rewriteSrcset(val, base) + q);

  // meta refresh
  html = html.replace(/(<meta[^>]+content\s*=\s*)(["'])(\s*\d+\s*;\s*url=)([^"']+)\2/ig,
    (m, pre, q, head, u) => pre + q + head + toProxy(u, base) + q);

  // インラインstyle属性
  html = html.replace(/(\bstyle\s*=\s*)(["'])(.*?)\2/ig,
    (m, pre, q, val) => pre + q + rewriteCss(val, base) + q);

  // <style>ブロック
  html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/ig,
    (m, open, css, close) => open + rewriteCss(css, base) + close);

  // クライアント傍受スクリプトを注入
  const inject = `<script src="/__proxy__/client.js" data-base="${base}"></script>`;
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, m => m + inject);
  } else if (/<html[^>]*>/i.test(html)) {
    html = html.replace(/<html[^>]*>/i, m => m + inject);
  } else {
    html = inject + html;
  }
  return html;
}

export function rewriteCss(css, base) {
  // url(...) と @import "..."
  css = css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/ig,
    (m, q, u) => `url(${q}${toProxy(u, base)}${q})`);
  css = css.replace(/@import\s+(["'])([^"']+)\1/ig,
    (m, q, u) => `@import ${q}${toProxy(u, base)}${q}`);
  return css;
}
