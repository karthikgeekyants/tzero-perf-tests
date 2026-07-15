// Shared load/stress VU profiles. Select with `-e TEST_TYPE=load` or `-e TEST_TYPE=stress`.
// Every stage duration, ramp percentage, and threshold below is overridable via
// `-e NAME=value` on the k6 run command — nothing here should need a code
// change to retune a run.

export const TEST_TYPE = (__ENV.TEST_TYPE || 'load').toLowerCase();
export const MAX_VUS = Number(__ENV.MAX_VUS || 500);

function envNumber(name, fallback) {
  return Number(__ENV[name] || fallback);
}

function envDuration(name, fallback) {
  return __ENV[name] || fallback;
}

const PROFILES = {
  load: {
    stages: [
      {
        duration: envDuration('LOAD_RAMP_UP_DURATION', '2m'),
        target: Math.round(MAX_VUS * envNumber('LOAD_RAMP_UP_PCT', 0.2)),
      },
      { duration: envDuration('LOAD_TO_TARGET_DURATION', '3m'), target: MAX_VUS },
      { duration: envDuration('LOAD_HOLD_DURATION', '5m'), target: MAX_VUS },
      { duration: envDuration('LOAD_RAMP_DOWN_DURATION', '2m'), target: 0 },
    ],
    thresholds: {
      http_req_failed: [`rate<${envNumber('LOAD_ERROR_RATE_THRESHOLD', 0.01)}`],
      http_req_duration: [`p(95)<${envNumber('LOAD_P95_THRESHOLD_MS', 800)}`],
    },
  },
  stress: {
    stages: [
      {
        duration: envDuration('STRESS_RAMP_UP_DURATION', '2m'),
        target: Math.round(MAX_VUS * envNumber('STRESS_RAMP_UP_PCT', 0.4)),
      },
      { duration: envDuration('STRESS_TO_TARGET_DURATION', '3m'), target: MAX_VUS },
      {
        duration: envDuration('STRESS_BREAKPOINT_DURATION', '5m'),
        target: Math.round(MAX_VUS * envNumber('STRESS_BREAKPOINT_PCT', 1.5)), // push past target to find breaking point
      },
      { duration: envDuration('STRESS_RAMP_DOWN_DURATION', '3m'), target: 0 },
    ],
    thresholds: {
      http_req_failed: [`rate<${envNumber('STRESS_ERROR_RATE_THRESHOLD', 0.05)}`],
      http_req_duration: [`p(95)<${envNumber('STRESS_P95_THRESHOLD_MS', 1500)}`],
    },
  },
};

export function buildOptions(extraThresholds = {}) {
  const profile = PROFILES[TEST_TYPE] || PROFILES.load;
  return {
    stages: profile.stages,
    thresholds: { ...profile.thresholds, ...extraThresholds },
  };
}

// For per-endpoint thresholds in scenario files, e.g.:
//   'http_req_duration{name:SignUp}': [thresholdMs('SIGNUP_P95_THRESHOLD_MS', 1000)]
export function thresholdMs(name, fallback) {
  return `p(95)<${envNumber(name, fallback)}`;
}
