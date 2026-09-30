// Writes osqa.env for a new server: the settings with their defaults, and a phone-notification
// (VAPID) key pair made on this machine. Leaves an existing osqa.env alone.
//   npm run server:setup -- https://osqa.company.internal
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../osqa.env', import.meta.url));
if (fs.existsSync(file)) {
  console.log('osqa.env already exists — left as it is.');
  process.exit(0);
}
const site = process.argv[2] || 'https://osqa.example.internal';
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
const example = fs.readFileSync(new URL('../osqa.env.example', import.meta.url), 'utf8')
  .replace(/^VAPID_SUBJECT=.*$/m, `VAPID_SUBJECT=${site}`)
  .replace(/^VAPID_PUBLIC_KEY=.*$/m, `VAPID_PUBLIC_KEY=${publicKey}`)
  .replace(/^VAPID_PRIVATE_JWK=.*$/m, `VAPID_PRIVATE_JWK='${JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d })}'`);
fs.writeFileSync(file, example, { mode: 0o600 });
console.log(`Wrote osqa.env (readable by this user only). Site address: ${site}`);
