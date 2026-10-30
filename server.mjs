import { createApp } from './lib/app.mjs';
import { closePool, getPool } from './lib/db.mjs';
import { purgeExpired } from './lib/sessions.mjs';

const port = Number(process.env.PORT) || 3000;
const server = createApp();

server.listen(port, '0.0.0.0', () => console.log(`Healthy Discussion listening on :${port}`));

// Housekeeping: drop sessions past their absolute expiry.
const timer = setInterval(() => {
  purgeExpired().catch((err) => console.error('session purge failed:', err?.code ?? err?.name));
}, 60 * 60 * 1000);
timer.unref();

async function shutdown() {
  clearInterval(timer);
  server.close(async () => {
    await closePool().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

void getPool; // pool is created on first use, not at boot
