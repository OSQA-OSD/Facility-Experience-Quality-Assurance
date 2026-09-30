// Settings for running OSQA on a company server. They come from the environment, or from the file
// osqa.env next to package.json (see osqa.env.example; `npm run server:setup` writes one).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadConfig() {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const envFile = process.env.OSQA_ENV || path.join(repo, 'osqa.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const e = process.env;
  const at = (p) => path.resolve(repo, p);
  return {
    repo,
    envFile: fs.existsSync(envFile) ? envFile : null,
    port: Number(e.PORT || 8080),
    host: e.HOST || '127.0.0.1',
    dataDir: at(e.DATA_DIR || 'data'),
    distDir: at(e.DIST_DIR || 'dist'),
    trustProxy: e.TRUST_PROXY === '1',                    // behind IIS / nginx / a load balancer: read the client address from X-Forwarded-For
    tlsCert: e.TLS_CERT ? at(e.TLS_CERT) : null,          // or let the reverse proxy do HTTPS
    tlsKey: e.TLS_KEY ? at(e.TLS_KEY) : null,
    maxBody: Number(e.MAX_BODY_MB || 20) * 1024 * 1024,
    vars: {
      VAPID_PUBLIC_KEY: e.VAPID_PUBLIC_KEY || '',
      VAPID_PRIVATE_JWK: e.VAPID_PRIVATE_JWK || '',
      VAPID_SUBJECT: e.VAPID_SUBJECT || '',
      PUSH_ALLOW_LOCAL: e.PUSH_ALLOW_LOCAL || '',
    },
  };
}
