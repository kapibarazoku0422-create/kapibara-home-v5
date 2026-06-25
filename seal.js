/*!
 * カピバラproxy — URL封印（AES-256-GCM, サーバ鍵のみ）
 * Copyright (c) 2026 kapibarazoku0422. All Rights Reserved.
 * Proprietary and confidential. See LICENSE. Watermark: KPBR-9f3a2c7e
 */
import crypto from 'node:crypto';

// PROXY_SECRET から32byte鍵を導出（サーバ内に留まる。ブラウザには渡さない）
const SECRET = process.env.PROXY_SECRET || 'dev-insecure-key';
const KEY = crypto.scryptSync(SECRET, 'kapibara-seal-salt-v1', 32);

// 決定的IV: 同じURL→同じトークン（キャッシュ可能）。鍵が無ければ生成不能。
function ivFor(url) {
  return crypto.createHash('sha256').update(KEY).update(url, 'utf8').digest().subarray(0, 12);
}

// 平文URL -> 封印トークン（base64url）。token = iv(12) | tag(16) | ciphertext
export function seal(url) {
  const iv = ivFor(url);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(url, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64url');
}

// 封印トークン -> 平文URL。改ざん・偽造は復号失敗で例外（=サーバ発行物のみ通る）
export function unseal(token) {
  const buf = Buffer.from(token, 'base64url');
  if (buf.length < 28) throw new Error('bad token');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
