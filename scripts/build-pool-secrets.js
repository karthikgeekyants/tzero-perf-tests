#!/usr/bin/env node
// Turns a captured scenarios/00-seed-user-pool.js run (stdout+stderr) into
// config/pool-secrets.json, keyed by pool index -> TOTP secret. Sign In (and
// any other pooled-user scenario) reads that file at k6 init time to compute
// a login code for whichever pooled account a VU picks.
//
// Usage:
//   k6 run scenarios/00-seed-user-pool.js > reports/seed-output.log 2>&1
//   node scripts/build-pool-secrets.js reports/seed-output.log

const fs = require('fs');
const path = require('path');

const [, , logFile] = process.argv;
if (!logFile) {
  console.error('Usage: node scripts/build-pool-secrets.js <seed-run-output.log>');
  process.exit(1);
}

const lines = fs.readFileSync(logFile, 'utf8').split('\n');
const secrets = {};
let count = 0;

for (const line of lines) {
  const markerIndex = line.indexOf('POOL_SECRET:');
  if (markerIndex === -1) continue;

  // k6's console.log lines are wrapped in a Go-style `msg="..."` field with
  // backslash-escaped quotes -- pull out everything up to the field's
  // closing quote and unescape it back into plain JSON.
  const rest = line.slice(markerIndex + 'POOL_SECRET:'.length);
  const endMatch = rest.match(/^(.*?)" source=console/);
  if (!endMatch) continue;

  const unescaped = endMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  try {
    const { index, totpSecret } = JSON.parse(unescaped);
    if (index && totpSecret) {
      secrets[index] = totpSecret;
      count++;
    }
  } catch {
    continue;
  }
}

if (count === 0) {
  console.error(`No POOL_SECRET lines found in ${logFile} -- did the seed run actually succeed? Check for errors in that file.`);
  process.exit(1);
}

const outPath = path.join(__dirname, '..', 'config', 'pool-secrets.json');
fs.writeFileSync(outPath, JSON.stringify(secrets, null, 2));
console.log(`Wrote ${count} pooled account secrets to ${outPath}`);
