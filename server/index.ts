import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';

const here = path.dirname(fileURLToPath(import.meta.url));
// production bundle lives in dist/server, the built client in dist/client
const clientDir = path.resolve(here, '../client');

const app = await createApp({ clientDir });
console.log(`MathBoard server listening on http://localhost:${app.port}`);
console.log(`  data directory: ${app.store.dataDir}`);
console.log(`  passcode: ${process.env.APP_PASSCODE ? 'required' : 'not set'}`);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  console.log('Saving and shutting down…');
  const force = setTimeout(() => process.exit(0), 5000);
  await app.close().catch(() => {});
  clearTimeout(force);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => console.error('[uncaught]', err));
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));
