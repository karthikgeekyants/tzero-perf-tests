import { BASE_URL } from '../config/environment.js';

export function url(path) {
  return `${BASE_URL}${path}`;
}

export function jsonHeaders(token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
