import http from 'k6/http';
import crypto from 'k6/crypto';
import { check } from 'k6';
import { url, jsonHeaders } from './http.js';
import { generateTestUser } from './users.js';
import { EMAIL_VERIFICATION_CODE, SESSION_REFRESH_INTERVAL_MS } from '../config/environment.js';

// -- TOTP (RFC 6238) --------------------------------------------------------
// Generated locally from the secret captured at enrolment, so sign-in needs
// no vendor round-trip. Base32 decode + HMAC-SHA1 dynamic truncation.

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  const clean = input.replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

function counterBytes(counter) {
  const bytes = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    bytes[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  return bytes;
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

export function generateTotpCode(base32Secret, stepSeconds = 30, digits = 6) {
  const key = base32Decode(base32Secret);
  const counter = Math.floor(Date.now() / 1000 / stepSeconds);
  const hmacHex = crypto.hmac('sha1', key.buffer, counterBytes(counter).buffer, 'hex');
  const hmacBytes = hexToBytes(hmacHex);
  const offset = hmacBytes[hmacBytes.length - 1] & 0x0f;
  const binary =
    ((hmacBytes[offset] & 0x7f) << 24) |
    ((hmacBytes[offset + 1] & 0xff) << 16) |
    ((hmacBytes[offset + 2] & 0xff) << 8) |
    (hmacBytes[offset + 3] & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

// -- Sign up / sign in --------------------------------------------------------
// Session lives in HttpOnly cookies k6's per-VU jar attaches automatically —
// signUp()/signIn() return a plain success boolean, not a token to thread
// through later calls.

export function checkEmailAvailability(email) {
  const res = http.get(url(`/auth/emails?email=${encodeURIComponent(email)}`), {
    tags: { name: 'CheckEmailAvailability' },
    // 204 = taken, 404 = free -- both are expected outcomes, not failures.
    // Without this, k6's built-in http_req_failed metric flags every 404
    // (the common case, since generated emails are almost always free) as a
    // failed request, wildly inflating the reported error rate.
    responseCallback: http.expectedStatuses(204, 404),
  });
  check(res, { 'email availability check ok': (r) => r.status === 204 || r.status === 404 });
  return res.status === 404;
}

export function signUp(user) {
  const res = http.post(
    url('/identities?isEnterprise=true&skipReCaptcha=true'),
    JSON.stringify({
      clientId: user.clientId,
      clientName: user.clientName,
      credentials: { email: user.email, password: user.password },
      platform: user.platform,
    }),
    { headers: jsonHeaders(), tags: { name: 'SignUp' } }
  );
  return check(res, { 'sign up succeeded': (r) => r.status === 200 || r.status === 201 });
}

// Returns the response body on success (truthy, so `if (!signIn(user))` call
// sites keep working unchanged) or null on failure. The body already carries
// accountId even for a frozen (not yet KYC-approved) account -- no need to
// get past 2FA just to read it.
export function signIn(user) {
  const res = http.post(
    url('/auth/login'),
    JSON.stringify({ email: user.email, password: user.password, clientId: user.clientId }),
    { headers: jsonHeaders(), tags: { name: 'SignIn' } }
  );
  const ok = check(res, { 'sign in succeeded': (r) => r.status === 200 });
  if (!ok) return null;
  return res.json();
}

// Returns the response body on success (truthy, so `if (!getCurrentUser())`
// call sites keep working unchanged) or null on failure. The body's own
// `accountId` field is null until the account is actually onboarded (it's
// the legacy user-service link, not set at signup) -- that's a normal,
// expected value, NOT a failure, so callers must not gate on it.
export function getCurrentUser() {
  const res = http.get(url('/auth/user'), { headers: jsonHeaders(), tags: { name: 'GetCurrentUser' } });
  const ok = check(res, { 'get current user ok': (r) => r.status === 200 });
  if (!ok) return null;
  return res.json();
}

export function sendEmailVerificationCode(email) {
  const res = http.post(
    url('/auth/sendEmailVerificationCode'),
    JSON.stringify({ email }),
    { headers: jsonHeaders(), tags: { name: 'SendEmailVerificationCode' } }
  );
  const ok = check(res, { 'send email verification code ok': (r) => r.status === 200 });
  if (!ok) return null;
  // The response's `code` field is a status label (e.g. "SENT"), never the
  // actual OTP -- that only ever reaches the user's inbox.
  return EMAIL_VERIFICATION_CODE;
}

export function verifyEmailCode(email, code) {
  const res = http.post(
    url('/auth/verifyEmailCode'),
    JSON.stringify({ email, code }),
    { headers: jsonHeaders(), tags: { name: 'VerifyEmailCode' } }
  );
  return check(res, { 'verify email code ok': (r) => r.status === 200 });
}

// No separate init/enrolment-token step -- this call alone returns
// { label, issuer, secret, otpAuthUri }.
export function enrollTotp() {
  const res = http.post(url('/auth/2fa/totp/secrets'), null, {
    headers: jsonHeaders(),
    tags: { name: 'EnrollTotp' },
  });
  const ok = check(res, { 'totp enroll ok': (r) => r.status === 200 || r.status === 201 });
  if (!ok) return null;
  return res.json('secret');
}

// Returns the PIAS userId on success (truthy, usable in `if (!verifyTotp(...))`
// checks same as a boolean) or null on failure. Callers that only need
// pass/fail can ignore the return value entirely.
export function verifyTotp(secret) {
  const code = generateTotpCode(secret);
  const res = http.post(url(`/auth/2fa/verify/${code}`), null, {
    headers: jsonHeaders(),
    tags: { name: 'Verify2FACode' },
  });
  const ok = check(res, { 'verify totp ok': (r) => r.status === 200 });
  return ok ? res.json('userId') : null;
}

export function logout() {
  const res = http.post(url('/auth/logout'), null, { headers: jsonHeaders(), tags: { name: 'Logout' } });
  return check(res, { 'logout ok': (r) => r.status === 200 });
}

export function refreshSession() {
  const res = http.post(url('/auth/refresh'), null, {
    headers: jsonHeaders(),
    tags: { name: 'RefreshSession' },
  });
  // Success is 201, not 200 -- same class of bug as sign() (see lib/onboarding-individual.js).
  return check(res, { 'refresh session ok': (r) => r.status === 200 || r.status === 201 });
}

// Call between steps so a VU's ~180s session never expires mid-flow. `state`
// is a plain object the caller owns across the iteration.
export function maybeRefreshSession(state, intervalMs) {
  const interval = intervalMs || SESSION_REFRESH_INTERVAL_MS;
  if (!state.lastAuthAt || Date.now() - state.lastAuthAt > interval) {
    if (refreshSession()) state.lastAuthAt = Date.now();
  }
}

// The three account-id namespaces the app resolves once per session and
// carries everywhere: /uap/v1/* takes the UAP uuid, /pi/* takes the PIAS id,
// bare /accounts/* takes the user-service id. All three come back from this
// one call. A 404 means "not onboarded yet" — a valid state, not a failure.
export function resolveAccountIds() {
  const res = http.get(url('/uap/v1/me'), {
    headers: jsonHeaders(),
    tags: { name: 'ResolveAccountIds' },
    // 404 = not onboarded yet, an expected state for pooled/fresh accounts --
    // same http_req_failed inflation issue as checkEmailAvailability above.
    responseCallback: http.expectedStatuses(200, 404),
  });
  if (res.status === 404) return null;
  const ok = check(res, { 'resolve account ids ok': (r) => r.status === 200 });
  if (!ok) return null;

  const body = res.json();
  const account = (body.accounts && body.accounts[0]) || body;
  // PIAS/USER_SERVICE ids live in a `mirrors` array keyed by platform, each
  // with its own syncStatus -- only count one as resolved once SYNCED.
  // clientId isn't on this endpoint at all (comes from 2fa/verify instead),
  // so it stays undefined here.
  const mirrors = account.mirrors || [];
  const findMirror = (platform) => mirrors.find((m) => m.platform === platform);
  const piasMirror = findMirror('PIAS');
  const userServiceMirror = findMirror('USER_SERVICE');
  return {
    uapAccountId: account.accountId || account.id,
    piasAccountId: piasMirror?.syncStatus === 'SYNCED' ? piasMirror.legacyAccountId : undefined,
    userServiceAccountId:
      userServiceMirror?.syncStatus === 'SYNCED' ? userServiceMirror.legacyAccountId : undefined,
    clientId: body.clientId || account.clientId,
  };
}

// -- Composite helpers used by every flow ------------------------------------

// Runs the full confirmed Sign Up journey for an explicit user object (e.g. a
// pooled account being seeded with a known email): register, hydrate,
// send (but not gate on) email verification, enrol + verify TOTP. POST
// /identities sets the session cookies directly (step 2 below) -- there's no
// separate sign-in call here, that's a different journey (see signIn(), for
// returning users).
//
// Confirmed 2026-08-19: TOTP enrolment/verification succeed without ever
// verifying the emailed code -- the real web app's own signup journey never
// calls verifyEmailCode either, so it's not a gate on reaching a fully
// 2FA-verified account. sendEmailVerificationCode() is still called (it
// always succeeds) to represent the real load that endpoint sees, but its
// result is no longer required for the rest of signup to proceed -- there
// was never a working bypass code for it anyway.
export function completeSignUp(user) {
  if (!signUp(user)) return null;
  const currentUser = getCurrentUser();
  if (!currentUser) return null;

  sendEmailVerificationCode(user.email);

  const totpSecret = enrollTotp();
  if (!totpSecret) return null;
  if (!verifyTotp(totpSecret)) return null;

  // accountId is null here (not onboarded yet) -- flows that go on to
  // onboard the account should re-resolve it (e.g. via resolveAccountIds())
  // after sign, and prefer that fresher value over this one.
  return { user, totpSecret, accountId: currentUser.accountId };
}

// Convenience for scenarios that just need an authenticated session and
// aren't themselves exercising sign-up/sign-in.
export function provisionAuthenticatedUser(prefix) {
  return completeSignUp(generateTestUser(prefix));
}
