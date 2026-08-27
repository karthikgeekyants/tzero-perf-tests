// Scenario 9.2 — Onboarding (Entity: LLC/Corporation/Partnership)
// See lib/onboarding-entity.js for the full step-by-step flow.
//
// "ENTITY" is not a real accountType — the real enum is INDIVIDUAL/JOINT/
// LLC/CORPORATION/PARTNERSHIP/TRUST. Defaults to LLC
// (ONBOARDING_ENTITY_ACCOUNT_TYPE); override to test Corporation/Partnership.
//
// Run:
//   k6 run -e TEST_TYPE=load   -e BASE_URL=https://... scenarios/02-onboarding-entity.js
//   k6 run -e TEST_TYPE=stress -e BASE_URL=https://... scenarios/02-onboarding-entity.js
//
// Each iteration provisions (signs up + verifies TOTP) a brand-new user
// before onboarding it, since onboarding is a per-user, one-time flow — it
// creates real accounts in staging on every run, same caveat as
// scenarios/01-signup.js.

import { buildOptions, thresholdMs } from '../lib/options.js';
import { runEntityOnboardingFlow } from '../lib/onboarding-entity.js';
import { buildSummary } from '../lib/report.js';
import { ONBOARDING_ENTITY_ACCOUNT_TYPE } from '../config/environment.js';

export const options = buildOptions({
  // Every tagged step gets a threshold -- k6 only keeps a separate per-step
  // breakdown metric (shown in the report's "Response time by step" table)
  // for tags referenced by a threshold, so without this only the 4 below
  // would show their own numbers even though all 15 calls in this flow are
  // individually tagged.
  'http_req_duration{name:SignUp}': [thresholdMs('SIGNUP_P95_THRESHOLD_MS', 1000)],
  'http_req_duration{name:GetCurrentUser}': [thresholdMs('GET_CURRENT_USER_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:SendEmailVerificationCode}': [thresholdMs('SEND_EMAIL_VERIFICATION_CODE_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:EnrollTotp}': [thresholdMs('ENROLL_TOTP_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:Verify2FACode}': [thresholdMs('VERIFY_2FA_CODE_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:RegistrationOptions}': [thresholdMs('REGISTRATION_OPTIONS_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:CreateOnboardingAccount}': [thresholdMs('CREATE_ONBOARDING_ACCOUNT_P95_THRESHOLD_MS', 1200)],
  'http_req_duration{name:GetOnboardingAccountStatus}': [thresholdMs('GET_ONBOARDING_ACCOUNT_STATUS_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:UpdateOnboardingAccount}': [thresholdMs('UPDATE_ONBOARDING_ACCOUNT_P95_THRESHOLD_MS', 1200)],
  'http_req_duration{name:SubmitOnboardingAccount}': [thresholdMs('SUBMIT_ONBOARDING_ACCOUNT_P95_THRESHOLD_MS', 2000)],
  'http_req_duration{name:RefreshSession}': [thresholdMs('REFRESH_SESSION_P95_THRESHOLD_MS', 800)],
  'http_req_duration{name:UploadDocument}': [thresholdMs('UPLOAD_DOCUMENT_P95_THRESHOLD_MS', 2000)],
  'http_req_duration{name:SignOnboardingAgreements}': [thresholdMs('SIGN_ONBOARDING_AGREEMENTS_P95_THRESHOLD_MS', 2000)],
  'http_req_duration{name:GetOnboardingKyc}': [thresholdMs('GET_ONBOARDING_KYC_P95_THRESHOLD_MS', 1000)],
  'http_req_duration{name:ResolveAccountIds}': [thresholdMs('RESOLVE_ACCOUNT_IDS_P95_THRESHOLD_MS', 500)],
  'http_req_duration{name:GetOnboardingTradingStatus}': [thresholdMs('GET_ONBOARDING_TRADING_STATUS_P95_THRESHOLD_MS', 3000)],
});

export default function () {
  runEntityOnboardingFlow(ONBOARDING_ENTITY_ACCOUNT_TYPE, 'perf.onb.ent');
}

const API_LIST = [
  { step: '1. Sign up + verify 2FA', method: 'POST/GET', endpoint: '/identities, /auth/user, /auth/2fa/*', description: 'Same account-creation steps as Sign Up (see that scenario)' },
  { step: '2. Registration options', method: 'GET', endpoint: '/registration-options', description: 'Reference data (country codes, document types)' },
  { step: '3. Create onboarding account', method: 'POST', endpoint: '/uap/v1/accounts', description: 'Starts the onboarding application' },
  { step: '4. Get account status', method: 'GET', endpoint: '/uap/v1/accounts/{id}', description: 'Hydrates on re-entry' },
  { step: '5. Update account (personal, employment, investor, entity, associated people)', method: 'PUT', endpoint: '/uap/v1/accounts/{id}', description: 'Fills in each onboarding step' },
  { step: '6. Submit application', method: 'POST', endpoint: '/uap/v1/accounts/{id}/submit', description: 'Provisions the entity account for documents/signing' },
  { step: '7. Refresh session', method: 'POST', endpoint: '/auth/refresh', description: 'Forces a fresh token before document upload' },
  { step: '8. Upload supporting documents', method: 'POST', endpoint: '/uap/v1/accounts/{id}/documents', description: '4 required LLC documents' },
  { step: '9. Sign agreements', method: 'POST', endpoint: '/uap/v1/accounts/{id}/sign', description: 'Signs customer agreements, triggers KYC' },
  { step: '10. Get KYC verdict', method: 'GET', endpoint: '/uap/v1/accounts/{id}/kyc', description: 'Polls the KYC result' },
  { step: '11. Get trading status', method: 'GET', endpoint: '/uap/v1/accounts/{id}/trading-status', description: 'Confirms trading eligibility' },
];

export function handleSummary(data) {
  return buildSummary('onboarding-entity', data, API_LIST);
}
