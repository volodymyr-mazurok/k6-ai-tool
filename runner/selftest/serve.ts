import { startMockServer } from './server.js';

const PORT = 4010;

const server = await startMockServer({ port: PORT });
console.log(`Mock server listening on ${server.url}`);
console.log('Login: POST /oauth/token (grant_type=password, username=perf, password=perf). Ctrl+C to stop.');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server.stop().then(() => process.exit(0));
  });
}
