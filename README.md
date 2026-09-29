# Facility Experience Quality Assurance (OSQA)

Facility inspections for OSD: auditors score buildings on a phone or tablet, officers assign and
review, leaders and analysts read the results. One Cloudflare Worker serves the pages and the API;
the data lives in Cloudflare D1.

## What is where

| Path | What it is |
|---|---|
| `worker.js` | The API, the page gatekeeper (signed-in pages need a session), backups, notifications |
| `auth.js` | Passwords and sessions |
| `push.js` | Phone notifications (Web Push: RFC 8291 encryption, VAPID signing) |
| `index.html`, `login.html` | Landing page and sign-in |
| `app.html` | The signed-in app (markup and styles only) |
| `report.html` | The page printable documents (reports, exports) are written into |
| `heic.html` | The sealed iPhone-photo (HEIC) converter, loaded in a sandboxed frame |
| `js/` | All browser code — no page carries script of its own. `js/app.js` is served to signed-in people only |
| `sw.js` | Service worker for notifications (no caching) |
| `migrations/` | The D1 schema, applied in order |
| `_headers` | Security headers for every page |
| `tests/` | End-to-end security and regression tests (see `tests/README.md`) |

## Run it locally

```bash
npm ci
node tests/dev-keys.mjs                                  # .dev.vars with a local-only notification key
npx wrangler d1 migrations apply facility-qa --local
npm run dev                                              # http://localhost:8787
npm test                                                 # in a second terminal
```

## Deploy

- Merging to `main` deploys automatically (Cloudflare Workers Builds). Branches get preview builds,
  which use the **live** database — treat a preview as production.
- A change that needs a new migration: run `npm run migrate` (applies to the live database) **before**
  merging the code that uses it.
- Bindings (see `wrangler.jsonc`): `DB` (D1), `BACKUPS` (KV), `PHOTOS` (R2, optional — not yet enabled),
  two cron triggers (backups).
- Secrets: `VAPID_PRIVATE_JWK` only, set with `npx wrangler secret put VAPID_PRIVATE_JWK`. It is never
  in the repository; `.dev.vars` is git-ignored.

## Security design, in short

- **Sessions:** a random token, stored only as its SHA-256; cookie `HttpOnly; Secure; SameSite=Strict`;
  8 hours, extended while in use; administrators can sign a person out everywhere.
- **Passwords:** PBKDF2-SHA-256 (WebCrypto, 100,000 iterations × 6 rounds); 8+ characters with upper, lower
  and a symbol; five wrong passwords lock the account for 15 minutes; temporary passwords must be replaced.
- **Access:** every API request is checked on the server against the person's role and permissions;
  the browser's view of permissions only hides buttons.
- **Forged requests:** every change must come from this site (Origin / Sec-Fetch-Site), on top of SameSite cookies.
- **Rate limits:** sign-in per network; per person for changes, submissions, reviews and notifications.
- **Page policy (CSP):** no inline script and no `eval` on any page; CDN files are allowed file by file
  and carry integrity hashes. The HEIC converter, which needs `eval`, runs in a sandboxed frame with an
  origin and policy of its own. Also HSTS, `nosniff`, framing limited to this site, `Referrer-Policy`,
  `Permissions-Policy`, `Cross-Origin-Opener-Policy`; API answers are `no-store` and `Cross-Origin-Resource-Policy`.
- **Uploads:** photos only — JPEG, PNG, WebP or HEIC, checked by their bytes, size-limited, and served back
  with a sandboxing policy.
- **Audit log:** sign-ins and failed sign-ins, lockouts, throttling, account and permission changes,
  report submissions, edits, reviews, deletions and restores, backups and downloads.
- **Backups:** to KV every 10 minutes and nightly, plus D1 Time Travel (30 days).
