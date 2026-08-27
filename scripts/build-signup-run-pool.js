#!/usr/bin/env node
// Turns a captured scenarios/01-signup.js run (stdout+stderr) into
// config/signup-run-pool.json -- an array of every account that fully
// completed sign up (email, password, accountId, totpSecret), captured
// straight from the run's own responses at zero extra request cost (see the
// SIGNUP_ACCOUNT_CREDENTIAL console.log in that scenario).
//
// Two uses:
//   1. Sign In can log into these same real accounts instead of a separately
//      pre-seeded pool -- run 01b-signin.js with -e SIGNIN_SOURCE=CAPTURED.
//   2. The email + accountId ("User ID") pairs are exactly what a dev needs
//      to approve KYC / fund wallets for -- see scripts/print-dev-credentials.js.
//
// Usage:
//   k6 run --vus 500 --iterations 500 scenarios/01-signup.js > reports/signup-run-output.log 2>&1
//   node scripts/build-signup-run-pool.js reports/signup-run-output.log

const fs = require('fs');
const path = require('path');

const [, , logFile] = process.argv;
if (!logFile) {
  console.error('Usage: node scripts/build-signup-run-pool.js <signup-run-output.log>');
  process.exit(1);
}

const lines = fs.readFileSync(logFile, 'utf8').split('\n');
const entries = [];

for (const line of lines) {
  const markerIndex = line.indexOf('SIGNUP_ACCOUNT_CREDENTIAL:');
  if (markerIndex === -1) continue;

  const rest = line.slice(markerIndex + 'SIGNUP_ACCOUNT_CREDENTIAL:'.length);
  const endMatch = rest.match(/^(.*?)" source=console/);
  if (!endMatch) continue;

  const unescaped = endMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  try {
    const entry = JSON.parse(unescaped);
    if (entry.email && entry.totpSecret) entries.push(entry);
  } catch {
    continue;
  }
}

if (entries.length === 0) {
  console.error(`No SIGNUP_ACCOUNT_CREDENTIAL lines found in ${logFile} -- did the run actually succeed? Check for errors in that file.`);
  process.exit(1);
}

const outPath = path.join(__dirname, '..', 'config', 'signup-run-pool.json');
fs.writeFileSync(outPath, JSON.stringify(entries, null, 2));
console.log(`Wrote ${entries.length} captured signup accounts to ${outPath}`);
