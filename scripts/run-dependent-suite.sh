#!/usr/bin/env bash
# Runs the 3 scenarios that DO depend on KYC-approved / wallet-funded
# accounts -- Invest via Wire, Trade via Wallet, Order History -- back to
# back at the same VU count against one BASE_URL, using POOL_ACCOUNT_TYPE=
# MIXED so both the Individual and Entity onboarded pools get exercised in
# every run (odd VUs -> Individual, even VUs -> Entity). Order matters:
# Trade via Wallet places real orders, which Order History then needs to
# have something to list -- so it must run before Order History.
#
# Requires config/onboarded-pool-secrets.json and
# config/onboarded-entity-pool-secrets.json to hold accounts that are
# ALREADY KYC-approved and wallet-funded for this BASE_URL (see
# scenarios/00b-seed-onboarded-pool.js / 00c-seed-onboarded-entity-pool.js
# to seed them, and scripts/print-dev-credentials.js for the dev-approval
# handoff list) -- otherwise every run here will fail the same way
# everything did before approval.
#
# Each scenario still writes its own timestamped
# reports/<name>-<TEST_TYPE>-*.{html,json} via lib/report.js; this just
# sequences the runs and prints a consolidated summary at the end.
#
# Usage:
#   BASE_URL=https://staging... VUS=500 ./scripts/run-dependent-suite.sh
set -euo pipefail

BASE_URL="${BASE_URL:?Set BASE_URL, e.g. BASE_URL=https://staging... ./scripts/run-dependent-suite.sh}"
VUS="${VUS:-500}"

cd "$(dirname "$0")/.."

# k6 exits 99 on a threshold breach (e.g. a p95 latency threshold), which is
# routine under load and NOT the same as a functional failure -- checks are
# what determine pass/fail. Don't let `set -e` abort the suite over that;
# just note the exit code and move on.
run_k6() {
  set +e
  k6 run "$@"
  local exit_code=$?
  set -e
  if [[ "$exit_code" -ne 0 ]]; then
    echo "(k6 exited $exit_code -- usually just a threshold breach; see the checks/summary above for actual pass/fail.)"
  fi
}

echo ""
echo "=== 1/3: Invest via Wire at ${VUS} VUs against ${BASE_URL} (MIXED pool) ==="
run_k6 -e BASE_URL="$BASE_URL" -e POOL_ACCOUNT_TYPE=MIXED --vus "$VUS" --iterations "$VUS" scenarios/03-invest-wire.js

echo ""
echo "=== 2/3: Trade via Wallet at ${VUS} VUs against ${BASE_URL} (MIXED pool) ==="
run_k6 -e BASE_URL="$BASE_URL" -e POOL_ACCOUNT_TYPE=MIXED --vus "$VUS" --iterations "$VUS" scenarios/04-trade-wallet.js

echo ""
echo "=== 3/3: Order History at ${VUS} VUs against ${BASE_URL} (MIXED pool) ==="
run_k6 -e BASE_URL="$BASE_URL" -e POOL_ACCOUNT_TYPE=MIXED --vus "$VUS" --iterations "$VUS" scenarios/05-order-history.js

echo ""
echo "=== Suite complete -- consolidated summary ==="
node scripts/summarize-suite.js invest-wire trade-wallet order-history
