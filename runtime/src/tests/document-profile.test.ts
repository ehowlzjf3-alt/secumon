import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentConfigSchema, AgentConfigV1Schema, AgentSetupOperationSchema, AgentSetupOperationV1Schema } from '../application/agent-profile-contracts.js';
import type { AgentConfig } from '../application/agent-profile-contracts.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'document-profile-'))), engine = join(base, 'engine');
  mkdirSync(engine, { mode: 0o700 });
  return { base, root: join(base, 'agent'), store: new FileAgentProfileStore(engine), close: () => rmSync(base, { recursive: true, force: true }) };
}
const put = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
const operationPath = (root: string) => join(root, '.secumon', 'setup-operation.json');
const operation = (root: string) => AgentSetupOperationSchema.parse(JSON.parse(readFileSync(operationPath(root), 'utf8')));
function documentMemory(config: AgentConfig) {
  assert.equal(config.schemaVersion, 2);
  if (config.schemaVersion !== 2) throw new Error('expected_document_profile');
  return config.storage.personalMemory;
}

test('ordinary and explicit SQLite setup retain the exact v1 configuration and initialize operation shapes', () => {
  const f = fixture();
  try {
    const ready = f.store.initialize(f.root);
    assert.deepEqual(ready.config, { schemaVersion: 1, identity: ready.identity, name: 'agent', purpose: '',
      storage: { state: 'sqlite', memory: 'sqlite', artifacts: 'files' }, model: null,
      features: { board: false, archive: false }, skills: { mode: 'on-demand' } });
    assert.deepEqual(AgentConfigV1Schema.parse(ready.config), ready.config);
    const saved = operation(f.root);
    assert.deepEqual(Object.keys(saved).sort(), ['identity', 'kind', 'operationId', 'schemaVersion']);
    assert.equal(saved.schemaVersion, 1); assert.equal(saved.kind, 'initialize');
    assert.deepEqual(AgentSetupOperationV1Schema.parse(saved), saved);
    assert.deepEqual(f.store.initialize(f.root, { personalMemory: 'sqlite' }), ready);
  } finally { f.close(); }
});

test('documents setup persists a distinct v2 choice while retaining the existing SQLite work-memory path', () => {
  const f = fixture();
  try {
    const ready = f.store.initialize(f.root, { personalMemory: 'documents' }), selected = documentMemory(ready.config), saved = operation(f.root);
    assert.equal(selected.backend, 'documents'); assert.notEqual(selected.storeId, ready.identity.agentId);
    assert.equal(ready.paths.memory, join(f.root, 'memory', 'memory.sqlite'));
    assert.equal(saved.schemaVersion, 2); assert.equal(saved.kind, 'initialize');
    if (saved.schemaVersion !== 2 || saved.kind !== 'initialize') throw new Error('expected_document_operation');
    assert.deepEqual(saved.personalMemory, selected);
    assert.equal(AgentConfigV1Schema.safeParse(ready.config).success, false);
    assert.equal(AgentSetupOperationV1Schema.safeParse(saved).success, false);
    assert.deepEqual(readdirSync(join(f.root, 'memory')), [], 'document owner/store initialization belongs to openAgentStores');
    assert.deepEqual(f.store.initialize(f.root), ready);
    assert.deepEqual(f.store.initialize(f.root, { personalMemory: 'documents' }), ready);
  } finally { f.close(); }
});

for (const phase of ['operation-only', 'identity-published'] as const) {
  test(`${phase}: a saved document setup resumes with the same store and agent when the option is omitted`, () => {
    const f = fixture();
    try {
      const ready = f.store.initialize(f.root, { personalMemory: 'documents' }), selected = documentMemory(ready.config);
      const saved = readFileSync(operationPath(f.root));
      unlinkSync(join(f.root, 'config.json')); unlinkSync(join(f.root, '.secumon', 'setup.json'));
      if (phase === 'operation-only') unlinkSync(join(f.root, '.secumon', 'identity.json'));
      assert.equal(f.store.inspect(f.root).status, 'incomplete');
      const resumed = f.store.initialize(f.root);
      assert.deepEqual(resumed.identity, ready.identity); assert.deepEqual(documentMemory(resumed.config), selected);
      assert.deepEqual(readFileSync(operationPath(f.root)), saved);
    } finally { f.close(); }
  });
}

test('ready and incomplete profiles reject an explicit backend switch without replacing their saved choice', () => {
  const f = fixture();
  try {
    const ready = f.store.initialize(f.root, { personalMemory: 'documents' });
    const config = readFileSync(join(f.root, 'config.json')), saved = readFileSync(operationPath(f.root));
    assert.throws(() => f.store.initialize(f.root, { personalMemory: 'sqlite' }), /agent_personal_memory_backend_mismatch/);
    assert.deepEqual(readFileSync(join(f.root, 'config.json')), config);
    unlinkSync(join(f.root, 'config.json')); unlinkSync(join(f.root, '.secumon', 'setup.json'));
    assert.throws(() => f.store.initialize(f.root, { personalMemory: 'sqlite', repair: true }), /agent_personal_memory_backend_mismatch/);
    assert.equal(existsSync(join(f.root, 'config.json')), false); assert.deepEqual(readFileSync(operationPath(f.root)), saved);
    assert.deepEqual(documentMemory(f.store.initialize(f.root, { repair: true }).config), documentMemory(ready.config));
    const ordinary = f.store.initialize(join(f.base, 'sqlite'));
    assert.throws(() => f.store.initialize(ordinary.root, { personalMemory: 'documents' }), /agent_personal_memory_backend_mismatch/);
    assert.deepEqual(f.store.inspect(ordinary.root), ordinary);
  } finally { f.close(); }
});

test('explicit missing-identity repair preserves document assignment and does not restore a missing completed config by default', () => {
  const f = fixture();
  try {
    const ready = f.store.initialize(f.root, { personalMemory: 'documents', name: '문서 담당' });
    unlinkSync(join(f.root, '.secumon', 'identity.json'));
    assert.throws(() => f.store.initialize(f.root), /agent_repair_required/);
    assert.deepEqual(f.store.initialize(f.root, { repair: true }), ready);
    unlinkSync(join(f.root, 'config.json'));
    assert.throws(() => f.store.initialize(f.root, { repair: true }), /agent_recovery_source_required/);
    assert.equal(existsSync(join(f.root, 'config.json')), false);
  } finally { f.close(); }
});

for (const change of ['store-id', 'downgrade-config', 'downgrade-operation', 'missing-operation'] as const) {
  test(`documents inspection rejects ${change} without repairing the conflicting original`, () => {
    const f = fixture();
    try {
      const ready = f.store.initialize(f.root, { personalMemory: 'documents' }), saved = operation(f.root);
      if (ready.config.schemaVersion !== 2) throw new Error('expected_document_profile');
      if (change === 'store-id') put(join(f.root, 'config.json'), { ...ready.config,
        storage: { ...ready.config.storage, personalMemory: { backend: 'documents', storeId: randomUUID() } } });
      if (change === 'downgrade-config') put(join(f.root, 'config.json'), { ...ready.config, schemaVersion: 1,
        storage: { state: 'sqlite', memory: 'sqlite', artifacts: 'files' } });
      if (change === 'downgrade-operation') put(operationPath(f.root), { schemaVersion: 1, kind: 'initialize', operationId: saved.operationId, identity: saved.identity });
      if (change === 'missing-operation') unlinkSync(operationPath(f.root));
      const config = readFileSync(join(f.root, 'config.json'));
      assert.throws(() => f.store.inspect(f.root), /agent_personal_memory_profile_mismatch/);
      assert.throws(() => f.store.initialize(f.root, { repair: true }), /agent_personal_memory_profile_mismatch/);
      assert.deepEqual(readFileSync(join(f.root, 'config.json')), config);
    } finally { f.close(); }
  });
}

test('a v1 setup cannot acquire a document store by editing only config, and malformed or unknown versions are rejected', () => {
  const f = fixture();
  try {
    const ready = f.store.initialize(f.root);
    const upgraded = { ...ready.config, schemaVersion: 2, storage: { ...ready.config.storage,
      personalMemory: { backend: 'documents', storeId: randomUUID() } } };
    assert.equal(AgentConfigSchema.safeParse(upgraded).success, true); put(join(f.root, 'config.json'), upgraded);
    assert.throws(() => f.store.inspect(f.root), /agent_personal_memory_profile_mismatch/);
    put(join(f.root, 'config.json'), { ...ready.config, schemaVersion: 2 });
    assert.throws(() => f.store.inspect(f.root), /agent_metadata_invalid/);
    put(join(f.root, 'config.json'), { ...upgraded, schemaVersion: 3 });
    assert.throws(() => f.store.inspect(f.root), /agent_schema_unsupported/);
    assert.equal(AgentConfigSchema.safeParse({ ...upgraded, storage: { ...upgraded.storage, otherBackend: 'sqlite' } }).success, false);
    assert.throws(() => f.store.initialize(join(f.base, 'injected'), { personalMemory: 'documents', storeId: randomUUID() } as never), /agent_setup_options_invalid/);
    assert.equal(existsSync(join(f.base, 'injected')), false);
  } finally { f.close(); }
});

test('the personal assignment fence preserves the existing independent state-backend selection', () => {
  const f = fixture();
  try {
    const ready = f.store.initialize(f.root, { personalMemory: 'documents' });
    const config = { ...ready.config, storage: { ...ready.config.storage, state: 'file-journal' } };
    put(join(f.root, 'config.json'), config);
    const inspected = f.store.inspect(f.root); assert.equal(inspected.status, 'ready');
    const resumed = f.store.initialize(f.root);
    assert.equal(resumed.config.storage.state, 'file-journal'); assert.equal(resumed.paths.state, join(f.root, '.secumon', 'state-journal'));
    assert.deepEqual(documentMemory(resumed.config), documentMemory(ready.config));
  } finally { f.close(); }
});

test('document clone gives the new agent a new store and copies skills without any original memories', () => {
  const f = fixture();
  try {
    const ready = f.store.initialize(f.root, { personalMemory: 'documents', purpose: 'Reusable document task' });
    mkdirSync(join(f.root, 'memory', 'documents'), { mode: 0o700 });
    writeFileSync(join(f.root, 'memory', 'documents', 'original.md'), 'Original-only memory', { mode: 0o600 });
    writeFileSync(join(ready.paths.skills, 'SKILL.md'), '# Reusable skill', { mode: 0o600 });
    const before = readFileSync(join(f.root, 'config.json')), clone = f.store.clone(f.root, join(f.base, 'copy'));
    assert.notEqual(clone.identity.agentId, ready.identity.agentId);
    assert.notEqual(documentMemory(clone.config).storeId, documentMemory(ready.config).storeId);
    assert.equal(clone.config.purpose, ready.config.purpose);
    assert.deepEqual(readdirSync(join(clone.root, 'memory')), []);
    assert.equal(readFileSync(join(clone.paths.skills, 'SKILL.md'), 'utf8'), '# Reusable skill');
    assert.deepEqual(readFileSync(join(f.root, 'config.json')), before);
    assert.equal(readFileSync(join(f.root, 'memory', 'documents', 'original.md'), 'utf8'), 'Original-only memory');
    const saved = operation(clone.root); assert.equal(saved.schemaVersion, 2); assert.equal(saved.kind, 'clone');
    assert.equal(AgentSetupOperationV1Schema.safeParse(saved).success, false);
    assert.deepEqual(f.store.clone(f.root, clone.root, { resume: true }), clone);
  } finally { f.close(); }
});

test('an incomplete document clone resumes the same recorded target store and identity', () => {
  const f = fixture();
  try {
    f.store.initialize(f.root, { personalMemory: 'documents' });
    const cloned = f.store.clone(f.root, join(f.base, 'copy')), saved = readFileSync(operationPath(cloned.root));
    for (const file of ['clone-complete.json', 'identity.json', 'setup.json']) unlinkSync(join(cloned.root, '.secumon', file));
    unlinkSync(join(cloned.root, 'config.json'));
    const partial = f.store.inspect(cloned.root); assert.equal(partial.status, 'incomplete');
    assert.throws(() => f.store.initialize(cloned.root, { repair: true }), /agent_clone_resume_required/);
    const resumed = f.store.clone(f.root, cloned.root, { resume: true });
    assert.deepEqual(resumed.identity, cloned.identity); assert.deepEqual(documentMemory(resumed.config), documentMemory(cloned.config));
    assert.deepEqual(readFileSync(operationPath(cloned.root)), saved);
  } finally { f.close(); }
});

for (const changed of ['config', 'skills'] as const) {
  test(`an incomplete document clone still refuses changed source ${changed}`, () => {
    const f = fixture();
    try {
      const ready = f.store.initialize(f.root, { personalMemory: 'documents' }), clone = f.store.clone(f.root, join(f.base, 'copy'));
      unlinkSync(join(clone.root, '.secumon', 'clone-complete.json'));
      const saved = readFileSync(operationPath(clone.root));
      if (changed === 'config') put(join(f.root, 'config.json'), { ...ready.config, purpose: 'Changed source purpose' });
      else writeFileSync(join(ready.paths.skills, 'new.md'), 'Changed source skill', { mode: 0o600 });
      assert.throws(() => f.store.clone(f.root, clone.root, { resume: true }), /agent_clone_source_changed/);
      assert.deepEqual(readFileSync(operationPath(clone.root)), saved);
      assert.equal(existsSync(join(clone.root, '.secumon', 'clone-complete.json')), false);
    } finally { f.close(); }
  });
}
