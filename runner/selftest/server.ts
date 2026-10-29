import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

export interface MockServerOptions {
  /** Listen port; 0 (default) picks a free one. */
  port?: number;
  /** How many slow-search requests are served at once. */
  slowSlots?: number;
  /** Service time of one slow-search request. slowSlots / slowServiceMs is its capacity. */
  slowServiceMs?: number;
  /** How many slow-search requests may wait for a slot before the next one gets a 503. */
  queueLimit?: number;
}

export interface MockServer {
  url: string;
  stop(): Promise<void>;
  /** Extra latency in ms added to every slow-search response, on top of the service time. */
  setExtraDelay(ms: number): void;
  /** Fraction (0..1) of authenticated API calls answered with 500 { error: 'planted' }. */
  setFailRate(rate: number): void;
  /** HTTP status the token endpoint answers with; 200 (default) means normal behaviour. */
  setTokenStatus(code: number): void;
  /** Number of requests the token endpoint has received, whatever its answer. */
  tokenCalls(): number;
  /**
   * What the token endpoint issues from now on: a JWT (default) or an opaque access token that only `expires_in` dates,
   * living `lifetimeSec` (default 3600).
   */
  setTokenShape(shape: { opaque?: boolean; lifetimeSec?: number }): void;
}

const TOKEN_LIFETIME_SEC = 3600;
const SEARCH_LATENCY_MS = 20;
const EXPORT_BYTES = 2048;
const SIGNING_KEY = 'mock-server-signing-key';
const REFRESH_PREFIX = 'mock-refresh-';
const LOGIN = 'perf';
const PASSWORD = 'perf';

const SEARCH_BODY = JSON.stringify({
  items: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `Item ${i + 1}` })),
  totalCount: 500,
});

const EXPORT_BODY = Buffer.alloc(EXPORT_BYTES, 'perf-export;');

// Keys carry the /api prefix, like the real API's swagger.
const SWAGGER = JSON.stringify({
  openapi: '3.0.1',
  info: { title: 'Perf mock API', version: 'v1' },
  paths: {
    '/api/items/search': { post: { operationId: 'ItemsSearch', responses: { '200': { description: 'OK' } } } },
    '/api/items/slow-search': { post: { operationId: 'ItemsSlowSearch', responses: { '200': { description: 'OK' } } } },
    '/api/items/export': { post: { operationId: 'ItemsExport', responses: { '200': { description: 'OK' } } } },
  },
});

const ROOT_HTML =
  '<!doctype html><html><head><title>Perf mock app</title></head>' +
  '<body><app-root></app-root><script src="main-SELFTEST.js"></script></body></html>';

/** A semaphore with a bounded wait queue: acquire() resolves false when the queue is already full. */
class SlotQueue {
  private busy = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly slots: number,
    private readonly queueLimit: number,
  ) {}

  async acquire(): Promise<boolean> {
    if (this.busy < this.slots) {
      this.busy++;
      return true;
    }
    if (this.waiting.length >= this.queueLimit) return false;
    // release() hands its slot straight to us, so busy stays as it is.
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    return true;
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.busy--;
  }
}

function base64url(input: string): string {
  return Buffer.from(input).toString('base64url');
}

function issueTokens(shape: { opaque: boolean; lifetimeSec: number }): { access_token: string; refresh_token: string; expires_in: number } {
  const nowSec = Math.floor(Date.now() / 1000);
  const refresh_token = `${REFRESH_PREFIX}${randomBytes(16).toString('hex')}`;
  if (shape.opaque) return { access_token: `mock-opaque-${randomBytes(16).toString('hex')}`, refresh_token, expires_in: shape.lifetimeSec };
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ sub: LOGIN, iat: nowSec, exp: nowSec + shape.lifetimeSec }));
  const signature = createHmac('sha256', SIGNING_KEY).update(`${header}.${payload}`).digest('base64url');
  return { access_token: `${header}.${payload}.${signature}`, refresh_token, expires_in: shape.lifetimeSec };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, contentType: string, body: string | Buffer): void {
  if (res.destroyed || res.writableEnded) return; // the client or stop() already closed the connection
  res.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, 'application/json', typeof body === 'string' ? body : JSON.stringify(body));
}

function hasBearerToken(req: IncomingMessage): boolean {
  return /^Bearer\s+\S+/i.test(req.headers.authorization ?? '');
}

export async function startMockServer(opts: MockServerOptions = {}): Promise<MockServer> {
  const { port = 0, slowSlots = 4, slowServiceMs = 400, queueLimit = 20 } = opts;

  let extraDelayMs = 0;
  let failRate = 0;
  let tokenStatus = 200;
  let tokenCallCount = 0;
  let tokenShape = { opaque: false, lifetimeSec: TOKEN_LIFETIME_SEC };
  const slots = new SlotQueue(slowSlots, queueLimit);

  async function tokenEndpoint(req: IncomingMessage, res: ServerResponse): Promise<void> {
    tokenCallCount++;
    const form = new URLSearchParams(await readBody(req));
    if (tokenStatus !== 200) return sendJson(res, tokenStatus, { error: 'planted' });

    const grant = form.get('grant_type');
    const passwordGrant = grant === 'password' && form.get('username') === LOGIN && form.get('password') === PASSWORD;
    const refreshGrant = grant === 'refresh_token' && (form.get('refresh_token') ?? '').startsWith(REFRESH_PREFIX);
    if (passwordGrant || refreshGrant) return sendJson(res, 200, issueTokens(tokenShape));
    return sendJson(res, 400, { error: 'invalid_grant' });
  }

  const apiRoutes: Record<string, (res: ServerResponse) => Promise<void>> = {
    'POST /api/items/search': async (res) => {
      await sleep(SEARCH_LATENCY_MS);
      sendJson(res, 200, SEARCH_BODY);
    },
    'POST /api/items/slow-search': async (res) => {
      if (!(await slots.acquire())) return sendJson(res, 503, { error: 'queue_full' });
      try {
        await sleep(slowServiceMs);
      } finally {
        slots.release();
      }
      // Extra delay is plain added latency: it does not hold a slot, so it moves latency without moving capacity.
      if (extraDelayMs > 0) await sleep(extraDelayMs);
      sendJson(res, 200, SEARCH_BODY);
    },
    'POST /api/items/export': async (res) => {
      send(res, 200, 'application/octet-stream', EXPORT_BODY);
    },
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const route = `${req.method} ${new URL(req.url ?? '/', 'http://mock').pathname}`;

    if (route === 'POST /oauth/token') return tokenEndpoint(req, res);
    if (route === 'GET /swagger/v1/swagger.json') return sendJson(res, 200, SWAGGER);
    if (route === 'GET /') return send(res, 200, 'text/html; charset=utf-8', ROOT_HTML);

    if (!hasBearerToken(req)) return sendJson(res, 401, { error: 'unauthorized' });
    const apiRoute = apiRoutes[route];
    if (!apiRoute) return sendJson(res, 404, { error: 'not_found' });
    if (Math.random() < failRate) return sendJson(res, 500, { error: 'planted' });
    return apiRoute(res);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      sendJson(res, 500, { error: 'mock_server_error', message: String(err) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const { port: boundPort } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${boundPort}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections(); // keep-alive clients would otherwise hold close() open
      }),
    setExtraDelay: (ms) => {
      extraDelayMs = ms;
    },
    setFailRate: (rate) => {
      if (!(rate >= 0 && rate <= 1)) throw new RangeError(`failRate must be within 0..1, got ${rate}`);
      failRate = rate;
    },
    setTokenStatus: (code) => {
      tokenStatus = code;
    },
    tokenCalls: () => tokenCallCount,
    setTokenShape: (shape) => {
      tokenShape = { opaque: shape.opaque ?? false, lifetimeSec: shape.lifetimeSec ?? TOKEN_LIFETIME_SEC };
    },
  };
}
