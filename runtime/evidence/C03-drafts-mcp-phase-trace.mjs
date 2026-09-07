// Optional evidence-only preload for one isolated MCP test file. No arguments or result bodies are logged.
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { createHook } from 'node:async_hooks';
import { syncBuiltinESMExports } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const diagnosticDirectory = process.env.SECUMON_MCP_DIAG_DIR;
const selected = process.argv.some(value => /(?:^|[\\/])mcp-read-tools\.test\.js$/.test(value)) &&
  !process.execArgv.includes('--test');

async function install() {
  const maximumEvents = 2000, ordinaryEventLimit = 1996, maximumPending = 64;
  const startedAt = performance.now();
  let fd;
  try {
    if (!diagnosticDirectory || !isAbsolute(diagnosticDirectory)) return;
    const directory = fs.lstatSync(diagnosticDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 ||
      process.getuid && directory.uid !== process.getuid()) return;
    fd = fs.openSync(join(diagnosticDirectory, `${process.pid}.jsonl`),
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  } catch { return; }

  let events = 0, suppressed = 0, nextPhase = 0, omittedPhases = 0, omittedFs = 0, disabled = false;
  let insideHook = false;
  const phases = new Map(), pendingFs = new Map();
  const instrumentedHandles = new WeakSet();
  const restores = [];
  const code = error => {
    try { return typeof error?.code === 'string' ? error.code.slice(0, 96) : null; }
    catch { return null; }
  };
  function emit(value, reserved = false) {
    if (disabled) return;
    if (events >= (reserved ? maximumEvents : ordinaryEventLimit)) { suppressed++; return; }
    try {
      const bytes = Buffer.from(JSON.stringify({ diagnostic: 'C03-drafts-mcp-phase-trace',
        event: ++events, pid: process.pid, elapsedMs: performance.now() - startedAt, ...value }) + '\n');
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error('diagnostic_write_incomplete');
        offset += written;
      }
    } catch { disabled = true; }
  }
  function begin(name) {
    const id = ++nextPhase;
    const phase = { id, name, startedMs: performance.now() - startedAt };
    if (phases.size < maximumPending) phases.set(id, phase); else omittedPhases++;
    emit({ type: 'phase', state: 'started', id, name });
    return id;
  }
  function finish(id, name, error, failed) {
    try {
      phases.delete(id);
      emit({ type: 'phase', state: failed ? 'failed' : 'completed', id, name, ...(failed ? { code: code(error) } : {}) });
    } catch { /* Instrumentation cannot change a result. */ }
  }
  function wrap(target, key, name, afterSuccess, retainRestore = true, announce = true) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (!descriptor || typeof descriptor.value !== 'function' || !descriptor.writable) {
        if (announce) emit({ type: 'instrumentation', name, state: 'unavailable' }); return;
      }
      const original = descriptor.value;
      const wrapped = function (...args) {
        let id;
        try { id = begin(name); } catch { /* Call the original even if tracking fails. */ }
        let result;
        try { result = Reflect.apply(original, this, args); }
        catch (error) { finish(id, name, error, true); throw error; }
        // Observe settlement without replacing the caller's Promise or returned value.
        try {
          if (result && typeof result.then === 'function') {
            result.then(value => {
              try { afterSuccess?.(value); } catch { /* Keep the original fulfillment. */ }
              finish(id, name, undefined, false);
            }, error => { finish(id, name, error, true); });
          } else {
            try { afterSuccess?.(result); } catch { /* Keep the original return value. */ }
            finish(id, name, undefined, false);
          }
        } catch { /* Observation cannot replace the original Promise. */ }
        return result;
      };
      Object.defineProperty(target, key, { ...descriptor, value: wrapped });
      if (retainRestore) restores.push(() => {
        if (Object.getOwnPropertyDescriptor(target, key)?.value === wrapped) Object.defineProperty(target, key, descriptor);
      });
      if (announce) emit({ type: 'instrumentation', name, state: 'installed' });
    } catch (error) { emit({ type: 'instrumentation', name, state: 'unavailable', code: code(error) }); }
  }
  function traceHandleClose(handle) {
    if (!handle || typeof handle !== 'object' || instrumentedHandles.has(handle)) return;
    instrumentedHandles.add(handle);
    // Node's FileHandle.close is an own method. Do not replace the handle or its private state.
    // No restore closure retains this handle after its normal close/GC lifetime.
    wrap(handle, 'close', 'fs.FileHandle.close', undefined, false, false);
  }
  const hook = createHook({
    init(asyncId, type, triggerAsyncId) {
      if (insideHook || disabled || type !== 'FSREQPROMISE' && type !== 'FILEHANDLECLOSEREQ') return;
      insideHook = true;
      try {
        if (pendingFs.size >= maximumPending) { omittedFs++; return; }
        const stack = new Error('pending_fs_created').stack?.split('\n').slice(1, 13).join('\n').slice(0, 2048) ?? '';
        pendingFs.set(asyncId, { asyncId, type, triggerAsyncId, startedMs: performance.now() - startedAt,
          phaseIds: [...phases.keys()].slice(-16), stack });
      } catch { /* No exceptions may escape an async_hooks callback. */ }
      finally { insideHook = false; }
    },
    destroy(asyncId) { try { pendingFs.delete(asyncId); } catch {} },
    promiseResolve(asyncId) { try { pendingFs.delete(asyncId); } catch {} },
  });

  function selfProc() {
    if (process.platform !== 'linux') return { available: false, reason: 'not_linux' };
    function read(path) {
      let file;
      try {
        file = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const bytes = Buffer.alloc(4096), length = fs.readSync(file, bytes, 0, bytes.length, null);
        return { value: bytes.subarray(0, length).toString('utf8').trim(), limitReached: length === bytes.length };
      } catch (error) { return { unavailable: true, code: code(error) }; }
      finally { if (file !== undefined) try { fs.closeSync(file); } catch {} }
    }
    const tids = []; let directory, truncated = false;
    try {
      directory = fs.opendirSync('/proc/self/task');
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (!/^\d+$/.test(entry.name)) continue;
        if (tids.length === maximumPending) { truncated = true; break; }
        tids.push(entry.name);
      }
    } catch (error) { return { available: false, code: code(error) }; }
    finally { if (directory) try { directory.closeSync(); } catch {} }
    return { available: true, truncated, threads: tids.sort((a, b) => Number(a) - Number(b)).map(tid => ({ tid: Number(tid),
      wchan: read(`/proc/self/task/${tid}/wchan`), syscall: read(`/proc/self/task/${tid}/syscall`),
      children: read(`/proc/self/task/${tid}/children`) })) };
  }
  emit({ type: 'installed', node: process.version, platform: process.platform,
    limits: { maximumEvents, maximumPending, snapshotAfterMs: 20000, fsStackCharacters: 2048 },
    note: 'Promise observation adds microtasks; test results and original exceptions are preserved.' });
  hook.enable();
  const snapshotTimer = setTimeout(() => {
    try {
      emit({ type: 'snapshot', afterMs: 20000, diagnosticTimerCurrentlyRunning: true,
        activeResources: process.getActiveResourcesInfo().slice(0, 128),
        phases: [...phases.values()], pendingFs: [...pendingFs.values()], omittedPhases, omittedFs,
        suppressedEvents: suppressed, proc: selfProc() }, true);
    } catch (error) { emit({ type: 'snapshot_unavailable', code: code(error) }, true); }
  }, 20000);
  snapshotTimer.unref();

  process.once('exit', exitCode => {
    try {
      hook.disable(); clearTimeout(snapshotTimer);
      emit({ type: 'exit', exitCode, activeResources: process.getActiveResourcesInfo().slice(0, 128),
        phases: [...phases.values()], pendingFs: [...pendingFs.values()],
        omittedPhases, omittedFs, suppressedEvents: suppressed }, true);
    } catch { /* Never change the test's exit result. */ }
    for (const restore of restores.reverse()) try { restore(); } catch {}
    try { fs.closeSync(fd); } catch {}
  });

  wrap(fsPromises, 'rm', 'fs.promises.rm');
  wrap(fsPromises, 'open', 'fs.promises.open', traceHandleClose);
  syncBuiltinESMExports();
  try {
    const [{ McpStdioClient }, { FileArtifactStore }] = await Promise.all([
      import(pathToFileURL(resolve(process.cwd(), 'dist/infrastructure/mcp-stdio-client.js')).href),
      import(pathToFileURL(resolve(process.cwd(), 'dist/infrastructure/file-artifacts.js')).href),
    ]);
    for (const method of ['discover', 'call', 'close', 'shutdown']) wrap(McpStdioClient.prototype, method, `McpStdioClient.${method}`);
    for (const method of ['put', 'get', 'exists']) wrap(FileArtifactStore.prototype, method, `FileArtifactStore.${method}`);
    emit({ type: 'ready' });
  } catch (error) { emit({ type: 'instrumentation_import_failed', code: code(error) }, true); }
}

if (selected && diagnosticDirectory) {
  try { await install(); } catch { /* A diagnostic setup failure must not fail the test itself. */ }
}
