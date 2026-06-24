// ヘッダ/Cookie の正規化ロジック（ブラウザらしい振る舞い + サイト別Cookie分離）
import dns from 'node:dns/promises';
import netmod from 'node:net';
import { decodeProxyUrl, PREFIX } from './rewrite.js';

// --- SSRF対策: プライベート/ループバック/リンクローカル宛を拒否 -----------
function ipToInt(ip) {
  return ip.split('.').reduce((a, o) => (a << 8) + (parseInt(o, 10) & 255), 0) >>> 0;
}
function isPrivateV4(ip) {
  const n = ipToInt(ip);
  const inR = (base, bits) => (n >>> (32 - bits)) === (ipToInt(base) >>> (32 - bits));
  return inR('10.0.0.0', 8) || inR('172.16.0.0', 12) || inR('192.168.0.0', 16) ||
         inR('127.0.0.0', 8) || inR('169.254.0.0', 16) || inR('0.0.0.0', 8) ||
         inR('100.64.0.0', 10) || inR('192.0.0.0', 24) || inR('255.255.255.255', 32);
}
function isPrivateV6(ip) {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (a === '::1' || a === '::') return true;
  if (a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd')) return true; // link-local / ULA
  // IPv4-mapped (::ffff:a.b.c.d)
  const m = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return isPrivateV4(m[1]);
  return false;
}
function isBlockedIP(ip) {
  const t = netmod.isIP(ip);
  if (t === 4) return isPrivateV4(ip);
  if (t === 6) return isPrivateV6(ip);
  return true; // 判定不能は拒否
}

// 対象ホストが公開アドレスに解決できるか検証（DNSリバインディングも遮断）
export async function assertPublicHost(host) {
  // ホストがIPリテラルならそのまま判定
  if (netmod.isIP(host)) {
    if (isBlockedIP(host)) throw new Error('blocked address');
    return;
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch { throw new Error('dns resolution failed'); }
  if (!addrs.length) throw new Error('no address');
  for (const { address } of addrs) {
    if (isBlockedIP(address)) throw new Error('blocked address');
  }
}

// --- 文字コード判定とデコード（Shift_JIS/EUC-JP等の日本語サイト対応） -------
export function decodeBody(buf, ctype) {
  let cs = (/charset=["']?\s*([\w-]+)/i.exec(ctype || '') || [])[1];
  if (!cs) {
    // 先頭2KBを latin1 として覗き、metaタグの charset を拾う
    const head = buf.subarray(0, 2048).toString('latin1');
    const m = /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(head) ||
              /charset=["']?\s*([\w-]+)/i.exec(head);
    if (m) cs = m[1];
  }
  cs = (cs || 'utf-8').trim().toLowerCase();
  if (cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii' || cs === 'ascii') {
    return buf.toString('utf-8');
  }
  try { return new TextDecoder(cs).decode(buf); }
  catch { return buf.toString('utf-8'); }
}

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
