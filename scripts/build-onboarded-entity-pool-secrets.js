#!/usr/bin/env node
// Turns a captured scenarios/00c-seed-onboarded-entity-pool.js run
// (stdout+stderr) into config/onboarded-entity-pool-secrets.json, keyed by
// pool index -> TOTP secret. Same mechanic as
// scripts/build-onboarded-pool-secrets.js, separate file so seeding this
// pool never clobbers the individual-onboarded pool's secrets.
//
// Usage:
//   k6 run scenarios/00c-seed-onboarded-entity-pool.js > reports/seed-onboarded-entity-output.log 2>&1
//   node scripts/build-onboarded-entity-pool-secrets.js reports/seed-onboarded-entity-output.log

const fs = require('fs');
const path = require('path');

const [, , logFile] = process.argv;
if (!logFile) {
  console.error('Usage: node scripts/build-onboarded-entity-pool-secrets.js <seed-run-output.log>');
  process.exit(1);
}

const lines = fs.readFileSync(logFile, 'utf8').split('\n');
const secrets = {};
let count = 0;

for (const line of lines) {
  const markerIndex = line.indexOf('ONBOARDED_ENTITY_POOL_SECRET:');
  if (markerIndex === -1) continue;

  const rest = line.slice(markerIndex + 'ONBOARDED_ENTITY_POOL_SECRET:'.length);
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
  console.error(`No ONBOARDED_ENTITY_POOL_SECRET lines found in ${logFile} -- did the seed run actually succeed? Check for errors in that file.`);
  process.exit(1);
}

const outPath = path.join(__dirname, '..', 'config', 'onboarded-entity-pool-secrets.json');
fs.writeFileSync(outPath, JSON.stringify(secrets, null, 2));
console.log(`Wrote ${count} onboarded entity pooled account secrets to ${outPath}`);
