import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Usage: node evidence/C02-compact-measure.mjs /absolute/path/to/new-report.json
// This script requires the existing final build; it never builds or contacts a model endpoint.
if (process.argv.length !== 3) throw new Error('usage: node C02-compact-measure.mjs OUTPUT_JSON');
const runtimeRoot = fileURLToPath(new URL('../', import.meta.url));
const outputPath = resolve(process.argv[2]);
const scriptPath = fileURLToPath(import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const delta = (before, after) => Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - (before[key] ?? 0)]));
const failure = error => ({ name: error?.name ?? 'Error', message: error?.message ?? String(error) });
const load = path => import(pathToFileURL(join(runtimeRoot, 'dist', path)).href);
const counts = {
  historyCalls: 0, historyFailures: 0, historyReturnedJsonBytes: 0, historyEntryJsonBytes: 0, historyReturnedEntries: 0,
  historyFromSequenceZeroCalls: 0, historyTailCalls: 0, historyCursorCalls: 0,
  stateGetCalls: 0, stateGetFailures: 0,
  artifactExistsCalls: 0, artifactExistsFailures: 0, artifactExistsFalse: 0,
  artifactGetCalls: 0, artifactGetFailures: 0, artifactGetReturnedBytes: 0,
  originalManifestCalls: 0, originalManifestFailures: 0,
};
const report = {
  schemaVersion: 1, kind: 'C02-single-synthetic-compact-observation', status: 'running',
  startedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform, arch: process.arch },
  scriptSha256: hash(await readFile(scriptPath)), stateBackend: 'sqlite', transcriptBackend: 'sqlite', artifactBackend: 'files',
  realModelInvoked: false, externalApiInvoked: false, productionDataRead: false, actualModelTokenizationMeasured: false,
  physicalDiskIoMeasured: false, repeats: 1, compactRounds: [], phases: [], fixtureCleanup: 'pending',
  interpretation: [
    'One generated X-complete / Y-three-compacts / Z-context flow with QuoteCompactPlanner. This is not a throughput benchmark or a model-quality evaluation.',
    'Reported input/output tokens are fixed synthetic provider values that the real runtime usage ledger received. They are not tokenizer output, billed usage or measured tokens from a real model.',
    'Estimated tokens use the fixture estimator. JSON byte sizes are actual local UTF-8 serialization sizes; they are not an observed remote wire payload.',
    'history counts and returned bytes include repeated scans, including prefix checks from sequence zero. They are adapter method observations, not unique transcript size, SQL counts or physical disk reads.',
    'originalManifestCalls expose full-prefix validation entry points. historyQueries also show scans used by preparation and fixed-context validation outside that method.',
    'File artifact metrics include repeated content/hash verification caused by exists/get, including source-prefix verification. Failed exists probes do not by themselves imply a failed runtime operation.',
    'Context inspections create derived compiler frames and reread them. Their costs are marked measurement separately from reserve/execute/adopt runtime phases and remain included in observed totals.',
    'A prepared planning envelope/frame is not a dispatched planning request. Only each compact inputArtifact is an actual stored model-call request artifact in this flow.',
    'Elapsed milliseconds include local storage, assertions and instrumentation overhead. No percentile, concurrency, warm/cold comparison or production latency improvement is inferred.',
    'Selected quote preservation is a deterministic fixture assertion. Complete preservation of natural-language agreements, counterarguments and unresolved obligations is not established by this script.',
  ],
};
await mkdir(dirname(outputPath), { recursive: true });
const output = await open(outputPath, 'wx', 0o600);
let f, fixtureDirectory, activePhase;
const restoreWrappers = [];
const wallStart = performance.now();
let initialArtifactMetrics;

function wrap(target, method, replacement) {
  const original = target[method];
  target[method] = replacement(original.bind(target));
  restoreWrappers.push(() => { target[method] = original; });
}
function instrument() {
  wrap(f.stores.sessions, 'history', original => async (...args) => {
    counts.historyCalls++;
    const options = args[2];
    if ((options.afterSequence ?? 0) === 0) counts.historyFromSequenceZeroCalls++; else counts.historyTailCalls++;
    if (options.cursor) counts.historyCursorCalls++;
    const query = { afterSequence: options.afterSequence ?? 0, throughSequence: options.throughSequence ?? null,
      hasCursor: Boolean(options.cursor), limit: options.limit };
    activePhase?.historyQueries.push(query);
    try {
      const page = await original(...args);
      query.returnedEntries = page.entries.length; query.returnedJsonBytes = jsonBytes(page); query.hasNextCursor = page.nextCursor !== null;
      counts.historyReturnedEntries += page.entries.length; counts.historyReturnedJsonBytes += query.returnedJsonBytes;
      counts.historyEntryJsonBytes += jsonBytes(page.entries);
      return page;
    } catch (error) { counts.historyFailures++; query.error = failure(error); throw error; }
  });
  wrap(f.services.state, 'get', original => async (...args) => {
    counts.stateGetCalls++;
    try { return await original(...args); } catch (error) { counts.stateGetFailures++; throw error; }
  });
  wrap(f.services.artifacts, 'exists', original => async (...args) => {
    counts.artifactExistsCalls++;
    try { const exists = await original(...args); if (!exists) counts.artifactExistsFalse++; return exists; }
    catch (error) { counts.artifactExistsFailures++; throw error; }
  });
  wrap(f.services.artifacts, 'get', original => async (...args) => {
    counts.artifactGetCalls++;
    try { const bytes = await original(...args); counts.artifactGetReturnedBytes += bytes.byteLength; return bytes; }
    catch (error) { counts.artifactGetFailures++; throw error; }
  });
  wrap(f.sessions.compactor.originals, 'manifest', original => async (...args) => {
    counts.originalManifestCalls++;
    activePhase?.manifestPrefixes.push({ throughSequence: args[2], requiredQuotes: args[3]?.length ?? 0 });
    try { return await original(...args); } catch (error) { counts.originalManifestFailures++; throw error; }
  });
}
async function measure(name, category, operation) {
  assert.equal(activePhase, undefined, 'measurement phases must not overlap');
  const phase = { name, category, status: 'running', historyQueries: [], manifestPrefixes: [] };
  report.phases.push(phase); activePhase = phase;
  const before = { ...counts }, artifactBefore = f.stores.artifacts.metrics(), started = performance.now();
  try { const result = await operation(); phase.status = 'passed'; return result; }
  catch (error) { phase.status = 'failed'; phase.error = failure(error); throw error; }
  finally {
    phase.elapsedMs = performance.now() - started;
    phase.adapterCalls = delta(before, counts);
    phase.fileArtifactIo = delta(artifactBefore, f.stores.artifacts.metrics());
    activePhase = undefined;
  }
}
function contextSizes(context) {
  const summary = context.schemaVersion === 2 ? context.summary : null;
  return { schemaVersion: context.schemaVersion, actualSessionContextJsonBytes: jsonBytes(context),
    summaryContentJsonBytes: summary ? jsonBytes(summary.content) : 0, summaryViewJsonBytes: summary ? jsonBytes(summary) : 0,
    retainedItems: summary?.content.retained.length ?? 0, tailEntries: context.entries.length, tailJsonBytes: jsonBytes(context.entries),
    tailTextUtf8Bytes: context.entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.text, 'utf8'), 0),
    appliedInputSequence: context.basis.input.sequence, summaryThroughSequence: summary?.ref.throughSequence ?? null,
    summaryRevision: summary?.ref.revision ?? null };
}
function packetSizes(inspected) {
  const { prepared } = inspected;
  assert(prepared.packet.session);
  return { ...contextSizes(prepared.packet.session), packetJsonBytes: jsonBytes(prepared.packet),
    preparedPlanningEnvelopeJsonBytes: jsonBytes({ packet: prepared.packet, options: prepared.options }),
    planningRequestDispatched: false, derivedFrameArtifactBytes: prepared.head.artifact.byteLength,
    compilerReportedEstimate: prepared.estimate, compilerMetrics: prepared.frame.metrics };
}

try {
  const evaluation = await load('infrastructure/local-evaluation.js');
  report.buildBefore = await evaluation.verifyEvaluationBuild(runtimeRoot);
  const helpers = await load('tests/session-compact-flow-helpers.js');
  fixtureDirectory = await realpath(await mkdtemp(join(tmpdir(), 'secumon-compact-measure-')));
  await mkdir(join(fixtureDirectory, 'engine'), { mode: 0o700 });
  const setupStart = performance.now(); helpers.initialize(fixtureDirectory, 'sqlite'); f = await helpers.openCompact(fixtureDirectory);
  report.openProfileElapsedMs = performance.now() - setupStart;
  report.profileSetupInstrumented = false;
  report.provider = f.planner.identity;
  assert.equal(report.provider.provider, 'synthetic'); assert.equal(report.provider.model, 'quote-compact');
  initialArtifactMetrics = f.stores.artifacts.metrics(); instrument();
  const { session, x, y } = await measure('seed_completed_X_and_active_Y', 'fixture-setup', () => helpers.seedCompletedXAndActiveY(f));
  report.workIds = { x: x.workId, y: y.workId };
  const xBefore = await measure('inspect_completed_X', 'measurement', () => f.runtime.state(x.workId));
  assert.equal(xBefore.status, 'completed'); assert.equal(xBefore.budget.used.modelCalls, 0);

  for (let round = 1; round <= 3; round++) {
    if (round > 1) await measure(`round_${round}_apply_input`, 'runtime', () => f.sessions.input(helpers.actor, {
      sessionId: session.scope.sessionId, workId: y.workId, messageId: `measurement-y-${round}`, expectedGoalRevision: 1,
      rawText: helpers.longText(round === 2 ? helpers.preservation[3].quote : '다음 작업에도 앞서 정한 형식과 미해결 질문을 유지해 줘.'),
    }));
    const before = await measure(`round_${round}_inspect_context_before`, 'measurement', () => helpers.preparedSession(f, y.workId, `measure-before-${round}`));
    const row = { round, before: packetSizes(before) }; report.compactRounds.push(row);
    const call = await measure(`round_${round}_reserve`, 'runtime', () => f.compactPlanning.requestCompact(y.workId,
      { force: true, requestId: `measurement-compact-${round}`, expectedGoalRevision: 1 }));
    assert(call); row.callId = call.id;
    await measure(`round_${round}_execute`, 'runtime', () => f.compactPlanning.execute(y.workId, call.id));
    assert.equal(await measure(`round_${round}_adopt`, 'runtime', () => f.compactPlanning.adopt(y.workId, call.id)), true);
    row.call = await measure(`round_${round}_inspect_stored_call`, 'measurement', async () => {
      const state = await f.runtime.state(y.workId), settled = state.modelCalls.find(value => value.id === call.id);
      assert.equal(settled.status, 'accepted'); assert.equal(settled.purpose, 'session_compact'); assert(settled.replyArtifact);
      const inputBytes = await f.stores.artifacts.get(settled.inputArtifact, state.policy);
      const envelope = JSON.parse(Buffer.from(inputBytes).toString('utf8'));
      const replyBytes = await f.stores.artifacts.get(settled.replyArtifact, state.policy);
      const reply = JSON.parse(Buffer.from(replyBytes).toString('utf8'));
      assert.equal(inputBytes.byteLength, settled.inputArtifact.byteLength); assert.equal(replyBytes.byteLength, settled.replyArtifact.byteLength);
      assert.equal(reply.status, 'ok'); assert.equal(settled.inputTokens, helpers.compactUsage.inputTokens); assert.equal(settled.outputTokens, helpers.compactUsage.outputTokens);
      const publication = await f.stores.sessions.publication(session.scope, call.id); assert(publication);
      return { purpose: settled.purpose, status: settled.status, usageStatus: settled.usageStatus,
        actualStoredRequestArtifactBytes: inputBytes.byteLength, requestArtifactMetadataBytes: settled.inputArtifact.byteLength,
        compactInputJsonBytes: jsonBytes(envelope.compact), modelOptionsJsonBytes: jsonBytes(envelope.options),
        actualStoredReplyArtifactBytes: replyBytes.byteLength, sourceSegmentEntries: envelope.compact.entries.length,
        sourceSegmentJsonBytes: jsonBytes(envelope.compact.entries), fixedPrefix: envelope.compact.prefix,
        estimatedInputTokens: settled.inputEstimate, reservedOutputTokens: settled.maxOutputTokens, originallyReservedTokens: settled.tokenReservation,
        reportedSyntheticInputTokens: settled.inputTokens, reportedSyntheticOutputTokens: settled.outputTokens,
        reportedSyntheticTokens: settled.inputTokens + settled.outputTokens,
        workBudgetAfter: structuredClone(state.budget), publication: { id: publication.ref.id, revision: publication.ref.revision,
          throughSequence: publication.ref.throughSequence, summaryContentJsonBytes: jsonBytes(publication.content),
          recordJsonBytes: jsonBytes(publication), retainedItems: publication.content.retained.length } };
    });
    const after = await measure(`round_${round}_inspect_context_after`, 'measurement', () => helpers.preparedSession(f, y.workId, `measure-after-${round}`));
    row.after = packetSizes(after);
    row.observedContextBytesChange = row.after.actualSessionContextJsonBytes - row.before.actualSessionContextJsonBytes;
    row.observedContextRatio = row.after.actualSessionContextJsonBytes / row.before.actualSessionContextJsonBytes;
    assert.equal(row.after.appliedInputSequence, row.before.appliedInputSequence);
    assert(row.after.summaryThroughSequence < row.after.appliedInputSequence);
  }

  const z = await measure('accept_Z', 'runtime', () => f.sessions.accept(helpers.actor, { sessionId: session.scope.sessionId,
    rawText: 'Z의 새 문서를 검토하되 이전 미해결 질문을 확정 답으로 바꾸지 마.', request: helpers.request('measurement-z') }));
  report.workIds.z = z.workId;
  const zPacket = await measure('inspect_Z_packet', 'measurement', () => helpers.preparedSession(f, z.workId, 'measure-z'));
  report.nextZ = packetSizes(zPacket);
  report.final = await measure('final_fixture_assertions', 'verification', async () => {
    const xAfter = await f.runtime.state(x.workId), yAfter = await f.runtime.state(y.workId), zAfter = await f.runtime.state(z.workId);
    assert.deepEqual(xAfter, xBefore); assert.equal(f.planner.inputs.length, 3); assert.equal(f.planner.planCalls, 0);
    assert.equal(yAfter.budget.used.modelCalls, 3); assert.equal(yAfter.budget.used.tokens, 3 * (helpers.compactUsage.inputTokens + helpers.compactUsage.outputTokens));
    assert.equal(yAfter.budget.reservedTokens, 0); assert.equal(yAfter.budget.reservedModelCalls, 0);
    assert.equal(zAfter.budget.used.modelCalls, 0); assert.equal(zAfter.budget.used.tokens, 0);
    const context = zPacket.prepared.packet.session; assert.equal(context.schemaVersion, 2);
    assert.deepEqual(context.summary.content.retained.map(item => item.id), helpers.preservation.map(item => item.id));
    const raw = await f.stores.sessions.history(session.scope, zAfter.policy, { limit: 256 }); assert.equal(raw.nextCursor, null);
    for (const item of context.summary.content.retained) for (const quote of item.citations)
      assert(raw.entries.some(entry => entry.sequence === quote.sequence && entry.sourceId === quote.sourceId && entry.role === quote.role && entry.text.includes(quote.quote)));
    return { syntheticQuoteAssertionsPassed: true, fullNaturalLanguagePreservationEstablished: false,
      providerCompactInvocations: f.planner.inputs.length, providerPlanningInvocations: f.planner.planCalls,
      xBudget: xAfter.budget, yBudget: yAfter.budget, zBudget: zAfter.budget,
      storedTranscriptEntries: raw.entries.length, storedTranscriptEntryJsonBytes: jsonBytes(raw.entries),
      userOriginals: raw.entries.filter(entry => entry.role === 'user').length, actualFixtureToolInvocations: f.tool.invocations.length };
  });
  report.observedAdapterTotals = { ...counts };
  report.observedFileArtifactIo = delta(initialArtifactMetrics, f.stores.artifacts.metrics());
  report.buildAfter = await evaluation.verifyEvaluationBuild(runtimeRoot);
  assert.deepEqual(report.buildAfter, report.buildBefore);
  assert.equal(hash(await readFile(scriptPath)), report.scriptSha256);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = failure(error); process.exitCode = 1; }
finally {
  report.observedAdapterTotals = { ...counts };
  if (f && initialArtifactMetrics) report.observedFileArtifactIo = delta(initialArtifactMetrics, f.stores.artifacts.metrics());
  for (const restore of restoreWrappers.reverse()) restore();
  try { if (f) await f.close(); }
  catch (error) { report.status = 'failed'; report.closeError = failure(error); process.exitCode = 1; }
  try {
    if (fixtureDirectory) { await rm(fixtureDirectory, { recursive: true, force: true }); report.fixtureCleanup = 'removed'; }
    else report.fixtureCleanup = 'not_created';
  } catch (error) { report.status = 'failed'; report.fixtureCleanup = 'failed'; report.cleanupError = failure(error); process.exitCode = 1; }
  report.elapsedMs = performance.now() - wallStart; report.finishedAt = new Date().toISOString();
  try { await output.writeFile(JSON.stringify(report, null, 2) + '\n'); }
  finally { await output.close(); }
  process.stdout.write(JSON.stringify({ status: report.status, outputPath, compactRounds: report.compactRounds.length,
    fixtureCleanup: report.fixtureCleanup, ...(report.error ? { error: report.error } : {}) }) + '\n');
}
