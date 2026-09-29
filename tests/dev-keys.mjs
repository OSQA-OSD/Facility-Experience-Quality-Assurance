// Writes .dev.vars for local development and tests: a phone-notification (VAPID) key pair made
// here, for this machine only — never the live site's key — and permission to deliver
// notifications to the stand-in push services the tests run on localhost.
// Leaves an existing .dev.vars alone.
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../.dev.vars', import.meta.url));
if (existsSync(file)) {
  console.log('.dev.vars already exists — left as it is.');
  process.exit(0);
}
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
writeFileSync(file, [
  '# Local development only (git ignores this file). Made by tests/dev-keys.mjs.',
  `VAPID_PUBLIC_KEY=${publicKey}`,
  `VAPID_PRIVATE_JWK=${JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d })}`,
  'PUSH_ALLOW_LOCAL=1',
  '',
].join('\n'), { mode: 0o600 });
console.log('Wrote .dev.vars with a local-only notification key.');
