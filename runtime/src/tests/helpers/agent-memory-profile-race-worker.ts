import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const [engine, directory, mode, identityRegistryDirectory] = process.argv.slice(2);
if (!engine || !directory || !identityRegistryDirectory || !['stale-assignment', 'first-open'].includes(mode ?? '')) throw new Error('invalid_memory_profile_race_arguments');
const enginePath = engine, root = directory, assignmentPath = join(root, '.secumon', 'personal-memory-profile.json');
const originalLstat = fs.lstatSync;
let injections = 0;
const waitCell = new Int32Array(new SharedArrayBuffer(4));
function output(value: unknown) { fs.writeSync(1, JSON.stringify(value) + '\n'); }
type FailureDiagnostic = { name: string; code: string | null; message: string; stack: string | null; cause: FailureDiagnostic | null };
function failure(error: unknown, depth = 0): FailureDiagnostic {
  if (!(error instanceof Error)) return { name: 'NonError', code: null, message: 'non_error_throw', stack: null, cause: null };
  const value = error as Error & { code?: unknown };
  return { name: value.name, code: typeof value.code === 'string' ? value.code.slice(0, 160) : null,
    message: value.message.slice(0, 2048), stack: value.stack?.split('\n').slice(0, 16).join('\n').slice(0, 4096) ?? null,
    cause: depth < 3 && value.cause !== undefined ? failure(value.cause, depth + 1) : null };
}
function pause(boundary: string) {
  output({ type: 'boundary', boundary });
  const token = Buffer.alloc(1), deadline = Date.now() + 30000;
  for (;;) {
    try {
      if (fs.readSync(0, token, 0, 1, null) !== 1 || token[0] !== 49) throw new Error('memory_profile_race_resume_required');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN' || Date.now() >= deadline) throw error;
      Atomics.wait(waitCell, 0, 0, 10);
    }
  }
}
// Only this child intercepts fs. It forwards the real lstat, captures ENOENT,
// and returns that same observation after another process completes normal setup.
if (mode === 'stale-assignment') {
  Reflect.set(fs, 'lstatSync', ((...args: unknown[]) => {
    try { return Reflect.apply(originalLstat, fs, args); }
    catch (error) {
      if (injections === 0 && String(args[0]) === assignmentPath && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        injections++; pause('assignment-observed-missing');
      }
      throw error;
    }
  }) as typeof fs.lstatSync);
}
syncBuiltinESMExports();
try {
  const { FileAgentProfileStore } = await import('../../infrastructure/file-agent-profile.js');
  const { openAgentStores } = await import('../../infrastructure/agent-stores.js');
  if (mode === 'first-open') pause('before-first-open');
  const stores = await openAgentStores(new FileAgentProfileStore(enginePath), root, undefined, { identityRegistryDirectory });
  try {
    const agentId = stores.profile.identity.agentId;
    const retained = await stores.knowledge.get('tenant-a', 'same-memory', { agentId, partition: 'personal', principalId: 'user-a' });
    output({ type: 'result', injections, status: stores.profile.status, agentId, retained,
      assignment: fs.readFileSync(assignmentPath, 'utf8'),
      ready: fs.readFileSync(join(root, '.secumon', 'document-memory-ready.json'), 'utf8'), failure: null });
  } finally { await stores.close(); }
} catch (error) {
  output({ type: 'result', injections, failure: failure(error) });
  process.exitCode = 1;
} finally { Reflect.set(fs, 'lstatSync', originalLstat); syncBuiltinESMExports(); }
