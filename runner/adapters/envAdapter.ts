// The default adapter: auth settings and accounts come from environment variables (`.env` at the repo root fills
// the ones the shell did not set). Names only live in .env.example; values are never printed.
//   PERF_TOKEN_URL, PERF_TOKEN_CLIENT_ID, PERF_SCOPE
//   PERF_<ROLE>_LOGIN, PERF_<ROLE>_PASSWORD   for every role listed in project.yaml (role upper-cased: User -> PERF_USER_LOGIN)

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectAdapter, ResolvedEnv } from '../adapter.js';
import { REPO_ROOT, envConfig, type Project } from '../config.js';

/** The dotenv file the runner reads: `.env` at the repo root. */
export const DEFAULT_DOTENV = join(REPO_ROOT, '.env');

/** Load a dotenv file into process.env when it exists. Variables that are already set win. */
export function loadDotEnv(file: string = DEFAULT_DOTENV): void {
  if (existsSync(file)) process.loadEnvFile(file);
}

export interface EnvAdapterOptions {
  /** The dotenv file that fills the variables the shell did not set; default `.env` at the repo root (tests pass their own). */
  dotenvFile?: string;
}

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — put it in .env (names are in .env.example) or in the environment`);
  return value;
}

export function createEnvAdapter(project: Project, options: EnvAdapterOptions = {}): ProjectAdapter {
  return {
    async resolveEnv(env: string): Promise<ResolvedEnv> {
      const config = envConfig(project, env);
      if (!project.roles || project.roles.length === 0) {
        throw new Error(`project ${project.name}: project.yaml lists no roles; the env adapter needs roles: [...]`);
      }
      loadDotEnv(options.dotenvFile ?? DEFAULT_DOTENV);
      const accounts: ResolvedEnv['accounts'] = {};
      for (const role of project.roles) {
        const prefix = `PERF_${role.toUpperCase()}`;
        accounts[role] = { login: need(`${prefix}_LOGIN`), password: need(`${prefix}_PASSWORD`) };
      }
      return {
        apiUrl: config.apiUrl,
        auth: { tokenUrl: need('PERF_TOKEN_URL'), clientId: need('PERF_TOKEN_CLIENT_ID'), scope: need('PERF_SCOPE') },
        accounts,
      };
    },
  };
}
