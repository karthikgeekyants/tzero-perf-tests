import http from 'k6/http';
import { BASE_URL } from '../config/environment.js';

export function url(path) {
  return `${BASE_URL}${path}`;
}

// Session lives in the HttpOnly cookies k6's per-VU cookie jar already
// attaches to every request automatically — there's no bearer token to pass
// around (confirmed: the app uses cookie sessions from POST /auth/login, not
// Authorization headers). Writes additionally need the double-submit CSRF
// pair: the TZM-XSRF-TOKEN cookie the server sets, echoed back as the
// X-TZM-XSRF-TOKEN header. Reading it fresh from the jar on every call (
// rather than caching it once) means it stays correct if the server rotates
// it after login/refresh.
export function jsonHeaders(extra = {}) {
  const jar = http.cookieJar();
  const cookies = jar.cookiesForURL(url('/'));
  const csrfToken = cookies['TZM-XSRF-TOKEN'] && cookies['TZM-XSRF-TOKEN'][0];
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (csrfToken) headers['X-TZM-XSRF-TOKEN'] = csrfToken;
  return headers;
}
