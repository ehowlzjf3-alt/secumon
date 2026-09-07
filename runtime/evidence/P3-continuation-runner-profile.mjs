// Local intermediate profiling only. Uses the compiled synthetic fixture; no external driver or model.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { computerActor, computerActInput, computerHarness, computerResult, observeComputer, saveNoteSteps,
  submitComputerTask } from '../dist/tests/computer-use-helpers.js';

const stateCalls = { get: 0, receipt: 0, commit: 0 };
const artifactCalls = { get: 0, exists: 0, put: 0 };
const calls = {};
let rawState; let rawArtifacts;
function counted(target, counts) {
  return new Proxy(target, { get(object, key) {
    const value = Reflect.get(object, key, object);
    if (typeof value !== 'function') return value;
    return (...args) => {
      if (Object.hasOwn(counts, key)) counts[key]++;
      return value.apply(object, args);
    };
  } });
}
const h = await computerHarness('file-journal', { continuations: true,
  store: value => { rawState = value; return counted(value, stateCalls); },
  artifacts: value => { rawArtifacts = value; return counted(value, artifactCalls); } });
function instrument(object, prefix, methods) {
  for (const name of methods) {
    assert.equal(typeof object[name], 'function', `missing compiled instrumentation method ${prefix}.${name}`);
    const original = object[name].bind(object);
    object[name] = async (...args) => {
      const key = `${prefix}.${name}`; calls[key] = (calls[key] ?? 0) + 1;
      return original(...args);
    };
  }
}
function snapshot() {
  return structuredClone({ state: stateCalls, artifact: artifactCalls, calls,
    physical: rawArtifacts.metrics(), journal: rawState.metrics() });
}
function delta(after, before) {
  return Object.fromEntries(Object.entries(after).map(([key, value]) => [key,
    typeof value === 'number' ? value - (before?.[key] ?? 0) : delta(value, before?.[key] ?? {})]));
}
async function measure(phase, action) {
  const before = snapshot(); const started = performance.now(); const value = await action();
  const ms = performance.now() - started;
  return { record: { phase, ms, ...delta(snapshot(), before) }, value };
}
try {
  instrument(h.computerContinuations, 'continuation', ['current', 'resolve', 'derive', 'resultCurrent', 'canonical']);
  instrument(h.computerUse, 'computer', ['current', 'verifyCheckpoint', 'inspectCheckpoint', 'validateResult']);
  instrument(h.computerReconciliations, 'reconciliation', ['proofCurrent']);
  const search = { action: { kind: 'click', target: { role: 'button', name: 'Search' } },
    condition: { kind: 'fact_equals', key: 'resultsReady', value: true } };
  const observation = await observeComputer(h);
  h.driver.injectNextAction({ outcome: 'applied_unknown' });
  const source = await submitComputerTask(h, 'act', computerActInput(observation.observationId, [search, ...saveNoteSteps]));
  await h.runtime.execute(h.workId, source.id); await h.runtime.settlePending(source.id); await h.runtime.adopt(h.workId, source.id);
  let state = await h.state.get(h.workId);
  const parent = state.attempts.find(value => value.id === source.id);
  assert.equal((await computerResult(h, source.id)).effectState, 'unknown');
  const reconciliation = await h.computerReconciliations.reconcile(h.workId, `profile-reconcile-${source.id}`, computerActor,
    { attemptId: source.id, checkpointId: parent.computerUse.head.id });
  assert.equal(reconciliation.status, 'settled');
  state = await h.state.get(h.workId);
  const task = { id: `profile-continuation-${state.revision}`, toolId: 'synthetic.ui.continue', toolVersion: '1',
    description: 'Profile two remaining synthetic inputs', input: {}, computerResume: {
      attemptId: source.id, checkpointId: parent.computerUse.head.id,
      reconciliation: { id: reconciliation.id, proofId: reconciliation.proofArtifact.id } },
    dependsOn: [], effect: 'write', maxAttempts: 1, satisfies: ['saved'] };
  await h.runtime.submitPlan(h.workId, `profile-plan-${state.revision}`, {
    baseStateRevision: state.revision, baseGoalRevision: state.goal.revision, basePlanRevision: state.plan?.revision ?? 0,
    reason: 'Profile explicit continuation without replaying the applied prefix', tasks: [task], hypotheses: [] });
  const child = await h.runtime.reserve(h.workId, task.id);
  state = await h.state.get(h.workId);
  const resolved = await measure('resolve', () => h.computerContinuations.resolve(state, child.id));
  const current = await measure('current', () => h.computerContinuations.current(state));
  const executed = await measure('execute', async () => {
    await h.runtime.execute(h.workId, child.id); await h.runtime.settlePending(child.id);
  });
  const finalState = await h.state.get(h.workId); const attempt = finalState.attempts.find(value => value.id === child.id);
  const result = await computerResult(h, child.id); const app = h.driver.snapshot();
  const pins = [];
  for (const file of ['application/computer-continuations.js', 'application/computer-use.js',
    'application/computer-reconciliation.js', 'tests/computer-use-helpers.js']) {
    const bytes = await readFile(new URL(`../dist/${file}`, import.meta.url));
    pins.push({ file: `dist/${file}`, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  console.log(JSON.stringify({ schemaVersion: 1, kind: 'local_intermediate_computer_continuation_profile',
    recordedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, kernel: release(),
    backend: 'file-journal', fixtureClock: 1000, runtimeLeaseMs: 10000, phases: [
      { ...resolved.record, valid: !!resolved.value }, { ...current.record, valid: current.value },
      { ...executed.record, attemptStatus: attempt.status, resultStatus: result.status, error: result.error,
        inputCount: app.inputCount, saveCount: app.saveCount }], pins,
    scope: 'One isolated local process; compiled synthetic fixture only. Timings are descriptive, not a performance acceptance threshold. No external services or actual computer-use driver.',
    measurement: 'Counters/physical metrics are per-phase deltas. Fixture setup, parent execution/reconciliation, child reservation, final status/result reads and cleanup are excluded. execute includes child execution and pending response settlement, but not adoption. Journal byte/read counters include repeated verified reads; they are not distinct files. Retained/cache-size metrics in deltas are gauge changes, not total heap.',
  }, null, 2));
} finally { await h.close(); }
