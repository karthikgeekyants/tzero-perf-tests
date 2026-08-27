// Shared load/stress/staircase VU profiles. Select with `-e TEST_TYPE=load`,
// `-e TEST_TYPE=stress`, or `-e TEST_TYPE=staircase`. Every stage duration,
// ramp percentage, and threshold below is overridable via `-e NAME=value` on
// the k6 run command — nothing here should need a code change to retune a run.

export const TEST_TYPE = (__ENV.TEST_TYPE || 'load').toLowerCase();
export const MAX_VUS = Number(__ENV.MAX_VUS || 500);

function envNumber(name, fallback) {
  return Number(__ENV[name] || fallback);
}

function envDuration(name, fallback) {
  return __ENV[name] || fallback;
}

function envSteps(name, fallbackArray) {
  const raw = __ENV[name];
  if (!raw) return fallbackArray;
  return raw.split(',').map((v) => Number(v.trim()));
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
  stress: (() => {
    // Holds at MAX_VUS, then at STRESS_MID_PCT*MAX_VUS, then at
    // STRESS_BREAKPOINT_PCT*MAX_VUS (defaults 1x/2x/3x -> 500/1,000/1,500 at
    // the default MAX_VUS=500) so the raw --out json time-series has a
    // distinct plateau per load step, not just one continuous ramp — see
    // scripts/analyze-run.js for pulling per-step RPS/latency/error-rate and
    // the breaking point out of that plateau structure.
    const midVUs = Math.round(MAX_VUS * envNumber('STRESS_MID_PCT', 2));
    const breakpointVUs = Math.round(MAX_VUS * envNumber('STRESS_BREAKPOINT_PCT', 3));
    return {
      stages: [
        {
          duration: envDuration('STRESS_RAMP_UP_DURATION', '2m'),
          target: Math.round(MAX_VUS * envNumber('STRESS_RAMP_UP_PCT', 0.4)),
        },
        { duration: envDuration('STRESS_TO_TARGET_DURATION', '3m'), target: MAX_VUS },
        { duration: envDuration('STRESS_HOLD_TARGET_DURATION', '2m'), target: MAX_VUS },
        { duration: envDuration('STRESS_TO_MID_DURATION', '2m'), target: midVUs },
        { duration: envDuration('STRESS_HOLD_MID_DURATION', '2m'), target: midVUs },
        { duration: envDuration('STRESS_TO_BREAKPOINT_DURATION', '2m'), target: breakpointVUs },
        { duration: envDuration('STRESS_HOLD_BREAKPOINT_DURATION', '3m'), target: breakpointVUs },
        { duration: envDuration('STRESS_RAMP_DOWN_DURATION', '3m'), target: 0 },
      ],
      thresholds: {
        http_req_failed: [`rate<${envNumber('STRESS_ERROR_RATE_THRESHOLD', 0.05)}`],
        http_req_duration: [`p(95)<${envNumber('STRESS_P95_THRESHOLD_MS', 1500)}`],
      },
    };
  })(),
  staircase: (() => {
    // A fine-grained climb rather than 3 broad plateaus (like `stress`
    // above) -- ramps through each VU level in STAIRCASE_STEPS in turn,
    // holding briefly at each one, so scripts/analyze-run.js's per-bucket
    // breakdown lines up with real, distinct VU levels instead of an
    // interpolated ramp. Steps get finer where flows are already known to
    // break (low end) and coarser higher up, rather than uniform spacing,
    // to find the exact breaking point without burning time re-confirming
    // "still broken" at every step once well past it.
    const steps = envSteps('STAIRCASE_STEPS', [20, 40, 60, 80, 100, 150, 200, 300, 500, 750, 1000]);
    const rampDuration = envDuration('STAIRCASE_RAMP_DURATION', '10s');
    const holdDuration = envDuration('STAIRCASE_HOLD_DURATION', '30s');
    const stages = [];
    for (const target of steps) {
      stages.push({ duration: rampDuration, target });
      stages.push({ duration: holdDuration, target });
    }
    stages.push({ duration: rampDuration, target: 0 });
    return {
      stages,
      thresholds: {
        http_req_failed: [`rate<${envNumber('STAIRCASE_ERROR_RATE_THRESHOLD', 0.05)}`],
        http_req_duration: [`p(95)<${envNumber('STAIRCASE_P95_THRESHOLD_MS', 2000)}`],
      },
    };
  })(),
};

export function buildOptions(extraThresholds = {}) {
  const profile = PROFILES[TEST_TYPE] || PROFILES.load;
  return {
    stages: profile.stages,
    thresholds: { ...profile.thresholds, ...extraThresholds },
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  };
}

// For per-endpoint thresholds in scenario files, e.g.:
//   'http_req_duration{name:SignUp}': [thresholdMs('SIGNUP_P95_THRESHOLD_MS', 1000)]
export function thresholdMs(name, fallback) {
  return `p(95)<${envNumber(name, fallback)}`;
}
