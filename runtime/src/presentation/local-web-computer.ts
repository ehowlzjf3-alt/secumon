import { startLocalWebComputerFixture } from '../infrastructure/local-web-computer-fixture.js';

// A disposable local learning surface. Bind only loopback; the runtime receives a separately installed browser transport.
const stateFile = process.env['SECUMON_FIXTURE_STATE_FILE'];
const fixture = await startLocalWebComputerFixture(stateFile ? { stateFile } : {});
console.log(JSON.stringify({ kind: 'local_web_fixture_ready', url: fixture.url, persistence: stateFile ? 'file' : 'memory',
  automation: 'typed-dom', nativeOsInput: false, modelConnected: false }));
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await fixture.close();
  console.log(JSON.stringify({ kind: 'local_web_fixture_stopped', closed: true }));
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
