import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
// OWASP's recommended scrypt work factors.
const PARAMS = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const KEY_LENGTH = 64;

export const MIN_PASSWORD_LENGTH = 10;

/** Stored as scrypt$N$r$p$salt$hash so the work factors can be raised later. */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw Object.assign(new Error(`密码至少 ${MIN_PASSWORD_LENGTH} 位`), { code: 'PASSWORD_TOO_SHORT', status: 400 });
  }
  const salt = randomBytes(16);
  const key = await derive(password.normalize('NFKC'), salt, KEY_LENGTH, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !hash || typeof password !== 'string') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
