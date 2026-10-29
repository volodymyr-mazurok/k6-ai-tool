// Project and feature configuration: reads projects/<name>/project.yaml and features/<f>/{journey,workload}.yaml,
// validates them and returns plain objects. YAML keys are snake_case, the objects are camelCase, and every duration
// ("2m") is turned into seconds here, so everything after config loading works in seconds.

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELFTEST_DIR = join(REPO_ROOT, 'runner', 'selftest', 'project');

export interface EnvConfig {
  appUrl?: string;
  apiUrl: string;
  swaggerUrl?: string;
  caps: { maxVus: number; maxRps: number; maxDurationSec: number };
  defaults: { vus: number; rps: number };
  /** Load window in UTC. `weekdays` is `HH:MM-HH:MM` (may wrap past midnight). Absent means no window. */
  windowUtc?: { weekdays: string; weekends: 'all-day' | 'none' };
}

/** The limits that abort a run: the k6 thresholds (error rate, p95) and the shared-DB guard (CPU or data IO, percent). */
export interface AbortLimits {
  /** Share of failed requests, 0..1 (k6 threshold `rate<`, cumulative from the start). */
  errorRate: number;
  /** p95 of all requests, ms (k6 threshold `p(95)<`). */
  p95Ms: number;
  /**
   * CPU or data IO of the shared DB, percent, sustained for 4 samples in a row. Optional in project.yaml for a project
   * without a database; a run that finds a database without it is refused (it fails closed, see run.ts openDb).
   */
  dbCpuOrIoPct?: number;
}

/** OAuth password grant: a token per account from a token endpoint (the adapter supplies url, client id, scope and accounts). */
export interface RopcAuthConfig {
  type: 'ropc';
}

/**
 * The same header on every request, no login. `value` is a template: `${random:N}` becomes N random letters and digits,
 * made once per virtual user inside k6; `${env:NAME}` becomes the environment variable NAME (`.env` fills it), read by the
 * runner and handed to k6 through the secrets file, never through the run config.
 */
export interface StaticHeaderAuthConfig {
  type: 'static_header';
  header: string;
  value: string;
}

export type AuthConfig = RopcAuthConfig | StaticHeaderAuthConfig;

export interface Project {
  name: string;
  /** Absolute folder of project.yaml. */
  dir: string;
  /** Free-form options for the project's own adapter (`adapter_options:` in project.yaml), passed through untouched. */
  adapterOptions?: Record<string, unknown>;
  /** Roles the project's accounts are named after (the env adapter reads one login/password pair per role). */
  roles?: string[];
  envs: Record<string, EnvConfig>;
  auth: AuthConfig;
  abort: AbortLimits;
  /** POST routes (relative to the API base) that only read, so read-only features may call them. */
  readOnlyPostRoutes: string[];
  /** Tables whose row counts the runner compares before and after a run (the adapter counts them): proof the run left no data. */
  rowCountTables?: string[];
}

export interface Step {
  name: string;
  method: string;
  /** Route relative to the API base url, e.g. `/orders/search`. */
  route: string;
  /** Where the step comes from (HAR entry, swagger, automated test...). Absent evidence is reported by the journey check. */
  evidence?: Record<string, unknown>;
  /** Percent of iterations that run this step, 1..100. */
  optionalShare: number;
}

export interface Journey {
  name: string;
  /** Short id used in step ids: `<key>.<step>`. */
  key: string;
  role: string;
  /** Name of the exported k6 function that runs one iteration of this journey. */
  exec: string;
  evidence?: Record<string, unknown>;
  steps: Step[];
}

/** Ramp up to `users`, hold, ramp down. `users` absent means the env's default. Seconds. */
export interface HoldProfile {
  users?: number;
  rampSec: number;
  holdSec: number;
  rampDownSec: number;
}

/** Arrival rate from `startRps` up to `maxRps` in steps. `maxRps` absent means the env's default rate. Seconds. */
export interface StressProfile {
  startRps: number;
  maxRps?: number;
  stepRps: number;
  stepEverySec: number;
}

export interface Workload {
  businessUnit: string;
  businessAction: string;
  /** Journey name -> percent of users; sums to 100. */
  mix: Record<string, number>;
  thinkTime: { min: number; max: number };
  profiles: { load?: HoldProfile; stress?: StressProfile; soak?: HoldProfile };
  /** `baseline` (compare with the accepted baseline) or explicit per-step targets, keyed by step id. */
  targets: 'baseline' | Record<string, { p95Ms: number }>;
  /** Abort limits this feature changes from the project's (a key that is absent keeps the project's value). */
  abort?: Partial<AbortLimits>;
  /** Free-form description of the standing data the feature is measured against; `perf setup` hands it to the adapter untouched. */
  standingData?: Record<string, unknown>;
}

/** A request a writing feature declares (journey.yaml `writes:`), and who removes what it creates. */
export interface DeclaredWrite {
  method: string;
  route: string;
  /** `app`: the app removes these rows itself (e.g. it prunes a table to its newest rows); nothing for the runner to clean up. */
  cleanup: 'app';
}

export interface Feature {
  name: string;
  /** Absolute folder of the feature. */
  dir: string;
  /** Absolute path of the k6 script, `<dir>/<name>.js`. It is not required to exist at load time. */
  script: string;
  readOnly: boolean;
  journeys: Journey[];
  workload: Workload;
  /**
   * The writes a feature with `read_only: false` declares, each with who cleans up; required (at least one) for such a
   * feature, absent for a read-only one. `perf check` refuses any write step that is not declared here.
   */
  writes?: DeclaredWrite[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Obj = Record<string, unknown>;

/**
 * Seconds in a duration written as a number and a unit: `90s`, `2m`, `1h` (decimals allowed: `0.5s`).
 * @throws {ConfigError} when the text has no unit or an unknown one
 */
export function parseDuration(text: string): number {
  const match = typeof text === 'string' ? /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(text.trim()) : null;
  if (!match) {
    throw new ConfigError(`invalid duration ${JSON.stringify(text)}: write a number and a unit, e.g. 90s, 2m or 1h`);
  }
  const unit = { s: 1, m: 60, h: 3600 }[match[2] as 's' | 'm' | 'h'];
  return Number(match[1]) * unit;
}

/** Field-by-field validation with the file and the YAML path in every error. */
class Reader {
  constructor(private readonly file: string) {}

  fail(where: string, problem: string): never {
    throw new ConfigError(`${this.file}: ${where} ${problem}`);
  }

  obj(value: unknown, where: string): Obj {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) this.fail(where, 'must be a mapping');
    return value as Obj;
  }

  list(value: unknown, where: string): unknown[] {
    if (!Array.isArray(value)) this.fail(where, 'must be a list');
    return value as unknown[];
  }

  text(value: unknown, where: string): string {
    if (typeof value !== 'string' || value.trim() === '') this.fail(where, 'must be a non-empty text');
    return value as string;
  }

  /** A name usable inside metric names and JS identifiers: letters, digits and underscores, starting with a letter. */
  name(value: unknown, where: string): string {
    const text = this.text(value, where);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(text)) {
      this.fail(where, `must be letters, digits and underscores, starting with a letter (got "${text}")`);
    }
    return text;
  }

  bool(value: unknown, where: string): boolean {
    if (typeof value !== 'boolean') this.fail(where, 'must be true or false');
    return value as boolean;
  }

  /** `above` is an exclusive lower bound (`min` is inclusive). */
  num(value: unknown, where: string, opts: { min?: number; above?: number; max?: number; int?: boolean } = {}): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) this.fail(where, 'must be a number');
    const n = value as number;
    if (opts.int && !Number.isInteger(n)) this.fail(where, 'must be a whole number');
    const { min, above, max } = opts;
    if (above !== undefined && max !== undefined && (n <= above || n > max)) this.fail(where, `must be above ${above} and at most ${max}`);
    if (above !== undefined && n <= above) this.fail(where, `must be above ${above}`);
    if (min !== undefined && max !== undefined && (n < min || n > max)) this.fail(where, `must be between ${min} and ${max}`);
    if (min !== undefined && n < min) this.fail(where, `must be at least ${min}`);
    if (max !== undefined && n > max) this.fail(where, `must be at most ${max}`);
    return n;
  }

  duration(value: unknown, where: string, minSec = 0): number {
    let seconds: number;
    try {
      seconds = parseDuration(value as string);
    } catch (err) {
      return this.fail(where, (err as Error).message);
    }
    if (seconds < minSec) this.fail(where, `must be at least ${minSec}s`);
    return seconds;
  }
}

async function readYaml(file: string, notFound: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ConfigError(notFound);
    throw err;
  }
  try {
    return parseYaml(text);
  } catch (err) {
    throw new ConfigError(`${file}: not valid YAML: ${(err as Error).message}`);
  }
}

/**
 * Replace `${NAME}` and `${NAME:-fallback}` in every string of a parsed YAML tree with the environment variable.
 * Resolved at load time, so a caller sets the variable before loading (the self-test sets PERF_SELFTEST_URL).
 * project.yaml's `auth` is not expanded (see readAuth): a value put into the header this way would skip its rules.
 */
function expandEnv(node: unknown, file: string): unknown {
  if (typeof node === 'string') {
    return node.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_all, name: string, fallback?: string) => {
      const value = process.env[name];
      if (value !== undefined && value !== '') return value;
      if (fallback !== undefined) return fallback;
      throw new ConfigError(`${file}: environment variable ${name} is not set (used as \${${name}})`);
    });
  }
  if (Array.isArray(node)) return node.map((item) => expandEnv(item, file));
  if (typeof node === 'object' && node !== null) {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, expandEnv(v, file)]));
  }
  return node;
}

function readEnv(r: Reader, name: string, raw: unknown): EnvConfig {
  const where = `envs.${name}`;
  const env = r.obj(raw, where);
  const caps = r.obj(env.caps, `${where}.caps`);
  const defaults = r.obj(env.defaults, `${where}.defaults`);
  const config: EnvConfig = {
    apiUrl: r.text(env.api_url, `${where}.api_url`),
    caps: {
      maxVus: r.num(caps.max_vus, `${where}.caps.max_vus`, { min: 1, int: true }),
      maxRps: r.num(caps.max_rps, `${where}.caps.max_rps`, { min: 1 }),
      maxDurationSec: r.duration(caps.max_duration, `${where}.caps.max_duration`, 1),
    },
    defaults: {
      vus: r.num(defaults.vus, `${where}.defaults.vus`, { min: 1, int: true }),
      rps: r.num(defaults.rps, `${where}.defaults.rps`, { min: 1 }),
    },
  };
  if (config.defaults.vus > config.caps.maxVus) r.fail(`${where}.defaults.vus`, 'is above caps.max_vus');
  if (config.defaults.rps > config.caps.maxRps) r.fail(`${where}.defaults.rps`, 'is above caps.max_rps');
  if (env.app_url !== undefined) config.appUrl = r.text(env.app_url, `${where}.app_url`);
  if (env.swagger_url !== undefined) config.swaggerUrl = r.text(env.swagger_url, `${where}.swagger_url`);
  if (env.window_utc !== undefined) {
    const window = r.obj(env.window_utc, `${where}.window_utc`);
    const weekdays = r.text(window.weekdays, `${where}.window_utc.weekdays`);
    if (!/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(weekdays)) {
      r.fail(`${where}.window_utc.weekdays`, `must look like 17:00-06:00 (got "${weekdays}")`);
    }
    const weekends = r.text(window.weekends, `${where}.window_utc.weekends`);
    if (weekends !== 'all-day' && weekends !== 'none') {
      r.fail(`${where}.window_utc.weekends`, `must be all-day or none (got "${weekends}")`);
    }
    config.windowUtc = { weekdays, weekends };
  }
  return config;
}

/** The abort limits, as written in YAML (project.yaml and a feature's workload.yaml) and as read. One table for both files. */
const ABORT_FIELDS = [
  { yaml: 'error_rate', key: 'errorRate', range: { above: 0, max: 1 } },
  { yaml: 'p95_ms', key: 'p95Ms', range: { min: 1 } },
  { yaml: 'db_cpu_or_io_pct', key: 'dbCpuOrIoPct', range: { above: 0, max: 100 }, optional: true },
] as const;

/**
 * Read an `abort` mapping. The project's has all three limits; a feature's may have any of them (`partial`). A key outside
 * the three, a missing required key, a non-number or a value outside its range is a ConfigError naming the file and the path.
 */
function readAbort(r: Reader, raw: unknown, where: string, partial: true): Partial<AbortLimits>;
function readAbort(r: Reader, raw: unknown, where: string, partial: false): AbortLimits;
function readAbort(r: Reader, raw: unknown, where: string, partial: boolean): Partial<AbortLimits> {
  const abort = r.obj(raw, where);
  const known: string[] = ABORT_FIELDS.map((f) => f.yaml);
  for (const key of Object.keys(abort)) {
    if (!known.includes(key)) r.fail(where, `has unknown key ${key} (known: ${known.join(', ')})`);
  }
  const limits: Partial<AbortLimits> = {};
  for (const field of ABORT_FIELDS) {
    if ((partial || ('optional' in field && field.optional)) && abort[field.yaml] === undefined) continue;
    limits[field.key] = r.num(abort[field.yaml], `${where}.${field.yaml}`, field.range);
  }
  return limits;
}

/**
 * Check limits given in code (RunOptions.abortOverride) against the same ranges as the YAML files.
 * @throws {ConfigError} for a key that is not a limit, or a value that is not a finite number in range
 */
export function checkAbortLimits(limits: Partial<AbortLimits>, where: string): void {
  const r = new Reader('run options');
  const known: string[] = ABORT_FIELDS.map((f) => f.key);
  for (const key of Object.keys(limits)) {
    if (!known.includes(key)) r.fail(where, `has unknown key ${key} (known: ${known.join(', ')})`);
  }
  for (const field of ABORT_FIELDS) {
    if (Object.hasOwn(limits, field.key)) r.num(limits[field.key], `${where}.${field.key}`, field.range);
  }
}

/** The limits a feature or a run option may only tighten: loosening them would quietly weaken a guard. The p95 limit may be raised. */
const TIGHTEN_ONLY = ['errorRate', 'dbCpuOrIoPct'] as const;

/** A tighten-only limit that was set above the project's. */
export interface LoosenedLimit {
  key: (typeof TIGHTEN_ONLY)[number];
  /** The key as written in YAML (`error_rate`). */
  yaml: string;
  value: number;
  /** The project's value, the most the limit may be. */
  max: number;
}

/** The tighten-only limits of `limits` that are above the project's (empty: nothing is loosened). */
export function loosenedLimits(limits: Partial<AbortLimits>, project: AbortLimits): LoosenedLimit[] {
  const loosened: LoosenedLimit[] = [];
  for (const key of TIGHTEN_ONLY) {
    const value = limits[key];
    const max = project[key];
    // Without a project value there is nothing to loosen: a feature's value only adds a guard.
    if (value !== undefined && max !== undefined && value > max) {
      loosened.push({ key, yaml: ABORT_FIELDS.find((f) => f.key === key)!.yaml, value, max });
    }
  }
  return loosened;
}

/** `must be at most 0.1 (…)`: what a feature's workload.yaml is told when it loosens a tighten-only limit. */
export const featureLoosenedMessage = (l: LoosenedLimit): string =>
  `must be at most ${l.max} (the project's limit: a feature may only tighten error_rate and db_cpu_or_io_pct; p95_ms may be raised)`;

/**
 * `${random:N}` (N random letters and digits) and `${env:PERF_NAME}` (an environment variable): the placeholders of a static
 * header value. The variable must start with PERF_: k6 inherits the runner's environment except PERF_* (runner/k6.ts), so
 * a key read from any other name would also sit in the k6 process's environment.
 */
const HEADER_PLACEHOLDER = /\$\{([^}]*)\}/g;
const RANDOM_MAX = 256;

function readAuth(r: Reader, raw: unknown): AuthConfig {
  const auth = r.obj(raw, 'auth');
  if (auth.type === 'ropc') return { type: 'ropc' };
  if (auth.type !== 'static_header') r.fail('auth.type', 'must be ropc or static_header');
  const header = r.text(auth.header, 'auth.header');
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(header)) r.fail('auth.header', `must be an HTTP header name, e.g. Authorization (got "${header}")`);
  const value = r.text(auth.value, 'auth.value');
  for (const [all, inner] of value.matchAll(HEADER_PLACEHOLDER)) {
    const random = /^random:(\d+)$/.exec(inner!);
    if (random) {
      const n = Number(random[1]);
      if (n < 1 || n > RANDOM_MAX) r.fail('auth.value', `${all}: the number of random characters must be 1 to ${RANDOM_MAX}`);
      continue;
    }
    if (/^env:PERF_[A-Z0-9_]+$/.test(inner!)) continue;
    const expansion = /^([A-Za-z_][A-Za-z0-9_]*)(?::-.*)?$/.exec(inner!);
    if (expansion) {
      const name = expansion[1]!;
      const suggested = name.startsWith('PERF_') ? name : `PERF_${name}`;
      r.fail(
        'auth.value',
        `${all}: auth is read as written, without \${NAME} expansion (an expanded value would skip the secret rules: the PERF_ ` +
          `prefix, the 4-character minimum and the run-folder scan); write \${env:${suggested}} and set ${suggested}`,
      );
    }
    if (/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(inner!)) {
      r.fail('auth.value', `${all}: the variable must start with PERF_ (upper-case letters, digits, _), so it never reaches k6's environment`);
    }
    r.fail('auth.value', `has an unknown placeholder ${all} (known: \${random:N}, \${env:PERF_NAME})`);
  }
  return { type: 'static_header', header, value };
}

/**
 * Load `projects/<name>/project.yaml` (`runner/selftest/project/project.yaml` for `selftest`).
 * @throws {ConfigError} when the project is missing or its file is invalid
 */
export async function loadProject(name: string): Promise<Project> {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new ConfigError(`invalid project name ${JSON.stringify(name)}`);
  return loadProjectFrom(name === 'selftest' ? SELFTEST_DIR : join(REPO_ROOT, 'projects', name), name);
}

/**
 * Load the project `name` from the folder `dir` (which holds project.yaml), wherever it is. `loadProject` calls this for
 * `projects/<name>`; tests call it for a fixture folder.
 * @throws {ConfigError} when the file is missing or invalid
 */
export async function loadProjectFrom(dir: string, name: string): Promise<Project> {
  const file = join(dir, 'project.yaml');
  const r = new Reader(file);
  // `auth` is read as written: `${NAME}` expansion would put a value into a static header past its rules (readAuth).
  const { auth: rawAuth, ...rest } = r.obj(await readYaml(file, `project ${name} not found (expected ${file})`), 'project.yaml');
  const root = expandEnv(rest, file) as Obj;
  if (r.text(root.name, 'name') !== name) r.fail('name', `must be "${name}" to match the project folder`);

  const envsRaw = r.obj(root.envs, 'envs');
  const envNames = Object.keys(envsRaw);
  if (envNames.length === 0) r.fail('envs', 'must define at least one env');
  const envs: Record<string, EnvConfig> = {};
  for (const envName of envNames) envs[envName] = readEnv(r, envName, envsRaw[envName]);

  const project: Project = {
    name,
    dir,
    envs,
    auth: readAuth(r, rawAuth),
    abort: readAbort(r, root.abort, 'abort', false),
    readOnlyPostRoutes: [],
  };
  if (root.adapter_options !== undefined) project.adapterOptions = { ...r.obj(root.adapter_options, 'adapter_options') };
  if (root.roles !== undefined) {
    project.roles = r.list(root.roles, 'roles').map((role, i) => r.name(role, `roles[${i}]`));
  }
  if (root.read_only_post_routes !== undefined) {
    project.readOnlyPostRoutes = r.list(root.read_only_post_routes, 'read_only_post_routes').map((route, i) => {
      const text = r.text(route, `read_only_post_routes[${i}]`);
      if (!text.startsWith('/')) r.fail(`read_only_post_routes[${i}]`, `must start with / (got "${text}")`);
      return text;
    });
  }
  if (root.row_count_tables !== undefined) {
    project.rowCountTables = r.list(root.row_count_tables, 'row_count_tables').map((table, i) => {
      const text = r.text(table, `row_count_tables[${i}]`);
      if (!/^[a-z][a-z0-9_]*$/.test(text)) {
        r.fail(`row_count_tables[${i}]`, `must be a table name in lower-case letters, digits and underscores (got "${text}")`);
      }
      return text;
    });
  }
  return project;
}

/** The env's config. @throws {ConfigError} for an env the project does not define */
export function envConfig(project: Project, env: string): EnvConfig {
  const config = Object.hasOwn(project.envs, env) ? project.envs[env] : undefined;
  if (!config) {
    throw new ConfigError(`env ${env} is not defined in project ${project.name} (known: ${Object.keys(project.envs).join(', ')})`);
  }
  return config;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function camelCase(snake: string): string {
  return snake.replace(/_+([A-Za-z0-9])/g, (_all, ch: string) => ch.toUpperCase());
}

function readEvidence(r: Reader, raw: unknown, where: string): Record<string, unknown> | undefined {
  return raw === undefined ? undefined : r.obj(raw, where);
}

function readJourneys(r: Reader, raw: unknown, roles: string[] | undefined): Journey[] {
  const list = r.list(raw, 'journeys');
  if (list.length === 0) r.fail('journeys', 'must define at least one journey');
  const journeys = list.map((item, i): Journey => {
    const where = `journeys[${i}]`;
    const j = r.obj(item, where);
    const name = r.name(j.name, `${where}.name`);
    const stepsRaw = r.list(j.steps, `${where}.steps`);
    if (stepsRaw.length === 0) r.fail(`${where}.steps`, 'must define at least one step');
    const steps = stepsRaw.map((stepItem, k): Step => {
      const sw = `${where}.steps[${k}]`;
      const s = r.obj(stepItem, sw);
      const { method, route } = readRequest(r, s.request, `${sw}.request`);
      const step: Step = {
        name: r.name(s.name, `${sw}.name`),
        method,
        route,
        optionalShare: s.optional_share === undefined ? 100 : r.num(s.optional_share, `${sw}.optional_share`, { min: 1, max: 100 }),
      };
      const evidence = readEvidence(r, s.evidence, `${sw}.evidence`);
      if (evidence) step.evidence = evidence;
      return step;
    });
    const seen = new Set<string>();
    for (const step of steps) {
      if (seen.has(step.name)) r.fail(`${where}.steps`, `has the step name ${step.name} twice`);
      seen.add(step.name);
    }
    const role = r.text(j.role, `${where}.role`);
    if (roles && !roles.includes(role)) r.fail(`${where}.role`, `must be one of project.yaml roles (${roles.join(', ')}) (got "${role}")`);
    const journey: Journey = {
      name,
      key: r.name(j.key, `${where}.key`),
      role,
      exec: j.exec === undefined ? camelCase(name) : r.name(j.exec, `${where}.exec`),
      steps,
    };
    const evidence = readEvidence(r, j.evidence, `${where}.evidence`);
    if (evidence) journey.evidence = evidence;
    return journey;
  });
  for (const field of ['name', 'key', 'exec'] as const) {
    const seen = new Set<string>();
    for (const journey of journeys) {
      if (seen.has(journey[field])) r.fail('journeys', `has the journey ${field} ${journey[field]} twice`);
      seen.add(journey[field]);
    }
  }
  return journeys;
}

/** `METHOD /route` -> method and route, or a failure at `where`. */
function readRequest(r: Reader, raw: unknown, where: string): { method: string; route: string } {
  const request = r.text(raw, where);
  const match = /^([A-Za-z]+)\s+(\/\S*)$/.exec(request.trim());
  if (!match || !METHODS.includes(match[1]!.toUpperCase())) r.fail(where, `must look like "POST /route" (got "${request}")`);
  return { method: match![1]!.toUpperCase(), route: match![2]! };
}

/** The rule a writing feature without `writes:` breaks (loadFeature, and the journey check for a feature built in code). */
export const WRITES_REQUIRED =
  'must list every write of a feature with read_only: false, each with its cleanup (cleanup: app, the only mode today: ' +
  'the app removes these rows itself). A feature whose writes nobody removes cannot be run; make it read-only instead';

function readWrites(r: Reader, raw: unknown, readOnly: boolean, journeys: Journey[]): DeclaredWrite[] {
  if (readOnly) r.fail('writes', 'is only for a feature with read_only: false (a read-only feature writes nothing)');
  return r.list(raw, 'writes').map((item, i): DeclaredWrite => {
    const where = `writes[${i}]`;
    const w = r.obj(item, where);
    const { method, route } = readRequest(r, w.request, `${where}.request`);
    if (w.cleanup !== 'app') {
      r.fail(`${where}.cleanup`, 'must be app (the app removes these rows itself; nothing for the runner to clean up)');
    }
    if (!journeys.some((j) => j.steps.some((s) => s.method === method && s.route === route))) {
      r.fail(where, `${method} ${route} is not a step of any journey`);
    }
    return { method, route, cleanup: 'app' };
  });
}

function readHoldProfile(r: Reader, raw: unknown, where: string): HoldProfile {
  const p = r.obj(raw, where);
  const profile: HoldProfile = {
    rampSec: r.duration(p.ramp, `${where}.ramp`),
    holdSec: r.duration(p.hold, `${where}.hold`, 1),
    rampDownSec: p.ramp_down === undefined ? 0 : r.duration(p.ramp_down, `${where}.ramp_down`),
  };
  if (p.users !== undefined) profile.users = r.num(p.users, `${where}.users`, { min: 1, int: true });
  return profile;
}

function readStressProfile(r: Reader, raw: unknown, where: string): StressProfile {
  const p = r.obj(raw, where);
  const profile: StressProfile = {
    startRps: r.num(p.start_rps, `${where}.start_rps`, { min: 1 }),
    stepRps: r.num(p.step_rps, `${where}.step_rps`, { min: 1 }),
    stepEverySec: r.duration(p.step_every, `${where}.step_every`, 1),
  };
  if (p.max_rps !== undefined) {
    profile.maxRps = r.num(p.max_rps, `${where}.max_rps`, { min: profile.startRps });
  }
  return profile;
}

function readWorkload(r: Reader, raw: unknown, journeys: Journey[], projectAbort: AbortLimits): Workload {
  const w = r.obj(raw, 'workload.yaml');

  const mixRaw = r.obj(w.mix, 'mix');
  const mix: Record<string, number> = {};
  const journeyNames = journeys.map((j) => j.name);
  for (const [name, share] of Object.entries(mixRaw)) {
    if (!journeyNames.includes(name)) r.fail('mix', `key ${name} is not a journey (journeys: ${journeyNames.join(', ')})`);
    mix[name] = r.num(share, `mix.${name}`, { min: 0, max: 100 });
  }
  const sum = Object.values(mix).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 1e-9) r.fail('mix', `must sum to 100 (got ${sum})`);

  const think = r.obj(w.think_time, 'think_time');
  const thinkTime = { min: r.duration(think.min, 'think_time.min'), max: r.duration(think.max, 'think_time.max') };
  if (thinkTime.min > thinkTime.max) r.fail('think_time', 'min must not be above max');

  const profiles: Workload['profiles'] = {};
  if (w.profiles !== undefined) {
    const p = r.obj(w.profiles, 'profiles');
    for (const key of Object.keys(p)) {
      if (!['load', 'stress', 'soak'].includes(key)) r.fail('profiles', `has unknown profile ${key} (known: load, stress, soak)`);
    }
    if (p.load !== undefined) profiles.load = readHoldProfile(r, p.load, 'profiles.load');
    if (p.stress !== undefined) profiles.stress = readStressProfile(r, p.stress, 'profiles.stress');
    if (p.soak !== undefined) profiles.soak = readHoldProfile(r, p.soak, 'profiles.soak');
  }

  let targets: Workload['targets'] = 'baseline';
  if (w.targets !== undefined && w.targets !== 'baseline') {
    const stepIds = journeys.flatMap((j) => j.steps.map((s) => `${j.key}.${s.name}`));
    targets = {};
    for (const [id, target] of Object.entries(r.obj(w.targets, 'targets'))) {
      if (!stepIds.includes(id)) r.fail('targets', `key ${id} is not a step id (<journey key>.<step>: ${stepIds.join(', ')})`);
      targets[id] = { p95Ms: r.num(r.obj(target, `targets.${id}`).p95_ms, `targets.${id}.p95_ms`, { min: 1 }) };
    }
  }

  const workload: Workload = {
    businessUnit: r.text(w.business_unit, 'business_unit'),
    businessAction: r.text(w.business_action, 'business_action'),
    mix,
    thinkTime,
    profiles,
    targets,
  };
  if (w.abort !== undefined) {
    workload.abort = readAbort(r, w.abort, 'abort', true);
    const [loosened] = loosenedLimits(workload.abort, projectAbort);
    if (loosened) r.fail(`abort.${loosened.yaml}`, featureLoosenedMessage(loosened));
  }
  if (w.standing_data !== undefined) workload.standingData = { ...r.obj(w.standing_data, 'standing_data') };
  return workload;
}

/**
 * Load `<project.dir>/features/<name>/{journey,workload}.yaml`. The k6 script (`<name>.js`) is not read here.
 * @throws {ConfigError} when a file is missing or invalid (mix not summing to 100, unknown mix key, optional_share out of range...)
 */
export async function loadFeature(project: Project, name: string): Promise<Feature> {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new ConfigError(`invalid feature name ${JSON.stringify(name)}`);
  const dir = join(project.dir, 'features', name);
  const journeyFile = join(dir, 'journey.yaml');
  const workloadFile = join(dir, 'workload.yaml');
  const notFound = `feature ${name} not found in project ${project.name} (expected ${journeyFile} and ${workloadFile})`;
  const journeyDoc = await readYaml(journeyFile, notFound);
  const workloadDoc = await readYaml(workloadFile, notFound);

  const jr = new Reader(journeyFile);
  const journeyRoot = jr.obj(journeyDoc, 'journey.yaml');
  const journeys = readJourneys(jr, journeyRoot.journeys, project.roles);
  // No read_only key means read-only: the strictest guardrails apply until the feature says it writes.
  const readOnly = journeyRoot.read_only === undefined ? true : jr.bool(journeyRoot.read_only, 'read_only');
  const writes = journeyRoot.writes === undefined ? undefined : readWrites(jr, journeyRoot.writes, readOnly, journeys);
  // A writing feature says who removes what it creates; nothing else cleans up after it (the runner only counts rows).
  if (!readOnly && (writes === undefined || writes.length === 0)) jr.fail('writes', WRITES_REQUIRED);

  const workload = readWorkload(new Reader(workloadFile), workloadDoc, journeys, project.abort);
  const feature: Feature = { name, dir, script: join(dir, `${name}.js`), readOnly, journeys, workload };
  if (writes) feature.writes = writes;
  return feature;
}
