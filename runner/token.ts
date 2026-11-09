// The password-grant request the k6 side makes (core/auth/ropc.js fetchTokens), for the commands that ask the token
// endpoint once from Node: `perf doctor` and `perf probe`. One request per call, no retry (the endpoint can throttle or
// lock an account that is asked too often). The returned access token is a secret: callers use it and never print it.

import type { ResolvedEnv } from './adapter.js';

const REQUEST_TIMEOUT_MS = 30_000;

export interface TokenResult {
  /** HTTP status of the token endpoint. */
  status: number;
  /** Only on a 200 answer that carried an access token. A secret: never print, log or write it. */
  accessToken?: string;
}

/** One password-grant request. Resolves with the status (and the token on success); rejects on a network error or a timeout. */
export async function requestToken(auth: ResolvedEnv['auth'], account: { login: string; password: string }): Promise<TokenResult> {
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
    return { status: res.status };
  }
  const body = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
  return typeof body?.access_token === 'string' ? { status: 200, accessToken: body.access_token } : { status: 200 };
}
