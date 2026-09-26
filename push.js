/* Phone and desktop notifications (Web Push).
 *
 * A device that turned notifications on gave us an address at its push service (Apple, Google,
 * Mozilla or Microsoft) and two keys. A message is encrypted for that device alone (RFC 8291,
 * "aes128gcm") and posted to the address with a signed token that proves it came from this site
 * (VAPID, RFC 8292). The push service cannot read it; only the device can.
 */

const enc = new TextEncoder();

export const b64url = {
  encode(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let bin = '';
    for (let i = 0; i < b.length; i += 1) bin += String.fromCharCode(b[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(text) {
    let s = String(text).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  },
};

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** The message body for one device. `sender` and `salt` are only given by tests (RFC 8291 §5). */
export async function encryptForDevice(plaintext, deviceKeyB64, authB64, { sender = null, salt = null } = {}) {
  const uaPublic = b64url.decode(deviceKeyB64);
  const auth = b64url.decode(authB64);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || auth.length !== 16) throw new Error('the device keys are not valid');
  const keys = sender || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, keys.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const s = salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(s, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(s, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const body = typeof plaintext === 'string' ? enc.encode(plaintext) : plaintext;
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(body, new Uint8Array([2]))));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(s, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, sealed);
}

/** The signed token that tells the push service this site sent the message (valid 12 hours). */
const tokens = new Map();                                   // per isolate: push service → token
export async function vapidAuthorization(endpoint, { publicKey, privateJwk, subject }) {
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const hit = tokens.get(aud);
  if (hit && hit.exp - now > 3600) return hit.value;
  const exp = now + 12 * 3600;
  const head = b64url.encode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url.encode(enc.encode(JSON.stringify({ aud, exp, sub: subject })));
  const jwk = typeof privateJwk === 'string' ? JSON.parse(privateJwk) : privateJwk;
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`)));
  const value = `vapid t=${head}.${claims}.${b64url.encode(sig)}, k=${publicKey}`;
  tokens.set(aud, { exp, value });
  return value;
}

/** Only the real push services are ever sent to — never an address someone typed in. */
const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
export function pushEndpointAllowed(endpoint, { allowLocal = false } = {}) {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (allowLocal && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
  return u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname));
}

/** Sends one message to one device. Returns the push service's status (201 = accepted; 404 and
 *  410 = the device turned notifications off, so its address can be forgotten). */
export async function sendPush(subscription, message, vapid, { ttl = 86400, urgency = 'high' } = {}) {
  const body = await encryptForDevice(JSON.stringify(message), subscription.p256dh, subscription.auth);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
      Authorization: await vapidAuthorization(subscription.endpoint, vapid),
    },
    body,
  });
  return res.status;
}
