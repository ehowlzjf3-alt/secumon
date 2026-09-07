import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, open, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

// One public personal-memory read on an existing verified build; no build, test runner or endpoint.
if (process.argv.length > 3) throw new Error('usage: node C05-source-read-probe.mjs [OUTPUT_JSON]');
assert.equal(process.versions.node.split('.')[0], '24');
const runtimeRoot = fileURLToPath(new URL('../', import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
const outputPath = resolve(process.argv[2] ?? join(runtimeRoot, 'evidence/C05-source-read-baseline1.json'));
assert.equal(resolve(outputPath, '..'), join(runtimeRoot, 'evidence'), 'output must be a new evidence file');
const output = await open(outputPath, 'wx', 0o600);
const hash = value => createHash('sha256').update(value).digest('hex');
const jsonBytes = value => value === undefined ? 0 : value instanceof Uint8Array ? value.byteLength : Buffer.byteLength(JSON.stringify(value), 'utf8');
const errorInfo = error => ({ name: error?.name ?? 'Error', message: error?.message ?? String(error),
  ...(error?.code ? { code: error.code } : {}), ...(error?.cause ? { cause: errorInfo(error.cause) } : {}) });
const load = name => import(pathToFileURL(join(runtimeRoot, 'dist', name)).href);
const originalText = '개인 기억 계측용 원문: 응답은 한국어로 작성하고 세 문장 요약으로 시작한다.';
const report = {
  schemaVersion: 1, kind: 'C05-personal-memory-source-read-forwarding-baseline', status: 'running',
  startedAt: new Date().toISOString(), scriptSha256: hash(await readFile(scriptPath)),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  storage: { profile: 'C01-owned', state: 'sqlite', memory: 'sqlite', transcript: 'sqlite', artifacts: 'files' },
  repeats: 1, measuredPublicOperation: 'KnowledgeService.get', setupInstrumented: false,
  actualModelInvoked: false, externalApiInvoked: false, existingUserDataRead: false,
  phases: [], sourceValidationSpans: [], instrumentationErrors: [],
  conditions: [
    'Reuses C03-personal-measure.mjs C01 setup, session-flow-helpers and the same 105-byte synthetic original. This is a narrower current-build observation, not a rerun of its multi-stage experiment.',
    'One newly registered private agent, one session, one remembered user original, one personal service instance, one measured get. Setup/remember and observer assertions are excluded from the measured phase.',
    'Async wrappers forward the original receiver, arguments, returned value and thrown error. AsyncLocalStorage and immediate stack classification observe calls; they add overhead and do not introduce storage reads.',
    'Source spans correspond to actual SessionKnowledgeSources.current calls. Caller classification distinguishes #inspect reads from SessionOriginals.read reads; ordered calls also expose the final rechecks.',
    'Returned UTF-8 JSON bytes are logical port response sizes. Nested response bytes overlap. They are not SQL statements, physical disk I/O, distinct stored bytes or network traffic.',
    'No cache control, throughput/latency benchmark, optimization comparison, tokenizer or model-quality evaluation. Single elapsed observations include forwarding/stack overhead.',
    'Only the existing synthetic local stores are used. Final source/receipt/policy validation is neither omitted nor replaced by observer assertions.',
  ],
  fixture: { originalTextUtf8Bytes: Buffer.byteLength(originalText, 'utf8'), originalSha256: hash(originalText) },
};
const sourceSpan = new AsyncLocalStorage();
const restores = [];
const methods = [];
let stores, fixtureDirectory, phase, evaluation;
const started = performance.now();
function metric(map, key) { return map[key] ??= { calls: 0, failures: 0, nullReturns: 0, returnedJsonBytes: 0 }; }
function observe(target, method, group) {
  const own = Object.getOwnPropertyDescriptor(target, method), implementation = target[method], key = `${group}.${method}`;
  assert.equal(typeof implementation, 'function', key);
  methods.push(key);
  target[method] = async function (...args) {
    const currentPhase = phase, span = sourceSpan.getStore();
    if (!currentPhase) return implementation.apply(this, args);
    const stack = new Error().stack ?? '';
    const caller = stack.includes('/application/session-originals.js:') ? 'SessionOriginals.read'
      : stack.includes('/application/session-knowledge-sources.js:') ? 'SessionKnowledgeSources.#inspect' : 'other';
    const event = { key, caller, sourceSpan: span?.id ?? null, status: 'running' };
    const counters = [metric(currentPhase.ports, key), ...(span ? [metric(span.ports, key)] : [])];
    for (const counter of counters) counter.calls++;
    currentPhase.events.push(event);
    try {
      const result = await implementation.apply(this, args);
      try {
        event.status = 'returned'; event.returnedJsonBytes = jsonBytes(result);
        for (const counter of counters) { counter.returnedJsonBytes += event.returnedJsonBytes; if (result === null) counter.nullReturns++; }
        if (key === 'session.history') event.history = { entries: result.entries.length,
          textUtf8Bytes: result.entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.text, 'utf8'), 0),
          afterSequence: args[2].afterSequence ?? 0, throughSequence: args[2].throughSequence ?? null,
          limit: args[2].limit, hasNextCursor: result.nextCursor !== null };
      } catch (error) { report.instrumentationErrors.push(errorInfo(error)); }
      return result;
    } catch (error) {
      event.status = 'threw'; for (const counter of counters) counter.failures++;
      try { event.error = errorInfo(error); } catch { report.instrumentationErrors.push({ message: 'error_description_failed' }); }
      throw error;
    }
  };
  restores.push(() => own ? Object.defineProperty(target, method, own) : delete target[method]);
}
function observeSourceCurrent(prototype) {
  const own = Object.getOwnPropertyDescriptor(prototype, 'current'), implementation = prototype.current;
  prototype.current = async function (...args) {
    if (!phase) return implementation.apply(this, args);
    const span = { id: report.sourceValidationSpans.length + 1, phase: phase.name, ports: {}, status: 'running' };
    report.sourceValidationSpans.push(span);
    const start = performance.now();
    return sourceSpan.run(span, async () => {
      try { const result = await implementation.apply(this, args); span.status = 'returned'; span.returnedJsonBytes = jsonBytes(result); return result; }
      catch (error) { span.status = 'threw'; throw error; }
      finally { span.elapsedMs = performance.now() - start; }
    });
  };
  restores.push(() => Object.defineProperty(prototype, 'current', own));
}
async function runPhase(name, category, action) {
  assert.equal(phase, undefined);
  const row = { name, category, ports: Object.fromEntries(methods.map(key => [key, metric({}, key)])), events: [], status: 'running' };
  report.phases.push(row); phase = row; const start = performance.now();
  try { const result = await action(row); row.status = 'passed'; return result; }
  catch (error) { row.status = 'failed'; row.error = errorInfo(error); throw error; }
  finally { row.elapsedMs = performance.now() - start; phase = undefined; }
}
try {
  evaluation = await load('infrastructure/local-evaluation.js');
  report.buildBefore = await evaluation.verifyEvaluationBuild(runtimeRoot);
  const pinPath = join(runtimeRoot, 'evidence/C05-host-local-build2-pin.json');
  report.expectedPinFile = { path: 'evidence/C05-host-local-build2-pin.json', sha256: hash(await readFile(pinPath)) };
  assert.deepEqual(report.buildBefore, JSON.parse(await readFile(pinPath, 'utf8')));
  const helpers = await load('tests/session-flow-helpers.js');
  const { FileAgentProfileStore } = await load('infrastructure/file-agent-profile.js');
  const { openAgentStores } = await load('infrastructure/agent-stores.js');
  const { composeRuntime } = await load('application/compose-runtime.js');
  const { FixtureReadTool, ScriptedPlanner } = await load('infrastructure/fakes.js');
  const { RandomIds, Sha256Digester } = await load('infrastructure/digest.js');
  const { AjvSchemas } = await load('infrastructure/ajv-schemas.js');
  const { SessionKnowledgeSources } = await load('application/session-knowledge-sources.js');
  fixtureDirectory = await realpath(await mkdtemp(join(tmpdir(), 'secumon-c05-source-read-')));
  await chmod(fixtureDirectory, 0o700); await mkdir(join(fixtureDirectory, 'engine'), { mode: 0o700 });
  helpers.initialize(fixtureDirectory, 'sqlite');
  stores = await openAgentStores(new FileAgentProfileStore(join(fixtureDirectory, 'engine')), join(fixtureDirectory, 'agent'));
  assert.equal(stores.profile.config.storage.state, 'sqlite'); assert.equal(stores.profile.config.storage.memory, 'sqlite');
  const planner = new ScriptedPlanner([]), tool = new FixtureReadTool(helpers.scenario.evidence);
  const trusted = { ...helpers.actor, agentId: stores.profile.identity.agentId, allowedLabels: helpers.scenario.policy.allowedLabels,
    allowedDestinations: ['local'], allowedScopes: [helpers.scenario.goal.scope], allowedNamespaces: ['personal'], canReview: false, canPublish: false };
  const composed = await composeRuntime({ services: { state: stores.state, artifacts: stores.artifacts, sink: stores.channel, tools: [tool], planner,
    ids: new RandomIds(), digester: new Sha256Digester(), clock: { now: () => Date.now() } },
    schemas: new AjvSchemas(), guidanceSource: { list: async () => [], read: async () => { throw new Error('no_guidance'); } },
    session: { repository: stores.sessions, agentId: stores.profile.identity.agentId },
    knowledge: { repository: stores.knowledge, actors: { current: async () => structuredClone(trusted) } },
    owner: 'c05-source-read-observation', enablePlanning: false });
  assert.equal(composed.planning, null); assert(composed.sessions && composed.personalKnowledge);
  const session = await composed.sessions.open(helpers.actor, { channel: 'test', conversationId: 'conversation', newSession: true });
  const accepted = await composed.sessions.accept(helpers.actor, { sessionId: session.scope.sessionId, rawText: originalText, request: helpers.request('personal-source') });
  const memory = await composed.personalKnowledge(helpers.actor);
  const saved = await memory.remember({ id: 'response-format', commandId: 'remember-format', title: '응답 형식',
    source: { sessionId: session.scope.sessionId, messageId: 'personal-source', quote: originalText }, expiresAt: null });
  assert.equal(saved.card.body, originalText); assert.equal(saved.card.revision, 1);
  report.fixture = { ...report.fixture, scenarioId: helpers.scenario.id, agentId: stores.profile.identity.agentId,
    sessionId: session.scope.sessionId, workId: accepted.workId, personalMemoryId: saved.card.id };
  for (const method of ['get', 'receipt', 'events', 'recentEventMetadata']) observe(stores.state, method, 'state');
  for (const method of ['get', 'receipt', 'indexHead', 'candidates']) observe(stores.knowledge, method, 'knowledge');
  for (const method of ['get', 'input', 'pending', 'history', 'head', 'summaryHead', 'summary', 'summaryBefore', 'publication']) observe(stores.sessions, method, 'session');
  for (const method of ['get', 'exists']) observe(stores.artifacts, method, 'artifact');
  observeSourceCurrent(SessionKnowledgeSources.prototype);
  await runPhase('one_personal_memory_get', 'measured_service_operation', async row => {
    const result = await memory.get(saved.card.id);
    assert.equal(result.card.body, originalText); assert.equal(result.card.revision, saved.card.revision);
    assert.deepEqual(result.card.owner, saved.card.owner);
    row.result = { publicGetCalls: 1, returnedJsonBytes: jsonBytes(result), bodyUtf8Bytes: Buffer.byteLength(result.card.body, 'utf8'),
      bodySha256: hash(result.card.body), revision: result.card.revision, ownerMatches: true, dependencyJsonBytes: jsonBytes(result.dependency) };
  });
  assert(report.sourceValidationSpans.length > 0, 'real user-source validation must run');
  assert(report.phases[0].events.some(event => event.caller === 'SessionOriginals.read'));
  assert(report.phases[0].events.some(event => event.caller === 'SessionKnowledgeSources.#inspect'));
  await runPhase('observer_assertions_excluded', 'extra_observer_reads_not_in_baseline', async row => {
    const state = await stores.state.get(accepted.workId);
    const receipt = await stores.sessions.input(session.scope, 'personal-source');
    const history = await stores.sessions.history(session.scope, state.policy, { limit: 50 });
    assert.equal(receipt.status, 'applied'); assert.equal(receipt.text, originalText);
    assert.deepEqual(history.entries.filter(entry => entry.role === 'user').map(entry => entry.text), [originalText]);
    assert.deepEqual(state.modelCalls, []); assert.deepEqual(state.attempts, []);
    assert.equal(state.budget.used.modelCalls, 0); assert.equal(state.budget.used.tokens, 0); assert.equal(state.budget.used.toolCalls, 0);
    assert.equal(planner.inputs.length, 0); assert.equal(tool.invocations.length, 0);
    row.result = { originalAndReceiptPreserved: true, modelCalls: 0, toolInvocations: 0, usedModelCalls: 0, usedTokens: 0, usedToolCalls: 0 };
  });
  assert.deepEqual(report.instrumentationErrors, []);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = errorInfo(error); process.exitCode = 1; }
finally {
  for (const restore of restores.reverse()) restore();
  try { if (stores) await stores.close(); report.storeCleanup = stores ? 'closed' : 'not_opened'; }
  catch (error) { report.status = 'failed'; report.closeError = errorInfo(error); process.exitCode = 1; }
  try {
    if (fixtureDirectory) {
      await rm(fixtureDirectory, { recursive: true, force: true });
      await assert.rejects(stat(fixtureDirectory), error => error?.code === 'ENOENT'); report.fixtureCleanup = 'removed_and_absence_checked';
    } else report.fixtureCleanup = 'not_created';
  } catch (error) { report.status = 'failed'; report.cleanupError = errorInfo(error); process.exitCode = 1; }
  try {
    assert(evaluation); report.buildAfter = await evaluation.verifyEvaluationBuild(runtimeRoot);
    assert.deepEqual(report.buildAfter, report.buildBefore);
    assert.equal(hash(await readFile(scriptPath)), report.scriptSha256); report.sourceBuildUnchanged = true;
  } catch (error) { report.status = 'failed'; report.pinError = errorInfo(error); process.exitCode = 1; }
  report.elapsedMs = performance.now() - started; report.finishedAt = new Date().toISOString();
  try { await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync(); } finally { await output.close(); }
  process.stdout.write(JSON.stringify({ status: report.status, outputPath, sourceValidationSpans: report.sourceValidationSpans.length,
    measuredPorts: report.phases[0]?.ports, fixtureCleanup: report.fixtureCleanup, sourceBuildUnchanged: report.sourceBuildUnchanged,
    ...(report.error ? { error: report.error } : {}) }) + '\n');
}
