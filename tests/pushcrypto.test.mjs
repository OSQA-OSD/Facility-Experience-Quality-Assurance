// Checks push.js three independent ways: the RFC 8291 worked example, a round trip decrypted by
// Node's own crypto (a different implementation), and the VAPID signature verified by Node.
import { fileURLToPath } from 'node:url';
import nodeCrypto from 'node:crypto';
const REPO = process.env.REPO || fileURLToPath(new URL('..', import.meta.url));
const { encryptForDevice, vapidAuthorization, b64url, pushEndpointAllowed } = await import(REPO + '/push.js');
let pass = 0, bad = 0;
const ok = (c, l, x = '') => { c ? pass++ : bad++; console.log((c ? '  ✓ ' : '  ✗ ') + l + (x ? '  ' + x : '')); };
const B = (s) => Buffer.from(b64url.decode(s));

console.log('RFC 8291 §5 worked example');
const as_priv = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
const as_pub = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const ua_pub = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const auth = 'BTBZMqHH6r4Tts7J_aSIgg';
const salt = 'DGv6ra1nlYgDCS1FRnbzlw';
const expected = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';
const pub = b64url.decode(as_pub);
const jwk = { kty: 'EC', crv: 'P-256', d: as_priv, x: b64url.encode(pub.slice(1, 33)), y: b64url.encode(pub.slice(33, 65)) };
const sender = {
  privateKey: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
  publicKey: await crypto.subtle.importKey('raw', pub, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
};
const out = await encryptForDevice('When I grow up, I want to be a watermelon', ua_pub, auth, { sender, salt: b64url.decode(salt) });
ok(b64url.encode(out) === expected, 'byte-for-byte the RFC’s encrypted message', b64url.encode(out) === expected ? '' : b64url.encode(out).slice(0, 60));

console.log('Round trip, decrypted by Node’s crypto');
const ua = nodeCrypto.createECDH('prime256v1'); ua.generateKeys();
const uaAuth = nodeCrypto.randomBytes(16);
const msg = JSON.stringify({ title: 'New report to review: BLDG #137', body: 'Ali submitted BOQI 2026-Q3 · score 82/100', url: '/app#pg-library/123' });
const box = Buffer.from(await encryptForDevice(msg, b64url.encode(ua.getPublicKey()), b64url.encode(uaAuth)));
const s = box.subarray(0, 16), rs = box.readUInt32BE(16), idlen = box[20], asPublic = box.subarray(21, 21 + idlen), sealed = box.subarray(21 + idlen);
const shared = ua.computeSecret(asPublic);
const ikm = Buffer.from(nodeCrypto.hkdfSync('sha256', shared, uaAuth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32));
const cek = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, s, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
const nonce = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, s, Buffer.from('Content-Encoding: nonce\0'), 12));
const d = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce);
d.setAuthTag(sealed.subarray(sealed.length - 16));
const plain = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
ok(rs === 4096 && idlen === 65, 'header: record size 4096, 65-byte sender key');
ok(plain[plain.length - 1] === 2 && plain.subarray(0, -1).toString() === msg, 'the device reads exactly what was sent');

console.log('VAPID token');
const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pj = privateKey.export({ format: 'jwk' });
const rawPub = b64url.encode(Buffer.concat([Buffer.from([4]), B(pj.x), B(pj.y)]));
const header = await vapidAuthorization('https://web.push.apple.com/QGuQyavXutnMH', { publicKey: rawPub, privateJwk: JSON.stringify(pj), subject: 'https://example.test' });
const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
const claims = JSON.parse(Buffer.from(b64url.decode(m[2])).toString());
const verified = nodeCrypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, B(m[3]));
ok(verified, 'signature verifies with the public key');
ok(claims.aud === 'https://web.push.apple.com' && claims.sub === 'https://example.test' && claims.exp > Date.now() / 1000 + 11 * 3600, 'audience is the push service; expires in 12 hours', JSON.stringify(claims));
ok(m[4] === rawPub, 'carries the public key');

console.log('Only real push services');
ok(pushEndpointAllowed('https://web.push.apple.com/abc') && pushEndpointAllowed('https://fcm.googleapis.com/fcm/send/x'), 'Apple and Google accepted');
ok(!pushEndpointAllowed('https://evil.example/x') && !pushEndpointAllowed('http://web.push.apple.com/x') && !pushEndpointAllowed('http://localhost:9999/x'), 'anything else refused (and localhost unless testing)');
console.log(`\n${pass} passed, ${bad} failed`);
