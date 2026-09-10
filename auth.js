/**
 * Authentication: password hashing, sessions, cookies.
 *
 * Password hashing is chained PBKDF2-SHA256: the Workers runtime caps a single
 * PBKDF2 call at 100,000 iterations, so strength comes from feeding each
 * round's output into the next (ROUNDS x ITERATIONS effective iterations)
 * rather than raising the per-call count.
 */

const ITERATIONS = 100_000;
const ROUNDS = 6;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

export const SESSION_COOKIE = 'qa_session';

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

async function derive(secret, saltBytes, iterations, rounds) {
  let block = secret;
  for (let round = 0; round < rounds; round += 1) {
    const key = await crypto.subtle.importKey('raw', block, 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
      key,
      256,
    );
    block = new Uint8Array(bits);
  }
  return bytesToBase64(block);
}

function constantTimeEquals(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hashPassword(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(new TextEncoder().encode(password), saltBytes, ITERATIONS, ROUNDS);
  return { hash, salt: bytesToBase64(saltBytes), iterations: ITERATIONS, rounds: ROUNDS };
}

export async function verifyPassword(password, stored) {
  const saltBytes = base64ToBytes(stored.password_salt);
  const derived = await derive(
    new TextEncoder().encode(password),
    saltBytes,
    stored.password_iterations,
    stored.password_rounds,
  );
  return constantTimeEquals(derived, stored.password_hash);
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function createSession(env, userId) {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await env.DB.prepare(
    'INSERT INTO qa_sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)',
  ).bind(tokenHash, userId, expiresAt).run();
  return { token, expiresAt };
}

export async function destroySession(env, token) {
  if (!token) return;
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare('DELETE FROM qa_sessions WHERE token_hash = ?1').bind(tokenHash).run();
}

export async function getUserFromRequest(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const session = await env.DB.prepare(
    'SELECT user_id, expires_at FROM qa_sessions WHERE token_hash = ?1',
  ).bind(tokenHash).first();
  if (!session || session.expires_at < Date.now()) return null;
  const user = await env.DB.prepare(
    'SELECT id, name, username, role FROM qa_users WHERE id = ?1',
  ).bind(session.user_id).first();
  return user || null;
}

export function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const match = header.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[1]) : null;
}

export function sessionCookieHeader(token, expiresAt) {
  const expires = new Date(expiresAt).toUTCString();
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Expires=${expires}`;
}

export function clearCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function isLocked(user) {
  return !!user.locked_until && user.locked_until > Date.now();
}

export async function registerFailedAttempt(env, user) {
  const attempts = (user.failed_attempts || 0) + 1;
  const lockedUntil = attempts >= MAX_FAILED_ATTEMPTS ? Date.now() + LOCKOUT_MS : null;
  await env.DB.prepare(
    'UPDATE qa_users SET failed_attempts = ?2, locked_until = ?3, updated_at = datetime(\'now\') WHERE id = ?1',
  ).bind(user.id, attempts, lockedUntil).run();
}

export async function clearFailedAttempts(env, userId) {
  await env.DB.prepare(
    'UPDATE qa_users SET failed_attempts = 0, locked_until = NULL, updated_at = datetime(\'now\') WHERE id = ?1',
  ).bind(userId).run();
}
