import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { MissionEventSource } from '../../application/mission-contracts.js';
import type { ResidentMissions } from '../../application/resident-missions.js';
import { FileAgentProfileStore } from '../../infrastructure/file-agent-profile.js';
import { openAgentTurnProfile } from '../../presentation/agent-turn-profile.js';
import type { AgentExecutionHost } from '../../presentation/host-tools.js';
import { HOST_ENTRY_PROFILE } from '../host-tool-entry-fixture.js';
import { residentControlEntryHost, RESIDENT_CONTROL_ENTRY_RULE } from '../resident-control-entry-host.js';

const runtimeRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cliWorker = fileURLToPath(new URL('./agent-mission-cli-worker.js', import.meta.url));
export type ResidentStatus = Awaited<ReturnType<ResidentMissions['status']>>;
export type ResidentControl = Awaited<ReturnType<ResidentMissions['control']>>;
export function gate<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; }); return { promise, resolve, reject }; }
export async function within<T>(promise: Promise<T>, milliseconds = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('resident_process_wait_timeout')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
export const outcome = <T>(promise: Promise<T>) => promise.then(value => ({ kind: 'returned' as const, value }), error => ({ kind: 'rejected' as const, error }));
type RawInput = Parameters<MissionEventSource['poll']>[0];
export interface HeldPoll {
  input: RawInput; startedAt: number; abortedAt: number | null; settledAt: number | null; released: boolean;
  release(): void;
}
type Profile = Awaited<ReturnType<typeof openAgentTurnProfile>>;
type Driver = ReturnType<Profile['createResidentMissions']>;
export interface ResidentProcessTarget {
  directory: string; profile: Profile; driver: Driver; rule: typeof RESIDENT_CONTROL_ENTRY_RULE; workId: string; sessionId: string; created: boolean;
}
interface ResidentProcessAgent {
  directory: string; profile: Profile; entry: ReturnType<typeof residentControlEntryHost>; held: HeldPoll[];
  register(label: string, newSession?: boolean): Promise<ResidentProcessTarget>;
  start(target: ResidentProcessTarget): { entered: Promise<HeldPoll>; result: ReturnType<typeof outcome<Awaited<ReturnType<Driver['tick']>>>> };
  close(): Promise<void>;
}

/** Real CLI-compatible local profiles. Only the parent's raw source waits; child callbacks retain their zero-call assertions. */
export async function residentProcessFixture(t: TestContext, backend: 'sqlite' | 'file-journal') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'resident-process-'))), registry = join(base, 'registry');
  const profiles = new FileAgentProfileStore(runtimeRoot);
  const agents: ResidentProcessAgent[] = [];
  const children = new Map<ReturnType<typeof execFile>, Promise<unknown>>();
  async function open(name: string): Promise<ResidentProcessAgent> {
    const directory = join(base, name), ready = profiles.initialize(directory, { stateBackend: backend });
    writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...ready.config, model: { profile: HOST_ENTRY_PROFILE },
      features: { ...ready.config.features, missions: true }, skills: { mode: 'off' } }), { mode: 0o600 });
    const entry = residentControlEntryHost(registry), registration = entry.host.missions; assert.ok(registration);
    const held: HeldPoll[] = [], waiting = new Map<string, ReturnType<typeof gate<HeldPoll>>[]>();
    const host: AgentExecutionHost = { ...entry.host, missions: { async open(context, assembly) {
      const original = await registration.open(context, assembly);
      return { sources: original.sources.map(source => ({ ...source, async poll(input: RawInput) {
        await input.authorize(); input.signal.throwIfAborted();
        const release = gate<void>();
        const item: HeldPoll = { input, startedAt: performance.now(), abortedAt: null, settledAt: null, released: false,
          release() { item.released = true; release.resolve(); } };
        const abort = () => { item.abortedAt = performance.now(); };
        input.signal.addEventListener('abort', abort, { once: true });
        held.push(item); const next = waiting.get(input.resourceId)?.shift(); assert.ok(next, 'only an explicitly started parent poll reaches the raw source'); next.resolve(item);
        // Deliberately noncooperative raw I/O: cancellation must finish observation without releasing this original page.
        try {
          await release.promise;
          return { cursor: input.cursor + 1, snapshotDigest: 'late-original', events: [{ id: 'late-original-event', kind: 'observation' as const,
            referenceId: input.resourceId, occurredAt: input.now, body: { text: 'Preserved parent original, never accepted after cancellation.' } }] };
        } finally { item.settledAt = performance.now(); input.signal.removeEventListener('abort', abort); }
      } })), async close() { for (const item of held) item.release(); await original.close(); } };
    } } };
    const profile = await openAgentTurnProfile(directory, { provider: 'registered' }, host);
    const drivers: ReturnType<typeof profile.createResidentMissions>[] = [];
    async function register(label: string, newSession = false) {
      const session = await profile.sessions.open(profile.actor, { channel: 'cli', conversationId: 'terminal', ...(newSession ? { newSession: true } : {}) });
      const driver = profile.createResidentMissions({ policy: profile.policy, limits: profile.limits, binding: {
        tenantId: profile.actor.tenantId, principalId: profile.actor.principalId, channel: 'cli', conversationId: 'terminal', destination: 'local', recipientId: profile.actor.principalId,
      } });
      drivers.push(driver);
      const rule = { ...RESIDENT_CONTROL_ENTRY_RULE, id: `process-${label}`, resourceId: `resource-${label}` };
      const registered = await driver.register({ rule, instruction: 'Wait for explicit host observation controls.', sessionId: session.scope.sessionId });
      return { directory, profile, driver, rule, ...registered };
    }
    function start(target: Awaited<ReturnType<typeof register>>) {
      const entered = gate<HeldPoll>(), queue = waiting.get(target.rule.resourceId) ?? [];
      queue.push(entered); waiting.set(target.rule.resourceId, queue);
      const result = outcome(target.driver.tick(target.workId));
      return { entered: entered.promise, result };
    }
    const agent = { directory, profile, register, start, held, entry, async close() {
      try {
        await within(Promise.all(drivers.map(driver => driver.close())));
      } finally {
        for (const item of held) item.release();
        await within(profile.close()); entry.assertIdleAndClosed();
      }
    } };
    agents.push(agent); return agent;
  }
  t.after(async () => {
    try {
      for (const child of children.keys()) child.kill('SIGKILL');
      await within(Promise.allSettled([...children.values()]), 50000);
      const results = await Promise.allSettled(agents.toReversed().map(agent => agent.close()));
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'resident_process_cleanup_failed');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
  type Target = ResidentProcessTarget;
  async function raw(target: Target, args: string[], options: { sessionId?: string; directory?: string } = {}) {
    const startedAt = performance.now();
    let exit: { code: number | null; signal: NodeJS.Signals | null; at: number } | undefined;
    const finished = gate<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; startedAt: number; exitedAt: number; closedAt: number }>();
    let result: { stdout: string; stderr: string } | undefined, closed: { code: number | null; signal: NodeJS.Signals | null; at: number } | undefined;
    const complete = () => {
      if (!result || !closed) return;
      try {
        assert.ok(exit, 'a spawned command reports exit as well as stdio close'); assert.equal(exit.code, closed.code); assert.equal(exit.signal, closed.signal);
        finished.resolve({ ...closed, ...result, startedAt, exitedAt: exit.at, closedAt: closed.at });
      } catch (error) { finished.reject(error); }
    };
    const child = execFile(process.execPath, [cliWorker, 'mission', ...args, '--directory', options.directory ?? target.directory,
      '--provider', 'registered', '--work', target.workId, '--session', options.sessionId ?? target.sessionId, '--json'], {
      timeout: 45000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, SECUMON_RESIDENT_CLI_REGISTRY: registry },
    }, (_error, stdout, stderr) => { result = { stdout, stderr }; complete(); });
    child.once('exit', (code, signal) => { exit = { code, signal, at: performance.now() }; });
    child.once('close', (code, signal) => { closed = { code, signal, at: performance.now() }; complete(); });
    children.set(child, finished.promise);
    try { return await within(finished.promise, 50000); } finally { if (closed) children.delete(child); }
  }
  async function call<T = ResidentStatus>(target: Target, args: string[]) {
    const process = await raw(target, args); assert.equal(process.code, 0, process.stderr); assert.equal(process.signal, null);
    const value = JSON.parse(process.stdout) as T; return { value, process };
  }
  async function failure(target: Target, args: string[], code: string, options: { sessionId?: string; directory?: string } = {}) {
    const process = await raw(target, args, options); assert.equal(process.code, 1); assert.equal(process.signal, null); assert.equal(process.stdout, '');
    const line = process.stderr.trim().split('\n').filter(value => value.startsWith('{')).at(-1); assert.ok(line);
    assert.deepEqual(JSON.parse(line), { code }); return process;
  }
  return { base, registry, backend, open, call, failure };
}

export async function residentProcessRecord(target: { profile: Awaited<ReturnType<typeof openAgentTurnProfile>>; workId: string; sessionId: string }) {
  const { profile, workId } = target, state = await profile.runtime.state(workId), events = await profile.services.state.events(workId, 0);
  const receipts = await Promise.all(events.map(async event => ({ commandId: event.commandId, receipt: await profile.services.state.receipt(workId, event.commandId) })));
  const originals = await Promise.all(state.artifacts.map(async artifact => ({ artifact, bytes: await profile.services.artifacts.get(artifact, state.policy) })));
  const history = await profile.sessions.history(profile.actor, target.sessionId, profile.policy, { limit: 100 });
  return { state, events, receipts, originals, history };
}
export async function preservedProcessRecord(target: Parameters<typeof residentProcessRecord>[0], original: Awaited<ReturnType<typeof residentProcessRecord>>) {
  const current = await residentProcessRecord(target);
  assert.deepEqual(current.events.slice(0, original.events.length), original.events);
  for (const receipt of original.receipts) assert.deepEqual(current.receipts.find(value => value.commandId === receipt.commandId), receipt);
  for (const raw of original.originals) assert.deepEqual(current.originals.find(value => value.artifact.id === raw.artifact.id), raw);
  assert.deepEqual(current.history, original.history);
  assert.deepEqual(current.state.budget, original.state.budget); assert.deepEqual(current.state.attempts, original.state.attempts);
  assert.deepEqual(current.state.modelCalls, original.state.modelCalls); assert.deepEqual(current.state.evidence, original.state.evidence);
}
