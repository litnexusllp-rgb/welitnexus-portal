'use strict';

// Encryption at rest for OAuth tokens, TOTP secrets and private calendar links,
// plus a dependency-free TOTP (RFC 6238) implementation for admin sign-in.

const crypto = require('node:crypto');

function keyMaterial() {
  const explicit = process.env.INTEGRATIONS_KEY;
  if (explicit && explicit.length >= 32) return explicit;
  if (process.env.NODE_ENV === 'production' && explicit) {
    throw new Error('INTEGRATIONS_KEY must be at least 32 characters.');
  }
  // Fallback keeps first deploys working; set INTEGRATIONS_KEY so rotating
  // JWT_SECRET never makes stored tokens unreadable.
  return 'wln-v2:' + (process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me');
}
const key = () => crypto.createHash('sha256').update(keyMaterial()).digest();

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

function decrypt(blob) {
  const [v, iv, tag, data] = String(blob || '').split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unreadable encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

const encryptJson = (obj) => encrypt(JSON.stringify(obj));
const decryptJson = (blob) => JSON.parse(decrypt(blob));

// ---------- TOTP ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = mac[mac.length - 1] & 0xf;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(code).padStart(6, '0');
}

const STEP = 30;
const currentStep = (ms = Date.now()) => Math.floor(ms / 1000 / STEP);

// Returns the matching time step (for replay protection) or null.
function verifyTotp(secret, code, { ms = Date.now(), window = 1, afterStep = 0 } = {}) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = currentStep(ms);
  for (let d = -window; d <= window; d++) {
    const step = now + d;
    if (step <= afterStep) continue;
    const expected = hotp(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return step;
  }
  return null;
}

function otpauthUri(secret, accountName, issuer = 'LIT Nexus Portal') {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomId = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

module.exports = {
  encrypt, decrypt, encryptJson, decryptJson,
  newTotpSecret, hotp, verifyTotp, currentStep, otpauthUri, base32Encode, base32Decode,
  sha256, randomId,
};
