// Scenario 9.2 — Onboarding (Individual)
// See lib/onboarding-individual.js for the full step-by-step flow.
//
// Run:
//   k6 run -e TEST_TYPE=load   -e BASE_URL=https://... scenarios/02-onboarding-individual.js
//   k6 run -e TEST_TYPE=stress -e BASE_URL=https://... scenarios/02-onboarding-individual.js
//
// Each iteration signs up a brand-new user before onboarding it, since
// onboarding is a per-user, one-time flow — creates real accounts in staging
// on every run, same caveat as scenarios/01-signup.js.

import { buildOptions, thresholdMs } from '../lib/options.js';
import { runIndividualOnboardingFlow } from '../lib/onboarding-individual.js';
import { buildSummary } from '../lib/report.js';

export const options = buildOptions({
  // Every tagged step in this flow gets a threshold -- not because each one
  // needs its own SLA, but because k6 only keeps a separate per-step
  // breakdown metric (and therefore only shows it in the report's
  // "Response time by step" table) for tags referenced by a threshold.
  // Without this, only the 3 steps below had visible numbers even though
  // all 16 calls in this flow are individually tagged.
  'http_req_duration{name:SignUp}': [thresholdMs('SIGNUP_P95_THRESHOLD_MS', 1000)],
  'http_req_duration{name:GetCurrentUser}': [thresholdMs('GET_CURRENT_USER_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:SendEmailVerificationCode}': [thresholdMs('SEND_EMAIL_VERIFICATION_CODE_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:EnrollTotp}': [thresholdMs('ENROLL_TOTP_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:Verify2FACode}': [thresholdMs('VERIFY_2FA_CODE_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:RegistrationOptions}': [thresholdMs('REGISTRATION_OPTIONS_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:CreateOnboardingAccount}': [thresholdMs('CREATE_ONBOARDING_ACCOUNT_P95_THRESHOLD_MS', 1200)],
  'http_req_duration{name:GetOnboardingAccountStatus}': [thresholdMs('GET_ONBOARDING_ACCOUNT_STATUS_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:UpdateOnboardingAccount}': [thresholdMs('UPDATE_ONBOARDING_ACCOUNT_P95_THRESHOLD_MS', 1200)],
  'http_req_duration{name:ResendEmploymentBeforeSign}': [thresholdMs('RESEND_EMPLOYMENT_BEFORE_SIGN_P95_THRESHOLD_MS', 1200)],
  'http_req_duration{name:ResendInvestmentProfileBeforeSign}': [thresholdMs('RESEND_INVESTMENT_PROFILE_BEFORE_SIGN_P95_THRESHOLD_MS', 1200)],
  'http_req_duration{name:SignOnboardingAgreements}': [thresholdMs('SIGN_ONBOARDING_AGREEMENTS_P95_THRESHOLD_MS', 2000)],
  'http_req_duration{name:GetOnboardingKyc}': [thresholdMs('GET_ONBOARDING_KYC_P95_THRESHOLD_MS', 1000)],
  'http_req_duration{name:ResolveAccountIds}': [thresholdMs('RESOLVE_ACCOUNT_IDS_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:GetOnboardingTradingStatus}': [thresholdMs('GET_ONBOARDING_TRADING_STATUS_P95_THRESHOLD_MS', 3000)],
});

export default function () {
  runIndividualOnboardingFlow('perf.onb.ind');
}

const API_LIST = [
  { step: '1. Sign up + verify 2FA', method: 'POST/GET', endpoint: '/identities, /auth/user, /auth/2fa/*', description: 'Same account-creation steps as Sign Up (see that scenario)' },
  { step: '2. Registration options', method: 'GET', endpoint: '/registration-options', description: 'Reference data (country codes, document types)' },
  { step: '3. Create onboarding account', method: 'POST', endpoint: '/uap/v1/accounts', description: 'Starts the onboarding application' },
  { step: '4. Get account status', method: 'GET', endpoint: '/uap/v1/accounts/{id}', description: 'Hydrates on re-entry' },
  { step: '5. Update account (personal, employment, investor, trusted contact)', method: 'PUT', endpoint: '/uap/v1/accounts/{id}', description: 'Fills in each onboarding step' },
  { step: '6. Refresh session', method: 'POST', endpoint: '/auth/refresh', description: 'Keeps the session alive for this longer flow' },
  { step: '7. Sign agreements', method: 'POST', endpoint: '/uap/v1/accounts/{id}/sign', description: 'Signs customer agreements, triggers KYC' },
  { step: '8. Get KYC verdict', method: 'GET', endpoint: '/uap/v1/accounts/{id}/kyc', description: 'Polls the KYC result' },
  { step: '9. Get trading status', method: 'GET', endpoint: '/uap/v1/accounts/{id}/trading-status', description: 'Confirms trading eligibility' },
];

export function handleSummary(data) {
  return buildSummary('onboarding-individual', data, API_LIST);
}
