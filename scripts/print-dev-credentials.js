#!/usr/bin/env node
// Prints a copy-paste "email — accountId" list from one or more captured
// run-pool files (config/signup-run-pool.json,
// config/onboarding-individual-run-pool.json,
// config/onboarding-entity-run-pool.json -- see build-signup-run-pool.js /
// build-onboarding-run-pool.js), for handing to a developer to approve
// KYC / fund wallets against.
//
// Usage:
//   node scripts/print-dev-credentials.js config/onboarding-individual-run-pool.json
//   node scripts/print-dev-credentials.js config/onboarding-individual-run-pool.json config/onboarding-entity-run-pool.json
//   node scripts/print-dev-credentials.js --limit=20 config/signup-run-pool.json

const fs = require('fs');

function parseArgs(argv) {
  let limit = Infinity;
  const files = [];
  for (const arg of argv) {
    const limitMatch = arg.match(/^--limit=(\d+)$/);
    if (limitMatch) {
      limit = Number(limitMatch[1]);
      continue;
    }
    files.push(arg);
  }
  return { files, limit };
}

function main() {
  const { files, limit } = parseArgs(process.argv.slice(2));
  if (files.length === 0) {
    console.error('Usage: node scripts/print-dev-credentials.js [--limit=N] <run-pool.json> [<run-pool.json> ...]');
    process.exit(1);
  }

  for (const file of files) {
    const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(`\n${file} (${entries.length} accounts${limit < entries.length ? `, showing ${limit}` : ''}):`);
    for (const entry of entries.slice(0, limit)) {
      console.log(`${entry.email} — ${entry.accountId}`);
    }
  }
}

main();
