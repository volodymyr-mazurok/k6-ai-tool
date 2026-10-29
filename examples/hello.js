// A first k6 script: 2 virtual users search the local mock for 10 seconds.
//   npm run mock                                               (terminal 1: starts the mock on port 4010)
//   k6 run -e BASE_URL=http://127.0.0.1:4010 examples/hello.js (terminal 2)
import http from 'k6/http';
import { check, sleep } from 'k6';

// -e BASE_URL=... on the command line lands in __ENV. Nothing is hard-coded, so one script serves any environment.
const BASE_URL = __ENV.BASE_URL;
if (!BASE_URL) throw new Error('BASE_URL is not set: run k6 run -e BASE_URL=http://127.0.0.1:4010 examples/hello.js');

export const options = {
  vus: 2, // two virtual users run default() in parallel...
  duration: '10s', // ...in a loop, for ten seconds
  thresholds: {
    http_req_failed: ['rate<0.01'], // pass/fail rules: under 1% failed requests
    http_req_duration: ['p(95)<500'], // and 95 out of 100 requests faster than 500 ms
  },
};

// setup() runs once before the load. Log in here, never inside default(): one token request, not one per iteration.
export function setup() {
  const login = http.post(`${BASE_URL}/oauth/token`, { grant_type: 'password', username: 'perf', password: 'perf' });
  return { token: login.json('access_token') };
}

// default() is one iteration of one virtual user. k6 calls it again and again until the duration is over.
export default function (data) {
  const params = { headers: { Authorization: `Bearer ${data.token}`, 'Content-Type': 'application/json' } };
  const res = http.post(`${BASE_URL}/api/items/search`, JSON.stringify({ search: 'item' }), params);
  // A check records pass or fail and never stops the test. Check the content, not only the status:
  // an error page can answer 200.
  check(res, {
    'status is 200': (r) => r.status === 200,
    'answer lists items': hasItems,
  });
  sleep(1); // think time: a real person reads the page before the next click
}

// A check must answer false, never throw: an exception ends the iteration before sleep(1), and the loop would hammer the server.
function hasItems(res) {
  try {
    return res.json('items').length > 0;
  } catch (_err) {
    return false; // not JSON, or no items in it
  }
}
