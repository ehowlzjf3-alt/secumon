import assert from 'node:assert/strict';
import { join } from 'node:path';
import { composeRuntime } from '../../application/compose-runtime.js';
import { createExecutionAuthority } from '../../application/execution-authority.js';
import { FileArtifactStore } from '../../infrastructure/file-artifacts.js';
import { LocalChannel } from '../../infrastructure/local-channel.js';
import { AjvSchemas } from '../../infrastructure/ajv-schemas.js';
import { Sha256Digester } from '../../infrastructure/digest.js';
import { FakeClock, ScriptedPlanner, SequenceIds } from '../../infrastructure/fakes.js';
import { openRepository } from '../state-conformance-helpers.js';

const [backend, directory, workId] = process.argv.slice(2);
assert.ok(backend === 'sqlite' || backend === 'file-journal'); assert.ok(directory); assert.ok(workId);
const state = openRepository(backend, directory), channel = new LocalChannel(join(directory, 'channel.sqlite'), 'mission-agent');
const current = await state.get(workId); assert.ok(current);
const actor = { ...current.policy }, lifetime = new AbortController(), planner = new ScriptedPlanner([]);
const bundle = await composeRuntime({ services: { state, artifacts: new FileArtifactStore(join(directory, 'artifacts')), sink: channel,
  clock: new FakeClock(current.updatedAt + 1), ids: new SequenceIds(), digester: new Sha256Digester(), tools: [], planner },
  executionAuthority: createExecutionAuthority({ actor, scope: current.goal.scope, signal: lifetime.signal }), schemas: new AjvSchemas(),
  guidanceSource: { list: async () => [], read: async () => { throw new Error('unused_guidance'); } }, owner: 'other-process-control', enablePlanning: false });
try {
  await bundle.runtime.command(workId, 'other-process-pause', actor, current.goal.revision, { kind: 'pause', reason: 'Pause the pending observation from another host process.' });
  assert.equal(planner.inputs.length, 0);
  process.stdout.write(JSON.stringify({ revision: (await state.get(workId))!.revision, modelCalls: 0 }) + '\n');
} finally { lifetime.abort(); bundle.runtime.beginClose(); await bundle.runtime.finishClose(); await state.close(); channel.close(); }
