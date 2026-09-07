import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Usage: node evidence/C03-documents-measure.mjs [OUTPUT_JSON]
// Uses an existing verified build; no build, test runner, browser or model endpoint is invoked.
if (process.argv.length > 3) throw new Error('usage: node C03-documents-measure.mjs [OUTPUT_JSON]');
const runtimeRoot = fileURLToPath(new URL('../', import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
const outputPath = resolve(process.argv[2] ?? join(runtimeRoot, 'evidence/C03-documents-measurement1.json'));
const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const textBytes = value => Buffer.byteLength(value, 'utf8');
const load = path => import(pathToFileURL(join(runtimeRoot, 'dist', path)).href);
const difference = (before, after) => Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - (before[key] ?? 0)]));
const errorInfo = error => ({ name: error?.name ?? 'Error', message: error?.message ?? String(error) });
const original = '문서 기억 계측용 원문: 답변은 한국어로 작성하고 먼저 세 문장으로 요약한다.';
const counters = {}, restorers = [];
const increment = (key, amount = 1) => { counters[key] = (counters[key] ?? 0) + amount; };
const report = {
  schemaVersion: 1, kind: 'C03-single-synthetic-document-memory-observation', status: 'running', startedAt: new Date().toISOString(),
  scriptSha256: hash(await readFile(scriptPath)), environment: { node: process.version, platform: process.platform, arch: process.arch },
  storage: { profile: 'C01-owned-v2', state: 'sqlite', workMemory: 'sqlite', personalMemory: 'documents', transcript: 'sqlite', artifacts: 'files' },
  repeats: 1, realModelInvoked: false, externalApiInvoked: false, productionDataRead: false,
  physicalDiskIoMeasured: false, actualModelTokenizationMeasured: false, profileSetupInstrumented: true,
  phases: [], inventories: [], fixtureCleanup: 'pending',
  fixture: { personalRecords: 1, documentRevisions: 1, originalTextUtf8Bytes: textBytes(original), originalSha256: hash(original) },
  interpretation: [
    'One temporary private agent, one synthetic user, one remembered original and two sessions. This is one observation, not a throughput/concurrency benchmark or model-quality evaluation.',
    'hostMetadataFiles.diagnostics deltas are actual counters at the common metadata boundary. dataBytes includes repeated file verification; directorySyncs counts attempted fsync calls at that boundary.',
    'These counters exclude direct opendir/lstat calls in the document adapter, mutation writes, SQLite internals and asynchronous artifact I/O. They are not complete filesystem syscall counts or physical disk I/O.',
    'Port counters report calls, failures and returned UTF-8 JSON bytes. Layers can return overlapping data; byte counters must not be summed as unique bytes or network traffic.',
    'First and repeat search use one retained KnowledgeService. cached=true can reuse candidate identifiers but still validates records and user originals. No cache reuse between separate HTTP requests is claimed.',
    'Cold get means the first explicit get through a newly opened repository after close/reopen. Warm get is its immediate repeat. The OS page cache is not flushed and no physical cold-cache condition is claimed.',
    'The reopened repository starts a new in-memory directory-sync signature cache. Two full verified namespace scans and source validation remain part of normal reads; an omitted repeat sync is not omitted content validation.',
    'Document inventory uses bounded lstat/readdir on this fixture only and reports logical regular-file sizes for event Markdown, witnesses and registration/pending metadata. It does not report allocated blocks.',
    'context.prepare persists a real frame artifact but dispatches no model call. Packet/frame sizes are bytes, not actual tokenizer counts, billed tokens or token savings.',
    'Elapsed milliseconds include assertions, wrappers and local scheduling. Each phase has one sample; no percentile, speedup or general storage recommendation follows from these times.',
    'Temporary fixture creation, reopen and cleanup are separately labeled. Existing agents and original source data outside the generated fixture are not opened.',
    'Observed metadata/port totals stop before final cleanup; total elapsed time includes final close and fixture removal. Inventory timings are separate from service/context phase timings.',
  ],
};
await mkdir(dirname(outputPath), { recursive: true });
const output = await open(outputPath, 'wx', 0o600);
let fixtureDirectory, stores, composed, hostFiles, initialMetadata, activePhase;
let helpers, ProfileStore, openStores, composeRuntime, FixtureReadTool, ScriptedPlanner, RandomIds, Sha256Digester, AjvSchemas, ContextFrameSchema;
const planners = [], tools = [];
const started = performance.now();

function observe(target, method, group) {
  const own = Object.getOwnPropertyDescriptor(target, method), originalMethod = target[method];
  assert.equal(typeof originalMethod, 'function', `${group}.${method}`);
  const key = `${group}.${method}`;
  for (const metric of ['calls', 'failures', 'nullReturns', 'returnedJsonBytes']) counters[`${key}.${metric}`] ??= 0;
  target[method] = async function (...args) {
    increment(`${key}.calls`);
    try {
      const result = await originalMethod.apply(this, args);
      if (result === null) increment(`${key}.nullReturns`);
      if (result !== undefined) increment(`${key}.returnedJsonBytes`, result instanceof Uint8Array ? result.byteLength : bytes(result));
      return result;
    } catch (error) { increment(`${key}.failures`); throw error; }
  };
  restorers.push(() => { if (own) Object.defineProperty(target, method, own); else delete target[method]; });
}
function instrument() {
  for (const method of ['get', 'receipt']) observe(stores.state, method, 'state');
  for (const method of ['get', 'receipt', 'indexHead', 'candidates', 'commit']) observe(stores.knowledge, method, 'knowledge');
  for (const method of ['get', 'input', 'pending', 'history', 'head', 'summaryHead', 'summary', 'summaryBefore', 'publication']) observe(stores.sessions, method, 'session');
  for (const method of ['get', 'exists']) observe(stores.artifacts, method, 'artifact');
  observe(composed.services.planner, 'propose', 'planner');
}
function restoreObservers() { while (restorers.length) restorers.pop()(); }
async function phase(name, category, action) {
  assert.equal(activePhase, undefined);
  const row = { name, category, status: 'running' }, before = hostFiles.diagnostics(), portsBefore = { ...counters }, start = performance.now();
  report.phases.push(row); activePhase = row;
  try { const result = await action(row); row.status = 'passed'; return result; }
  catch (error) { row.status = 'failed'; row.error = errorInfo(error); throw error; }
  finally {
    row.elapsedMs = performance.now() - start;
    row.hostMetadataIo = difference(before, hostFiles.diagnostics()); row.portObservations = difference(portsBefore, counters); activePhase = undefined;
  }
}
async function composeOpenedProfile() {
  stores = await openStores(new ProfileStore(join(fixtureDirectory, 'engine')), join(fixtureDirectory, 'agent'));
  assert.equal(stores.profile.config.schemaVersion, 2); assert.equal(stores.profile.config.storage.personalMemory.backend, 'documents');
  const planner = new ScriptedPlanner([]), tool = new FixtureReadTool(helpers.scenario.evidence); planners.push(planner); tools.push(tool);
  const trusted = { ...helpers.actor, agentId: stores.profile.identity.agentId, allowedLabels: helpers.scenario.policy.allowedLabels,
    allowedDestinations: ['local'], allowedScopes: [helpers.scenario.goal.scope], allowedNamespaces: ['personal'], canReview: false, canPublish: false };
  composed = await composeRuntime({ services: { state: stores.state, artifacts: stores.artifacts, sink: stores.channel, tools: [tool], planner,
    ids: new RandomIds(), digester: new Sha256Digester(), clock: { now: () => Date.now() } }, schemas: new AjvSchemas(),
    guidanceSource: { list: async () => [], read: async () => { throw new Error('no_guidance'); } },
    session: { repository: stores.sessions, agentId: stores.profile.identity.agentId },
    knowledge: { repository: stores.knowledge, actors: { current: async () => structuredClone(trusted) } }, owner: 'document-memory-measurement', enablePlanning: false });
  assert.equal(composed.planning, null); assert(composed.personalKnowledge && composed.personalMemories && composed.sessions);
  instrument();
}
function cardSizes(read) {
  return { revision: read.card.revision, cardJsonBytes: bytes(read.card), bodyUtf8Bytes: textBytes(read.card.body), bodySha256: hash(read.card.body),
    fullServiceResultJsonBytes: bytes(read), dependencyJsonBytes: bytes(read.dependency) };
}
function searchSizes(result) {
  return { cards: result.cards.length, cardsJsonBytes: bytes(result.cards), bodyUtf8Bytes: result.cards.reduce((sum, card) => sum + textBytes(card.body), 0),
    fullServiceResultJsonBytes: bytes(result), dependencyJsonBytes: bytes(result.dependencies), index: result.index };
}
async function inventory(label) {
  const start = performance.now(), directory = join(fixtureDirectory, 'agent', 'memory', 'documents');
  const result = { label, event: { count: 0, bytes: 0 }, witness: { count: 0, bytes: 0 }, registration: { count: 0, bytes: 0 }, pending: { count: 0, bytes: 0 } };
  const roots = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  assert(roots.length <= 16, 'bounded single-namespace fixture inventory');
  async function file(path, category) {
    const value = await lstat(path); assert(value.isFile() && !value.isSymbolicLink());
    result[category].count++; result[category].bytes += value.size;
  }
  for (const entry of roots) {
    if (entry.isFile()) await file(join(directory, entry.name), entry.name.endsWith('.pending') ? 'pending' : 'registration');
    else {
      assert(entry.isDirectory() && /^(ns|witness)-[a-f0-9]{64}$/.test(entry.name));
      const entries = await readdir(join(directory, entry.name)); assert(entries.length <= 16);
      for (const name of entries) await file(join(directory, entry.name, name), name.endsWith('.pending') ? 'pending' : entry.name.startsWith('ns-') ? 'event' : 'witness');
    }
  }
  result.elapsedMs = performance.now() - start; report.inventories.push(result); return result;
}
async function prepare(workId, name) {
  return phase(name, 'context-preparation', async row => {
    const state = await composed.runtime.state(workId);
    const prepared = await composed.context.prepare(state, { callId: name, maxOutputTokens: 1024, maxInputBytes: 524288, maxInputTokens: 100000 });
    assert.equal(prepared.packet.personalMemory.entries[0].body, original);
    row.result = { packetJsonBytes: bytes(prepared.packet), frameJsonBytes: bytes(prepared.frame), derivedFrameArtifactBytes: prepared.head.artifact.byteLength,
      personalMemoryJsonBytes: bytes(prepared.packet.personalMemory), sessionContextJsonBytes: bytes(prepared.packet.session), modelRequestDispatched: false };
    return { prepared, state };
  });
}

try {
  const evaluation = await load('infrastructure/local-evaluation.js'); report.buildBefore = await evaluation.verifyEvaluationBuild(runtimeRoot);
  const { hostMetadataFiles } = await load('infrastructure/host-metadata-files.js'); hostFiles = hostMetadataFiles(); initialMetadata = hostFiles.diagnostics();
  report.hostMetadataCapabilities = hostFiles.capabilities;
  helpers = await load('tests/session-flow-helpers.js');
  ({ FileAgentProfileStore: ProfileStore } = await load('infrastructure/file-agent-profile.js'));
  ({ openAgentStores: openStores } = await load('infrastructure/agent-stores.js'));
  ({ composeRuntime } = await load('application/compose-runtime.js'));
  ({ FixtureReadTool, ScriptedPlanner } = await load('infrastructure/fakes.js'));
  ({ RandomIds, Sha256Digester } = await load('infrastructure/digest.js'));
  ({ AjvSchemas } = await load('infrastructure/ajv-schemas.js'));
  ({ ContextFrameSchema } = await load('application/context-contracts.js'));
  report.fixture.scenarioId = helpers.scenario.id;
  report.fixture.scenarioAsset = { path: 'fixtures/documents-simple.json', sha256: hash(await readFile(join(runtimeRoot, 'fixtures/documents-simple.json'))) };
  fixtureDirectory = await realpath(await mkdtemp(join(tmpdir(), 'secumon-documents-measure-')));
  await mkdir(join(fixtureDirectory, 'engine'), { mode: 0o700 });
  await phase('initialize_and_open_documents_profile', 'setup', async () => {
    helpers.initialize(fixtureDirectory, 'sqlite', 'agent', 'documents'); await composeOpenedProfile();
  });
  report.agentId = stores.profile.identity.agentId; report.documentStoreId = stores.profile.config.storage.personalMemory.storeId;
  const actor = helpers.actor;
  const { x, xSession } = await phase('accept_original_X', 'runtime', async () => {
    const xSession = await composed.sessions.open(actor, { channel: 'test', conversationId: 'measurement-X', newSession: true });
    const x = await composed.sessions.accept(actor, { sessionId: xSession.scope.sessionId, rawText: original, request: helpers.request('document-source') });
    return { x, xSession };
  });
  const memory = await composed.personalKnowledge(actor);
  const saved = await phase('remember_original', 'memory', async row => {
    const result = await memory.remember({ id: 'response-format', commandId: 'remember-format', title: '응답 형식',
      source: { sessionId: xSession.scope.sessionId, messageId: 'document-source', quote: original }, expiresAt: null });
    assert.equal(result.card.body, original); row.result = cardSizes(result); return result;
  });
  const firstInventory = await inventory('after_remember'); assert.equal(firstInventory.event.count, 1); assert.equal(firstInventory.witness.count, 1);
  const query = { namespace: 'personal', scope: 'personal', text: '응답', limit: 5 };
  const cold = await phase('same_service_first_search', 'memory', async row => { const result = await memory.search(query); row.result = searchSizes(result); return result; });
  const warm = await phase('same_service_repeat_search', 'memory', async row => { const result = await memory.search(query); row.result = searchSizes(result); return result; });
  assert.equal(cold.index.cached, false); assert.equal(warm.index.cached, true); assert.deepEqual(warm.cards, cold.cards); assert.equal(warm.cards[0].body, original);
  const warmRow = report.phases.find(row => row.name === 'same_service_repeat_search');
  assert.equal(warmRow.portObservations['knowledge.candidates.calls'], 0); assert(warmRow.hostMetadataIo.dataBytes > 0);
  assert(warmRow.portObservations['knowledge.get.calls'] > 0 && warmRow.portObservations['session.input.calls'] > 0 && warmRow.portObservations['session.history.calls'] > 0);
  report.cache = { scope: 'one-retained-KnowledgeService', firstSearchCached: cold.index.cached, repeatedSearchCached: warm.index.cached,
    repeatedSearchStillReadCanonicalFiles: true, operatingSystemCacheControlled: false };
  const { y, ySession } = await phase('accept_new_session_Y', 'runtime', async () => {
    const ySession = await composed.sessions.open(actor, { channel: 'test', conversationId: 'measurement-Y', newSession: true });
    const y = await composed.sessions.accept(actor, { sessionId: ySession.scope.sessionId, rawText: '다음 업무의 합성 문서를 확인한다.', request: helpers.request('document-next') });
    assert.notEqual(ySession.scope.sessionId, xSession.scope.sessionId); return { y, ySession };
  });
  await phase('select_memory_for_Y', 'memory', async row => {
    const state = await composed.runtime.state(y.workId);
    row.result = await composed.personalMemories.select(y.workId, actor, { commandId: 'select-format', expectedGoalRevision: state.goal.revision,
      expectedStateRevision: state.revision, refs: [{ ...saved.card.owner, tenantId: actor.tenantId, id: saved.card.id, revision: saved.card.revision }] });
    assert.equal(row.result.applied, true);
  });
  const selected = await prepare(y.workId, 'prepare_selected_context');
  assert(!JSON.stringify(selected.prepared.packet.session).includes(original));
  await phase('read_stored_frame', 'verification', async row => {
    const data = await stores.artifacts.get(selected.prepared.head.artifact, selected.state.policy);
    assert.deepEqual(ContextFrameSchema.parse(JSON.parse(Buffer.from(data).toString('utf8'))).packet, selected.prepared.packet);
    row.result = { actualArtifactBytes: data.byteLength, packetMatchesPrepared: true };
  });
  await phase('close_original_profile', 'lifecycle', async () => { restoreObservers(); await stores.close(); });
  await phase('reopen_same_profile', 'lifecycle', async () => {
    await composeOpenedProfile(); assert.equal(stores.profile.identity.agentId, report.agentId); assert.equal(stores.profile.config.storage.personalMemory.storeId, report.documentStoreId);
  });
  const reopenedMemory = await composed.personalKnowledge(actor);
  const firstGet = await phase('reopened_repository_first_get', 'memory', async row => { const result = await reopenedMemory.get(saved.card.id); row.result = cardSizes(result); return result; });
  const repeatGet = await phase('reopened_repository_repeat_get', 'memory', async row => { const result = await reopenedMemory.get(saved.card.id); row.result = cardSizes(result); return result; });
  assert.deepEqual(firstGet.card, saved.card); assert.deepEqual(repeatGet.card, saved.card);
  await phase('reopen_recall_saved_selection', 'memory', async row => {
    const result = await composed.personalMemories.selected(y.workId, actor);
    assert.equal(result.available, true); assert.equal(result.refs.length, 1); assert.equal(result.refs[0].revision, 1); row.result = result;
  });
  await prepare(y.workId, 'prepare_context_after_reopen');
  const finalInventory = await inventory('after_reopen_recall');
  for (const category of ['event', 'witness', 'registration', 'pending']) assert.deepEqual(finalInventory[category], firstInventory[category]);
  report.final = await phase('verify_originals_and_no_execution', 'verification', async () => {
    const xState = await composed.runtime.state(x.workId), yState = await composed.runtime.state(y.workId);
    const source = await stores.sessions.input(xSession.scope, 'document-source'); assert.equal(source.text, original);
    const historyY = await composed.sessions.history(actor, ySession.scope.sessionId, yState.policy, { limit: 50 });
    assert.equal(historyY.entries.filter(entry => entry.role === 'user').length, 1); assert(!JSON.stringify(historyY).includes(original));
    for (const state of [xState, yState]) {
      assert.deepEqual(state.attempts, []); assert.deepEqual(state.modelCalls, []);
      assert.equal(state.budget.used.tokens, 0); assert.equal(state.budget.used.modelCalls, 0); assert.equal(state.budget.used.toolCalls, 0);
    }
    assert(planners.every(planner => planner.inputs.length === 0)); assert(tools.every(tool => tool.invocations.length === 0));
    assert.equal(counters['planner.propose.calls'], 0);
    return { originalPreserved: true, newSessionDidNotCopyOldHistory: true, reopenedSelectedRevision: 1,
      modelCalls: 0, toolCalls: 0, canonicalEventCount: finalInventory.event.count, witnessCount: finalInventory.witness.count };
  });
  report.buildAfter = await evaluation.verifyEvaluationBuild(runtimeRoot); assert.deepEqual(report.buildAfter, report.buildBefore);
  assert.equal(hash(await readFile(scriptPath)), report.scriptSha256); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = errorInfo(error); process.exitCode = 1; }
finally {
  report.observedPortTotals = { ...counters };
  if (hostFiles && initialMetadata) report.observedHostMetadataIo = difference(initialMetadata, hostFiles.diagnostics());
  restoreObservers();
  try { if (stores) { await stores.close(); report.storeCleanup = 'closed'; } else report.storeCleanup = 'not_opened'; }
  catch (error) { report.status = 'failed'; report.storeCleanup = 'failed'; report.closeError = errorInfo(error); process.exitCode = 1; }
  try {
    if (fixtureDirectory) {
      await rm(fixtureDirectory, { recursive: true, force: true });
      await assert.rejects(stat(fixtureDirectory), error => error?.code === 'ENOENT'); report.fixtureCleanup = 'removed_and_absence_checked';
    } else report.fixtureCleanup = 'not_created';
  } catch (error) { report.status = 'failed'; report.fixtureCleanup = 'failed'; report.cleanupError = errorInfo(error); process.exitCode = 1; }
  report.elapsedMs = performance.now() - started; report.finishedAt = new Date().toISOString();
  try { await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync(); }
  finally { await output.close(); }
  process.stdout.write(JSON.stringify({ status: report.status, outputPath, phases: report.phases.length, fixtureCleanup: report.fixtureCleanup,
    ...(report.error ? { error: report.error } : {}) }) + '\n');
}
