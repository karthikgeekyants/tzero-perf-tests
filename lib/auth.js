import http from 'k6/http';
import { check } from 'k6';
import { url, jsonHeaders } from './http.js';
import { generateTestUser } from './users.js';

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

// Convenience for scenarios (onboarding, invest, trade, order history) that just
// need an authenticated session and aren't themselves exercising sign-up/sign-in
// (see scenarios/01-signin-signup.js for that).
export function provisionAuthenticatedUser(prefix) {
  const user = generateTestUser(prefix);
  if (!signUp(user)) return null;
  const token = signIn(user);
  if (!token) return null;
  return { user, token };
}
