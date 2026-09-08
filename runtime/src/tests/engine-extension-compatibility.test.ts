import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGINE_EXTENSION_SUPPORT, captureEngineApi, inspectEngineExtensions, type EngineApiDeclaration,
  type EngineExtensionSelection } from '../application/engine-extension-contracts.js';
import { EngineReleaseSchema } from '../application/agent-lifecycle-contracts.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import { backupAgent, checkAgentLifecycle, pinAgentEngine } from '../infrastructure/agent-lifecycle.js';
import { checkAgentPostgresLifecycle, pinAgentPostgresEngine } from '../infrastructure/agent-postgres-lifecycle.js';
import { readAgentEnginePin } from '../infrastructure/agent-engine-release.js';
import { captureKnoxRegistration } from '../infrastructure/knox-channel.js';
import { resolveHostModelRegistration, type HostModelRegistration } from '../presentation/host-models.js';
import { resolveHostToolRegistration, type AgentExecutionHost } from '../presentation/host-tools.js';
import { resolveHostBoardRegistration } from '../presentation/host-board.js';
import { resolveHostPeerRegistration } from '../presentation/host-peers.js';
import { captureHostArchiveRegistration } from '../presentation/host-archive.js';
import { captureHostA2aRegistration } from '../presentation/host-a2a.js';
import { captureHostMissionRegistration } from '../presentation/host-missions.js';
import { captureHostBudgetRegistration, captureHostPostgresRegistration } from '../presentation/host-engine-extensions.js';
import { openAgentTurnProfile } from '../presentation/agent-turn-profile.js';
import { collaborationRegistrationFixture } from './host-collaboration-registration-fixture.js';
import { HOST_ENTRY_PROFILE } from './host-tool-entry-fixture.js';
import { createEngineUpdateReleases } from './helpers/agent-engine-update-releases.js';

const api = (...requires: string[]): EngineApiDeclaration => ({ version: 1, requires });
const selection = (engineApi?: EngineApiDeclaration): EngineExtensionSelection => ({ kind: 'model', name: 'company-model', ...(engineApi ? { engineApi } : {}) });

test('extension API: declared compatibility checks engine API and required capabilities independently of provider versions', () => {
  const report = inspectEngineExtensions(ENGINE_EXTENSION_SUPPORT, { extensions: [selection(api('model.turn', 'model.compact'))], requireDeclaredExtensions: true });
  assert.equal(report.status, 'verified'); assert.equal(report.registrations[0]!.status, 'verified');
  assert.throws(() => inspectEngineExtensions(ENGINE_EXTENSION_SUPPORT, { extensions: [selection({ version: 2, requires: [] })] }), /engine_extension_api_incompatible/);
  assert.throws(() => inspectEngineExtensions(ENGINE_EXTENSION_SUPPORT, { extensions: [selection(api('unknown.future'))] }), /engine_extension_capability_unsupported/);
  assert.throws(() => captureEngineApi({ engineApi: { version: 1, requires: ['tools', 'tools'] } }), /engine_extension_declaration_invalid/);
  assert.throws(() => inspectEngineExtensions(ENGINE_EXTENSION_SUPPORT, { extensions: [selection(api()), selection(api())] }), /engine_extension_inventory_invalid/);
});

test('extension API: legacy inventory and legacy release support stay unverified, while host strict policy refuses omissions', () => {
  assert.equal(inspectEngineExtensions(ENGINE_EXTENSION_SUPPORT).status, 'unverified');
  assert.equal(inspectEngineExtensions(ENGINE_EXTENSION_SUPPORT).inventory, 'not_provided');
  assert.equal(inspectEngineExtensions(ENGINE_EXTENSION_SUPPORT, { extensions: [selection()] }).registrations[0]!.status, 'undeclared');
  assert.equal(inspectEngineExtensions(undefined, { extensions: [] }).status, 'unverified');
  assert.throws(() => inspectEngineExtensions(ENGINE_EXTENSION_SUPPORT, { requireDeclaredExtensions: true }), /engine_extension_inventory_required/);
  assert.throws(() => inspectEngineExtensions(ENGINE_EXTENSION_SUPPORT, { extensions: [selection()], requireDeclaredExtensions: true }), /engine_extension_declaration_required/);
  assert.throws(() => inspectEngineExtensions(undefined, { extensions: [selection(api())] }), /engine_extension_support_undeclared/);
  assert.equal(inspectEngineExtensions(ENGINE_EXTENSION_SUPPORT, { extensions: [], requireDeclaredExtensions: true }).status, 'verified');
});

test('extension API: captured declarations preserve semantic ordering and refuse later changes or removal', () => {
  const registration = { engineApi: api('model.turn', 'model.compact') }, captured = captureEngineApi(registration);
  assert.ok(Object.isFrozen(captured.engineApi)); assert.ok(Object.isFrozen(captured.engineApi!.requires));
  registration.engineApi.requires.reverse(); captured.assertCurrent();
  registration.engineApi.requires.push('board'); assert.throws(captured.assertCurrent, /engine_extension_declaration_changed/);
  const optional: { engineApi?: EngineApiDeclaration } = { engineApi: api('tools') }, second = captureEngineApi(optional);
  delete optional.engineApi; assert.throws(second.assertCurrent, /engine_extension_declaration_changed/);
});

test('extension API: every registered factory family rejects unsupported declarations without invoking its callback', () => {
  let calls = 0;
  const bad = { engineApi: { version: 99, requires: [] }, async open(): Promise<never> { calls++; throw new Error('unexpected_open'); } };
  const model: HostModelRegistration = { ...bad, execution: 'deterministic_fixture' };
  const entries = [
    () => resolveHostModelRegistration({ models: new Map([['model', model]]) }, 'model'),
    () => resolveHostToolRegistration({ models: new Map(), tools: bad }),
    () => resolveHostBoardRegistration({ board: bad }), () => resolveHostPeerRegistration({ peers: bad }),
    () => captureHostArchiveRegistration(bad), () => captureHostA2aRegistration(bad), () => captureHostMissionRegistration(bad),
    () => captureKnoxRegistration({ engineApi: bad.engineApi, destination: 'knox', transport: {
      capabilities: { idempotentSend: true }, async send(): Promise<never> { calls++; throw new Error('unexpected_send'); },
    } }),
    () => captureHostBudgetRegistration({ engineApi: bad.engineApi }),
    () => captureHostPostgresRegistration({ engineApi: bad.engineApi,
      selection: { storeId: randomUUID(), registrationId: randomUUID(), purposes: ['state'] },
      pool: { async connect(): Promise<never> { calls++; throw new Error('unexpected_connect'); } } }),
  ];
  for (const capture of entries) assert.throws(capture, /engine_extension_api_incompatible|agent_(?:tool|board)_registration_invalid/);
  assert.equal(calls, 0);
});

test('extension API: a selected model declaration change is rejected before its captured factory runs', async t => {
  const f = collaborationRegistrationFixture(t), registration = f.entry.host.models.get(HOST_ENTRY_PROFILE)!;
  const declared = { ...registration, engineApi: api('model.turn') }, captured = resolveHostModelRegistration({ models: new Map([[HOST_ENTRY_PROFILE, declared]]) }, HOST_ENTRY_PROFILE);
  declared.engineApi.requires.push('board');
  assert.throws(() => captured.open({ agentId: f.context.agentId, purpose: 'test', skillsMode: 'off' }), /engine_extension_declaration_changed/);
  assert.equal(f.entry.observed.modelInputs.length, 0);
});

function declaredHost(f: ReturnType<typeof collaborationRegistrationFixture>): AgentExecutionHost {
  return { ...f.entry.host, requireDeclaredExtensions: true,
    models: new Map([[HOST_ENTRY_PROFILE, { ...f.entry.host.models.get(HOST_ENTRY_PROFILE)!, engineApi: api('model.turn') }]]),
    tools: { ...f.entry.host.tools!, engineApi: api('tools') } };
}

test('extension API: general profile opens declared selected adapters; feature-off registrations are never inspected', async t => {
  const f = collaborationRegistrationFixture(t), host = declaredHost(f);
  for (const name of ['board', 'archive', 'peers', 'a2a', 'missions', 'budget'])
    Object.defineProperty(host, name, { get() { assert.fail(`disabled ${name} must not be selected`); } });
  const opened = f.track(await openAgentTurnProfile(f.directory, { provider: 'registered' }, host));
  assert.equal(opened.extensions.status, 'verified');
  assert.deepEqual(opened.extensions.registrations.map(value => value.kind), ['model', 'tools']);
  assert.equal(f.entry.observed.toolContexts.length, 1); assert.equal(f.entry.observed.modelInputs.length, 0);
  assert.equal(opened.modelInfo.identity.revision, '1', 'provider revision remains its original value');
});

test('extension API: strict profile refuses undeclared adapters before stores and callbacks; legacy open reports unverified', async t => {
  const f = collaborationRegistrationFixture(t);
  await assert.rejects(openAgentTurnProfile(f.directory, { provider: 'registered' }, { ...f.entry.host, requireDeclaredExtensions: true }), /engine_extension_declaration_required/);
  assert.equal(existsSync(join(f.directory, '.secumon', 'runtime.sqlite')), false);
  assert.equal(existsSync(join(f.base, 'registry')), false); assert.equal(f.entry.observed.toolContexts.length, 0);
  const opened = f.track(await openAgentTurnProfile(f.directory, { provider: 'registered' }, f.entry.host));
  assert.equal(opened.extensions.status, 'unverified');
  assert.ok(opened.extensions.registrations.every(value => value.status === 'undeclared'));
});

test('extension API: declaration changes during earlier acquisition stop the later model and close acquired resources', async t => {
  const f = collaborationRegistrationFixture(t), host = declaredHost(f), model = host.models.get(HOST_ENTRY_PROFILE)!;
  const tools = host.tools!;
  const changing: AgentExecutionHost = { ...host, tools: { engineApi: api('tools'), async open(...args) {
    const opened = await tools.open(...args); model.engineApi!.requires.push('board'); return opened;
  } } };
  await assert.rejects(openAgentTurnProfile(f.directory, { provider: 'registered' }, changing), /engine_extension_declaration_changed/);
  assert.equal(f.entry.observed.toolContexts.length, 1); assert.equal(f.entry.observed.toolCloses, 1);
  assert.equal(f.entry.observed.modelCloses, 0); assert.equal(f.entry.observed.modelInputs.length, 0);
});

test('extension API: enabled optional registration incompatibility stops general profile before any store or open', async t => {
  for (const kind of ['board', 'archive', 'peers', 'a2a', 'missions'] as const) {
    const f = collaborationRegistrationFixture(t), configPath = join(f.directory, 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { features: Record<string, boolean> };
    config.features[kind] = true; writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const bad = { engineApi: { version: 99, requires: [] }, async open(): Promise<never> { assert.fail('incompatible factory ran'); } };
    await assert.rejects(openAgentTurnProfile(f.directory, { provider: 'registered' }, { ...declaredHost(f), [kind]: bad }),
      /engine_extension_api_incompatible|agent_board_registration_invalid/);
    assert.equal(existsSync(join(f.directory, '.secumon', 'runtime.sqlite')), false); assert.equal(f.entry.observed.toolContexts.length, 0);
  }
});

test('extension API: local release check, pin and real update share declared host checks; PG rejects before connecting',
  { timeout: 180000, skip: process.platform === 'win32' ? 'POSIX release fixture; native Windows is separate.' : false }, async t => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'engine-extension-lifecycle-')));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const releases = createEngineUpdateReleases(base), root = join(base, 'agent'), registry = join(base, 'registry');
    // Preserve the explicit first-pin compatibility gate on a historical unpinned agent.
    const legacyEngine = join(base, 'legacy-engine'); mkdirSync(legacyEngine, { mode: 0o700 });
    const legacyProfiles = new FileAgentProfileStore(legacyEngine, { engineRegistryDirectory: join(base, 'engine-registry') });
    legacyProfiles.initialize(root);
    const profiles = new FileAgentProfileStore(releases.a.directory, { engineRegistryDirectory: join(base, 'engine-registry') });
    const stores = await openAgentStores(profiles, root, undefined, { identityRegistryDirectory: registry }); await stores.close();
    const options = { extensions: [selection(api('model.turn'))], requireDeclaredExtensions: true };
    assert.equal(checkAgentLifecycle(profiles, root, releases.a.directory).extensions.status, 'unverified');
    assert.equal(checkAgentLifecycle(profiles, root, releases.a.directory, options).extensions.status, 'verified');
    assert.throws(() => pinAgentEngine(profiles, root, releases.a.directory, { offline: true, expectedPrevious: null, requireDeclaredExtensions: true }), /engine_extension_inventory_required/);
    assert.equal(readAgentEnginePin(root), null);
    const first = pinAgentEngine(profiles, root, releases.a.directory, { ...options, offline: true, expectedPrevious: null });
    assert.equal(first.extensions.status, 'verified'); assert.equal(first.pin.sequence, 1);
    const saved = backupAgent(profiles, root, join(base, 'backup'), true), config = readFileSync(join(root, 'config.json'));
    const bad = { extensions: [selection({ version: 9, requires: [] })] };
    assert.throws(() => checkAgentLifecycle(profiles, root, releases.b.directory, bad), /engine_extension_api_incompatible/);
    assert.throws(() => pinAgentEngine(profiles, root, releases.b.directory, { ...bad, offline: true, expectedPrevious: first.pin.releaseDigest, backup: saved.directory }), /engine_extension_api_incompatible/);
    assert.deepEqual(readAgentEnginePin(root), first.pin); assert.deepEqual(readFileSync(join(root, 'config.json')), config);
    const updated = pinAgentEngine(profiles, root, releases.b.directory, { ...options, offline: true, expectedPrevious: first.pin.releaseDigest, backup: saved.directory });
    assert.equal(updated.applied, true); assert.equal(updated.extensions.status, 'verified'); assert.equal(updated.pin.sequence, 2);
    assert.notEqual(updated.pin.releaseDigest, first.pin.releaseDigest);
    const legacy = structuredClone(releases.a.release); delete legacy.compatibility.extensions;
    assert.equal(EngineReleaseSchema.parse(legacy).compatibility.extensions, undefined, 'historical manifest schema still parses; this is not an installed-release proof');

    const pgRoot = join(base, 'pg-agent'), selected = { storeId: randomUUID(), registrationId: randomUUID(), purposes: ['state', 'knowledge', 'channel'] as ('state' | 'knowledge' | 'channel')[] };
    legacyProfiles.initialize(pgRoot, { postgres: selected }); let connects = 0;
    const host = { selection: selected, pool: { async connect(): Promise<never> { connects++; throw new Error('unexpected_pg_connect'); } } };
    const pgOptions = { ...bad, offline: true, operationId: randomUUID() };
    await assert.rejects(checkAgentPostgresLifecycle(profiles, pgRoot, releases.a.directory, host, pgOptions), /engine_extension_api_incompatible/);
    await assert.rejects(pinAgentPostgresEngine(profiles, pgRoot, releases.a.directory, host, { ...pgOptions, expectedPrevious: null }), /engine_extension_api_incompatible/);
    assert.equal(connects, 0); assert.equal(readAgentEnginePin(pgRoot), null);
  });
