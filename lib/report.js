import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import { TEST_TYPE } from './options.js';

// Shared handleSummary() for every scenario — writes an HTML report (for
// sharing with the client) and a raw JSON summary into reports/, named per
// scenario + test type + timestamp, alongside the usual console output.
export function buildSummary(scenarioName, data) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileBase = `reports/${scenarioName}-${TEST_TYPE}-${timestamp}`;

  return {
    [`${fileBase}.html`]: htmlReport(data),
    [`${fileBase}.json`]: JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
