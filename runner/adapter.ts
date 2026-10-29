// What the runner needs from a project: where its API is, how to sign in, who the test accounts are, and
// (optionally) a database and standing-data hooks. A project either ships `<dir>/adapter.ts` or gets the env adapter.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Knex } from 'knex';
import { createEnvAdapter } from './adapters/envAdapter.js';
import type { Feature, Project } from './config.js';

export interface ResolvedEnv {
  apiUrl: string;
  auth: { tokenUrl: string; clientId: string; scope: string };
  /** role -> credentials. Secrets: never print or write them. */
  accounts: Record<string, { login: string; password: string }>;
}

export interface ProjectAdapter {
  /**
   * The API url, the token endpoint and the accounts of a password-grant (ropc) project. Never called for a project whose
   * `auth.type` is static_header (it needs no login, its API url is the env's api_url and its header comes from project.yaml),
   * so such a project's adapter.ts may leave it out (StaticHeaderAdapter).
   */
  resolveEnv(env: string): Promise<ResolvedEnv>;
  /**
   * A connection to the env's database, cached per env; null when the project has none. The caller destroys it.
   * The runner's database features assume SQL Server / Azure SQL (they query `sys.dm_db_resource_stats`, the query
   * statistics and missing-index views): the busy check, the DB abort guard, db.json and the report's Database section.
   * Without `db` (or with null) a run has none of them: no busy check (a load run is not refused) and nothing
   * enforces `abort.db_cpu_or_io_pct`. A `db()` that throws refuses a non-smoke run (DB_UNREACHABLE), even with
   * --override-busy: without a connection the DB abort guard cannot run.
   */
  db?(env: string): Promise<Knex | null>;
  verifyStandingData?(env: string, feature: Feature): Promise<void>;
  /** Data the k6 script needs at run time (e.g. search terms); goes into the run config. Never secrets. */
  runData?(env: string, feature: Feature): Promise<unknown>;
  /**
   * Create the standing data. `spec` is the workload `standing_data` mapping with the `--set key=value` flags laid over
   * it, passed untouched: parse and validate it here, and name what is missing in the error. Return a one-line summary
   * of the result; the CLI prints it as `standing data ready: <summary>`.
   * setup and teardown are not bound by the caps or the load window (the CLI only takes the env lock): the adapter owns
   * their pace, so it batches, pauses and keeps the requests few on a shared env.
   */
  setup?(env: string, spec: Record<string, unknown>, log: (message: string) => void): Promise<string | void>;
  /** Remove the standing data setup created (only rows the project's own naming marks as its own). Paced by the adapter, like setup. */
  teardown?(env: string, log: (message: string) => void): Promise<void>;
  rowCounts?(env: string, tables: string[]): Promise<Record<string, number>>;
  /** Release every connection the adapter opened (its own pools and any a dependency opened). Call once, at the end. */
  close?(): Promise<void>;
}

/** The adapter of a static_header project: the same hooks, and resolveEnv may be left out (nothing calls it). */
export type StaticHeaderAdapter = Omit<ProjectAdapter, 'resolveEnv'> & Partial<Pick<ProjectAdapter, 'resolveEnv'>>;

/** What `<dir>/adapter.ts` may export as default: an adapter, or a function that builds one for the project. */
export type AdapterExport = ProjectAdapter | StaticHeaderAdapter | ((project: Project) => ProjectAdapter | StaticHeaderAdapter);

/**
 * The project's adapter: the default export of `<project.dir>/adapter.ts` (called with the project when it is a
 * function), otherwise the env adapter, which reads `.env` / process.env. A static_header project's adapter without
 * resolveEnv gets one that refuses (nothing calls it); a password-grant project's adapter must have it.
 * @throws {Error} when adapter.ts exports no adapter, or a password-grant project's adapter has no resolveEnv
 */
export async function loadAdapter(project: Project): Promise<ProjectAdapter> {
  const file = join(project.dir, 'adapter.ts');
  if (!existsSync(file)) return createEnvAdapter(project);
  const mod = (await import(pathToFileURL(file).href)) as { default?: AdapterExport };
  const exported = mod.default;
  const adapter = typeof exported === 'function' ? exported(project) : exported;
  if (!adapter || typeof adapter !== 'object') {
    throw new Error(`${file} must export default a ProjectAdapter, or a function (project) => ProjectAdapter`);
  }
  if (typeof adapter.resolveEnv === 'function') return adapter as ProjectAdapter;
  if (project.auth.type !== 'static_header') {
    throw new Error(`${file} must define resolveEnv(env): project ${project.name} signs in with the password grant (auth.type: ropc)`);
  }
  // A Proxy over the export (a module's default object is shared between loads, so it is not changed): resolveEnv is the
  // proxy's own, every other hook is the export's, called on the export itself so a class with #private fields still works.
  const refuse = async (): Promise<ResolvedEnv> => {
    throw new Error(`project ${project.name} signs in with a static header: it has no accounts or token endpoint to resolve`);
  };
  return new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'resolveEnv') return refuse;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as ProjectAdapter;
}
