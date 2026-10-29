// k6 threshold options. Pure ES module with no k6 imports.

const PROFILE_TYPES = ['smoke', 'load', 'stress', 'soak'];

/**
 * Thresholds for a run.
 *
 * Each step id gets three no-op submetric thresholds (they always pass). k6 only writes a tagged
 * submetric into the end-of-test summary when a threshold references it, so these are what put
 * per-step stats into summary.json.
 *
 * @param {object} args
 * @param {string[]} args.stepIds step ids as used in the `name` tag, including `auth_token`
 * @param {'smoke'|'load'|'stress'|'soak'} args.profileType
 * @param {{ errorRate: number, p95Ms: number }} args.abort
 * @returns {Record<string, Array<string | { threshold: string, abortOnFail: boolean, delayAbortEval: string }>>}
 */
export function buildThresholds({ stepIds, profileType, abort }) {
  if (!PROFILE_TYPES.includes(profileType)) throw new Error(`unknown profile type ${profileType}`);
  /** @type {Record<string, any[]>} */
  const thresholds = {};
  for (const id of stepIds) {
    thresholds[`http_req_duration{name:${id}}`] = ['max>=0'];
    thresholds[`http_req_failed{name:${id}}`] = ['rate>=0'];
    thresholds[`checks{name:${id}}`] = ['rate>=0'];
  }
  if (profileType === 'smoke') {
    thresholds.checks = ['rate==1'];
    thresholds.http_req_failed = ['rate==0'];
  } else {
    thresholds.http_req_failed = [
      { threshold: 'rate<' + abort.errorRate, abortOnFail: true, delayAbortEval: '30s' },
    ];
    thresholds.http_req_duration = [
      { threshold: 'p(95)<' + abort.p95Ms, abortOnFail: true, delayAbortEval: '60s' },
    ];
  }
  return thresholds;
}
