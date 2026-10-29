// perf doctor: is this machine ready to run a test? One line per check, `✓ label` or `✗ label — how to fix it`.
//   tools        k6 1.0 or newer, Node 22 or newer, the npm dependencies installed
//   with a project and env also:
//   project      project.yaml loads and lists the env; the accounts resolve (presence only)
//   env          swagger answers 200; one token per role (a static_header project: its header resolves, no request);
//                the database answers, its statistics are readable, its tier
//
// Nothing secret is ever printed: an account shows as "Analyst account", never its login or password; a token is
// checked for its HTTP status and dropped; a driver's error text is reduced to its code. Every error text is also
// scrubbed of the account logins and passwords, in case a library quotes them. At most one token request per role,
// no retries: the token endpoint can throttle or lock an account that is asked too often.
// Every call to the outside goes through a probe, so the tests can answer for k6, the network and the database.

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Knex } from 'knex';
import { loadAdapter, type ProjectAdapter, type ResolvedEnv } from './adapter.js';
import { loadDotEnv } from './adapters/envAdapter.js';
import { resolveStaticHeader } from './auth.js';
import { dbProfile, describeDbError, type DbProfile } from './collectors/mssql.js';
import { REPO_ROOT, loadProject, type EnvConfig, type Project } from './config.js';
import { checkEnv } from './guardrails.js';
import { k6Version } from './k6.js';
import { JWT, MIN_SECRET_CHARS } from './secretScan.js';

export interface DoctorCheck {
  ok: boolean;
  /** What was checked; when it passed, also the answer (`k6 v2.3.0`). */
  label: string;
  /** What to do about it; present when `ok` is false. */
  fix?: string;
}

/** `✓ label`, or `✗ label — fix`. */
export function formatCheck(check: DoctorCheck): string {
  if (check.ok) return `✓ ${check.label}`;
  return check.fix ? `✗ ${check.label} — ${check.fix}` : `✗ ${check.label}`;
}

export interface TokenAnswer {
  /** HTTP status of the token endpoint. */
  status: number;
  /** A 200 answer that carried an access token (the token itself is never returned). */
  hasAccessToken: boolean;
}

export interface DatabaseAnswer {
  viewDatabaseState: boolean;
  profile: DbProfile;
}

/** Everything doctor asks of the outside world. The defaults are the real thing; a test replaces the ones it needs. */
export interface DoctorProbes {
  /** The installed k6 version (`2.3.0`); rejects when k6 is missing or older than 1.0. */
  k6Version(): Promise<string>;
  nodeVersion(): string;
  /** Names of the packages in package.json that node_modules lacks. */
  missingDependencies(): Promise<string[]>;
  loadProject(name: string): Promise<Project>;
  loadAdapter(project: Project): Promise<ProjectAdapter>;
  /** HTTP status of a GET of the swagger url (the body is not downloaded). */
  swaggerStatus(url: string): Promise<number>;
  /** One password-grant request; resolves with the status, rejects on a network error. */
  tokenAnswer(auth: ResolvedEnv['auth'], account: { login: string; password: string }): Promise<TokenAnswer>;
  /** Connects, reads the permission and the tier; rejects when the database cannot be reached. */
  database(db: Knex): Promise<DatabaseAnswer>;
}

export interface DoctorOptions {
  probes?: Partial<DoctorProbes>;
  /** Called with each check as soon as it is made, so a slow check does not leave the terminal silent. */
  onCheck?: (check: DoctorCheck) => void;
}

const REQUEST_TIMEOUT_MS = 30_000;
const MIN_NODE_MAJOR = 22;
const MAX_MESSAGE_CHARS = 200;

// ---------------------------------------------------------------------------------------------------------------
// the real probes
// ---------------------------------------------------------------------------------------------------------------

/** The packages package.json lists (dependencies and devDependencies) that `<root>/node_modules` does not hold, sorted. */
export async function missingDependencies(root: string = REPO_ROOT): Promise<string[]> {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
  const missing: string[] = [];
  for (const name of names) {
    try {
      await access(join(root, 'node_modules', name, 'package.json'));
    } catch {
      missing.push(name);
    }
  }
  return missing.sort();
}

async function swaggerStatus(url: string): Promise<number> {
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  await res.body?.cancel(); // the document is megabytes; the status is the answer
  return res.status;
}

/** The request the k6 side makes (core/auth/ropc.js fetchTokens): the password grant. Only the status leaves this function. */
async function tokenAnswer(auth: ResolvedEnv['auth'], account: { login: string; password: string }): Promise<TokenAnswer> {
  const res = await fetch(auth.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: auth.clientId,
      scope: auth.scope,
      username: account.login,
      password: account.password,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status !== 200) {
    await res.body?.cancel();
    return { status: res.status, hasAccessToken: false };
  }
  const body = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
  return { status: 200, hasAccessToken: typeof body?.access_token === 'string' };
}

/** `db.raw` answers with the rows (the mssql dialect); a `{ recordset }` shape is read too. */
async function queryRows(db: Knex, sql: string): Promise<Record<string, unknown>[]> {
  const result = (await db.raw(sql)) as unknown;
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const recordset = (result as { recordset?: unknown } | null)?.recordset;
  return Array.isArray(recordset) ? (recordset as Record<string, unknown>[]) : [];
}

async function database(db: Knex): Promise<DatabaseAnswer> {
  const work = (async (): Promise<DatabaseAnswer> => {
    const [row] = await queryRows(db, `SELECT HAS_PERMS_BY_NAME(NULL, 'DATABASE', 'VIEW DATABASE STATE') AS granted`);
    return { viewDatabaseState: Number(row?.granted) === 1, profile: await dbProfile(db) };
  })();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('no answer in time'), { code: 'ETIMEOUT' })), REQUEST_TIMEOUT_MS);
  });
  work.catch(() => {}); // when the deadline wins, a late failure of the query is not an unhandled rejection
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const REAL_PROBES: DoctorProbes = {
  k6Version,
  nodeVersion: () => process.versions.node,
  missingDependencies: () => missingDependencies(),
  loadProject,
  loadAdapter,
  swaggerStatus,
  tokenAnswer,
  database,
};

// ---------------------------------------------------------------------------------------------------------------
// the checks
// ---------------------------------------------------------------------------------------------------------------

/** A JWT (the secret scan's pattern) or a bearer value: replaced as a whole. */
const TOKEN_LIKE = new RegExp(`${JWT.source}|Bearer\\s+\\S+`, 'g');

/** A message that is safe to print: the first line only, cut short, with every known secret and anything token-shaped replaced. */
function safeMessage(err: unknown, secrets: string[]): string {
  let text = (err instanceof Error ? err.message : String(err)).split('\n')[0]!.trim().replace(TOKEN_LIKE, '***');
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_CHARS) text = text.split(secret).join('***');
  }
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

function k6Check(version: string | Error): DoctorCheck {
  if (typeof version === 'string') return { ok: true, label: `k6 v${version}` };
  const found = /found (\d+\.\d+\.\d+)/.exec(version.message);
  if (found) return { ok: false, label: 'k6 1.0 or newer', fix: `upgrade it with: brew upgrade k6 (found ${found[1]})` };
  if (/not found/.test(version.message)) return { ok: false, label: 'k6 1.0 or newer', fix: 'install it with: brew install k6' };
  return { ok: false, label: 'k6 1.0 or newer', fix: safeMessage(version, []) };
}

function nodeCheck(version: string): DoctorCheck {
  if (Number(version.split('.')[0]) >= MIN_NODE_MAJOR) return { ok: true, label: `Node v${version}` };
  return {
    ok: false,
    label: `Node ${MIN_NODE_MAJOR} or newer (found v${version})`,
    fix: `install Node ${MIN_NODE_MAJOR} or newer from https://nodejs.org, then reopen the terminal`,
  };
}

function tokenFix(role: string, answer: TokenAnswer | Error, secrets: string[]): string {
  if (answer instanceof Error) {
    return `no answer from the token endpoint (${safeMessage(answer, secrets)}); check the network and the VPN`;
  }
  if (answer.status === 429) {
    return 'the token endpoint answered 429: it is throttling; wait a few minutes, and do not retry in a loop';
  }
  if (answer.status === 400 || answer.status === 401) {
    return `the token endpoint answered ${answer.status}: the login or password of ${role} is wrong or the account is locked; fix it where the project keeps its accounts`;
  }
  if (answer.status === 200) return 'the token endpoint answered 200 without an access token; check the token url and client id in the project';
  return `the token endpoint answered ${answer.status}; check the token url, the client id and the network`;
}

const capsText = (env: EnvConfig): string =>
  `caps ${env.caps.maxVus} users / ${env.caps.maxRps} req/s, defaults ${env.defaults.vus} users / ${env.defaults.rps} req/s`;

/**
 * Run the checks. Without a project only the tools are checked; with a project and an env the project's access to the env
 * too. A failed check is a returned result, never a throw (the arguments themselves are the caller's to validate).
 */
export async function doctor(projectName?: string, envName?: string, options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const probes: DoctorProbes = { ...REAL_PROBES, ...options.probes };
  const checks: DoctorCheck[] = [];
  const add = (check: DoctorCheck): void => {
    checks.push(check);
    options.onCheck?.(check);
  };

  try {
    add(k6Check(await probes.k6Version()));
  } catch (err) {
    add(k6Check(err as Error));
  }
  add(nodeCheck(probes.nodeVersion()));
  try {
    const missing = await probes.missingDependencies();
    add(
      missing.length === 0
        ? { ok: true, label: 'dependencies installed' }
        : { ok: false, label: `dependencies installed (missing: ${missing.join(', ')})`, fix: 'run: npm install' },
    );
  } catch (err) {
    add({ ok: false, label: 'dependencies installed', fix: `could not read package.json or node_modules: ${safeMessage(err, [])}` });
  }
  if (projectName === undefined || envName === undefined) return checks;

  let project: Project;
  try {
    project = await probes.loadProject(projectName);
  } catch (err) {
    add({ ok: false, label: `project ${projectName} loads`, fix: safeMessage(err, []) });
    return checks;
  }
  add({ ok: true, label: `project ${project.name} loaded` });

  let envConfig: EnvConfig;
  try {
    envConfig = checkEnv(project, envName);
  } catch {
    add({
      ok: false,
      label: `env ${envName} is allowed`,
      fix: `${project.name} allows only: ${Object.keys(project.envs).join(', ')} (envs in its project.yaml)`,
    });
    return checks;
  }
  add({ ok: true, label: `env ${envName} is allowed (${capsText(envConfig)})` });

  let adapter: ProjectAdapter | undefined;
  try {
    adapter = await probes.loadAdapter(project);
    await envChecks(adapter, project, envName, envConfig, probes, add);
  } catch (err) {
    add({ ok: false, label: `adapter of ${project.name} loads`, fix: safeMessage(err, []) });
  } finally {
    await adapter?.close?.().catch(() => {});
  }
  return checks;
}

async function envChecks(
  adapter: ProjectAdapter,
  project: Project,
  envName: string,
  envConfig: EnvConfig,
  probes: DoctorProbes,
  add: (check: DoctorCheck) => void,
): Promise<void> {
  // A static header needs no login: no accounts to resolve and no token request; only its ${env:NAME} must be set.
  const staticAuth = project.auth.type === 'static_header' ? project.auth : undefined;
  let resolved: ResolvedEnv | undefined;
  if (!staticAuth) {
    try {
      resolved = await adapter.resolveEnv(envName);
    } catch (err) {
      add({ ok: false, label: `accounts for env ${envName}`, fix: `${safeMessage(err, [])}; the token and database checks follow once this works` });
    }
  }
  const roles = resolved ? Object.keys(resolved.accounts) : [];
  const secrets = roles.flatMap((role) => [resolved!.accounts[role]!.login, resolved!.accounts[role]!.password]);
  for (const role of roles) add({ ok: true, label: `${role} account` });

  if (!envConfig.swaggerUrl) {
    add({ ok: false, label: 'swagger answers 200', fix: `env ${envName} has no swagger_url in project.yaml; the journey check needs it` });
  } else {
    try {
      const status = await probes.swaggerStatus(envConfig.swaggerUrl);
      add(
        status === 200
          ? { ok: true, label: 'swagger answers 200' }
          : { ok: false, label: 'swagger answers 200', fix: `GET ${envConfig.swaggerUrl} returned ${status}; check the VPN and that the env is up` },
      );
    } catch (err) {
      add({
        ok: false,
        label: 'swagger answers 200',
        fix: `GET ${envConfig.swaggerUrl} failed (${safeMessage(err, secrets)}); check the VPN and that the env is up`,
      });
    }
  }
  if (staticAuth) {
    const label = `${staticAuth.header} header from project.yaml`;
    try {
      loadDotEnv();
      resolveStaticHeader(staticAuth);
      add({ ok: true, label: `${label} (no login, no token request)` });
    } catch (err) {
      add({ ok: false, label, fix: safeMessage(err, []) });
    }
  } else if (!resolved) {
    return;
  }

  for (const role of roles) {
    const label = `${role} token`;
    try {
      const answer = await probes.tokenAnswer(resolved!.auth, resolved!.accounts[role]!);
      add(answer.status === 200 && answer.hasAccessToken ? { ok: true, label } : { ok: false, label, fix: tokenFix(role, answer, secrets) });
    } catch (err) {
      add({ ok: false, label, fix: tokenFix(role, err as Error, secrets) });
    }
  }

  let db: Knex | null = null;
  try {
    db = (await adapter.db?.(envName)) ?? null;
  } catch (err) {
    add({ ok: false, label: 'database reachable', fix: `${describeDbError(err)}; check the VPN and the database connection the project reads` });
    return;
  }
  if (!db) {
    add({ ok: true, label: 'no database for this project (database evidence is skipped)' });
    return;
  }
  if (project.abort.dbCpuOrIoPct === undefined) {
    add({
      ok: false,
      label: 'abort.db_cpu_or_io_pct set for a project with a database',
      fix: 'add abort.db_cpu_or_io_pct to project.yaml (95 is usual); without it a run of a feature that does not set it is refused',
    });
  }
  let answer: DatabaseAnswer;
  try {
    answer = await probes.database(db);
  } catch (err) {
    add({ ok: false, label: 'database reachable', fix: `${describeDbError(err)}; check the VPN and the database connection the project reads` });
    return;
  }
  add({ ok: true, label: 'database reachable' });
  add(
    answer.viewDatabaseState
      ? { ok: true, label: 'VIEW DATABASE STATE granted' }
      : {
          ok: false,
          label: 'VIEW DATABASE STATE granted',
          fix: 'ask a database admin to grant it to the test database user; without it the report has no query statistics',
        },
  );
  const { tier, edition } = answer.profile;
  add({ ok: true, label: tier ? `database tier ${tier}${edition ? ` (${edition})` : ''}` : 'database tier not reported by the server' });
}
