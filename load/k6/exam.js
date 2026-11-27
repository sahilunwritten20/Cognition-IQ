// Cognition IQ load test (guide Section 12). Run with k6 from a SEPARATE machine against STAGING (never production).
// Data comes from `npm run load:seed -w server -- --yes` (writes load/data/users.json and meta.json).
//
//   k6 run -e BASE_URL=https://staging.college.edu -e SCENARIOS=exam,monitor \
//          --console-output=load/results/acks.log load/k6/exam.js
//   npm run load:verify -w server -- --quiz <quizId from load/data/meta.json> --acks ../load/results/acks.log
//
// Scenarios (comma-separated in SCENARIOS): exam | login_storm | monitor | results
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';

const BASE = (__ENV.BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const ORIGIN = __ENV.CLIENT_ORIGIN || 'http://localhost:5173';
const meta = JSON.parse(open('../data/meta.json'));
const users = new SharedArray('users', () => JSON.parse(open('../data/users.json')));

const SCENARIOS = (__ENV.SCENARIOS || 'exam,monitor').split(',').map((s) => s.trim());
const USERS = Math.min(Number(__ENV.USERS || users.length), users.length);
const LOGIN_SPREAD = Number(__ENV.LOGIN_SPREAD_SECONDS || 120); // pre-login window (the guide's mitigation for the login storm)
const START_SPREAD = Number(__ENV.START_SPREAD_SECONDS || 30); // "mass start": EVERYONE starts within this many seconds of each other
const ABANDON_PERCENT = Number(__ENV.ABANDON_PERCENT || 0); // % of students who close the laptop right after starting (exercises the deadline sweeper)
const EXAM_SECONDS = Number(__ENV.EXAM_SECONDS || 300); // how long each student keeps working (a real exam: 1800-2700)
const AUTOSAVE_SECONDS = Number(__ENV.AUTOSAVE_SECONDS || 20);
const MONITOR_VUS = Number(__ENV.MONITOR_VUS || 20); // "20+ teachers polling the monitor"
const STORM_RATE = Number(__ENV.STORM_RATE || 50); // logins per second in the login_storm scenario
const STORM_SECONDS = Number(__ENV.STORM_SECONDS || 60);
const RESULT_SPREAD = Number(__ENV.RESULT_SPREAD_SECONDS || 60);
const ACCESS_CODE = __ENV.ACCESS_CODE || '';

http.setResponseCallback(http.expectedStatuses(200, 201, 204));
const failedLogins = new Counter('failed_logins');

const allScenarios = {
  exam: { executor: 'per-vu-iterations', vus: USERS, iterations: 1, maxDuration: (LOGIN_SPREAD + 10 + START_SPREAD + EXAM_SECONDS + 600) + 's', exec: 'student' },
  login_storm: {
    executor: 'ramping-arrival-rate', startRate: 1, timeUnit: '1s', preAllocatedVUs: 200, maxVUs: 2000, exec: 'loginOnly',
    stages: [{ target: STORM_RATE, duration: '30s' }, { target: STORM_RATE, duration: STORM_SECONDS + 's' }, { target: 0, duration: '10s' }],
  },
  monitor: { executor: 'constant-vus', vus: MONITOR_VUS, duration: (LOGIN_SPREAD + 10 + START_SPREAD + EXAM_SECONDS) + 's', exec: 'monitor' },
  results: { executor: 'per-vu-iterations', vus: USERS, iterations: 1, maxDuration: '15m', exec: 'viewResults' },
};
const chosen = {};
SCENARIOS.forEach((s) => {
  if (!allScenarios[s]) throw new Error('Unknown scenario: ' + s);
  chosen[s] = allScenarios[s];
});

export const options = {
  scenarios: chosen,
  thresholds: {
    // Guide Section 12 targets: p95 under 500 ms, error rate under 0.1%.
    http_req_failed: ['rate<0.001'],
    checks: ['rate>0.999'],
    'http_req_duration{name:autosave}': ['p(95)<500'],
    'http_req_duration{name:start}': ['p(95)<500'],
    'http_req_duration{name:submit}': ['p(95)<500'],
    'http_req_duration{name:monitor_summary}': ['p(95)<500'],
    'http_req_duration{name:result}': ['p(95)<500'],
    // Login hashes a password (Argon2id, deliberately slow): measured separately and given a looser bound. Tune ARGON2_* from this number.
    'http_req_duration{name:login}': ['p(95)<2000'],
    failed_logins: ['count<1'],
  },
};

function params(token, name) {
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'cognition-iq', Origin: ORIGIN };
  if (token) headers.Authorization = 'Bearer ' + token;
  return { headers: headers, tags: { name: name } };
}

function login(loginId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = http.post(BASE + '/api/v1/auth/login', JSON.stringify({ loginId: loginId, password: meta.password }), params(null, 'login'));
    if (r.status === 200) {
      const token = r.json('accessToken');
      if (token) return token;
    }
    if (r.status === 429 || r.status >= 500) sleep(1 + Math.random() * 2 * (attempt + 1));
    else break;
  }
  return null;
}

// The 15-minute access token expires during a real exam: the browser renews it with the refresh cookie (k6 keeps a cookie jar per VU).
function refresh() {
  const r = http.post(BASE + '/api/v1/auth/refresh', '{}', params(null, 'refresh'));
  return r.status === 200 ? r.json('accessToken') : null;
}

// ---------------------------------------------------------------------------------------------------------------- a student
export function student() {
  const idx = exec.scenario.iterationInInstance; // unique 0..USERS-1 inside this scenario
  const loginId = users[idx];
  const userIndex = Number(String(loginId).split('.')[1]);

  sleep(Math.random() * LOGIN_SPREAD); // students sign in during the pre-login window, not all at the start
  let token = login(loginId);
  if (!token) {
    failedLogins.add(1);
    return;
  }
  // The mass start: nobody starts before the pre-login window is over, then everyone starts within START_SPREAD seconds.
  const syncStart = exec.scenario.startTime + (LOGIN_SPREAD + 10) * 1000;
  const wait = syncStart + Math.random() * START_SPREAD * 1000 - Date.now();
  if (wait > 0) sleep(wait / 1000);

  const body = ACCESS_CODE ? { accessCode: ACCESS_CODE } : {};
  const started = http.post(BASE + '/api/v1/student/quizzes/' + meta.quizId + '/start', JSON.stringify(body), params(token, 'start'));
  if (!check(started, { 'start returns an attempt': (r) => r.status === 200 || r.status === 201 })) return;
  const first = started.json();
  const questions = first.questions;
  const attemptId = first.attempt.id;
  const Q = questions.length;
  const url = BASE + '/api/v1/student/attempts/' + attemptId;

  // ANSWER_PATTERN_VERSION 1 (keep identical to server/src/scripts/load-spec.ts):
  // autosave number `seq` changes question (seq-1) % Q to option (userIndex + questionIndex + seq) % 2.
  let seq = first.attempt.lastSeq || 0;
  let acked = seq;
  const pending = {}; // changes not yet acknowledged: every request is CUMULATIVE
  let lastChange = null;
  let tick = 0;
  const endAt = Date.now() + EXAM_SECONDS * 1000;

  if (idx % 100 < ABANDON_PERCENT) {
    // This student closes the laptop: no more requests. Only the deadline sweeper (or lazy finalization) can close the attempt.
    console.log(JSON.stringify({ ack: true, user: userIndex, seq: 0 }));
    return;
  }

  while (Date.now() < endAt) {
    sleep(AUTOSAVE_SECONDS + (Math.random() * 6 - 3));
    tick++;
    seq++;
    const qi = (seq - 1) % Q;
    const oi = (userIndex + qi + seq) % 2;
    const change = { questionId: questions[qi].questionId, selectedOptionId: questions[qi].options[oi].optionId };
    pending[change.questionId] = change.selectedOptionId;
    const answers = Object.keys(pending).map((qid) => ({ questionId: qid, selectedOptionId: pending[qid] }));
    const payload = JSON.stringify({ seq: seq, answers: answers });

    let r = http.put(url + '/answers', payload, params(token, 'autosave'));
    if (r.status === 401) {
      const renewed = refresh();
      if (renewed) {
        token = renewed;
        r = http.put(url + '/answers', payload, params(token, 'autosave'));
      }
    }
    if (check(r, { 'autosave acknowledged': (x) => x.status === 200 && x.json('ok') === true })) {
      acked = seq;
      Object.keys(pending).forEach((k) => delete pending[k]);
      if (tick % 7 === 0) {
        // the response was "lost" and the browser retries the same request: must be a harmless success
        const dup = http.put(url + '/answers', payload, params(token, 'autosave_retry'));
        check(dup, { 'retry of an applied save is a harmless stale ok': (x) => x.status === 200 && x.json('stale') === true });
      }
      if (tick % 11 === 0 && lastChange) {
        // an OLDER request arrives late (out of order): must be ignored without error
        const late = http.put(url + '/answers', JSON.stringify({ seq: seq - 1, answers: [lastChange] }), params(token, 'autosave_retry'));
        check(late, { 'late older request is ignored': (x) => x.status === 200 && x.json('stale') === true });
      }
      lastChange = change;
    } else if (r.status === 409) {
      break; // ATTEMPT_FINISHED / TIME_UP: the attempt is over
    } // otherwise (429, 5xx, network): keep `pending` and resend it, merged, on the next tick
  }

  // Submit; if the last autosave was not acknowledged, carry the final cumulative answers with it.
  const final = Object.keys(pending).length > 0;
  const submitBody = final ? { seq: seq, answers: Object.keys(pending).map((qid) => ({ questionId: qid, selectedOptionId: pending[qid] })) } : {};
  const sub = http.post(url + '/submit', JSON.stringify(submitBody), params(token, 'submit'));
  if (check(sub, { 'submit succeeds': (x) => x.status === 200 }) && final && sub.json('lateRejected') === false) acked = seq;

  // Read by `npm run load:verify`: the last autosave the SERVER acknowledged to this student.
  console.log(JSON.stringify({ ack: true, user: userIndex, seq: acked }));
}

// ---------------------------------------------------------------------------------------------------------------- login storm
export function loginOnly() {
  const loginId = users[Math.floor(Math.random() * users.length)];
  const token = login(loginId);
  check(token, { 'login succeeded': (t) => !!t });
  if (!token) failedLogins.add(1);
}

// ---------------------------------------------------------------------------------------------------------------- teachers watching
let teacherToken = null;
export function monitor() {
  if (!teacherToken) {
    teacherToken = login(meta.teacherLogin);
    if (!teacherToken) {
      failedLogins.add(1);
      sleep(5);
      return;
    }
  }
  const quick = http.get(BASE + '/api/v1/quizzes/' + meta.quizId + '/monitor?view=summary', params(teacherToken, 'monitor_summary'));
  check(quick, { 'monitor summary ok': (r) => r.status === 200 });
  if (quick.status === 401) teacherToken = null; // token expired: sign in again next round
  if (exec.scenario.iterationInInstance % 6 === 0) {
    const full = http.get(BASE + '/api/v1/quizzes/' + meta.quizId + '/monitor?pageSize=100', params(teacherToken, 'monitor_full'));
    check(full, { 'monitor page ok': (r) => r.status === 200 || r.status === 401 });
  }
  sleep(10); // the page's pollAfterSeconds
}

// ---------------------------------------------------------------------------------------------------------------- results (after the teacher published)
export function viewResults() {
  const loginId = users[exec.scenario.iterationInInstance];
  sleep(Math.random() * RESULT_SPREAD);
  const token = login(loginId);
  if (!token) {
    failedLogins.add(1);
    return;
  }
  check(http.get(BASE + '/api/v1/student/results', params(token, 'result')), { 'results list ok': (r) => r.status === 200 });
  check(http.get(BASE + '/api/v1/student/quizzes/' + meta.quizId + '/result', params(token, 'result')), { 'result ok': (r) => r.status === 200 });
}

// ---------------------------------------------------------------------------------------------------------------- summary
function line(data, metric, label) {
  const m = data.metrics[metric];
  if (!m || !m.values) return null;
  const v = m.values;
  return label + ': p50=' + Math.round(v.med || 0) + 'ms  p95=' + Math.round(v['p(95)'] || 0) + 'ms  p99=' + Math.round(v['p(99)'] || 0) + 'ms  max=' + Math.round(v.max || 0) + 'ms';
}
export function handleSummary(data) {
  const lines = ['', 'Cognition IQ load test summary'];
  ['http_req_duration{name:login}', 'http_req_duration{name:start}', 'http_req_duration{name:autosave}', 'http_req_duration{name:submit}', 'http_req_duration{name:monitor_summary}', 'http_req_duration{name:result}'].forEach((k) => {
    const l = line(data, k, k.replace('http_req_duration{name:', '').replace('}', ''));
    if (l) lines.push('  ' + l);
  });
  const failed = data.metrics.http_req_failed && data.metrics.http_req_failed.values ? data.metrics.http_req_failed.values.rate : 0;
  lines.push('  http error rate: ' + (failed * 100).toFixed(3) + '%   checks passed: ' + (((data.metrics.checks && data.metrics.checks.values.rate) || 0) * 100).toFixed(3) + '%');
  lines.push('  requests/s (mean): ' + Math.round((data.metrics.http_reqs && data.metrics.http_reqs.values.rate) || 0));
  lines.push('Now run:  npm run load:verify -w server -- --quiz ' + meta.quizId + ' --acks ../load/results/acks.log', '');
  const out = {};
  out['load/results/last-summary.json'] = JSON.stringify(data, null, 2);
  out.stdout = lines.join('\n');
  return out;
}
