// Turns a resolved profile into k6 scenarios. Pure ES module with no k6 imports.

export class CapsError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'CapsError';
  }
}

/**
 * Split `total` users over journeys by their mix share (largest remainder).
 * A journey with share 0 gets 0. When `total` is at least the number of journeys with a share,
 * each of them gets at least 1.
 *
 * @param {number} total
 * @param {Record<string, number>} mix journey name -> share (percent)
 * @returns {Record<string, number>}
 */
export function splitUsers(total, mix) {
  const names = Object.keys(mix);
  /** @type {Record<string, number>} */
  const out = {};
  for (const name of names) out[name] = 0;
  const shareSum = names.reduce((sum, name) => sum + Math.max(0, mix[name]), 0);
  if (!(total > 0) || shareSum <= 0) return out;

  const withShare = names.filter((name) => mix[name] > 0);
  const quota = {};
  let assigned = 0;
  for (const name of withShare) {
    quota[name] = (total * mix[name]) / shareSum;
    out[name] = Math.floor(quota[name]);
    assigned += out[name];
  }
  // hand the leftovers to the biggest fractional parts; ties go to the earlier journey
  const frac = (name) => quota[name] - Math.floor(quota[name]);
  const order = (name) => withShare.indexOf(name);
  const byRemainder = [...withShare].sort((a, b) => frac(b) - frac(a) || order(a) - order(b));
  for (let i = 0; assigned < total; i++) {
    out[byRemainder[i % byRemainder.length]] += 1;
    assigned += 1;
  }
  // every journey with a share runs at least one user when there are enough users to go round
  if (total >= withShare.length) {
    for (const name of withShare) {
      if (out[name] >= 1) continue;
      const donor = [...withShare].sort((a, b) => out[b] - out[a] || order(a) - order(b))[0];
      out[donor] -= 1;
      out[name] = 1;
    }
  }
  return out;
}

/**
 * Build the k6 `scenarios` and `rps` options for a profile.
 *
 * @param {object} args
 * @param {{ type: 'smoke'|'load'|'stress'|'soak', users?: number, rampSec?: number, holdSec?: number,
 *   rampDownSec?: number, stages?: { fromSec: number, rps: number }[], totalSec: number,
 *   holdWindow?: { fromSec: number, toSec: number } }} args.profile
 * @param {{ name: string, exec: string }[]} args.journeys
 * @param {Record<string, number>} args.mix journey name -> share (percent)
 * @param {{ maxVus: number, maxRps: number }} args.caps
 * @param {Record<string, number>} args.stepsPerIteration journey name -> requests per iteration
 * @param {number} [args.rps] k6's rps option as the runner decided it (RunConfig.rps: the env's defaults.rps for a load or
 *   soak without --allow-max); absent means caps.maxRps
 * @returns {{ scenarios: Record<string, object>, rps: number }}
 * @throws {CapsError} when the profile or the rps option would exceed the caps
 */
export function buildScenarios({ profile, journeys, mix, caps, stepsPerIteration, rps }) {
  const rpsOption = rps === undefined ? caps.maxRps : rps;
  if (!(rpsOption > 0) || rpsOption > caps.maxRps) throw new CapsError(`rps option ${rpsOption} exceeds max_rps ${caps.maxRps}`);
  /** @type {Record<string, object>} */
  const scenarios = {};
  switch (profile.type) {
    case 'smoke': {
      if (journeys.length > caps.maxVus) {
        throw new CapsError(`users ${journeys.length} exceeds max_vus ${caps.maxVus}`);
      }
      for (const j of journeys) {
        scenarios[j.name] = { executor: 'per-vu-iterations', exec: j.exec, vus: 1, iterations: 1 };
      }
      break;
    }
    case 'load':
    case 'soak': {
      const users = profile.users ?? 0;
      if (users > caps.maxVus) throw new CapsError(`users ${users} exceeds max_vus ${caps.maxVus}`);
      const split = splitUsers(users, mix);
      for (const j of journeys) {
        const n = split[j.name] ?? 0;
        if (n < 1) continue;
        scenarios[j.name] = {
          executor: 'ramping-vus',
          exec: j.exec,
          startVUs: 0,
          stages: [
            { duration: profile.rampSec + 's', target: n },
            { duration: profile.holdSec + 's', target: n },
            { duration: profile.rampDownSec + 's', target: 0 },
          ],
        };
      }
      break;
    }
    case 'stress': {
      const levels = profile.stages ?? [];
      const peak = levels.reduce((max, s) => Math.max(max, s.rps), 0);
      if (peak > caps.maxRps) throw new CapsError(`rate ${peak} req/s exceeds max_rps ${caps.maxRps}`);
      const vus = splitUsers(caps.maxVus, mix);
      for (const j of journeys) {
        const share = mix[j.name] ?? 0;
        if (!(share > 0) || (vus[j.name] ?? 0) < 1) continue;
        const steps = stepsPerIteration[j.name];
        if (!(steps > 0)) throw new Error(`stepsPerIteration for journey ${j.name} must be a positive number`);
        // iterations per minute = req/s x share x 60 / requests per iteration
        const stages = levels.map((level, i) => {
          const endSec = i + 1 < levels.length ? levels[i + 1].fromSec : profile.totalSec;
          return {
            duration: endSec - level.fromSec + 's',
            target: Math.round((level.rps * share * 60) / (100 * steps)),
          };
        });
        scenarios[j.name] = {
          executor: 'ramping-arrival-rate',
          exec: j.exec,
          timeUnit: '1m',
          startRate: stages.length > 0 ? stages[0].target : 0,
          preAllocatedVUs: vus[j.name],
          maxVUs: vus[j.name],
          stages,
        };
      }
      break;
    }
    default:
      throw new Error(`unknown profile type ${profile.type}`);
  }
  return { scenarios, rps: rpsOption };
}
