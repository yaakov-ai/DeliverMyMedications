// Two-factor authentication helpers.
// Authenticator apps use TOTP (RFC 6238, SHA-1, 6 digits, 30-second steps) — the format Google Authenticator,
// Authy and 1Password expect. Text codes and recovery codes are one-time and hashed before they are stored.
import { sha256, timingSafeEqual } from "./lib.js";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function randomSecret(bytes = 20) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let bits = "", out = "";
  for (const x of b) bits += x.toString(2).padStart(8, "0");
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
function b32decode(s) {
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const v = B32.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, "0");
  }
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}
async function hotp(secret, counter) {
  const key = await crypto.subtle.importKey("raw", b32decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const buf = new ArrayBuffer(8), view = new DataView(buf);
  view.setUint32(4, counter);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const off = mac[19] & 0xf;
  const num = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(num % 1_000_000).padStart(6, "0");
}
// One step of drift either way, so a slightly slow phone clock still works.
export async function verifyTotp(secret, code) {
  const c = String(code || "").replace(/\D/g, "");
  if (c.length !== 6 || !secret) return false;
  const step = Math.floor(Date.now() / 30000);
  for (const s of [step - 1, step, step + 1]) if (timingSafeEqual(await hotp(secret, s), c)) return true;
  return false;
}
export const otpauthUrl = (secret, email, issuer = "DeliverMyMedications") =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

export const sixDigit = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");

// Recovery codes: shown once at setup, stored only as hashes, each usable once.
export async function makeRecoveryCodes(n = 8) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const raw = [...crypto.getRandomValues(new Uint8Array(5))].map(b => b.toString(36).padStart(2, "0")).join("").slice(0, 10).toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return { codes, hashes: await Promise.all(codes.map(c => sha256(c))) };
}
export async function useRecoveryCode(hashes, code) {
  const h = await sha256(String(code || "").trim().toUpperCase());
  const i = (hashes || []).indexOf(h);
  if (i < 0) return null;
  const left = hashes.slice(); left.splice(i, 1);
  return left;
}
