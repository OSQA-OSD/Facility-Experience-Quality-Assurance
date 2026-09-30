# Security and regression tests

End-to-end checks that call the Worker the way a browser (or an attacker) would. They run against
the **local development server and local database only**; nothing here touches the live site.

## Run them

```bash
npm ci
node tests/dev-keys.mjs                                   # once: a local-only notification key in .dev.vars
npx wrangler d1 migrations apply facility-qa --local      # once: the local database
npm run dev                                               # leave running (http://localhost:8787)
bash tests/run.sh                                         # in a second terminal
```

**Against the Node.js server** (`server/node.mjs`, see `docs/INSTALL-SERVER.md`): start a test instance on port 8787
with `PUSH_ALLOW_LOCAL=1`, then point the tests at its database:

```bash
OSQA_DB=data/osqa.sqlite bash tests/run.sh
```

`tests/sql.mjs` runs the tests' SQL against that SQLite file, or against wrangler's local D1 when `OSQA_DB`
is not set. The same checks pass on both.

`tests/run.sh` loads `tests/seed-local.sql` (six test accounts and one report; the migrations bring the buildings),
gives the test accounts sessions directly in the local database, and runs each suite. Run one or
two suites with `bash tests/run.sh h2test roletest`.

## What they cover

| Suite | What it checks |
|---|---|
| `pushcrypto.test` | Phone-notification encryption against the RFC 8291 test vector; only Apple, Google, Mozilla and Microsoft push hosts are accepted. |
| `sectest` | Same-origin guard (CSRF), report ownership from the session, photo type allowlist and signatures, versions, archive and restore, backups. |
| `pwtest` | Password rules, temporary passwords, lockout after five wrong passwords, unlock. |
| `reptest` | Repeat-for-end-of-quarter assignments and the automatic cloud backup. |
| `pushe2e` | Notifications end to end through a stand-in push service: signed (VAPID), encrypted, only to the signed-in device, forgotten when the service says the device is gone. |
| `settest` | The per-person notification setting; security alerts always delivered. |
| `hardtest` | Forged server fields, input limits, sign-in throttling, timing of wrong usernames. |
| `roletest` | Every protected endpoint × every role (admin, officer, leader, assessor, analyst) and anonymous, plus privilege-escalation attempts. |
| `h2test` | Page security policy (no inline script, no eval), the sealed photo converter, private caching, cross-site isolation headers, sign-in audit entries, per-network and per-person limits, duplicate reviews, notification device cap. |

A test that fails prints its name with ✗; the runner ends with `TOTAL FAILED: 0` when all pass.
