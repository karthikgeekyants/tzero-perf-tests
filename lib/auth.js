import http from 'k6/http';
import { check, sleep } from 'k6';
import { url, jsonHeaders } from './http.js';
import { generateTestUser } from './users.js';
import { SLEEP_SECONDS, TEST_2FA_CODE } from '../config/environment.js';

export function signUp(user) {
  const res = http.post(
    url('/identities'),
    JSON.stringify({ email: user.email, password: user.password, confirmPassword: user.confirmPassword }),
    { headers: jsonHeaders(), tags: { name: 'SignUp' } }
  );
  return check(res, { 'sign up succeeded': (r) => r.status === 200 || r.status === 201 });
}

export function signIn(user) {
  const res = http.post(
    url('/auth/login'),
    JSON.stringify({ email: user.email, password: user.password }),
    { headers: jsonHeaders(), tags: { name: 'SignIn' } }
  );
  const ok = check(res, { 'sign in succeeded': (r) => r.status === 200 });
  if (!ok) return null;
  return res.json('token') || res.json('accessToken');
  // TODO: confirm the actual token field name returned by /auth/login.
}

// Registers and signs in an explicit user object (e.g. a pooled account being
// seeded with a known email, rather than a randomly generated one).
export function signUpAndSignIn(user) {
  if (!signUp(user)) return null;
  const token = signIn(user);
  if (!token) return null;
  return { user, token };
}

// Convenience for scenarios (onboarding, invest, trade, order history) that just
// need an authenticated session and aren't themselves exercising sign-up/sign-in
// (see scenarios/01-signup.js for that).
export function provisionAuthenticatedUser(prefix) {
  return signUpAndSignIn(generateTestUser(prefix));
}

// Enter phone number, tap "Send code", then enter the received code and
// verify. Shared by scenarios/01-signup.js and scenarios/00-seed-user-pool.js.
export function verifyPhoneOtp(token, phone) {
  const requestRes = http.post(
    url('/auth/2fa/sms/code'),
    JSON.stringify({ phone }),
    { headers: jsonHeaders(token), tags: { name: 'Request2FACode' } }
  );
  const requestOk = check(requestRes, { 'request 2fa code ok': (r) => r.status === 200 });
  // Some staging environments return the OTP directly in this response so
  // tests don't need a real SMS gateway — use it if present.
  const smsCode = requestRes.json('code') || requestRes.json('otp') || TEST_2FA_CODE;
  // TODO: confirm with backend whether staging returns the code here (and
  // under what field name) — TEST_2FA_CODE is only a fallback placeholder.
  sleep(SLEEP_SECONDS);
  if (!requestOk) return false;

  const verifyRes = http.post(url(`/auth/2fa/verify/${smsCode}`), null, {
    headers: jsonHeaders(token),
    tags: { name: 'Verify2FACode' },
  });
  return check(verifyRes, { 'verify 2fa ok': (r) => r.status === 200 });
}
