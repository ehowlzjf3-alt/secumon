import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactRef, TaskSpec, WorkState } from '../domain/model.js';
import type { ReadCheckpoint } from '../domain/read-checkpoint.js';
import type { StateRepository } from '../application/ports.js';
import type { McpCollectionAudit } from './helpers/mcp-collection-fixture-contracts.js';
import { assertMcpPeersStopped } from './mcp-agent-profile-helper.js';

export type CollectionCrashStage = 'raw' | 'response' | 'usage';
export type CollectionCrashBackend = 'sqlite' | 'file-journal';
export interface CollectionCrashObservation {
  kind: 'checkpoint' | 'recovered'; stage: CollectionCrashStage; backend: CollectionCrashBackend;
  pid: number; peerPid: number | null; agentId: string; workId: string; attemptId: string; runtimeOwner: string;
  state: WorkState; before: WorkState | null; returned: WorkState | null; task: TaskSpec;
  head: { ref: ArtifactRef; text: string; checkpoint: ReadCheckpoint };
  raw: { ref: ArtifactRef; text: string } | null;
  responseCommandId: string;
  receipts: Record<string, Awaited<ReturnType<StateRepository['receipt']>>>;
  events: Awaited<ReturnType<StateRepository['events']>>;
  counters: { calls: number; discoveries: number; captures: number; fetches: number; projections: number;
    manifests: number; rawPuts: number; accountingReads: string[] };
}
export function collectionCrashAudit(base: string): McpCollectionAudit[] {
  try { return readFileSync(join(base, 'peer.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as McpCollectionAudit); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
async function exited(pid: number) {
  const until = Date.now() + 5000;
  while (alive(pid)) {
    if (Date.now() >= until) throw new Error(`collection_custody_owned_process_live:${pid}`);
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
}
async function bounded<T>(pending: Promise<T>, ms: number, reason: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(reason())), ms);
  })]); } finally { if (timer) clearTimeout(timer); }
}

/** Parent observes the exact post-write boundary before killing its own worker. Adapted from the plain custody crash harness. */
export async function runCollectionCrashWorker(base: string, backend: CollectionCrashBackend, stage: CollectionCrashStage,
  mode: 'crash' | 'recover', attemptId?: string): Promise<CollectionCrashObservation> {
  const child = fork(new URL('./mcp-collection-custody-crash-worker.js', import.meta.url),
    [base, backend, stage, mode, ...(attemptId ? [attemptId] : [])], { execPath: process.execPath, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout!.resume(); let stderr = '';
  child.stderr!.on('data', value => { stderr = (stderr + String(value)).slice(-16384); });
  const exit = once(child, 'exit');
  const message = new Promise<CollectionCrashObservation>((resolve, reject) => {
    child.once('error', reject); child.once('message', value => {
      try {
        const observation = value as CollectionCrashObservation;
        assert.equal(observation.kind, mode === 'crash' ? 'checkpoint' : 'recovered');
        assert.equal(observation.pid, child.pid); assert.equal(observation.stage, stage); assert.equal(observation.backend, backend);
        assert.ok(Buffer.byteLength(JSON.stringify(observation)) <= 1048576, 'bounded synthetic observation');
        resolve(observation);
      } catch (error) { reject(error); }
    });
  });
  try {
    const value = await bounded(Promise.race([message, exit.then(([code, signal]) => {
      throw new Error(`collection_custody_early_exit:${String(code)}:${String(signal)}:${stderr}`);
    })]), 20000, () => `collection_custody_checkpoint_timeout:${stderr}`);
    if (mode === 'crash') {
      assert.equal(child.kill('SIGKILL'), true);
      const [code, signal] = await bounded(exit, 5000, () => `collection_custody_kill_timeout:${stderr}`);
      assert.equal(code, null, stderr); assert.equal(signal, 'SIGKILL', stderr);
      assert.ok(Number.isSafeInteger(value.peerPid) && value.peerPid! > 0 && value.peerPid !== child.pid && value.peerPid !== process.pid);
      await exited(value.pid); await exited(value.peerPid!); assertMcpPeersStopped(join(base, 'peer.jsonl'));
    } else {
      const [code, signal] = await bounded(exit, 5000, () => `collection_custody_reopen_exit_timeout:${stderr}`);
      assert.equal(code, 0, stderr); assert.equal(signal, null, stderr); assert.equal(value.peerPid, null);
    }
    return value;
  } finally {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL'); await bounded(exit, 5000, () => `collection_custody_cleanup_timeout:${stderr}`);
      }
    } finally {
      // Only this run's online worker owns these peer PIDs; offline runs never claim old audit PIDs.
      if (mode === 'crash') for (const { pid } of collectionCrashAudit(base).filter(row => row.event === 'start'))
        if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && pid !== child.pid && alive(pid)) {
          process.kill(pid, 'SIGKILL'); await exited(pid);
        }
    }
  }
}
