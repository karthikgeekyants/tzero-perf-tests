// Scenario 9.2 — Onboarding (Individual)
// Covers: registration options, send/verify email code, create/update onboarding
// account, get onboarding account status, sign agreements, get UAP summary, run KYC.
//
// Run:
//   k6 run -e TEST_TYPE=load   -e BASE_URL=https://... scenarios/02-onboarding-individual.js
//   k6 run -e TEST_TYPE=stress -e BASE_URL=https://... scenarios/02-onboarding-individual.js
//
// Each iteration provisions (signs up + signs in) a brand-new user before
// onboarding it, since onboarding is a per-user, one-time flow — it creates
// real accounts in preprod on every run, same caveat as scenarios/01-signup.js.

import { buildOptions, thresholdMs } from '../lib/options.js';
import { runOnboardingFlow } from '../lib/onboarding.js';
import { buildSummary } from '../lib/report.js';

export const options = buildOptions({
  'http_req_duration{name:CreateOnboardingAccount}': [thresholdMs('CREATE_ONBOARDING_ACCOUNT_P95_THRESHOLD_MS', 1200)],
  'http_req_duration{name:RunOnboardingKYC}': [thresholdMs('RUN_ONBOARDING_KYC_P95_THRESHOLD_MS', 2000)],
});

export default function () {
  runOnboardingFlow('INDIVIDUAL', 'perf.onboarding.individual');
}

export function handleSummary(data) {
  return buildSummary('onboarding-individual', data);
}
