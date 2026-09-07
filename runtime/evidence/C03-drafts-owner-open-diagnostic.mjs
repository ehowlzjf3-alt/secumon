// Bounded observational diagnostic; not a test-suite replacement or a production patch.
// Execute with the pinned Node24 build. Only self-created temporary agent data is opened.
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fork } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const script = fileURLToPath(import.meta.url);
const runtime = resolve(dirname(script), '..');
const serialize = (error, depth = 0) => {
  if (error === null || error === undefined) return null;
  if (depth >= 6) return { truncated: true, message: String(error) };
  return { name: error.name ?? typeof error, message: error.message ?? String(error), stack: error.stack ?? null,
    code: error.code ?? null, errno: error.errno ?? null, syscall: error.syscall ?? null, path: error.path ?? null,
    status: error.status ?? null, cause: serialize(error.cause, depth + 1),
    errors: Array.isArray(error.errors) ? error.errors.slice(0, 8).map(value => ({ stage: value.stage ?? null, error: serialize(value.error ?? value, depth + 1) })) : null };
};
async function send(value) {
  if (!process.send) throw new Error('diagnostic_worker_requires_ipc');
  await new Promise((done, reject) => process.send(value, error => error ? reject(error) : done()));
}

if (process.argv[2] === '--worker') {
  const [, , , engine, root, workerIndex] = process.argv;
  if (!engine || !root || !workerIndex) throw new Error('diagnostic_worker_arguments_missing');
  const original = fs.lstatSync, trace = []; let phase = 'import';
  const record = value => { trace.push(value); if (trace.length > 64) trace.shift(); };
  fs.lstatSync = function (path, options) {
    const name = path instanceof URL ? fileURLToPath(path) : String(path);
    const observed = name === root || name.startsWith(root + sep);
    try {
      const value = original.call(fs, path, options);
      if (observed) record({ at: performance.now(), phase, path: name.slice(root.length) || '.',
        exists: value !== undefined, ...(value ? { dev: String(value.dev), ino: String(value.ino), mode: Number(value.mode).toString(8),
          nlink: String(value.nlink), uid: String(value.uid), size: String(value.size), kind: value.isSymbolicLink() ? 'link' :
            value.isFile() ? 'file' : value.isDirectory() ? 'directory' : 'other' } : {}),
        caller: new Error().stack?.split('\n').slice(2, 6) ?? [] });
      return value;
    } catch (error) {
      if (observed) record({ at: performance.now(), phase, path: name.slice(root.length) || '.', error: serialize(error),
        caller: new Error().stack?.split('\n').slice(2, 6) ?? [] });
      throw error;
    }
  };
  syncBuiltinESMExports();
  let stores, primary = null, cleanup = null, ready = null;
  try {
    const { FileAgentProfileStore } = await import(pathToFileURL(join(runtime, 'dist/infrastructure/file-agent-profile.js')).href);
    const { openAgentStores } = await import(pathToFileURL(join(runtime, 'dist/infrastructure/agent-stores.js')).href);
    const profiles = new FileAgentProfileStore(engine);
    const start = new Promise(resolve => process.once('message', value => {
      if (value?.command !== 'go') throw new Error('diagnostic_invalid_start'); resolve();
    }));
    await send({ type: 'ready', workerIndex: Number(workerIndex) }); await start;
    phase = 'initialize'; ready = profiles.initialize(root);
    phase = 'openAgentStores'; stores = await openAgentStores(profiles, ready.root);
  } catch (error) { primary = serialize(error); }
  finally {
    if (stores) {
      phase = 'close';
      try { await stores.close(); } catch (error) { cleanup = serialize(error); }
    }
    fs.lstatSync = original; syncBuiltinESMExports();
  }
  await send({ type: 'result', workerIndex: Number(workerIndex), pid: process.pid, success: !primary && !cleanup,
    identity: ready?.identity ?? null, backend: ready?.config.storage.state ?? null, primary, cleanup,
    metadataTrace: primary || cleanup ? trace : [] });
  process.exitCode = primary || cleanup ? 1 : 0; process.disconnect();
} else {
  const batches = Number(process.argv[2] ?? '5');
  if (!Number.isInteger(batches) || batches < 1 || batches > 10) throw new Error('diagnostic_batches_must_be_1_to_10');
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('diagnostic_requires_supported_Node24');
  const { FileAgentProfileStore } = await import(pathToFileURL(join(runtime, 'dist/infrastructure/file-agent-profile.js')).href);
  const report = { diagnostic: 'four-process-first-storage-open', requestedBatches: batches, workersPerBatch: 4,
    node: process.version, platform: process.platform, uid: process.getuid?.() ?? null, runtime, startedAt: new Date().toISOString(),
    limitations: ['Observational lstat tracing changes timing; no injected filesystem result.', 'Only the current dist build is inspected; no rebuild or source mutation.',
      'No model/tool/channel messages, external services, NAS or existing agent data are used.', 'A non-reproduction does not clear the original failure.'],
    batches: [], cleanup: [], observedFailure: false };
  function child(engine, root, index) {
    const process = fork(script, ['--worker', engine, root, String(index)], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stdout = '', stderr = '', reply = null, launchError = null;
    process.stdout.on('data', bytes => { stdout = (stdout + String(bytes)).slice(-4096); });
    process.stderr.on('data', bytes => { stderr = (stderr + String(bytes)).slice(-16384); });
    let markReady; const ready = new Promise(resolve => { markReady = resolve; });
    process.on('message', value => { if (value?.type === 'ready') markReady(true); else if (value?.type === 'result') reply = value; });
    const exited = new Promise(resolve => {
      process.once('error', error => { launchError = serialize(error); markReady(false); resolve({ index, code: null, signal: null, reply, launchError, stdout, stderr }); });
      process.once('exit', (code, signal) => { markReady(false); resolve({ index, code, signal, reply, launchError, stdout, stderr }); });
    });
    const timer = setTimeout(() => { markReady(false); if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); }, 25000);
    return { process, ready, exited, async cleanup() {
      clearTimeout(timer); if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); return exited;
    } };
  }
  try {
    for (let batch = 1; batch <= batches; batch++) {
      const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'secumon-owner-open-diag-'))), engine = join(base, 'engine'), root = join(base, 'agent');
      let workers = [];
      try {
        fs.mkdirSync(engine, { mode: 0o700 }); const profiles = new FileAgentProfileStore(engine); const profile = profiles.initialize(root);
        if (profile.config.storage.state !== 'sqlite') throw new Error('diagnostic_expected_default_sqlite');
        workers = Array.from({ length: 4 }, (_, index) => child(engine, root, index));
        const allReady = await Promise.all(workers.map(value => value.ready));
        if (allReady.every(Boolean)) for (const value of workers) value.process.send({ command: 'go' });
        else for (const value of workers) if (value.process.exitCode === null && value.process.signalCode === null) value.process.kill('SIGKILL');
        const results = await Promise.all(workers.map(value => value.exited));
        const failed = results.some(value => value.code !== 0 || value.signal !== null || !value.reply?.success || value.reply.identity?.agentId !== profile.identity.agentId);
        report.batches.push({ batch, identity: profile.identity, results, failed }); report.observedFailure ||= failed;
      } finally {
        await Promise.all(workers.map(value => value.cleanup()));
        try { fs.rmSync(base, { recursive: true, force: true }); report.cleanup.push({ batch, removed: !fs.existsSync(base) }); }
        catch (error) { report.cleanup.push({ batch, removed: false, error: serialize(error) }); throw error; }
      }
      if (report.observedFailure) break;
    }
  } catch (error) { report.runnerError = serialize(error); process.exitCode = 2; }
  report.finishedAt = new Date().toISOString();
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!process.exitCode) process.exitCode = report.observedFailure ? 1 : 0;
}
