import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { ResidentControlCommandSchema } from '../../application/resident-missions.js';
import type { AgentTurnProfile } from '../../presentation/agent-turn-profile.js';
import { agentTurnWorkbenchProfile, LocalWorkbench } from '../../presentation/local-workbench.js';
import { startWebServer } from '../../presentation/web-server.js';
import { residentEntryFixture, RESIDENT_RULE } from '../resident-missions-entry-fixture.js';

/** Standalone localhost browser fixture. No tick/drive is started; only explicit Web control commands can publish. */
const maximumLifetimeMs = 20 * 60 * 1000;
const callbacks: (() => void | Promise<void>)[] = [];
// residentEntryFixture uses only TestContext.after; this script is deliberately not a node:test case.
const context = { after(callback: () => void | Promise<void>) { callbacks.push(callback); } } as unknown as TestContext;
let server: Awaited<ReturnType<typeof startWebServer>> | undefined;
let driver: ReturnType<AgentTurnProfile['createResidentMissions']> | undefined;
let lines: Interface | undefined;
let stopping = false, forceExit: ReturnType<typeof setTimeout> | undefined;
const expiresAt = Date.now() + maximumLifetimeMs;
const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
function report(error: unknown) {
  process.stderr.write(JSON.stringify({ code: 'resident_browser_fixture_failed', message: error instanceof Error ? error.message : String(error) }) + '\n');
}
function requestStop() {
  if (stopping) return;
  stopping = true; lines?.close(); process.stdin.pause();
  forceExit = setTimeout(() => {
    report(new Error('resident_browser_fixture_cleanup_timeout')); process.exit(1);
  }, 15000);
  forceExit.unref();
}
const lifetime = setTimeout(requestStop, maximumLifetimeMs);
process.once('SIGTERM', requestStop); process.once('SIGINT', requestStop);

try {
  const fixture = await residentEntryFixture(context), profile = fixture.current();
  const workbench = new LocalWorkbench(agentTurnWorkbenchProfile(profile), profile.executionActor, 'resident-browser');
  await workbench.initializeSession();
  const config = workbench.config(), sessionId = config.persistentSession?.sessionId;
  assert.ok(sessionId); assert.equal(config.residentMissions, true);
  driver = profile.createResidentMissions({ policy: profile.policy, limits: profile.limits, binding: {
    tenantId: profile.actor.tenantId, principalId: profile.actor.principalId, channel: 'web', conversationId: config.conversationId,
    destination: 'local', recipientId: profile.actor.principalId,
  } });
  const registered = await driver.register({ rule: RESIDENT_RULE, instruction: 'Observe only explicitly controlled local browser fixture events.', sessionId });
  assert.equal(registered.sessionId, sessionId);
  let dropNextCommand = false;
  const successfulCommands: { commandId: string; kind: string; expectedControlRevision: number; replayed: boolean;
    appliedStateRevision: number; appliedControlRevision: number; responseLost: boolean }[] = [];
  const originalCommand = workbench.residentCommand.bind(workbench);
  workbench.residentCommand = async (workId, command) => {
    const selected = structuredClone(command);
    const result = await originalCommand(workId, selected);
    const responseLost = dropNextCommand;
    dropNextCommand = false;
    successfulCommands.push({ ...selected, replayed: result.replayed, appliedStateRevision: result.appliedStateRevision,
      appliedControlRevision: result.appliedControlRevision, responseLost });
    // The original method has already committed/verified its receipt. Only its HTTP response is failed once.
    if (responseLost) throw new Error('fixture_lost_response');
    return result;
  };
  const noExecution = () => {
    const modelCalls = fixture.observed.inputs.first.length + fixture.observed.inputs.second.length;
    const pollCalls = fixture.observed.polls.length;
    assert.equal(modelCalls, 0, 'browser observation controls never run a model');
    assert.equal(pollCalls, 0, 'browser observation controls never poll a source');
    return { modelCalls, pollCalls, compactCalls: fixture.observed.compacts.length };
  };
  async function snapshot() {
    const status = await workbench.residentStatus(registered.workId);
    const state = await profile.runtime.state(registered.workId);
    const events = (await profile.services.state.events(registered.workId, 0)).filter(event => event.type === 'resident_control');
    const controls = await Promise.all(events.map(async event => {
      const payload = event.data['payload'];
      assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
      const command = ResidentControlCommandSchema.parse(payload['command']);
      const receipt = await profile.services.state.receipt(registered.workId, event.commandId);
      assert.ok(receipt); assert.equal(receipt.state.revision, event.revision);
      assert.equal(receipt.digest, profile.services.digester.digest({ type: event.type, data: payload }));
      return { command, receiptId: event.commandId, revision: event.revision, sequence: event.sequence, receiptDigest: receipt.digest };
    }));
    assert.equal(state.attempts.length, 0); assert.equal(state.modelCalls.length, 0);
    return { status, stateRevision: state.revision, controlEventCount: controls.length, controlReceiptCount: controls.length, controls,
      successfulCommands: structuredClone(successfulCommands), dropNextCommand, ...noExecution() };
  }
  server = await startWebServer(workbench);
  assert.equal(new URL(server.origin).hostname, '127.0.0.1');
  if (stopping) throw new Error('resident_browser_fixture_stopped_during_startup');
  noExecution();
  output({ connectUrl: server.connectUrl, origin: server.origin, workId: registered.workId, sessionId, agentId: profile.agentId,
    conversationId: config.conversationId, directory: join(fixture.base, 'first'), fixtureRoot: fixture.base, expiresAt,
    operations: ['snapshot', 'drop-next-command'], modelCalls: 0, pollCalls: 0 });
  lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of lines) {
    if (stopping) break;
    try {
      if (Buffer.byteLength(line, 'utf8') > 4096) throw new Error('resident_browser_fixture_request_too_large');
      const input: unknown = JSON.parse(line);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !('op' in input)) {
        throw new Error('resident_browser_fixture_request_invalid');
      }
      if (input.op === 'snapshot') output({ op: 'snapshot', ok: true, ...await snapshot() });
      else if (input.op === 'drop-next-command') {
        dropNextCommand = true; output({ op: 'drop-next-command', ok: true, armed: true });
      } else throw new Error('resident_browser_fixture_operation_invalid');
    } catch (error) {
      report(error); output({ ok: false, code: error instanceof Error ? error.message : 'resident_browser_fixture_request_failed' });
    }
  }
  noExecution();
} catch (error) {
  report(error); process.exitCode = 1;
} finally {
  requestStop(); clearTimeout(lifetime);
  const failures: unknown[] = [];
  try { await server?.close(); } catch (error) { failures.push(error); }
  try { await driver?.close(); } catch (error) { failures.push(error); }
  for (const callback of callbacks.toReversed()) {
    try { await callback(); } catch (error) { failures.push(error); }
  }
  clearTimeout(forceExit);
  process.removeListener('SIGTERM', requestStop); process.removeListener('SIGINT', requestStop);
  if (failures.length) { report(new AggregateError(failures, 'resident_browser_fixture_cleanup_failed')); process.exitCode = 1; }
}
