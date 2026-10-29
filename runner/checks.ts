// Journey checks. Two moments:
//   before any run   checkJourney(...)  P1 every step cites evidence and its route+method exists in the env's swagger;
//                                       P7b a read-only feature sends no write (PUT/PATCH/DELETE, or a POST that is not
//                                       listed in project.yaml read_only_post_routes); a writing feature sends no write
//                                       it did not declare (journey.yaml `writes:`, which loadFeature requires).
//   after a smoke    checkScriptMatchesJourney(...)  P2 the traffic k6 recorded is exactly the journey: every step was
//                                       sent as a named request, nothing else was (besides the token request), and each
//                                       step went to the route and method journey.yaml says.
// Routes are compared segment by segment: `{param}` in a template matches any single segment, literals ignore case
// (the API's routing does), and a query string never counts.

import { parse as parseYaml } from 'yaml';
import { ConfigError, envConfig, type EnvConfig, type Feature, type Project, type Step } from './config.js';

export type ProblemCode =
  | 'NO_EVIDENCE'
  | 'ROUTE_NOT_IN_SWAGGER'
  | 'WRITE_IN_READ_ONLY'
  | 'WRITE_NOT_DECLARED'
  | 'STEP_NOT_EXERCISED'
  | 'UNNAMED_REQUEST'
  | 'ROUTE_MISMATCH';

export interface Problem {
  code: ProblemCode;
  /** Journey name (journey.yaml `name`). */
  journey?: string;
  /** Step name (journey.yaml step `name`, without the journey key). */
  step?: string;
  detail: string;
}

/** The part of an OpenAPI document the checks read: path -> method -> operation. */
export interface Swagger {
  paths: Record<string, Record<string, unknown>>;
}

/**
 * A request k6 sent, as `observedRequests` lists it. `url` is the full URL or just its path (`/api/items/search`);
 * absent or empty when k6 recorded none, and then only name and method are compared.
 */
export interface ObservedCall {
  name: string;
  method: string;
  url?: string;
}

/** The name k6 gets for the token request (core/auth/ropc.js tags it so); it goes to the token endpoint, outside the API. */
const AUTH_TOKEN = 'auth_token';

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A check that cannot be answered: the env has no swagger, or it could not be fetched or read. Nothing was sent. */
export class SwaggerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwaggerError';
  }
}

/** The journey check found problems; a run was refused before it started. */
export class JourneyCheckError extends Error {
  constructor(
    readonly project: string,
    readonly feature: string,
    readonly problems: Problem[],
  ) {
    super(
      `the journey check found ${problems.length} problem${problems.length === 1 ? '' : 's'} in ${project}/${feature}; ` +
        `nothing was sent. Fix journey.yaml:\n${problems.map((p) => `  - ${formatProblem(p)}`).join('\n')}`,
    );
    this.name = 'JourneyCheckError';
  }
}

/** `CODE journey.step: detail` (the journey or step part is left out when the problem has none). */
export function formatProblem(problem: Problem): string {
  const where = problem.journey && problem.step ? `${problem.journey}.${problem.step}` : (problem.journey ?? '');
  return `${problem.code}${where ? ` ${where}` : ''}: ${problem.detail}`;
}

// ---------------------------------------------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------------------------------------------

/** The non-empty segments of a path or route; a query string or fragment is cut off. */
function splitPath(path: string): string[] {
  return path
    .split(/[?#]/)[0]!
    .split('/')
    .filter((segment) => segment !== '');
}

const PARAM = /\{[^/{}]+\}/;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does `actual` fill the template segment? A template with `{param}` parts matches any text in their place (so `{id}`
 * matches any segment and `{name}.{ext}` matches `report.xlsx`); a literal segment matches itself, ignoring case.
 */
function segmentMatches(template: string, actual: string): boolean {
  if (!PARAM.test(template)) return template.toLowerCase() === actual.toLowerCase();
  const source = template.split(new RegExp(PARAM, 'g')).map(escapeRegExp).join('.+');
  return new RegExp(`^${source}$`, 'i').test(actual);
}

function segmentsMatch(template: string[], actual: string[]): boolean {
  return template.length === actual.length && template.every((segment, i) => segmentMatches(segment, actual[i]!));
}

/** The segments of the api url's path (`https://host/api/` -> `['api']`). */
function apiBase(apiUrl: string): string[] {
  try {
    return splitPath(new URL(apiUrl).pathname);
  } catch {
    throw new ConfigError(`api_url ${JSON.stringify(apiUrl)} is not a valid URL`);
  }
}

const asPath = (segments: string[]): string => `/${segments.join('/')}`;

/** Which methods swagger offers on the paths that match `segments`, and whether `method` is one of them. */
function lookupSwagger(swagger: Swagger, segments: string[], method: string): { found: boolean; methods: string[] } {
  const methods = new Set<string>();
  for (const [path, item] of Object.entries(swagger.paths)) {
    if (!segmentsMatch(splitPath(path), segments)) continue;
    if (typeof item !== 'object' || item === null) continue;
    for (const key of Object.keys(item)) {
      if (HTTP_METHODS.has(key.toLowerCase())) methods.add(key.toUpperCase());
    }
  }
  return { found: methods.has(method.toUpperCase()), methods: [...methods].sort() };
}

// ---------------------------------------------------------------------------------------------------------------
// before a run: P1 and P7b
// ---------------------------------------------------------------------------------------------------------------

const hasEvidence = (evidence: Record<string, unknown> | undefined): boolean => evidence !== undefined && Object.keys(evidence).length > 0;

/**
 * P1 and P7b on journey.yaml: every step cites evidence (its own, else its journey's), every step's method and route
 * (prefixed with the api url's path) exist in `swagger`, a read-only feature sends no write, and a writing feature sends
 * no write it did not declare (a write is PUT, PATCH, DELETE, or a POST that read_only_post_routes does not list).
 * @param apiUrl the env's api_url; its path is the prefix of every journey route in swagger
 * @throws {ConfigError} when `apiUrl` is not a URL
 */
export function checkJourney(feature: Feature, swagger: Swagger, project: Project, apiUrl: string): Problem[] {
  const base = apiBase(apiUrl);
  const listedPosts = new Set(project.readOnlyPostRoutes.map((route) => asPath(splitPath(route)).toLowerCase()));
  const problems: Problem[] = [];

  for (const journey of feature.journeys) {
    for (const step of journey.steps) {
      const at = { journey: journey.name, step: step.name };
      const request = `${step.method} ${step.route}`;

      if (!hasEvidence(step.evidence) && !hasEvidence(journey.evidence)) {
        problems.push({
          code: 'NO_EVIDENCE',
          ...at,
          detail: `${request} cites no evidence (a HAR entry, swagger route or automated test line); add an evidence: block to the step or to journey ${journey.name}`,
        });
      }

      const swaggerPath = asPath([...base, ...splitPath(step.route)]);
      const lookup = lookupSwagger(swagger, [...base, ...splitPath(step.route)], step.method);
      if (!lookup.found) {
        problems.push({
          code: 'ROUTE_NOT_IN_SWAGGER',
          ...at,
          detail:
            lookup.methods.length === 0
              ? `${request} (swagger path ${swaggerPath}) is not in the swagger of this env`
              : `${request} (swagger path ${swaggerPath}) is not in the swagger for ${step.method}; swagger has ${lookup.methods.join(', ')}`,
        });
      }

      const isWrite =
        !READ_METHODS.has(step.method) && !(step.method === 'POST' && listedPosts.has(asPath(splitPath(step.route)).toLowerCase()));
      const declared = feature.writes?.some((w) => w.method === step.method && segmentsMatch(splitPath(w.route), splitPath(step.route)));
      // `writes` is absent only on a feature built in code (loadFeature requires it when read_only is false); such a
      // feature's steps are not checked for writes, which the swagger tests rely on.
      if (!feature.readOnly && feature.writes && isWrite && !declared) {
        problems.push({
          code: 'WRITE_NOT_DECLARED',
          ...at,
          detail: `${request} writes, but journey.yaml writes: does not declare it; declare it there (with who cleans up), or make the step a read`,
        });
      }
      if (feature.readOnly && !READ_METHODS.has(step.method)) {
        if (isWrite) {
          problems.push({
            code: 'WRITE_IN_READ_ONLY',
            ...at,
            detail:
              step.method === 'POST'
                ? `${request} is a POST that read_only_post_routes of project ${project.name} does not list; a read-only feature may POST only to listed routes`
                : `${request} writes, but feature ${feature.name} is read-only (only GET, HEAD, OPTIONS and listed POST routes are allowed)`,
          });
        }
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// after a smoke: P2
// ---------------------------------------------------------------------------------------------------------------

const withoutQuery = (text: string): string => text.replace(/[?#].*$/, '');

/** What is wrong with `request` for a step it is named after, or undefined when it agrees with journey.yaml. */
function mismatch(request: ObservedCall, step: Step, base: string[]): string | undefined {
  const id = request.name;
  const says = `journey.yaml says ${step.method} ${step.route}`;
  if (request.method.toUpperCase() !== step.method) {
    return `${id} was sent as ${request.method || '(no method)'}, ${says}`;
  }
  if (!request.url) return undefined;

  let path: string[];
  try {
    path = splitPath(new URL(request.url, 'http://host.invalid').pathname); // the base only serves a url that is just a path
  } catch {
    return `${id} has an url k6 recorded in a form that cannot be read, ${says}`;
  }
  const shown = asPath(path);
  const underBase = base.every((segment, i) => path[i] !== undefined && segmentMatches(segment, path[i]!));
  if (!underBase) return `${id} was sent to ${shown}, outside the api path ${asPath(base)}; ${says}`;
  if (!segmentsMatch(splitPath(step.route), path.slice(base.length))) {
    return `${id} was sent to ${request.method.toUpperCase()} ${shown}, ${says} (under the api path ${asPath(base)})`;
  }
  return undefined;
}

/**
 * P2 on the requests a smoke sent: each is the token request or a step id (`<journey key>.<step>`) of the journeys, and
 * went to that step's route with its method; each step was sent at least once. A step name that is not a step id (k6
 * names an unnamed request after its URL) is UNNAMED_REQUEST.
 * @param observed unique requests of the run (`observedRequests`)
 * @param apiUrl the api url the run used; request urls are compared with journey routes under its path
 */
export function checkScriptMatchesJourney(feature: Feature, observed: ObservedCall[], apiUrl: string): Problem[] {
  const base = apiBase(apiUrl);
  const steps = new Map<string, { journey: string; step: Step }>();
  for (const journey of feature.journeys) {
    for (const step of journey.steps) steps.set(`${journey.key}.${step.name}`, { journey: journey.name, step });
  }

  const problems: Problem[] = [];
  const sent = new Set<string>();
  for (const request of observed) {
    if (request.name === AUTH_TOKEN) continue;
    const known = steps.get(request.name);
    if (!known) {
      problems.push({
        code: 'UNNAMED_REQUEST',
        detail:
          `request ${request.method} ${withoutQuery(request.name || request.url || '(no name)')} is not named after a journey step; ` +
          `send every request through step('<journey key>.<step>', ...) (the token request is the only other allowed name, ${AUTH_TOKEN})`,
      });
      continue;
    }
    sent.add(request.name);
    const wrong = mismatch(request, known.step, base);
    if (wrong) problems.push({ code: 'ROUTE_MISMATCH', journey: known.journey, step: known.step.name, detail: wrong });
  }

  for (const [id, { journey, step }] of steps) {
    if (!sent.has(id)) {
      problems.push({
        code: 'STEP_NOT_EXERCISED',
        journey,
        step: step.name,
        detail: `${id} (${step.method} ${step.route}) was never sent; every journey step must be a named request in the script`,
      });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// the swagger document and the whole check
// ---------------------------------------------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 15_000;

/**
 * The env's swagger document (fetched once per call).
 * @throws {ConfigError} when the env has no swagger_url: P1 must be checked, not skipped
 * @throws {SwaggerError} when it cannot be fetched or is not an OpenAPI document with `paths`
 */
export async function fetchSwagger(config: Pick<EnvConfig, 'swaggerUrl'>, env: string): Promise<Swagger> {
  const url = config.swaggerUrl;
  if (!url) throw new ConfigError(`no swagger_url configured for env ${env}`);
  const where = `the swagger of env ${env} (${url})`;

  let status: number;
  let text: string;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow', headers: { accept: 'application/json, application/yaml;q=0.9, */*;q=0.5' } });
    status = res.status;
    text = await res.text();
  } catch (err) {
    const reason = (err as { cause?: Error }).cause?.message ?? (err as Error).message;
    throw new SwaggerError(`could not fetch ${where}: ${reason}`);
  }
  if (status < 200 || status > 299) throw new SwaggerError(`could not read ${where}: it answered ${status}`);

  // An OpenAPI document is JSON or YAML (an app's own repo often keeps the YAML one).
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    try {
      doc = parseYaml(text);
    } catch {
      doc = undefined;
    }
    if (typeof doc !== 'object' || doc === null) throw new SwaggerError(`could not read ${where}: the answer is not JSON or YAML`);
  }
  const paths = (doc as { paths?: unknown } | null)?.paths;
  if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) {
    throw new SwaggerError(`could not read ${where}: the document has no "paths" object`);
  }
  return { paths: paths as Swagger['paths'] };
}

/**
 * Fetch the env's swagger and run checkJourney against it.
 * @throws {ConfigError} for an unknown env, an env without swagger_url, or an invalid api_url
 * @throws {SwaggerError} when the swagger cannot be fetched or read
 */
export async function checkFeature(project: Project, feature: Feature, env: string): Promise<Problem[]> {
  const config = envConfig(project, env);
  const swagger = await fetchSwagger(config, env);
  return checkJourney(feature, swagger, project, config.apiUrl);
}

/** checkFeature, refusing when it finds problems. @throws {JourneyCheckError} */
export async function requireJourneyChecks(project: Project, feature: Feature, env: string): Promise<void> {
  const problems = await checkFeature(project, feature, env);
  if (problems.length > 0) throw new JourneyCheckError(project.name, feature.name, problems);
}
