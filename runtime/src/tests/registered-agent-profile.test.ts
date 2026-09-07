import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AgentProfileStore } from '../application/agent-profile-contracts.js';
import type { AgentTurnProfile as PromptProfile } from '../application/agent-turn-types.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { FileWorkspaceStore } from '../infrastructure/file-workspaces.js';
import { LocalChannel } from '../infrastructure/local-channel.js';
import { SqliteStateRepository } from '../infrastructure/sqlite-state.js';
import { StructuredAgentTurnAdapter } from '../infrastructure/structured-agent-turn.js';
import { openAgentTurnProfile } from '../presentation/agent-turn-profile.js';
import type { AgentTurnHost, HostModelRegistration } from '../presentation/host-models.js';

const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
function fixture(documents = false, skills: 'off' | 'on-demand' = 'off', name: string | null = 'registered-local') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'registered-agent-'))), profiles = new FileAgentProfileStore(runtimeRoot);
  const ready = profiles.initialize(join(base, 'agent'), { purpose: '호스트 등록 모델의 실제 조립 확인', ...(documents ? { personalMemory: 'documents' } : {}) });
  writeFileSync(join(ready.root, 'config.json'), JSON.stringify({ ...ready.config, model: name === null ? null : { profile: name }, skills: { mode: skills } }));
  const current = profiles.inspect(ready.root); assert.equal(current.status, 'ready');
  if (current.status !== 'ready') throw new Error('profile_not_ready');
  return { base, profiles, ready: current, remove: () => rmSync(base, { recursive: true, force: true }) };
}
function host(compact = false) {
  let opens = 0, closes = 0, calls = 0, received: PromptProfile | undefined;
  const registration: HostModelRegistration = { execution: 'deterministic_fixture', async open(profile) {
    opens++; received = profile;
    const adapter = new StructuredAgentTurnAdapter({ profile, identity: { provider: 'local-contract', model: 'registration-fixture', revision: '1' }, destination: 'local',
      capabilities: { structuredOutput: true, toolCalling: false, cancellation: true, images: false, maxInputTokens: 80000, contextWindowTokens: 90000, maxOutputTokens: 512 } },
    { async invoke() { calls++; throw new Error('unexpected_model_call'); } });
    const planner = compact ? {
      identity: adapter.identity, destination: adapter.destination, capabilities: adapter.capabilities, prompt: adapter.prompt, inputEstimation: adapter.inputEstimation,
      propose: adapter.propose.bind(adapter), turn: adapter.turn.bind(adapter), estimateTurnInput: adapter.estimateTurnInput.bind(adapter),
      estimateContextPreview: adapter.estimateContextPreview.bind(adapter),
      compact: async () => ({ status: 'refused' as const, code: 'fixture_only', inputTokens: 0, outputTokens: 0 }),
      estimateCompactInput: () => ({ tokens: 1, bytes: 1, method: 'fixture_only' }),
    } : adapter;
    return { planner, inputLimits: { maxInputBytes: 48000, maxOutputTokens: 256 }, close: async () => { closes++; } };
  } };
  const value: AgentTurnHost = { models: new Map([['registered-local', registration]]) };
  return { value, registration, opens: () => opens, closes: () => closes, calls: () => calls, received: () => received };
}

for (const documents of [false, true]) test(`registered profile preserves C01 v${documents ? 2 : 1} and passes explicit model limits through composition`, async () => {
  const f = fixture(documents), h = host(documents), configBytes = readFileSync(join(f.ready.root, 'config.json'));
  const profile = await openAgentTurnProfile(f.ready.root, { provider: 'registered' }, h.value);
  try {
    assert.equal(profile.provider, 'registered'); assert.equal(profile.compactProvider, documents ? 'registered' : null);
    assert.deepEqual(profile.modelInfo, { selection: 'registered', profileName: 'registered-local', compact: documents,
      execution: 'deterministic_fixture', identity: { provider: 'local-contract', model: 'registration-fixture', revision: '1' } });
    assert.equal(Object.isFrozen(profile.modelInfo), true); assert.equal(Object.isFrozen(profile.modelInfo.identity), true);
    assert.equal(profile.planning!.config.maxInputBytes, 48000); assert.equal(profile.planning!.config.maxOutputTokens, 256);
    assert.equal(Boolean(profile.compactPlanning), documents);
    assert.deepEqual(h.received(), { agentId: f.ready.identity.agentId, purpose: f.ready.config.purpose, skillsMode: 'off' });
    assert.deepEqual(Object.keys(h.received()!).sort(), ['agentId', 'purpose', 'skillsMode']);
    assert.equal(profile.personalMemoryBackend, documents ? 'documents' : 'sqlite');
    assert.equal(profile.policy.principalId, 'operator'); assert.equal(profile.policy.allowWrites, false);
    assert.deepEqual(profile.policy.allowedDestinations, ['local']); assert.equal(profile.policy.allowedTools.includes('fixture.read'), true);
    assert.equal(profile.policy.allowedTools.some(id => id.startsWith('core.guidance.')), false);
    assert.deepEqual(await profile.services.state.runnable(Date.now()), []); assert.equal(h.opens(), 1); assert.equal(h.calls(), 0);
    assert.deepEqual(readFileSync(join(f.ready.root, 'config.json')), configBytes);
    const inspected = f.profiles.inspect(f.ready.root); assert.equal(inspected.status, 'ready');
    if (inspected.status === 'ready') { assert.equal(inspected.modelReady, false); assert.equal(inspected.config.schemaVersion, documents ? 2 : 1); }
  } finally { await profile.close(); await profile.close(); f.remove(); }
  assert.equal(h.closes(), 1);
});

test('registered selection requires an exact existing C01 name and host registration before opening databases', async () => {
  for (const name of [null, 'not-registered', 'registered-local']) {
    const f = fixture(false, 'off', name), h = host();
    try {
      await assert.rejects(openAgentTurnProfile(f.ready.root, { provider: 'registered' }, name === 'registered-local' ? undefined : h.value), /agent_turn_provider_unavailable/);
      assert.equal(h.opens(), 0); assert.equal(existsSync(f.ready.paths.state), false); assert.equal(existsSync(f.ready.paths.memory), false);
      assert.equal(existsSync(join(f.ready.paths.metadata, 'channel.sqlite')), false);
    } finally { f.remove(); }
  }
});

test('registered compact overrides are refused and explicit synthetic remains independent of the stored model name', async () => {
  const f = fixture(), h = host();
  try {
    await assert.rejects(openAgentTurnProfile(f.ready.root, { provider: 'registered', compactProvider: 'synthetic' }, h.value), /invalid_compact_provider/);
    assert.equal(h.opens(), 0); assert.equal(existsSync(f.ready.paths.state), false);
    const profile = await openAgentTurnProfile(f.ready.root, { provider: 'synthetic', compactProvider: 'synthetic' }, h.value);
    try {
      assert.equal(h.opens(), 0); assert.equal(profile.provider, 'synthetic'); assert.equal(profile.compactProvider, 'synthetic');
      assert.equal(profile.modelInfo.selection, 'synthetic'); assert.equal(profile.modelInfo.profileName, null);
      assert.equal(profile.modelInfo.execution, 'deterministic_fixture'); assert.equal(profile.modelInfo.compact, true);
      assert.equal(profile.planning!.config.maxOutputTokens, 2048);
    } finally { await profile.close(); }
  } finally { f.remove(); }
});

test('factory failure closes acquired stores and keeps the original exception object', async () => {
  const f = fixture(), h = host(), original = new Error('host_factory_failed'), close = SqliteStateRepository.prototype.close;
  let closed: SqliteStateRepository | undefined;
  h.registration.open = async () => { throw original; };
  SqliteStateRepository.prototype.close = async function () { await close.call(this); closed = this; };
  try {
    await assert.rejects(openAgentTurnProfile(f.ready.root, { provider: 'registered' }, h.value), error => error === original);
    assert.ok(closed); await assert.rejects(closed.get('absent'));
  } finally { SqliteStateRepository.prototype.close = close; f.remove(); }
});

test('post-factory composition failure retains the original parse error plus model cleanup failure and closes stores', async () => {
  const f = fixture(false, 'on-demand'), h = host(), open = h.registration.open, cleanup = new Error('model_cleanup_failed');
  const close = SqliteStateRepository.prototype.close; let closed: SqliteStateRepository | undefined, modelCloses = 0;
  writeFileSync(join(f.ready.paths.skills, 'catalog.json'), 'invalid JSON', { mode: 0o600 });
  h.registration.open = async value => ({ ...await open(value), close: async () => { modelCloses++; throw cleanup; } });
  SqliteStateRepository.prototype.close = async function () { await close.call(this); closed = this; };
  try {
    await assert.rejects(openAgentTurnProfile(f.ready.root, { provider: 'registered' }, h.value), error => {
      assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2); assert.ok(error.errors[0] instanceof SyntaxError);
      assert.equal(error.errors[1], cleanup); assert.equal(error.cause, error.errors[0]); return true;
    });
    assert.equal(modelCloses, 1); assert.ok(closed); await assert.rejects(closed.get('absent'));
  } finally { SqliteStateRepository.prototype.close = close; f.remove(); }
});

for (const duringOpen of [false, true]) test(`agent stores retain every actual close failure${duringOpen ? ' together with the opening error' : ''}`, async () => {
  const f = fixture(), primary = new Error('artifact_construction_failed'), workspaceError = new Error('workspace_close_failed'), channelError = new Error('channel_close_failed');
  const workspaceClose = FileWorkspaceStore.prototype.close, channelClose = LocalChannel.prototype.close, stateClose = SqliteStateRepository.prototype.close;
  const order: string[] = []; let closedState: SqliteStateRepository | undefined;
  FileWorkspaceStore.prototype.close = async function () { await workspaceClose.call(this); order.push('workspace'); throw workspaceError; };
  LocalChannel.prototype.close = function () { channelClose.call(this); order.push('channel'); throw channelError; };
  SqliteStateRepository.prototype.close = async function () { await stateClose.call(this); closedState = this; order.push('state'); };
  try {
    const paths = { ...f.ready.paths }; if (duringOpen) Object.defineProperty(paths, 'artifacts', { get() { throw primary; } });
    const profiles: AgentProfileStore = { inspect: () => ({ ...f.ready, paths }),
      initialize: f.profiles.initialize.bind(f.profiles), clone: f.profiles.clone.bind(f.profiles) };
    const fail = duringOpen ? openAgentStores(profiles, f.ready.root) : (async () => { const stores = await openAgentStores(profiles, f.ready.root); await stores.close(); })();
    await assert.rejects(fail, error => {
      assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, duringOpen ? [primary, workspaceError, channelError] : [workspaceError, channelError]);
      assert.equal(error.cause, duringOpen ? primary : workspaceError); return true;
    });
    assert.deepEqual(order, ['workspace', 'channel', 'state']); assert.ok(closedState); await assert.rejects(closedState.get('absent'));
  } finally {
    FileWorkspaceStore.prototype.close = workspaceClose; LocalChannel.prototype.close = channelClose; SqliteStateRepository.prototype.close = stateClose; f.remove();
  }
});
