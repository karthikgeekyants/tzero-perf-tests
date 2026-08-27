import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import { TEST_TYPE } from './options.js';

// A simple HTML table of the endpoints a scenario exercises, so the report
// is self-contained for sharing (no separate explanation needed for "which
// APIs are we testing"). apiList entries: { step, method, endpoint, description }.
function renderApiListSection(apiList) {
  const rows = apiList
    .map(
      ({ step, method, endpoint, description }) => `
      <tr>
        <td style="padding:6px 12px;border:1px solid #333;">${step}</td>
        <td style="padding:6px 12px;border:1px solid #333;font-family:monospace;">${method}</td>
        <td style="padding:6px 12px;border:1px solid #333;font-family:monospace;">${endpoint}</td>
        <td style="padding:6px 12px;border:1px solid #333;">${description}</td>
      </tr>`
    )
    .join('');

  return `
    <div style="max-width:1100px;margin:24px auto;font-family:sans-serif;">
      <h2 style="margin-bottom:8px;">APIs Tested</h2>
      <table style="border-collapse:collapse;width:100%;">
        <thead>
          <tr>
            <th style="padding:6px 12px;border:1px solid #333;text-align:left;">Step</th>
            <th style="padding:6px 12px;border:1px solid #333;text-align:left;">Method</th>
            <th style="padding:6px 12px;border:1px solid #333;text-align:left;">Endpoint</th>
            <th style="padding:6px 12px;border:1px solid #333;text-align:left;">Description</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ms -> "1.23s" above 1000ms, else "123ms" -- readable for a non-technical audience.
function formatMs(ms) {
  if (ms == null || Number.isNaN(ms)) return 'N/A';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;
}

function metricValues(data, name) {
  return data.metrics && data.metrics[name] && data.metrics[name].values;
}

// "onboarding-individual" -> "Onboarding Individual"
function titleCase(scenarioName) {
  return scenarioName
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Plain-language summary of exactly the numbers the SOW asks for (avg/p95/
// p99/min/max response time, error rate, throughput, concurrent VUs) --
// placed at the TOP of the report so a non-technical reader gets the answer
// immediately, without wading through k6's low-level network-timing rows
// (TCP connect, TLS handshake, etc.) further down. Nothing is removed --
// the full technical detail k6-reporter generates is still below this.
function renderPlainSummarySection(scenarioName, data) {
  const dur = metricValues(data, 'http_req_duration') || {};
  const failed = metricValues(data, 'http_req_failed') || {};
  const reqs = metricValues(data, 'http_reqs') || {};
  const iters = metricValues(data, 'iterations') || {};
  const vusMax = metricValues(data, 'vus_max') || {};

  // Per-step timing -- any http_req_duration{name:X} tag the scenario defined.
  const stepRows = Object.keys(data.metrics || {})
    .filter((k) => k.startsWith('http_req_duration{name:'))
    .map((k) => {
      const stepName = k.slice('http_req_duration{name:'.length, -1);
      const v = data.metrics[k].values;
      return `
        <tr>
          <td style="padding:6px 12px;border:1px solid #333;">${stepName}</td>
          <td style="padding:6px 12px;border:1px solid #333;">${formatMs(v.avg)}</td>
          <td style="padding:6px 12px;border:1px solid #333;">${formatMs(v['p(95)'])}</td>
          <td style="padding:6px 12px;border:1px solid #333;">${formatMs(v['p(99)'])}</td>
          <td style="padding:6px 12px;border:1px solid #333;">${formatMs(v.min)}</td>
          <td style="padding:6px 12px;border:1px solid #333;">${formatMs(v.max)}</td>
        </tr>`;
    })
    .join('');

  const errorRatePct = failed.rate != null ? (failed.rate * 100).toFixed(2) : 'N/A';

  return `
    <div style="max-width:1100px;margin:24px auto;font-family:sans-serif;">
      <h1 style="margin-bottom:4px;">${titleCase(scenarioName)} — Summary</h1>
      <p style="color:#666;margin-top:0;">Plain-language results. Full technical detail is further down this page.</p>

      <h2 style="margin-bottom:8px;">Overall response time</h2>
      <table style="border-collapse:collapse;width:100%;margin-bottom:20px;">
        <thead>
          <tr>
            <th style="padding:6px 12px;border:1px solid #333;text-align:left;">Average</th>
            <th style="padding:6px 12px;border:1px solid #333;text-align:left;">p95</th>
            <th style="padding:6px 12px;border:1px solid #333;text-align:left;">p99</th>
            <th style="padding:6px 12px;border:1px solid #333;text-align:left;">Min</th>
            <th style="padding:6px 12px;border:1px solid #333;text-align:left;">Max</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding:6px 12px;border:1px solid #333;">${formatMs(dur.avg)}</td>
            <td style="padding:6px 12px;border:1px solid #333;">${formatMs(dur['p(95)'])}</td>
            <td style="padding:6px 12px;border:1px solid #333;">${formatMs(dur['p(99)'])}</td>
            <td style="padding:6px 12px;border:1px solid #333;">${formatMs(dur.min)}</td>
            <td style="padding:6px 12px;border:1px solid #333;">${formatMs(dur.max)}</td>
          </tr>
        </tbody>
      </table>

      ${
        stepRows
          ? `<h2 style="margin-bottom:8px;">Response time by step</h2>
      <table style="border-collapse:collapse;width:100%;margin-bottom:20px;">
        <thead>
          <tr>
            <th style="padding:6px 12px;border:1px solid #333;text-align:left;">Step</th>
            <th style="padding:6px 12px;border:1px solid #333;text-align:left;">Average</th>
            <th style="padding:6px 12px;border:1px solid #333;text-align:left;">p95</th>
            <th style="padding:6px 12px;border:1px solid #333;text-align:left;">p99</th>
            <th style="padding:6px 12px;border:1px solid #333;text-align:left;">Min</th>
            <th style="padding:6px 12px;border:1px solid #333;text-align:left;">Max</th>
          </tr>
        </thead>
        <tbody>${stepRows}</tbody>
      </table>`
          : ''
      }

      <h2 style="margin-bottom:8px;">Error rate, throughput &amp; scale</h2>
      <table style="border-collapse:collapse;width:100%;">
        <thead>
          <tr>
            <th style="padding:6px 12px;border:1px solid #333;text-align:left;">Error rate</th>
            <th style="padding:6px 12px;border:1px solid #333;text-align:left;">Throughput (RPS)</th>
            <th style="padding:6px 12px;border:1px solid #333;text-align:left;">Concurrent VUs (peak)</th>
            <th style="padding:6px 12px;border:1px solid #333;text-align:left;">Total requests</th>
            <th style="padding:6px 12px;border:1px solid #333;text-align:left;">Total iterations</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding:6px 12px;border:1px solid #333;">${errorRatePct}%</td>
            <td style="padding:6px 12px;border:1px solid #333;">${reqs.rate != null ? reqs.rate.toFixed(2) : 'N/A'}/s</td>
            <td style="padding:6px 12px;border:1px solid #333;">${vusMax.value != null ? vusMax.value : 'N/A'}</td>
            <td style="padding:6px 12px;border:1px solid #333;">${reqs.count != null ? reqs.count : 'N/A'}</td>
            <td style="padding:6px 12px;border:1px solid #333;">${iters.count != null ? iters.count : 'N/A'}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <hr style="max-width:1100px;margin:32px auto;border:none;border-top:2px solid #ddd;" />`;
}

// Shared handleSummary() for every scenario — writes an HTML report (for
// sharing with the client) and a raw JSON summary into reports/, named per
// scenario + test type + timestamp, alongside the usual console output.
// A plain-language summary (exactly the metrics the SOW asks for) is
// inserted at the TOP of the report, and apiList (optional) as a table at
// the bottom -- both alongside k6-reporter's own full technical detail,
// nothing removed, just made accessible to a non-technical reader too.
export function buildSummary(scenarioName, data, apiList) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileBase = `reports/${scenarioName}-${TEST_TYPE}-${timestamp}`;

  let html = htmlReport(data);

  const summarySection = renderPlainSummarySection(scenarioName, data);
  html = html.includes('<body>')
    ? html.replace('<body>', `<body>${summarySection}`)
    : summarySection + html;

  if (apiList && apiList.length > 0) {
    const apiSection = renderApiListSection(apiList);
    html = html.includes('</body>') ? html.replace('</body>', `${apiSection}</body>`) : html + apiSection;
  }

  return {
    [`${fileBase}.html`]: html,
    [`${fileBase}.json`]: JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
