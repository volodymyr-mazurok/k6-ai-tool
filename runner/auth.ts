// The runner's side of a static auth header (project.yaml `auth.type: static_header`). The value template is kept in
// project.yaml; `${env:NAME}` is replaced here from the environment (which `.env` fills), so a real key never enters the
// repo or the run config. The result goes to k6 only in the mode-0600 secrets file; `${random:N}` is made inside k6, once
// per virtual user (core/auth/static.js).

import { ConfigError, type StaticHeaderAuthConfig } from './config.js';
// The shortest value an `${env:NAME}` may hold: the run-folder scan does not look for shorter ones.
import { MIN_SECRET_CHARS } from './secretScan.js';

/** The header k6 sends: its name, and the value with `${env:NAME}` replaced (a secret: never print it). */
export interface StaticHeader {
  name: string;
  value: string;
}

/** A resolved header and the secret parts in it: every value an `${env:NAME}` was replaced with (the scan redacts them). */
export interface ResolvedStaticHeader {
  header: StaticHeader;
  /** Not the `${random:N}` parts: those are made per VU and are no secret. */
  secretParts: string[];
}

/**
 * The static header of a project, with every `${env:NAME}` replaced from `env`, and the values it put in.
 * @throws {Error} naming the variable (never a value) when one is not set or empty, or holds `${` (k6 would read it as a
 *   placeholder); a ConfigError when it is shorter than 4 characters (the run-folder scan could not redact it)
 */
export function resolveStaticHeader(auth: StaticHeaderAuthConfig, env: NodeJS.ProcessEnv = process.env): ResolvedStaticHeader {
  const secretParts: string[] = [];
  const value = auth.value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_all, name: string) => {
    const found = env[name];
    if (found === undefined || found === '') {
      throw new Error(`${name} is not set — the ${auth.header} header in project.yaml uses \${env:${name}}; put it in .env or in the environment`);
    }
    if (found.includes('${')) throw new Error(`${name} holds "\${", which k6 would read as a placeholder; the header cannot carry it`);
    if (found.length < MIN_SECRET_CHARS) {
      throw new ConfigError(`${name} is shorter than ${MIN_SECRET_CHARS} characters: too short to be found and redacted if a script leaks it; use a longer value`);
    }
    secretParts.push(found);
    return found;
  });
  return { header: { name: auth.header, value }, secretParts };
}
