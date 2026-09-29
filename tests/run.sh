#!/bin/bash
# Runs the end-to-end security tests against the LOCAL development server and database only.
# Needs: `npm run dev` running on http://localhost:8787 (see tests/README.md).
#   bash tests/run.sh                 every suite
#   bash tests/run.sh h2test roletest just these
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
export REPO
cd "$REPO" || exit 1
curl -sf http://localhost:8787/api/health >/dev/null || { echo "The local server is not running on :8787 — start it with: npm run dev"; exit 1; }

d1() { npx wrangler d1 execute facility-qa --local --command "$1" >/dev/null 2>&1; }
npx wrangler d1 execute facility-qa --local --file tests/seed-local.sql >/dev/null 2>&1

# Sessions for the four accounts most suites use (the role suite makes its own).
NOW=$(($(date +%s)*1000)); EXP=$((NOW+8*3600*1000)); SESSIONS=""
for pair in tst-adm-2026:8c2e36fd-608d-47ac-ae2a-c9f5ec5151ab tst-au1-2026:a1fd8b2b-b220-45f5-b2ba-623700ae9e0b \
            tst-au2-2026:6a45c7e7-5e68-46aa-93aa-726d4312d59a tst-ldr-2026:df67488c-ff4b-40d9-95d8-5a8b32847a64; do
  t=${pair%%:*}; u=${pair#*:}; h=$(printf %s "$t" | shasum -a 256 | cut -d' ' -f1)
  SESSIONS+="INSERT OR REPLACE INTO qa_sessions (token_hash,user_id,expires_at,device,last_seen_at) VALUES ('$h','$u',$EXP,'local test',$NOW); "
done

total_fail=0
for s in ${@:-pushcrypto.test sectest pwtest reptest pushe2e settest hardtest roletest h2test}; do
  d1 "DELETE FROM auth_throttle"                     # each suite starts with no rate-limit counters
  d1 "UPDATE qa_users SET notifications_enabled=1, status='active' WHERE username IN ('auditor1','auditor2','leader1','boss','officer1','analystx')"
  d1 "DELETE FROM assignments WHERE quarter IN ('2031-Q3','2031-Q4')"
  d1 "$SESSIONS"                                     # a suite may sign its accounts out; start each one signed in
  out=$(node "tests/$s.mjs" 2>&1); code=$?
  p=$(grep -c '  ✓ ' <<<"$out"); f=$(grep -c '  ✗ ' <<<"$out")
  summary=$(grep -E '^[0-9]+ passed, [0-9]+ failed' <<<"$out" | tail -1)
  echo "$s: ${summary:-$p passed, $f failed}"
  grep '  ✗ ' <<<"$out" | head -20
  if [ "$code" -ne 0 ] && [ "$f" -eq 0 ]; then tail -5 <<<"$out"; f=1; fi
  total_fail=$((total_fail+f))
done
echo "TOTAL FAILED: $total_fail"
[ "$total_fail" -eq 0 ]
