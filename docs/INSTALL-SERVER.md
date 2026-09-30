# Running OSQA on a company server

OSQA is piloted on Cloudflare. The same code runs on an ordinary server with Node.js:
`server/node.mjs` hosts the unchanged `worker.js` and replaces the three Cloudflare services it uses.

| On Cloudflare | On the company server |
|---|---|
| D1 database (SQLite) | `data/osqa.sqlite` — SQLite through Node's built-in `node:sqlite`; same schema, same migrations |
| KV — the automatic backups | `data/backups/` — the same copies, as files |
| Static assets + `_headers` | `dist/`, served with the same security headers |
| Cron triggers | Timers: changes backed up every 10 minutes, a full copy at 23:30 UTC |
| Workers Builds (deploys) | Your own release process (copy the code, build, restart) |
| Edge TLS / firewall | Your reverse proxy, certificate and firewall |

No npm packages are needed at run time: only Node.js.

## Requirements

- **Node.js 22.13 or newer** (24 LTS recommended), on Windows Server or Linux.
- **HTTPS** with the company certificate — either a reverse proxy (IIS with ARR, nginx, a load balancer) or the
  server itself (`TLS_CERT` / `TLS_KEY`). Browsers only keep the sign-in cookie over HTTPS.
- An internal **DNS name**, e.g. `osqa.company.internal`.
- **Assessors' phones and tablets must reach that name** on site (company Wi-Fi, VPN or MDM).
- Optional: **outbound HTTPS** from the server to the Apple, Google, Mozilla and Microsoft push services, for
  phone notifications. Without it, notifications still appear inside OSQA.
- Disk: the database grows by roughly 0.25 MB per photo; plan for the backups folder of the same size.

## Install

```bash
git clone https://github.com/OSQA-OSD/Facility-Experience-Quality-Assurance.git osqa
cd osqa
node scripts/build.mjs                                      # builds dist/
node server/setup.mjs https://osqa.company.internal          # writes osqa.env with a new notification key pair
```

Check `osqa.env` (the settings are explained inside), then start it:

```bash
node server/node.mjs
```

On first start it creates `data/osqa.sqlite` and applies every migration. `GET /api/health` answers
`{"ok":true}`.

### Bring the pilot's data across (once)

1. On the pilot site, as an administrator: **Admin Control › Backup & Archive** — download **Data** and **Photos**.
2. On the new server, before anyone uses it:

```bash
node server/import.mjs facility-qa-data-2026-10-01.sql facility-qa-photos-2026-10-01.sql
```

It refuses a database that already has accounts or reports. Accounts keep their passwords; everyone
signs in again (sessions are not copied). The first automatic backups then copy everything.

With Cloudflare access, `npx wrangler d1 export facility-qa --remote --output osqa.sql` is an alternative source.

### Run it as a service

Linux (systemd), `/etc/systemd/system/osqa.service`:

```ini
[Unit]
Description=OSQA
After=network.target

[Service]
WorkingDirectory=/opt/osqa
ExecStart=/usr/bin/node server/node.mjs
User=osqa
Restart=always

[Install]
WantedBy=multi-user.target
```

Windows: run `node server\node.mjs` from the install folder as a service with your standard tool
(e.g. NSSM, or a scheduled task at start-up), under an account that can write to `data\`.

### Reverse proxy

Keep `HOST=127.0.0.1` and `TRUST_PROXY=1`, and have the proxy pass the client address and scheme.

nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;
  client_max_body_size 20m;
}
```

IIS: Application Request Routing + URL Rewrite to `http://127.0.0.1:8080`, set the server variables
`HTTP_X_FORWARDED_FOR` and `HTTP_X_FORWARDED_PROTO`, and allow request bodies of 20 MB
(`maxAllowedContentLength`).

Set `TRUST_PROXY=1` only with a proxy in front: it makes the server believe the address in
`X-Forwarded-For`, which the sign-in limits and the audit log use.

## Backups and restore

- **Include `data/` in the server's backups.** `data/osqa.sqlite` is the database; `data/backups/` holds OSQA's own
  second copy (changes every 10 minutes, a full copy every night, 30 days plus the first of each month).
- For a consistent copy while running: `node server/export.mjs <folder>` writes the same Data and Photos files
  as the admin download (read-only, safe at any time) — schedule it nightly.
- Restore: stop the service, move `data/` aside, run `node server/import.mjs <data.sql> <photos.sql>` (it creates a
  new database and loads the copy), then start the service again.
- OSQA keeps every saved version of every report and an archive of deleted reports inside the database, so most
  "undo" needs no restore at all.

## Updating

```bash
git pull            # or copy the new release over the folder, keeping data/ and osqa.env
node scripts/build.mjs
# restart the service — new migrations are applied automatically at start
```

## Security notes

- The application enforces its own security (sessions, passwords, lockout, permissions, rate limits, page policy,
  audit log); see the main README. The proxy and firewall are an additional layer.
- `osqa.env` holds the notification private key: readable by the service account only.
- Logs go to standard output: one line per request (time, method, path without query, status, duration) — no
  cookies or bodies.
- Single sign-on (company accounts) is not part of this release; OSQA has its own accounts. It can be added
  in `auth.js` once the identity provider (e.g. Entra ID / ADFS) and its settings are known.

## Testing an installation

On a **test** instance (never production — the tests create and delete data), started with `PORT=8787` and
`PUSH_ALLOW_LOCAL=1`:

```bash
OSQA_DB=data/osqa.sqlite bash tests/run.sh
```

See `tests/README.md`. The same 402 checks pass on Cloudflare and on the Node server.
