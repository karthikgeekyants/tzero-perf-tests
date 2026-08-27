#!/usr/bin/env node
// Turns a raw k6 `--out json=<file>` time-series dump into the per-load-step
// breakdown the end-of-run HTML/JSON summary (lib/report.js) can't give you:
// RPS/response time at each stage plateau (500/1,000/1,500 VUs), the
// breaking point, recovery time, the response-time degradation curve, error
// rate at peak, and a failure-type breakdown (timeout / connection error /
// 4xx / 5xx).
//
// The stress profile in lib/options.js holds VUs steady at each load step
// specifically so those plateaus show up as distinct buckets here.
//
// NOT covered here, and can't be: server-side CPU/memory. k6 only sees HTTP
// responses — it has no visibility into the backend process. This script
// prints the run's UTC time window specifically so that range can be handed
// to whoever owns the backend's own monitoring (Datadog/CloudWatch/Grafana)
// to pull for the same window.
//
// Usage:
//   k6 run -e TEST_TYPE=stress --out json=reports/raw-trade-stress.ndjson scenarios/04-trade-wallet.js
//   node scripts/analyze-run.js reports/raw-trade-stress.ndjson
//   node scripts/analyze-run.js reports/raw-trade-stress.ndjson --bucket=30 --error-threshold=0.05 --p95-threshold=2000 --recovery-consecutive=2

const fs = require('fs');
const readline = require('readline');
const path = require('path');

function parseArgs(argv) {
  const [file, ...rest] = argv;
  const opts = { bucketSeconds: 30, errorThreshold: 0.05, p95Threshold: 2000, recoveryConsecutive: 2 };
  for (const arg of rest) {
    const [flag, value] = arg.replace(/^--/, '').split('=');
    if (flag === 'bucket') opts.bucketSeconds = Number(value);
    if (flag === 'error-threshold') opts.errorThreshold = Number(value);
    if (flag === 'p95-threshold') opts.p95Threshold = Number(value);
    if (flag === 'recovery-consecutive') opts.recoveryConsecutive = Number(value);
  }
  return { file, ...opts };
}

function parseK6Time(timeStr) {
  // k6's json output uses RFC3339 with microsecond/nanosecond precision
  // (e.g. "2026-08-19T10:00:00.123456789Z"), which Date.parse chokes on —
  // truncate the fractional seconds to milliseconds first.
  const match = timeStr.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.(\d+))?Z?$/);
  if (!match) return Date.parse(timeStr);
  const fraction = (match[3] || '0').padEnd(3, '0').slice(0, 3);
  return Date.parse(`${match[1]}.${fraction}Z`);
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return Math.round(sortedValues[Math.max(0, index)]);
}

function classifyFailure(tags) {
  const status = Number(tags.status || 0);
  if (status === 0) return tags.error || 'connection error / timeout';
  if (status >= 500) return `5xx (${status})`;
  if (status >= 400) return `4xx (${status})`;
  return `unexpected status ${status}`;
}

async function main() {
  const { file, bucketSeconds, errorThreshold, p95Threshold, recoveryConsecutive } = parseArgs(process.argv.slice(2));
  if (!file) {
    console.error('Usage: node scripts/analyze-run.js <k6-raw-json-output> [--bucket=30] [--error-threshold=0.05] [--p95-threshold=2000] [--recovery-consecutive=2]');
    process.exit(1);
  }

  const buckets = new Map(); // bucketIndex -> { vus: [], durations: [], reqCount: 0, failCount: 0, failureTypes: Map }
  let runStartMs = null;
  let runEndMs = null;

  function getBucket(timeMs) {
    if (runStartMs === null) runStartMs = timeMs;
    const index = Math.floor((timeMs - runStartMs) / (bucketSeconds * 1000));
    if (!buckets.has(index)) {
      buckets.set(index, { vus: [], durations: [], reqCount: 0, failCount: 0, failureTypes: new Map() });
    }
    return buckets.get(index);
  }

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let lineCount = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let point;
    try {
      point = JSON.parse(line);
    } catch {
      continue;
    }
    if (point.type !== 'Point') continue;
    lineCount++;

    const timeMs = parseK6Time(point.data.time);
    runEndMs = runEndMs === null ? timeMs : Math.max(runEndMs, timeMs);
    const bucket = getBucket(timeMs);
    const tags = point.data.tags || {};

    if (point.metric === 'vus') {
      bucket.vus.push(point.data.value);
    } else if (point.metric === 'http_req_duration') {
      bucket.durations.push(point.data.value);
    } else if (point.metric === 'http_req_failed') {
      bucket.reqCount++;
      if (point.data.value === 1) {
        bucket.failCount++;
        const label = classifyFailure(tags);
        bucket.failureTypes.set(label, (bucket.failureTypes.get(label) || 0) + 1);
      }
    }
  }

  if (lineCount === 0) {
    console.error(`No Point records found in ${file} — did you run k6 with --out json=<file>?`);
    process.exit(1);
  }

  const sortedIndexes = [...buckets.keys()].sort((a, b) => a - b);
  const rows = [];
  const failureTypeTotals = new Map();
  let breakingPoint = null;

  for (const index of sortedIndexes) {
    const b = buckets.get(index);
    const durations = [...b.durations].sort((a, c) => a - c);
    const avgVus = b.vus.length ? Math.round(b.vus.reduce((s, v) => s + v, 0) / b.vus.length) : null;
    const rps = +(b.reqCount / bucketSeconds).toFixed(1);
    const errorRate = b.reqCount ? b.failCount / b.reqCount : 0;
    const p95 = percentile(durations, 95);

    for (const [label, count] of b.failureTypes) {
      failureTypeTotals.set(label, (failureTypeTotals.get(label) || 0) + count);
    }

    if (!breakingPoint && (errorRate > errorThreshold || (p95 !== null && p95 > p95Threshold))) {
      breakingPoint = { index, vus: avgVus, errorRate, p95, failureTypes: new Map(b.failureTypes) };
    }

    rows.push({
      't+sec': index * bucketSeconds,
      vus: avgVus,
      rps,
      'min(ms)': durations.length ? Math.round(durations[0]) : null,
      'avg(ms)': durations.length ? Math.round(durations.reduce((s, v) => s + v, 0) / durations.length) : null,
      'p50(ms)': percentile(durations, 50),
      'p95(ms)': p95,
      'p99(ms)': percentile(durations, 99),
      'max(ms)': durations.length ? Math.round(durations[durations.length - 1]) : null,
      'error%': +(errorRate * 100).toFixed(2),
    });
  }

  console.log(`\nDegradation curve (${bucketSeconds}s buckets) — ${file}\n`);
  console.table(rows);

  console.log('\nFailure type breakdown (all buckets):');
  if (failureTypeTotals.size === 0) {
    console.log('  none — no failed requests recorded');
  } else {
    for (const [label, count] of [...failureTypeTotals.entries()].sort((a, c) => c[1] - a[1])) {
      console.log(`  ${count.toString().padStart(6)}  ${label}`);
    }
  }

  console.log('\nBreaking point:');
  if (breakingPoint) {
    console.log(
      `  ~${breakingPoint.vus} VUs (t+${breakingPoint.index * bucketSeconds}s) — ` +
      `error rate ${(breakingPoint.errorRate * 100).toFixed(2)}% (threshold ${(errorThreshold * 100).toFixed(0)}%), ` +
      `p95 ${breakingPoint.p95}ms (threshold ${p95Threshold}ms)`
    );
    console.log('\nFailure type breakdown at breaking point (this bucket only, not the whole run):');
    if (breakingPoint.failureTypes.size === 0) {
      console.log('  none — this bucket crossed on p95 latency alone, not failed requests');
    } else {
      for (const [label, count] of [...breakingPoint.failureTypes.entries()].sort((a, c) => c[1] - a[1])) {
        console.log(`  ${count.toString().padStart(6)}  ${label}`);
      }
    }
  } else {
    console.log(`  not reached — error rate stayed under ${(errorThreshold * 100).toFixed(0)}% and p95 stayed under ${p95Threshold}ms for the whole run`);
  }

  const peakRow = rows.reduce((max, r) => (r.vus !== null && (max === null || r.vus > max.vus) ? r : max), null);
  console.log('\nError rate at peak load:');
  if (peakRow) {
    console.log(`  ${peakRow['error%']}% at ~${peakRow.vus} VUs (t+${peakRow['t+sec']}s, the highest VU level this run reached)`);
  } else {
    console.log('  no VU samples recorded');
  }

  console.log('\nRecovery time:');
  if (!breakingPoint) {
    console.log('  n/a — thresholds were never exceeded, nothing to recover from');
  } else {
    // "Peak" = the load plateau, found from the vus samples already collected
    // rather than assumed stage boundaries, so this works for any profile.
    const peakVus = Math.max(...rows.map((r) => r.vus).filter((v) => v !== null));
    let peakEndPos = 0;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].vus !== null && rows[i].vus >= peakVus * 0.9) peakEndPos = i;
    }

    let recoveredPos = null;
    for (let i = peakEndPos + 1; i <= rows.length - recoveryConsecutive; i++) {
      const window = rows.slice(i, i + recoveryConsecutive);
      const healthy = window.every((r) => r['error%'] <= errorThreshold * 100 && r['p95(ms)'] !== null && r['p95(ms)'] <= p95Threshold);
      if (healthy) {
        recoveredPos = i;
        break;
      }
    }

    if (recoveredPos !== null) {
      const recoverySeconds = rows[recoveredPos]['t+sec'] - rows[peakEndPos]['t+sec'];
      console.log(
        `  ~${recoverySeconds}s — from peak load (t+${rows[peakEndPos]['t+sec']}s, ~${peakVus} VUs) ` +
        `to ${recoveryConsecutive} consecutive healthy buckets starting t+${rows[recoveredPos]['t+sec']}s`
      );
    } else {
      console.log(`  did not recover within the captured run — error rate/p95 hadn't returned under threshold for ${recoveryConsecutive} consecutive buckets by the end of the data. Capture more time after ramp-down (longer STRESS_RAMP_DOWN_DURATION or maxDuration) if you need this number.`);
    }
  }

  console.log('\nRun window (UTC) — hand this range to backend/infra to pull server CPU/memory for the same window (k6 has no visibility into that, this script can\'t derive it):');
  console.log(`  ${new Date(runStartMs).toISOString()} -> ${new Date(runEndMs).toISOString()}`);

  const csvPath = path.join(path.dirname(file), `${path.basename(file, path.extname(file))}-analysis.csv`);
  const header = Object.keys(rows[0]).join(',');
  const csvBody = rows.map((r) => Object.values(r).join(',')).join('\n');
  fs.writeFileSync(csvPath, `${header}\n${csvBody}\n`);
  console.log(`\nCSV written to ${csvPath}`);
}

main();
