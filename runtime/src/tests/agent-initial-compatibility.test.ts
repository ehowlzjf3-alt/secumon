import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentCloneSetupSchema, AgentConfigSchema, AgentInitialEngineSchema, AgentInitialSetupReceiptSchema,
  AgentSetupOperationSchema, AgentSetupOperationV3Schema, AgentSetupReceiptSchema, type AgentProfileStatus } from '../application/agent-profile-contracts.js';
import { EnginePinSchema, EngineReleaseSchema, type EnginePin, type EngineRelease } from '../application/agent-lifecycle-contracts.js';
import { assertAgentEnginePin, assertAgentSetupCompatibility, engineCompatibility, inspectEngineRelease,
  readAgentSetupSchemaVersion } from '../infrastructure/agent-engine-release.js';
import { captureLifecycleTree, lifecycleDigest } from '../infrastructure/agent-lifecycle-files.js';
import { inspectAgentLocalStorageCompatibility } from '../infrastructure/agent-lifecycle.js';

const identity = { schemaVersion: 1 as const, agentId: '08fe733c-7bdb-4bf8-89d2-455276dd5bd2', createdAt: 1000 };
const operationId = '797fc417-e66c-4a58-912d-f6ac8f1bfe32';
const foreignId = 'ca069e0a-353f-464e-9296-bf8dc7f41996';
const hash = 'a'.repeat(64);
const localFileFixture = { skip: process.platform === 'win32' ? 'POSIX private metadata fixture; native Windows acceptance remains separate.' : false };
function firstPin(engineDirectory = '/fixture/engine', releaseDigest = hash): EnginePin {
  return EnginePinSchema.parse({ schemaVersion: 1, sequence: 1, agentId: identity.agentId, releaseDigest,
    engineDirectory, version: '1.0.0', previous: null, backupDigest: null, createdAt: 1001 });
}
function initial(pin = firstPin()) {
  return { schemaVersion: 3 as const, kind: 'initialize' as const, operationId, identity, personalMemory: null,
    stateBackend: 'sqlite' as const, initialEngine: { pin, registrationDigest: hash } };
}
function directory(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-initial-compatibility-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function json(path: string, value: unknown) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
function metadata(root: string, name: string, value: unknown) {
  mkdirSync(join(root, '.secumon'), { recursive: true, mode: 0o700 }); json(join(root, '.secumon', name), value);
}
function releaseBody(compatibility: EngineRelease['compatibility']) {
  return { schemaVersion: 1 as const, kind: 'secumon-engine-release' as const, version: '1.0.0', node: '>=24.20.0 <25' as const,
    platform: process.platform, arch: process.arch, compatibility, entries: [] };
}
function legacyCompatibility(): EngineRelease['compatibility'] {
  const { setup: _setup, ...legacy } = engineCompatibility; return legacy;
}
function engine(root: string, compatibility: EngineRelease['compatibility']) {
  mkdirSync(join(root, 'dist', 'presentation'), { recursive: true, mode: 0o700 });
  // A private release-verifier fixture only; no engine code from this tree is invoked.
  writeFileSync(join(root, 'dist', 'presentation', 'agent-cli.js'), '// release validation fixture\n', { mode: 0o600 });
  const parsed = EngineReleaseSchema.parse({ ...releaseBody(compatibility), entries: captureLifecycleTree(root), digest: hash });
  const { digest: _digest, ...body } = parsed;
  const release = { ...parsed, digest: lifecycleDigest(body) }; json(join(root, 'release.json'), release);
  return release;
}

test('initial setup schema 3 fixes first-pin lineage and owner while retaining explicit storage selections', () => {
  const pin = firstPin(), input = initial(pin), before = structuredClone(input);
  assert.deepEqual(AgentSetupOperationSchema.parse(input), input);
  assert.deepEqual(input, before);
  const documents = { backend: 'documents' as const, storeId: '967d6e64-9cba-470d-a39b-e1ebc2481f8d' };
  const postgres = { storeId: '7480f44c-b335-4a74-8758-ac053b0d2ab8', registrationId: 'c1c790db-b65e-4e7b-bb0d-5ed9b6c1e38e',
    purposes: ['state', 'knowledge', 'channel'] };
  const selected = AgentSetupOperationV3Schema.parse({ ...input, personalMemory: documents, stateBackend: 'file-journal', postgres });
  assert.deepEqual(selected.personalMemory, documents); assert.equal(selected.stateBackend, 'file-journal'); assert.deepEqual(selected.postgres, postgres);
  for (const changed of [{ sequence: 2 }, { previous: hash }, { backupDigest: hash }])
    assert.equal(AgentInitialEngineSchema.safeParse({ ...input.initialEngine, pin: { ...pin, ...changed } }).success, false);
  assert.equal(AgentSetupOperationV3Schema.safeParse({ ...input, initialEngine: { ...input.initialEngine, pin: { ...pin, agentId: foreignId } } }).success, false);
  assert.equal(AgentSetupOperationV3Schema.safeParse({ ...input, kind: 'clone' }).success, false);
  assert.equal(AgentSetupOperationV3Schema.safeParse({ ...input, personalMemory: undefined }).success, false);
  assert.equal(AgentInitialEngineSchema.safeParse({ ...input.initialEngine, registrationDigest: 'not-a-digest' }).success, false);
});

test('initial receipt and optional setup support preserve legacy receipt and release bytes', () => {
  const oldReceipt = { schemaVersion: 1, agentId: identity.agentId };
  const cloneReceipt = { schemaVersion: 2, agentId: identity.agentId, operationId, manifestDigest: hash };
  assert.deepEqual(AgentSetupReceiptSchema.parse(oldReceipt), oldReceipt);
  assert.deepEqual(AgentCloneSetupSchema.parse(cloneReceipt), cloneReceipt);
  const receipt = { schemaVersion: 3, agentId: identity.agentId, operationId, initialPinDigest: lifecycleDigest(firstPin()) };
  assert.deepEqual(AgentInitialSetupReceiptSchema.parse(receipt), receipt);
  assert.equal(AgentSetupReceiptSchema.safeParse(receipt).success, false);
  assert.equal(AgentInitialSetupReceiptSchema.safeParse({ ...receipt, initialPinDigest: undefined }).success, false);
  assert.equal(AgentSetupOperationSchema.safeParse({ schemaVersion: 1, kind: 'initialize', operationId, identity }).success, true);
  assert.equal(AgentSetupOperationSchema.safeParse({ schemaVersion: 2, kind: 'initialize', operationId, identity,
    personalMemory: { backend: 'documents', storeId: foreignId } }).success, true);
  for (const compatibility of [legacyCompatibility(), engineCompatibility]) {
    const body = releaseBody(compatibility), digest = lifecycleDigest(body), parsed = EngineReleaseSchema.parse({ ...body, digest });
    const { digest: parsedDigest, ...parsedBody } = parsed;
    assert.equal(parsedDigest, digest); assert.equal(lifecycleDigest(parsedBody), digest);
    assert.equal(Object.hasOwn(parsed.compatibility, 'setup'), Object.hasOwn(compatibility, 'setup'));
  }
});

test('raw setup compatibility sees unfinished operation 3 and refuses malformed or unsupported records', localFileFixture, t => {
  const root = directory(t), legacy = { compatibility: legacyCompatibility() }, current = { compatibility: engineCompatibility };
  assert.equal(readAgentSetupSchemaVersion(root), null);
  metadata(root, 'setup.json', { schemaVersion: 1, agentId: identity.agentId });
  assert.equal(readAgentSetupSchemaVersion(root), 1); assertAgentSetupCompatibility(root, legacy);
  metadata(root, 'setup-operation.json', { schemaVersion: 2, kind: 'initialize', operationId, identity,
    personalMemory: { backend: 'documents', storeId: foreignId } });
  assert.equal(readAgentSetupSchemaVersion(root), 2); assertAgentSetupCompatibility(root, legacy);
  rmSync(join(root, '.secumon', 'setup.json'));
  metadata(root, 'setup-operation.json', initial());
  const original = readFileSync(join(root, '.secumon', 'setup-operation.json'));
  assert.equal(readAgentSetupSchemaVersion(root), 3);
  assert.throws(() => assertAgentSetupCompatibility(root, legacy), /engine_setup_incompatible/);
  assertAgentSetupCompatibility(root, current);
  assert.deepEqual(readFileSync(join(root, '.secumon', 'setup-operation.json')), original);
  rmSync(join(root, '.secumon', 'setup-operation.json'));
  metadata(root, 'setup.json', { schemaVersion: 3, agentId: identity.agentId, operationId, initialPinDigest: lifecycleDigest(firstPin()) });
  assert.equal(readAgentSetupSchemaVersion(root), 3);
  assert.throws(() => assertAgentSetupCompatibility(root, legacy), /engine_setup_incompatible/);
  metadata(root, 'setup-operation.json', { schemaVersion: 4 });
  assert.throws(() => readAgentSetupSchemaVersion(root), /agent_schema_unsupported/);
  writeFileSync(join(root, '.secumon', 'setup-operation.json'), '{', { mode: 0o600 });
  assert.throws(() => readAgentSetupSchemaVersion(root), /agent_metadata_invalid/);
});

test('runtime setup compatibility rejects legacy releases even before the initial pin is published', localFileFixture, t => {
  const base = directory(t), root = join(base, 'agent'), legacy = join(base, 'legacy-engine'), current = join(base, 'current-engine');
  engine(legacy, legacyCompatibility()); engine(current, engineCompatibility);
  metadata(root, 'setup-operation.json', initial(firstPin(current)));
  assert.throws(() => assertAgentEnginePin(root, legacy), /engine_setup_incompatible/);
  // This checks format support only. Ready/initial publication proofs belong to FileAgentProfileStore.
  assert.doesNotThrow(() => assertAgentEnginePin(root, current));
  rmSync(join(root, '.secumon', 'setup-operation.json'));
  metadata(root, 'setup.json', { schemaVersion: 1, agentId: identity.agentId });
  assert.doesNotThrow(() => assertAgentEnginePin(root, join(base, 'legacy-dev-without-release')));
});

test('runtime pinned schema 3 checks setup support in addition to the exact release digest', localFileFixture, t => {
  const base = directory(t);
  for (const [name, compatibility, supported] of [['legacy', legacyCompatibility(), false], ['current', engineCompatibility, true]] as const) {
    const engineRoot = join(base, `${name}-engine`), release = engine(engineRoot, compatibility), root = join(base, `${name}-agent`);
    assert.equal(inspectEngineRelease(engineRoot).digest, release.digest);
    const pin = firstPin(engineRoot, release.digest), operation = initial(pin);
    metadata(root, 'setup-operation.json', operation);
    metadata(root, 'setup.json', { schemaVersion: 3, agentId: identity.agentId, operationId, initialPinDigest: lifecycleDigest(pin) });
    mkdirSync(join(root, '.secumon', 'engine-pins'), { mode: 0o700 }); json(join(root, '.secumon', 'engine-pins', '00000001.json'), pin);
    json(join(root, 'config.json'), { schemaVersion: 1, identity, name: 'Initial compatibility', purpose: '',
      storage: { state: 'sqlite', memory: 'sqlite', artifacts: 'files' }, model: null, features: { board: false, archive: false }, skills: { mode: 'off' } });
    const before = captureLifecycleTree(root);
    if (supported) assertAgentEnginePin(root, engineRoot);
    else assert.throws(() => assertAgentEnginePin(root, engineRoot), /engine_setup_incompatible/);
    assert.deepEqual(captureLifecycleTree(root), before);
  }
});

test('local and all-Postgres lifecycle purposes reject unsupported setup before reading physical stores', localFileFixture, t => {
  const root = directory(t); metadata(root, 'setup-operation.json', initial());
  const selection = { storeId: '7480f44c-b335-4a74-8758-ac053b0d2ab8', registrationId: 'c1c790db-b65e-4e7b-bb0d-5ed9b6c1e38e',
    purposes: ['state', 'knowledge', 'channel'] };
  const config = AgentConfigSchema.parse({ schemaVersion: 1, identity, name: 'Compatibility before stores', purpose: '',
    storage: { state: 'sqlite', memory: 'sqlite', artifacts: 'files' }, model: null, features: { board: false, archive: false }, skills: { mode: 'off' } });
  const local: Extract<AgentProfileStatus, { status: 'ready' }> = { status: 'ready', root, identity, config, modelReady: false,
    setupSchemaVersion: 3, effectivePersonalMemory: { backend: 'sqlite' }, paths: { root, metadata: join(root, '.secumon'),
      state: join(root, '.secumon', 'absent-state.sqlite'), memory: join(root, 'absent-memory.sqlite'), artifacts: join(root, 'artifacts'),
      skills: join(root, 'skills'), workspace: join(root, 'workspace') } };
  const postgres = { ...local, config: AgentConfigSchema.parse({ ...config, storage: { ...config.storage, postgres: selection } }),
    effectivePersonalMemory: { backend: 'postgres' as const, storeId: selection.storeId, registrationId: selection.registrationId } };
  const before = captureLifecycleTree(root);
  for (const profile of [local, postgres])
    assert.throws(() => inspectAgentLocalStorageCompatibility(profile, { compatibility: legacyCompatibility() }), /engine_setup_incompatible/);
  assert.deepEqual(inspectAgentLocalStorageCompatibility(postgres, { compatibility: engineCompatibility }),
    { config: 1, stateBackend: 'sqlite', state: null, knowledge: null, session: null, personalMemory: 'postgres' });
  assert.deepEqual(captureLifecycleTree(root), before);
});
