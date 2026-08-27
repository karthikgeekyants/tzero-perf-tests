#!/usr/bin/env bash
# Runs the 4 scenarios that have no external (KYC/wallet-funding) dependency
# -- Sign Up, Sign In, Individual Onboarding, Entity Onboarding -- back to
# back at the same VU count against one BASE_URL, then prints a consolidated
# pass/fail + latency summary. Each scenario still writes its own timestamped
# reports/<name>-<TEST_TYPE>-*.{html,json} via lib/report.js; this just
# sequences the runs and summarizes them together at the end.
#
# Every account-creating run's own console output is captured to
# reports/*-run-output-*.log and turned into a credentialed pool
# (config/signup-run-pool.json, config/onboarding-individual-run-pool.json,
# config/onboarding-entity-run-pool.json -- email/password/accountId/
# totpSecret, captured at zero extra request cost) via
# scripts/build-signup-run-pool.js / scripts/build-onboarding-run-pool.js.
# Sign In then reuses Sign Up's own freshly-created accounts directly
# (SIGNIN_SOURCE=CAPTURED) instead of needing a separately pre-seeded pool.
#
# At the end, prints the email + accountId ("User ID") list for every
# onboarded account -- exactly what to hand a developer to approve KYC /
# fund wallets against.
#
# Usage:
#   BASE_URL=https://staging... VUS=500 ./scripts/run-independent-suite.sh
set -euo pipefail

BASE_URL="${BASE_URL:?Set BASE_URL, e.g. BASE_URL=https://staging... ./scripts/run-independent-suite.sh}"
VUS="${VUS:-500}"

cd "$(dirname "$0")/.."

# k6 exits 99 on a threshold breach (e.g. a p95 latency threshold), which is
# routine under load and NOT the same as a functional failure -- checks are
# what determine pass/fail. Don't let `set -e` abort the suite over that;
# just note the exit code and move on.
run_k6() {
  local log_file="$1"
  shift
  set +e
  if [[ -n "$log_file" ]]; then
    k6 run "$@" 2>&1 | tee "$log_file"
    local exit_code=${PIPESTATUS[0]}
  else
    k6 run "$@"
    local exit_code=$?
  fi
  set -e
  if [[ "$exit_code" -ne 0 ]]; then
    echo "(k6 exited $exit_code -- usually just a threshold breach; see the checks/summary above for actual pass/fail.)"
  fi
}

mkdir -p reports
ts="$(date -u +%Y%m%dT%H%M%SZ)"
signup_log="reports/signup-run-output-${ts}.log"
onboarding_individual_log="reports/onboarding-individual-run-output-${ts}.log"
onboarding_entity_log="reports/onboarding-entity-run-output-${ts}.log"

echo ""
echo "=== 1/4: Sign Up at ${VUS} VUs against ${BASE_URL} ==="
run_k6 "$signup_log" -e BASE_URL="$BASE_URL" --vus "$VUS" --iterations "$VUS" scenarios/01-signup.js

echo ""
echo "=== Building Sign In's pool from this Sign Up run's accounts ==="
node scripts/build-signup-run-pool.js "$signup_log"

echo ""
echo "=== 2/4: Sign In at ${VUS} VUs against ${BASE_URL} (reusing Sign Up's accounts) ==="
run_k6 "" -e BASE_URL="$BASE_URL" -e SIGNIN_SOURCE=CAPTURED --vus "$VUS" --iterations "$VUS" scenarios/01b-signin.js

echo ""
echo "=== 3/4: Individual Onboarding at ${VUS} VUs against ${BASE_URL} ==="
run_k6 "$onboarding_individual_log" -e BASE_URL="$BASE_URL" --vus "$VUS" --iterations "$VUS" scenarios/02-onboarding-individual.js
node scripts/build-onboarding-run-pool.js "$onboarding_individual_log"

echo ""
echo "=== 4/4: Entity Onboarding at ${VUS} VUs against ${BASE_URL} ==="
run_k6 "$onboarding_entity_log" -e BASE_URL="$BASE_URL" --vus "$VUS" --iterations "$VUS" scenarios/02-onboarding-entity.js
node scripts/build-onboarding-run-pool.js "$onboarding_entity_log"

echo ""
echo "=== Suite complete -- consolidated summary ==="
node scripts/summarize-suite.js signup signin onboarding-individual onboarding-entity

echo ""
echo "=== Credentials for dev approval (email — accountId) ==="
credential_files=()
[[ -f config/onboarding-individual-run-pool.json ]] && credential_files+=("config/onboarding-individual-run-pool.json")
[[ -f config/onboarding-entity-run-pool.json ]] && credential_files+=("config/onboarding-entity-run-pool.json")
if [[ ${#credential_files[@]} -gt 0 ]]; then
  node scripts/print-dev-credentials.js "${credential_files[@]}"
else
  echo "No onboarded accounts captured this run."
fi
