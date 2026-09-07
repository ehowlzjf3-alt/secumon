import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Standalone generated-fixture observation. Run only after the emitted build is final for this observation.
const runtimeRoot = resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url)));
const stem = process.argv[3] ?? 'P3-computer-use-cost';
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(stem)) throw new Error('invalid_evidence_stem');
const outputPath = join(runtimeRoot, 'evidence', `${stem}.json`);
const logPath = join(runtimeRoot, 'evidence', `${stem}.log`);
for (const file of [outputPath, logPath]) {
  try { await access(file); throw new Error('output_already_exists_preserve_prior_evidence'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value);
const byteLength = value => Buffer.byteLength(JSON.stringify(value));
const zeroUsage = () => ({ transportCalls: 0, internalOperations: 0, imageBytes: 0, waitMs: 0 });
function difference(before, after) { return Object.fromEntries(Object.keys(after).map(key => [key, after[key] - (before[key] ?? 0)])); }
function add(rows) {
  const result = {};
  for (const row of rows) for (const [key, value] of Object.entries(row)) result[key] = (result[key] ?? 0) + value;
  return result;
}
function normalizedEvidence(evidence) {
  return evidence.map(value => ({ scope: value.scope, sourceId: value.sourceId, status: value.status, coverage: value.coverage,
    labels: [...value.labels].sort(), facts: value.facts, derivedFromCount: value.derivedFrom.length })).sort((a, b) => canonical(a).localeCompare(canonical(b)));
}
const implementationPaths = ['application/computer-use.js', 'application/computer-use-contracts.js', 'application/compose-runtime.js',
  'application/execution-runtime.js', 'application/tool-broker.js', 'application/plan-validator.js', 'domain/completion.js',
  'infrastructure/synthetic-computer-driver.js', 'infrastructure/file-artifacts.js', 'infrastructure/sqlite-state.js',
  'infrastructure/file-journal-state.js', 'tests/computer-use-helpers.js'];
async function implementationHashes() {
  return Object.fromEntries(await Promise.all(implementationPaths.map(async file => [file, hash(await readFile(join(runtimeRoot, 'dist', file)))])));
}
const report = { schemaVersion: 1, kind: 'generated-local-synthetic-computer-cost', status: 'running', createdAt: new Date().toISOString(),
  node: process.version, platform: process.platform, arch: process.arch, scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  scope: 'One synthetic document goal, two persistent runtime stores, batched versus separate typed actions. No actual GUI or model calls.',
  realModelInvoked: false, externalServiceInvoked: false, productionDataRead: false, actualGuiInvoked: false,
  physicalDiskIoMeasured: false, actualLatencyMeasured: false, cases: [], comparisons: [], fixtureCleanup: 'pending',
  notes: [
    'toolCalls counts logical registered runtime tool attempts. It is not a model round-trip count; every model count is zero.',
    'Driver transportCalls counts local observe/act/wait method calls. acquire/release session calls are reported separately; no MCP or network transport exists in this fixture.',
    'internalOperations counts the synthetic adapter observation, input-boundary check and wait-condition evaluations. inputCount separately counts applied synthetic form inputs.',
    'Artifact adapter metrics count Node-level file read/write bytes and verification calls, including repeated reads. They are not physical disk I/O, syscall counts or allocated disk space.',
    'Artifact exists probes can increment read/verification failure counters when a content-addressed file is not yet present. These counters are not automatically runtime failures.',
    'Tool result inspection reads are separated from runtime submission/execution/adoption and completion checks. Raw artifact-file inventory uses separate host stat calls.',
    'outputUtf8Bytes is JSON output payload size; resultArtifactBytes includes the entire stored ToolResult. Neither is an actual provider request, token or billed-byte measurement.',
    'Semantic comparison normalizes generated evidence IDs, lineage epoch IDs and artifact addresses; facts, source identity, coverage, labels, criterion outcomes and independence counts are retained.',
    'Only explicitly verified fact conditions produce completion evidence. The intermediate element-value-only fill must produce no evidence and cannot complete the save goal.',
    'This fixed scenario has no readiness delay, image request or model. Virtual elapsed time and image bytes must be zero; no real GUI latency, image efficiency or model-quality improvement is claimed.',
    'The durable app file persists synthetic contents/counters. Its session lease is confined to the driver instance, with no cross-process global lease or real OS input guarantee.',
    'Four synthetic runs are contract observations, not a throughput benchmark, p50/p95 estimate or evidence of production readiness.',
  ] };
await writeFile(logPath, `P3 computer-use synthetic cost observation\n${report.createdAt}\n`, { flag: 'wx' });
async function log(value) { const line = typeof value === 'string' ? value : JSON.stringify(value); await appendFile(logPath, line + '\n'); console.log(line); }
let fixtureDirectory;
const openHarnesses = new Set();

try {
  assert.equal(process.version, 'v24.20.0');
  const load = file => import(pathToFileURL(join(runtimeRoot, 'dist', file)).href);
  const [helpers, driverModule, completion, evaluation] = await Promise.all([
    load('tests/computer-use-helpers.js'), load('infrastructure/synthetic-computer-driver.js'), load('domain/completion.js'), load('infrastructure/local-evaluation.js'),
  ]);
  report.buildBefore = await evaluation.verifyEvaluationBuild(runtimeRoot);
  report.implementationSha256 = await implementationHashes();
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'secumon-computer-cost-'));

  async function runCase(backend, mode) {
    const directory = join(fixtureDirectory, `${backend}-${mode}`); await mkdir(directory, { recursive: true });
    const clock = new driverModule.SyntheticComputerClock(1000);
    const driver = new driverModule.SyntheticComputerDriver({ clock, stateFile: join(directory, 'app.json') });
    const calls = Object.fromEntries(['observe', 'act', 'wait'].map(method => [method, { calls: 0, failures: 0, responseJsonBytes: 0, usage: zeroUsage() }]));
    const instrument = method => async (...args) => {
      const row = calls[method]; row.calls++;
      try {
        const response = await driver[method](...args); row.responseJsonBytes += byteLength(response);
        for (const key of Object.keys(row.usage)) { assert.ok(Number.isSafeInteger(response.usage[key])); row.usage[key] += response.usage[key]; }
        return response;
      } catch (error) { row.failures++; throw error; }
    };
    const wrapped = { identity: driver.identity, acquire: driver.acquire.bind(driver), release: driver.release.bind(driver),
      observe: instrument('observe'), act: instrument('act'), wait: instrument('wait') };
    const h = await helpers.computerHarness(backend, { directory, clock, driver: wrapped }); openHarnesses.add(h);
    assert.equal(typeof h.artifacts.metrics, 'function');
    const artifactStart = h.artifacts.metrics(); const clockStart = clock.now(); const stages = [];
    const goal = structuredClone((await h.runtime.state(h.workId)).goal);
    async function invoke(kind, input = {}) {
      const before = h.artifacts.metrics(); const driverBefore = driver.snapshot();
      const attempt = await helpers.submitComputerTask(h, kind, input);
      await h.runtime.execute(h.workId, attempt.id); await h.runtime.settlePending(attempt.id); await h.runtime.adopt(h.workId, attempt.id);
      const afterRuntime = h.artifacts.metrics(); const driverAfter = driver.snapshot();
      const result = await helpers.computerResult(h, attempt.id); const afterInspection = h.artifacts.metrics();
      const current = await h.runtime.state(h.workId); const stored = current.attempts.find(value => value.id === attempt.id);
      assert.equal(result.status, 'success'); assert.equal(stored.adopted, true);
      assert.equal(stored.execution.mode, 'invoked');
      stages.push({ kind, stepCount: kind === 'act' ? input.steps.length : 0, resultStatus: result.status, effectState: result.effectState,
        evidenceCount: result.evidence.length, resultArtifactBytes: stored.resultArtifact.byteLength, outputUtf8Bytes: byteLength(result.output),
        toolResultUsage: result.usage, driverUsage: difference(driverBefore.usage, driverAfter.usage),
        sessionCalls: difference(driverBefore.sessionCalls, driverAfter.sessionCalls),
        runtimeArtifactIo: difference(before, afterRuntime), inspectionArtifactIo: difference(afterRuntime, afterInspection) });
      assert.deepEqual(result.usage, stages.at(-1).driverUsage);
      return result;
    }
    const observed = await invoke('observe'); assert.equal(observed.evidence.length, 0);
    let final;
    if (mode === 'batched') final = await invoke('act', helpers.computerActInput(observed.output.observationId, helpers.saveNoteSteps));
    else {
      const filled = await invoke('act', helpers.computerActInput(observed.output.observationId, [helpers.saveNoteSteps[0]]));
      assert.equal(filled.evidence.length, 0);
      const intermediate = await h.runtime.state(h.workId);
      assert.equal(intermediate.evidence.length, 0);
      assert.equal(completion.evaluateCompletion(intermediate.goal, intermediate.evidence, intermediate.obligations, intermediate.policy).complete, false);
      assert.equal(driver.snapshot().inputCount, 1); assert.equal(driver.snapshot().saveCount, 0);
      final = await invoke('act', helpers.computerActInput(filled.output.observationId, [helpers.saveNoteSteps[1]]));
    }
    assert.equal(final.evidence.length, 1);
    const beforeCompletion = h.artifacts.metrics(); const control = await h.runtime.step(h.workId);
    assert.deepEqual(control, { kind: 'complete', reason: 'criteria_verified' });
    const state = await h.runtime.state(h.workId); const afterCompletion = h.artifacts.metrics();
    const criteria = completion.evaluateCompletion(state.goal, state.evidence, state.obligations, state.policy);
    const snapshot = driver.snapshot();
    assert.equal(state.status, 'completed'); assert.equal(criteria.complete, true); assert.equal(state.evidence.length, 1);
    assert.equal(snapshot.savedNote, 'reviewed'); assert.equal(snapshot.note, 'reviewed'); assert.equal(snapshot.inputCount, 2); assert.equal(snapshot.saveCount, 1);
    assert.equal(state.budget.used.toolCalls, mode === 'batched' ? 2 : 3);
    assert.equal(state.budget.used.modelCalls, 0); assert.equal(state.modelCalls.length, 0); assert.equal(h.services.planner.inputs.length, 0);
    assert.equal(snapshot.usage.waitMs, 0); assert.equal(snapshot.usage.imageBytes, 0); assert.equal(clock.now() - clockStart, 0);
    assert.ok(Object.values(calls).every(row => row.failures === 0));
    const files = await readdir(join(directory, 'artifacts'), { withFileTypes: true }); const inventory = { bodyFiles: 0, bodyBytes: 0, metadataFiles: 0, metadataBytes: 0 };
    for (const file of files) {
      assert.ok(file.isFile()); const bytes = (await stat(join(directory, 'artifacts', file.name))).size;
      if (file.name.endsWith('.blob')) { inventory.bodyFiles++; inventory.bodyBytes += bytes; }
      else if (file.name.endsWith('.json')) { inventory.metadataFiles++; inventory.metadataBytes += bytes; }
      else throw new Error('unexpected_artifact_inventory_file');
    }
    const completionArtifactIo = difference(beforeCompletion, afterCompletion);
    const runtimeArtifactIo = add([...stages.map(stage => stage.runtimeArtifactIo), completionArtifactIo]);
    const inspectionArtifactIo = add(stages.map(stage => stage.inspectionArtifactIo));
    const allArtifactIo = difference(artifactStart, afterCompletion);
    assert.deepEqual(add([runtimeArtifactIo, inspectionArtifactIo]), allArtifactIo);
    assert.deepEqual(add(Object.values(calls).map(row => row.usage)), snapshot.usage);
    const semantic = { goal, query: snapshot.query, resultsReady: snapshot.resultsReady, savedNote: snapshot.savedNote, note: snapshot.note, inputCount: snapshot.inputCount, saveCount: snapshot.saveCount,
      status: state.status, evidence: normalizedEvidence(state.evidence), independentLineages: new Set(state.evidence.filter(value => value.derivedFrom.length === 0).map(value => value.lineageId)).size,
      criteria: criteria.criteria.map(value => ({ id: value.id, met: value.met, evidenceCount: value.evidenceIds.length, reasons: value.reasons })), blockers: criteria.blockers };
    const row = { backend, mode, semantic, semanticSha256: hash(canonical(semantic)), completed: true,
      logicalToolCalls: state.budget.used.toolCalls, modelCalls: 0, driverCalls: calls, driverUsage: snapshot.usage, sessionCalls: snapshot.sessionCalls,
      appliedInputs: snapshot.inputCount, saveCount: snapshot.saveCount, virtualElapsedMs: clock.now() - clockStart,
      resultArtifactBytes: stages.reduce((sum, stage) => sum + stage.resultArtifactBytes, 0),
      outputUtf8Bytes: stages.reduce((sum, stage) => sum + stage.outputUtf8Bytes, 0),
      artifacts: { runtimeIo: runtimeArtifactIo, resultInspectionIo: inspectionArtifactIo, allObservedIo: allArtifactIo, uniqueFileInventory: inventory }, stages };
    await h.close(false); openHarnesses.delete(h); return row;
  }
  for (const backend of ['sqlite', 'file-journal']) {
    const batched = await runCase(backend, 'batched'); report.cases.push(batched); await log({ backend, mode: 'batched', toolCalls: batched.logicalToolCalls, inputs: batched.appliedInputs, saves: batched.saveCount });
    const separate = await runCase(backend, 'separate'); report.cases.push(separate); await log({ backend, mode: 'separate', toolCalls: separate.logicalToolCalls, inputs: separate.appliedInputs, saves: separate.saveCount });
    assert.deepEqual(batched.semantic, separate.semantic);
    report.comparisons.push({ backend, sameNormalizedOutcome: true, batchedToolCalls: batched.logicalToolCalls, separateToolCalls: separate.logicalToolCalls,
      logicalToolCallsAvoided: separate.logicalToolCalls - batched.logicalToolCalls,
      driverCallsAvoided: separate.driverUsage.transportCalls - batched.driverUsage.transportCalls,
      runtimeArtifactBodyReadBytes: { batched: batched.artifacts.runtimeIo.bodyReadBytes, separate: separate.artifacts.runtimeIo.bodyReadBytes },
      runtimeArtifactBodyWriteBytes: { batched: batched.artifacts.runtimeIo.bodyWriteBytes, separate: separate.artifacts.runtimeIo.bodyWriteBytes },
      resultOutputBytes: { batched: batched.outputUtf8Bytes, separate: separate.outputUtf8Bytes },
      appliedInputsEqual: 2, saveCountEqual: 1, modelCallsEqual: 0, virtualElapsedMsEqual: 0 });
  }
  for (const mode of ['batched', 'separate']) assert.deepEqual(report.cases.find(row => row.backend === 'sqlite' && row.mode === mode).semantic,
    report.cases.find(row => row.backend === 'file-journal' && row.mode === mode).semantic);
  report.buildAfter = await evaluation.verifyEvaluationBuild(runtimeRoot);
  assert.deepEqual(report.buildAfter, report.buildBefore); assert.deepEqual(await implementationHashes(), report.implementationSha256);
  report.status = 'passed'; report.equivalenceAssertionsPassed = true;
} catch (error) {
  report.status = 'failed'; report.error = { name: error?.name ?? 'Error', message: error?.message ?? String(error) }; process.exitCode = 1;
} finally {
  try {
    for (const h of openHarnesses) await h.close(false);
    if (fixtureDirectory) { await rm(fixtureDirectory, { recursive: true, force: true }); report.fixtureCleanup = 'removed'; }
    else report.fixtureCleanup = 'not_created';
  } catch (error) { report.fixtureCleanup = 'failed'; report.cleanupError = error.message; report.status = 'failed'; process.exitCode = 1; }
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await log({ status: report.status, cases: report.cases.length, comparisons: report.comparisons, fixtureCleanup: report.fixtureCleanup,
    output: outputPath, ...(report.error ? { error: report.error } : {}) });
}
