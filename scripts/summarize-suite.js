#!/usr/bin/env node
// Prints a consolidated pass/fail + latency summary across a set of
// scenario reports, picking the most recent reports/<name>-<TEST_TYPE>-*.json
// for each named scenario (matching lib/report.js's buildSummary() naming).
//
// Usage:
//   node scripts/summarize-suite.js signup signin onboarding-individual onboarding-entity
//   node scripts/summarize-suite.js --dir=reports invest-wire trade-wallet order-history

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const names = [];
  let dir = 'reports';
  for (const arg of argv) {
    const dirMatch = arg.match(/^--dir=(.+)$/);
    if (dirMatch) {
      dir = dirMatch[1];
      continue;
    }
    names.push(arg);
  }
  return { names, dir };
}

function latestReportFor(dir, name) {
  const prefix = `${name}-`;
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort(); // ISO-ish timestamp suffix sorts chronologically
  if (candidates.length === 0) return null;
  return path.join(dir, candidates[candidates.length - 1]);
}

function fmtMs(v) {
  if (v == null || Number.isNaN(v)) return 'N/A';
  return `${Math.round(v)}ms`;
}

function summarizeOne(name, filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const metrics = data.metrics || {};
  const checks = (data.root_group && data.root_group.checks) || [];

  const totalPass = checks.reduce((sum, c) => sum + (c.passes || 0), 0);
  const totalFail = checks.reduce((sum, c) => sum + (c.fails || 0), 0);
  const checkTotal = totalPass + totalFail;
  const checkRate = checkTotal ? (100 * totalPass) / checkTotal : 0;

  const httpFailed = metrics.http_req_failed ? metrics.http_req_failed.values.rate * 100 : null;
  const dur = metrics.http_req_duration ? metrics.http_req_duration.values : {};
  const iterations = metrics.iterations ? metrics.iterations.values.count : null;
  const vusMax = metrics.vus_max ? metrics.vus_max.values.max : null;

  return {
    name,
    file: filePath,
    checkPass: totalPass,
    checkFail: totalFail,
    checkRate,
    httpFailed,
    p95: dur['p(95)'],
    max: dur.max,
    iterations,
    vusMax,
    failingChecks: checks.filter((c) => c.fails > 0).map((c) => `${c.name} (${c.passes}/${c.passes + c.fails})`),
  };
}

function main() {
  const { names, dir } = parseArgs(process.argv.slice(2));
  if (names.length === 0) {
    console.error('Usage: node scripts/summarize-suite.js [--dir=reports] <scenario-name> [<scenario-name> ...]');
    process.exit(1);
  }

  const rows = [];
  for (const name of names) {
    const filePath = latestReportFor(dir, name);
    if (!filePath) {
      console.error(`No report found for "${name}" in ${dir}/ -- skipping.`);
      continue;
    }
    rows.push(summarizeOne(name, filePath));
  }

  if (rows.length === 0) {
    console.error('No reports found for any of the requested scenarios.');
    process.exit(1);
  }

  console.log('');
  console.log('Scenario                    | VUs  | Checks (pass/fail)  | Pass%  | HTTP fail% | p95      | max');
  console.log('-----------------------------|------|----------------------|--------|------------|----------|----------');
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(28)} | ${String(r.vusMax ?? 'N/A').padEnd(4)} | ${`${r.checkPass}/${r.checkFail}`.padEnd(20)} | ${r.checkRate
        .toFixed(1)
        .padStart(5)}% | ${(r.httpFailed ?? 0).toFixed(2).padStart(9)}% | ${fmtMs(r.p95).padStart(8)} | ${fmtMs(r.max).padStart(8)}`
    );
  }
  console.log('');

  for (const r of rows) {
    if (r.failingChecks.length > 0) {
      console.log(`${r.name} -- failing checks:`);
      for (const fc of r.failingChecks) console.log(`  - ${fc}`);
    }
  }
  console.log('');
  console.log('Source reports:');
  for (const r of rows) console.log(`  ${r.name}: ${r.file} (and matching .html)`);
}

main();
