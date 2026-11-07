/**
 * Test stand-in for the native pet (`ti-pet`): speaks the JSON-lines
 * protocol of native-protocol.mjs on the socket it is given, checks the
 * token like the real one (re-read on every hello), logs every message it
 * gets to $STUB_LOG and answers `handoff` with `ack`, `quit` by exiting.
 *
 *   STUB_EVENTS=1  after `ready`, send a `position` then an `event click`
 *   STUB_CRASH=1   exit right after `ready` (crash-loop tests)
 */
import { appendFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const socketPath = arg('--socket');
const tokenFile = arg('--token-file');
const log = (entry) => {
  if (process.env.STUB_LOG) {
    appendFileSync(process.env.STUB_LOG, `${JSON.stringify(entry)}\n`);
  }
};

log({
  kind: 'spawned',
  pid: process.pid,
  argv: process.argv.slice(2),
  gdk: process.env.GDK_BACKEND ?? null
});
rmSync(socketPath, { force: true });

const server = createServer((conn) => {
  let buffer = '';
  let hello = false;
  conn.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const message = JSON.parse(line);
      log(message);
      if (!hello) {
        const token = readFileSync(tokenFile, 'utf8').trim();
        if (message.kind !== 'hello' || message.token !== token) {
          conn.destroy();
          return;
        }
        hello = true;
        conn.write(
          `${JSON.stringify({ kind: 'ready', protocol: 1, version: 'stub', caps: ['duo'], pid: process.pid })}\n`
        );
        if (process.env.STUB_CRASH === '1')
          setTimeout(() => process.exit(3), 50);
        if (process.env.STUB_EVENTS === '1') {
          conn.write(
            `${JSON.stringify({ kind: 'position', x: 40, y: 60, displayId: 'd1', secondSide: 'right' })}\n`
          );
          conn.write(`${JSON.stringify({ kind: 'event', event: 'click' })}\n`);
          conn.write(
            `${JSON.stringify({ kind: 'menuAction', id: 'tray.open-tracinginsights' })}\n`
          );
        }
        continue;
      }
      if (message.kind === 'handoff') {
        conn.write(`${JSON.stringify({ kind: 'ack', of: 'handoff' })}\n`);
      }
      if (message.kind === 'quit') {
        conn.end();
        server.close();
        rmSync(socketPath, { force: true });
        process.exit(0);
      }
    }
  });
});
server.listen(socketPath, () => {
  chmodSync(socketPath, 0o600);
  log({ kind: 'listening' });
});
// Never outlive a test run by much.
setTimeout(() => process.exit(0), 20_000).unref?.();
setInterval(() => {}, 1000);
