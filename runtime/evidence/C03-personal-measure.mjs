import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Usage: node evidence/C03-personal-measure.mjs [OUTPUT_JSON]
// Uses an already verified build. No build, test runner, browser or model endpoint is invoked.
if (process.argv.length > 3) throw new Error('usage: node C03-personal-measure.mjs [OUTPUT_JSON]');
const runtimeRoot = fileURLToPath(new URL('../', import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
const outputPath = resolve(process.argv[2] ?? join(runtimeRoot, 'evidence/C03-personal-measurement1.json'));
const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const textBytes = value => Buffer.byteLength(value, 'utf8');
const load = path => import(pathToFileURL(join(runtimeRoot, 'dist', path)).href);
const errorInfo = error => ({ name: error?.name ?? 'Error', message: error?.message ?? String(error) });
const difference = (before, after) => Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - (before[key] ?? 0)]));
const counts = {};
const increment = (key, amount = 1) => { counts[key] = (counts[key] ?? 0) + amount; };
const original = '개인 기억 계측용 원문: 응답은 한국어로 작성하고 세 문장 요약으로 시작한다.';
const correction = '개인 기억 계측용 정정: 응답은 한국어로 작성하고 두 문장 요약 뒤에 상세 설명을 붙인다.';
const report = {
  schemaVersion: 1, kind: 'C03-single-synthetic-personal-memory-observation', status: 'running',
  startedAt: new Date().toISOString(), scriptSha256: hash(await readFile(scriptPath)),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  storage: { profile: 'C01-owned', state: 'sqlite', memory: 'sqlite', transcript: 'sqlite', artifacts: 'files' },
  repeats: 1, realModelInvoked: false, externalApiInvoked: false, productionDataRead: false,
  physicalDiskIoMeasured: false, actualModelTokenizationMeasured: false, profileSetupInstrumented: false,
  phases: [], fixtureCleanup: 'pending',
  interpretation: [
    'One generated agent, one authenticated synthetic user, one personal memory and two sessions. This is not a throughput benchmark, a production workload or a model-quality evaluation.',
    'Cold means the first identical query on one fresh KnowledgeService instance. Warm means one immediate repeat on that same instance. It does not mean an OS/SQLite cold cache or a measured cache shared between separate HTTP requests.',
    'The CLI/Web factory currently creates scoped services per request. This observation isolates the public service cache behavior and does not claim cross-request presentation cache reuse.',
    'Port wrappers count calls, failures and returned UTF-8 JSON bytes. They forward the original receiver and arguments and retain original source, receipt, policy and artifact validation. Counts are not SQL statements, unique records or physical disk reads.',
    'A cached search reuses candidate identifiers, not unchecked bodies or user-source validation. Source and artifact observations show the repeated verification still performed on a warm query.',
    'File artifact metrics are the existing adapter counters, including repeated body/hash verification. Failed existence probes do not by themselves imply a failed runtime operation.',
    'Returned JSON byte counters overlap where one layer returns another layer\'s data. Do not add them to infer unique storage consumption or a remote network payload.',
    'context.prepare stages a real derived ContextFrame artifact. It does not dispatch planner.propose; frame rereading and final assertions are separately labeled verification phases.',
    'Elapsed milliseconds include local storage, assertions, metric collection and wrapper overhead. There is one sample per phase; no percentile, concurrency or warm-query latency improvement is inferred.',
    'Compiler estimate fields are omitted from the measurement result: no actual tokenizer, billed tokens or token savings are measured.',
    'Selected original and correction preservation are deterministic fixture assertions. No general natural-language memory extraction or retrieval quality is established.',
  ],
  fixture: { originalTextUtf8Bytes: textBytes(original), originalSha256: hash(original), correctionTextUtf8Bytes: textBytes(correction), correctionSha256: hash(correction) },
};
await mkdir(dirname(outputPath), { recursive: true });
const output = await open(outputPath, 'wx', 0o600);
let stores, composed, fixtureDirectory, activePhase, initialArtifactMetrics;
const restores = [];
const wallStart = performance.now();

function observe(target, method, group, describe) {
  const own = Object.getOwnPropertyDescriptor(target, method);
  const originalMethod = target[method];
  assert.equal(typeof originalMethod, 'function', `${group}.${method} is a required public port`);
  const key = `${group}.${method}`;
  for (const metric of ['calls', 'failures', 'nullReturns', 'returnedJsonBytes']) counts[`${key}.${metric}`] = 0;
  target[method] = async function (...args) {
    increment(`${key}.calls`);
    try {
      const result = await originalMethod.apply(this, args);
      if (result === null) increment(`${key}.nullReturns`);
      if (result !== undefined) increment(`${key}.returnedJsonBytes`, result instanceof Uint8Array ? result.byteLength : bytes(result));
      describe?.(result, args); return result;
    } catch (error) { increment(`${key}.failures`); throw error; }
  };
  restores.push(() => { if (own) Object.defineProperty(target, method, own); else delete target[method]; });
}
function instrument() {
  for (const method of ['get', 'receipt', 'events', 'recentEventMetadata', 'deliveries', 'workIdsForConversation', 'conversationWorkPage', 'runnable']) observe(stores.state, method, 'state');
  for (const method of ['get', 'receipt', 'indexHead', 'candidates']) observe(stores.knowledge, method, 'knowledge');
  // Commit is included separately to distinguish user changes from source verification reads.
  observe(stores.knowledge, 'commit', 'knowledgeMutation');
  for (const method of ['get', 'input', 'pending', 'summaryHead', 'summary', 'summaryBefore', 'publication']) observe(stores.sessions, method, 'session');
  observe(stores.sessions, 'history', 'session', (page, args) => {
    increment('session.history.returnedEntries', page.entries.length);
    increment('session.history.entryTextUtf8Bytes', page.entries.reduce((sum, entry) => sum + textBytes(entry.text), 0));
    const options = args[2];
    activePhase?.historyQueries.push({ afterSequence: options.afterSequence ?? 0, throughSequence: options.throughSequence ?? null,
      hasCursor: Boolean(options.cursor), limit: options.limit, returnedEntries: page.entries.length, hasNextCursor: page.nextCursor !== null });
  });
  for (const method of ['get', 'exists']) observe(stores.artifacts, method, 'artifact');
  observe(composed.services.planner, 'propose', 'planner');
}
async function phase(name, category, action) {
  assert.equal(activePhase, undefined, 'phases must not overlap');
  const row = { name, category, status: 'running', historyQueries: [] };
  report.phases.push(row); activePhase = row;
  const before = { ...counts }, artifactBefore = stores.artifacts.metrics(), start = performance.now();
  try { const result = await action(row); row.status = 'passed'; return result; }
  catch (error) { row.status = 'failed'; row.error = errorInfo(error); throw error; }
  finally {
    row.elapsedMs = performance.now() - start;
    row.portObservations = difference(before, counts);
    row.fileArtifactIo = difference(artifactBefore, stores.artifacts.metrics());
    activePhase = undefined;
  }
}
function cardSizes(cards) {
  return { count: cards.length, cardsJsonBytes: bytes(cards), bodyUtf8Bytes: cards.reduce((sum, card) => sum + textBytes(card.body), 0),
    cards: cards.map(card => ({ id: card.id, revision: card.revision, cardJsonBytes: bytes(card), bodyUtf8Bytes: textBytes(card.body), bodySha256: hash(card.body) })) };
}
function searchSizes(result) {
  return { ...cardSizes(result.cards), fullServiceResultJsonBytes: bytes(result), publicCardsAndIndexJsonBytes: bytes({ cards: result.cards, index: result.index }),
    dependencyJsonBytes: bytes(result.dependencies), index: result.index };
}
async function prepare(workId, name) {
  return phase(name, 'context-preparation', async row => {
    const state = await composed.runtime.state(workId);
    const value = await composed.context.prepare(state, { callId: name, maxOutputTokens: 1024, maxInputBytes: 524288, maxInputTokens: 100000 });
    row.result = { packetJsonBytes: bytes(value.packet), preparedEnvelopeJsonBytes: bytes({ packet: value.packet, options: value.options }),
      derivedFrameArtifactBytes: value.head.artifact.byteLength, personalMemoryJsonBytes: bytes(value.packet.personalMemory),
      selectedBodyUtf8Bytes: value.packet.personalMemory.entries.reduce((sum, entry) => sum + textBytes(entry.body), 0),
      sessionContextJsonBytes: bytes(value.packet.session), selectedRevisions: value.packet.personalMemory.entries.map(entry => entry.ref.revision),
      modelRequestDispatched: false };
    return { value, state };
  });
}

try {
  const evaluation = await load('infrastructure/local-evaluation.js'); report.buildBefore = await evaluation.verifyEvaluationBuild(runtimeRoot);
  const helpers = await load('tests/session-flow-helpers.js');
  report.fixture.scenarioId = helpers.scenario.id;
  report.fixture.scenarioAsset = { path: 'fixtures/documents-simple.json', sha256: hash(await readFile(join(runtimeRoot, 'fixtures/documents-simple.json'))) };
  const { FileAgentProfileStore } = await load('infrastructure/file-agent-profile.js');
  const { openAgentStores } = await load('infrastructure/agent-stores.js');
  const { composeRuntime } = await load('application/compose-runtime.js');
  const { FixtureReadTool, ScriptedPlanner } = await load('infrastructure/fakes.js');
  const { RandomIds, Sha256Digester } = await load('infrastructure/digest.js');
  const { AjvSchemas } = await load('infrastructure/ajv-schemas.js');
  const { ContextFrameSchema } = await load('application/context-contracts.js');
  fixtureDirectory = await realpath(await mkdtemp(join(tmpdir(), 'secumon-personal-measure-')));
  await mkdir(join(fixtureDirectory, 'engine'), { mode: 0o700 });
  const setupStart = performance.now(); helpers.initialize(fixtureDirectory, 'sqlite');
  stores = await openAgentStores(new FileAgentProfileStore(join(fixtureDirectory, 'engine')), join(fixtureDirectory, 'agent'));
  assert.equal(stores.profile.config.storage.state, 'sqlite');
  const tool = new FixtureReadTool(helpers.scenario.evidence), planner = new ScriptedPlanner([]);
  const trusted = { ...helpers.actor, agentId: stores.profile.identity.agentId, allowedLabels: helpers.scenario.policy.allowedLabels,
    allowedDestinations: ['local'], allowedScopes: [helpers.scenario.goal.scope], allowedNamespaces: ['personal'], canReview: false, canPublish: false };
  composed = await composeRuntime({ services: { state: stores.state, artifacts: stores.artifacts, sink: stores.channel, tools: [tool], planner,
    ids: new RandomIds(), digester: new Sha256Digester(), clock: { now: () => Date.now() } },
    schemas: new AjvSchemas(), guidanceSource: { list: async () => [], read: async () => { throw new Error('no_guidance'); } },
    session: { repository: stores.sessions, agentId: stores.profile.identity.agentId },
    knowledge: { repository: stores.knowledge, actors: { current: async () => structuredClone(trusted) } }, owner: 'personal-memory-measurement', enablePlanning: false });
  assert.equal(composed.planning, null); assert(composed.personalKnowledge && composed.personalMemories && composed.sessions);
  report.openProfileElapsedMs = performance.now() - setupStart;
  report.agentId = stores.profile.identity.agentId; report.provider = planner.identity;
  initialArtifactMetrics = stores.artifacts.metrics(); instrument();
  const actor = helpers.actor;
  const { xSession, x } = await phase('accept_user_original_X', 'runtime', async () => {
    const xSession = await composed.sessions.open(actor, { channel: 'test', conversationId: 'conversation', newSession: true });
    const x = await composed.sessions.accept(actor, { sessionId: xSession.scope.sessionId, rawText: original, request: helpers.request('personal-source') });
    return { xSession, x };
  });
  // Retaining this public service instance is what makes the candidate-cache comparison meaningful.
  const memory = await composed.personalKnowledge(actor);
  const saved = await phase('remember_applied_original', 'runtime', async row => {
    const result = await memory.remember({ id: 'response-format', commandId: 'remember-format', title: '응답 형식',
      source: { sessionId: xSession.scope.sessionId, messageId: 'personal-source', quote: original }, expiresAt: null });
    assert.equal(result.card.body, original); assert.equal(result.card.revision, 1);
    row.result = { ...cardSizes([result.card]), fullServiceResultJsonBytes: bytes(result), dependencyJsonBytes: bytes(result.dependency) }; return result;
  });
  const query = { namespace: 'personal', scope: 'personal', text: '응답', limit: 5 };
  const cold = await phase('same_service_first_search', 'runtime', async row => { const result = await memory.search(query); row.result = searchSizes(result); return result; });
  const warm = await phase('same_service_repeat_search', 'runtime', async row => { const result = await memory.search(query); row.result = searchSizes(result); return result; });
  assert.equal(cold.index.cached, false); assert.equal(warm.index.cached, true);
  assert.equal(cold.index.complete, true); assert.equal(warm.index.complete, true); assert.equal(cold.cards.length, 1);
  assert.deepEqual(cold.cards, warm.cards); assert.equal(warm.cards[0].body, original);
  const warmPhase = report.phases.find(row => row.name === 'same_service_repeat_search');
  assert.equal(warmPhase.portObservations['knowledge.candidates.calls'], 0);
  assert(warmPhase.portObservations['knowledge.get.calls'] > 0 && warmPhase.portObservations['session.input.calls'] > 0 && warmPhase.portObservations['session.history.calls'] > 0);
  report.cache = { scope: 'one-retained-KnowledgeService', firstQueryCached: cold.index.cached, repeatedQueryCached: warm.index.cached,
    sameCardsAndRevision: true, repeatedQueryStillVerifiedRecordsAndOriginals: true, operatingSystemCacheControlled: false };
  const { ySession, y } = await phase('accept_new_session_Y', 'runtime', async () => {
    const ySession = await composed.sessions.open(actor, { channel: 'test', conversationId: 'conversation', newSession: true });
    const y = await composed.sessions.accept(actor, { sessionId: ySession.scope.sessionId, rawText: '새 세션 Y에서 합성 문서 확인을 요청한다.', request: helpers.request('personal-next-work') });
    assert.notEqual(ySession.scope.sessionId, xSession.scope.sessionId); return { ySession, y };
  });
  const ref = { ...saved.card.owner, tenantId: actor.tenantId, id: saved.card.id, revision: saved.card.revision };
  async function select(name, selectedRef) {
    return phase(name, 'runtime', async row => {
      const state = await composed.runtime.state(y.workId);
      const result = await composed.personalMemories.select(y.workId, actor, { commandId: name, expectedGoalRevision: state.goal.revision, expectedStateRevision: state.revision, refs: [selectedRef] });
      assert.equal(result.applied, true); row.result = { selectionId: result.selectionId, stateRevision: result.stateRevision, selectedRevision: selectedRef.revision };
    });
  }
  await select('select_memory_v1_for_Y', ref);
  const v1 = await prepare(y.workId, 'prepare_selected_context_v1');
  assert.equal(v1.value.packet.personalMemory.entries[0].body, original);
  assert(!JSON.stringify(v1.value.packet.session).includes(original), 'the other session is not copied into the new session');
  await phase('read_stored_context_frame_v1', 'verification', async row => {
    const data = await stores.artifacts.get(v1.value.head.artifact, v1.state.policy);
    const frame = ContextFrameSchema.parse(JSON.parse(Buffer.from(data).toString('utf8')));
    assert.deepEqual(frame.packet, v1.value.packet); row.result = { returnedArtifactBytes: data.byteLength, packetMatchesPrepared: true };
  });
  await phase('apply_user_correction', 'runtime', async () => {
    const state = await composed.runtime.state(x.workId);
    await composed.sessions.input(actor, { sessionId: xSession.scope.sessionId, messageId: 'personal-correction', workId: x.workId, rawText: correction, expectedGoalRevision: state.goal.revision });
  });
  await phase('revise_memory_from_applied_correction', 'runtime', async row => {
    const result = await memory.revisePersonal({ id: ref.id, commandId: 'revise-format', expectedRevision: 1, title: '응답 형식', reason: '명시적 사용자 정정',
      source: { sessionId: xSession.scope.sessionId, messageId: 'personal-correction', quote: correction } });
    assert.equal(result.revision, 2); row.result = result;
  });
  await phase('fresh_get_after_revision', 'runtime', async row => {
    const result = await memory.get(ref.id); assert.equal(result.card.revision, 2); assert.equal(result.card.body, correction);
    row.result = { ...cardSizes([result.card]), fullServiceResultJsonBytes: bytes(result), dependencyJsonBytes: bytes(result.dependency) };
  });
  await phase('same_service_search_after_revision', 'runtime', async row => {
    const result = await memory.search(query); assert.equal(result.index.cached, false); assert.equal(result.index.complete, true);
    assert.equal(result.cards.length, 1); assert.equal(result.cards[0].revision, 2); assert.equal(result.cards[0].body, correction); row.result = searchSizes(result);
  });
  await phase('reject_old_context_after_revision', 'verification', async row => {
    const state = await composed.runtime.state(y.workId);
    assert.equal(await composed.context.sourcesCurrent(v1.value.packet, state), false);
    row.result = { oldPacketRejected: true };
  });
  await select('select_memory_v2_for_Y', { ...ref, revision: 2 });
  const v2 = await prepare(y.workId, 'prepare_selected_context_v2');
  assert.equal(v2.value.packet.personalMemory.entries[0].body, correction);
  report.final = await phase('final_original_and_no_model_assertions', 'verification', async () => {
    const xState = await composed.runtime.state(x.workId), yState = await composed.runtime.state(y.workId);
    const historyX = await composed.sessions.history(actor, xSession.scope.sessionId, xState.policy, { limit: 50 });
    const historyY = await composed.sessions.history(actor, ySession.scope.sessionId, yState.policy, { limit: 50 });
    assert.equal(historyX.nextCursor, null); assert.equal(historyY.nextCursor, null);
    assert.deepEqual(historyX.entries.filter(entry => entry.role === 'user').map(entry => entry.text), [original, correction]);
    assert.equal(historyY.entries.filter(entry => entry.role === 'user').length, 1);
    for (const state of [xState, yState]) {
      assert.deepEqual(state.attempts, []); assert.deepEqual(state.modelCalls, []); assert.equal(state.budget.used.modelCalls, 0);
      assert.equal(state.budget.used.tokens, 0); assert.equal(state.budget.used.toolCalls, 0);
    }
    assert.equal(planner.inputs.length, 0); assert.equal(tool.invocations.length, 0); assert.equal(counts['planner.propose.calls'], 0);
    return { sourceOriginalAndCorrectionPreserved: true, xUserEntries: 2, yUserEntries: 1, xHistoryJsonBytes: bytes(historyX), yHistoryJsonBytes: bytes(historyY),
      selectedMemoryRevision: 2, providerProposeCalls: 0, fixtureToolInvocations: 0, storedModelCallRecords: 0,
      xBudget: xState.budget, yBudget: yState.budget };
  });
  report.buildAfter = await evaluation.verifyEvaluationBuild(runtimeRoot); assert.deepEqual(report.buildAfter, report.buildBefore);
  assert.equal(hash(await readFile(scriptPath)), report.scriptSha256); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = errorInfo(error); process.exitCode = 1; }
finally {
  report.observedPortTotals = { ...counts };
  if (stores && initialArtifactMetrics) report.observedFileArtifactIo = difference(initialArtifactMetrics, stores.artifacts.metrics());
  for (const restore of restores.reverse()) restore();
  try { if (stores) { await stores.close(); report.storeCleanup = 'closed'; } else report.storeCleanup = 'not_opened'; }
  catch (error) { report.status = 'failed'; report.storeCleanup = 'failed'; report.closeError = errorInfo(error); process.exitCode = 1; }
  try {
    if (fixtureDirectory) {
      await rm(fixtureDirectory, { recursive: true, force: true });
      await assert.rejects(stat(fixtureDirectory), error => error?.code === 'ENOENT'); report.fixtureCleanup = 'removed_and_absence_checked';
    } else report.fixtureCleanup = 'not_created';
  } catch (error) { report.status = 'failed'; report.fixtureCleanup = 'failed'; report.cleanupError = errorInfo(error); process.exitCode = 1; }
  report.elapsedMs = performance.now() - wallStart; report.finishedAt = new Date().toISOString();
  try { await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync(); }
  finally { await output.close(); }
  process.stdout.write(JSON.stringify({ status: report.status, outputPath, phases: report.phases.length, fixtureCleanup: report.fixtureCleanup,
    ...(report.error ? { error: report.error } : {}) }) + '\n');
}
