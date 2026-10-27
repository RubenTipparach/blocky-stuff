// Signed tokens: base64url(JSON payload).base64url(HMAC-SHA256). The session token a signed-in player
// carries, and the OAuth state that remembers where to send them back. Stateless: the server keeps no
// session table, and a changed secret (SESSION_SECRET, or the one the server keeps in its database)
// signs everyone out.

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const b64 = (buf) => Buffer.from(buf).toString('base64url');

export function sign(payload, secret) {
  const body = b64(JSON.stringify(payload));
  const mac = b64(createHmac('sha256', secret).update(body).digest());
  return `${body}.${mac}`;
}

// The payload, or null if the token is forged, malformed or past its `exp` (seconds since 1970). A token
// with no `exp` never runs out: a link lasts until Unlink (owner, 2026-10-22: "There should be no expiration").
export function verify(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const want = createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(mac ?? '', 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp !== undefined && (typeof payload.exp !== 'number' || payload.exp * 1000 < now)) return null;
    return payload;
  } catch {
    return null;
  }
}

export const nonce = () => randomBytes(12).toString('base64url');
