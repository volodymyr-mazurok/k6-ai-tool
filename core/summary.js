// End-of-test summary. k6 only. Project scripts re-export it: `export { handleSummary } from '…/core/summary.js'`.
// With handleSummary defined k6 prints no end-of-test text; the report is built from summary.json.

/**
 * @param {Record<string, unknown>} data k6 summary data
 * @returns {Record<string, string>} file path -> content
 */
export function handleSummary(data) {
  if (!__ENV.PERF_RUN_DIR) throw new Error('PERF_RUN_DIR not set — start runs with: npm run perf -- run …');
  // k6 adds the return value of setup() to the summary as setup_data. Ours holds the bearer and refresh tokens, and
  // summary.json is linked from shareable reports, so the whole key is dropped, never redacted selectively.
  const { setup_data: _setupData, ...safe } = data;
  return { [__ENV.PERF_RUN_DIR + '/summary.json']: JSON.stringify(safe) };
}
