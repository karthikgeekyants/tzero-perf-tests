#!/usr/bin/env node
// Turns a captured scenarios/02-onboarding-individual.js or
// scenarios/02-onboarding-entity.js run (stdout+stderr) into
// config/onboarding-individual-run-pool.json / config/onboarding-entity-run-pool.json
// -- an array of every account that fully signed onboarding agreements
// (email, password, accountId, uapAccountId, totpSecret), captured straight
// from the run's own responses at zero extra request cost (see the
// ONBOARDING_*_ACCOUNT_CREDENTIAL console.log in those flows).
//
// The email + accountId ("User ID") pairs are exactly what a dev needs to
// approve KYC / fund wallets for -- see scripts/print-dev-credentials.js.
// Handles a log containing either or both markers in one pass.
//
// Usage:
//   k6 run --vus 500 --iterations 500 scenarios/02-onboarding-individual.js > reports/onboarding-individual-run-output.log 2>&1
//   node scripts/build-onboarding-run-pool.js reports/onboarding-individual-run-output.log

const fs = require('fs');
const path = require('path');

const [, , logFile] = process.argv;
if (!logFile) {
  console.error('Usage: node scripts/build-onboarding-run-pool.js <onboarding-run-output.log>');
  process.exit(1);
}

// Every generated user shares this same password (see config/environment.js)
// -- the flow deliberately doesn't log it (keeps a real secret out of
// stdout), so it's filled back in here instead of being captured per-account.
// No default on purpose -- must match whatever the run itself used.
const SIGN_UP_PASSWORD = process.env.SIGN_UP_PASSWORD;
if (!SIGN_UP_PASSWORD) {
  console.error('SIGN_UP_PASSWORD env var is required -- set it to the same value the run itself used.');
  process.exit(1);
}

const MARKERS = [
  { marker: 'ONBOARDING_INDIVIDUAL_ACCOUNT_CREDENTIAL:', outFile: 'onboarding-individual-run-pool.json' },
  { marker: 'ONBOARDING_ENTITY_ACCOUNT_CREDENTIAL:', outFile: 'onboarding-entity-run-pool.json' },
];

const lines = fs.readFileSync(logFile, 'utf8').split('\n');

for (const { marker, outFile } of MARKERS) {
  const entries = [];
  for (const line of lines) {
    const markerIndex = line.indexOf(marker);
    if (markerIndex === -1) continue;

    const rest = line.slice(markerIndex + marker.length);
    const endMatch = rest.match(/^(.*?)" source=console/);
    if (!endMatch) continue;

    const unescaped = endMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    try {
      const entry = JSON.parse(unescaped);
      if (entry.email && entry.totpSecret) entries.push({ ...entry, password: SIGN_UP_PASSWORD });
    } catch {
      continue;
    }
  }

  if (entries.length === 0) continue;

  const outPath = path.join(__dirname, '..', 'config', outFile);
  fs.writeFileSync(outPath, JSON.stringify(entries, null, 2));
  console.log(`Wrote ${entries.length} captured accounts to ${outPath}`);
}
