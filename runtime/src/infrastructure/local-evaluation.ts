import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { composeRuntime } from '../application/compose-runtime.js';
import { ArtifactSchema } from '../application/contracts.js';
import { scoreEvaluation, summarizeEvaluations } from '../application/execution-evaluation.js';
import { replayEvaluation } from '../application/evaluation-replay.js';
import { asJson } from '../application/plan-validator.js';
import type { MessageSink, Planner, StateRepository, Tool } from '../application/ports.js';
import { transact } from '../application/work-transactions.js';
import type { ArtifactRef, WorkState } from '../domain/model.js';
import type { EvaluationEntry, EvaluationObservation, EvaluationPins, EvaluationReplayBundle, EvaluationSample } from '../domain/execution-evaluation.js';
import { AjvSchemas } from './ajv-schemas.js';
import { Sha256Digester, sha256 } from './digest.js';
import { evaluationConfiguration, evaluationStart, evaluationReply, loadEvaluationCases, type EvaluationBackend, type LocalEvaluationCase } from './evaluation-cases.js';
import { FileArtifactStore } from './file-artifacts.js';
import { FileJournalStateRepository } from './file-journal-state.js';
import { FakeClock, FixtureReadTool, ScriptedPlanner, SequenceIds } from './fakes.js';
import { LocalChannel } from './local-channel.js';
import { SqliteStateRepository } from './sqlite-state.js';

const actor = { tenantId: 'synthetic', principalId: 'learner' };
const digester = new Sha256Digester();
const digest = (value: unknown) => digester.digest(asJson(value));
const openRepository = (backend: EvaluationBackend, directory: string): StateRepository => backend === 'sqlite' ?
  new SqliteStateRepository(join(directory, 'state.sqlite')) : new FileJournalStateRepository(join(directory, 'journal'));
type Runtime = Awaited<ReturnType<typeof composeRuntime>>;

export function evaluationArtifactRefs(value: unknown): ArtifactRef[] {
  const found = new Map<string, ArtifactRef>();
  const visit = (item: unknown) => {
    if (item === null || typeof item !== 'object') return;
    const parsed = ArtifactSchema.safeParse(item);
    if (parsed.success) {
      const old = found.get(parsed.data.id);
      if (old && digest(old) !== digest(parsed.data)) throw new Error('evaluation_artifact_identity_conflict');
      found.set(parsed.data.id, parsed.data); return;
    }
    for (const child of Object.values(item)) visit(child);
  };
  visit(value); return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function evaluationCodePin(root: string) {
  const files: { path: string; sha256: string }[] = [];
  async function scan(relative: string) {
    for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await scan(path);
      else if (entry.isFile()) files.push({ path, sha256: sha256(await readFile(join(root, path))) });
      else throw new Error('evaluation_code_link_not_supported');
    }
  }
  for (const directory of ['src', 'scripts', 'fixtures']) await scan(directory);
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.core.json']) files.push({ path, sha256: sha256(await readFile(join(root, path))) });
  return { digest: digest(files), files };
}
export async function evaluationBuildFiles(root: string) {
  const files: { path: string; sha256: string }[] = [];
  async function scan(relative: string) {
    for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${relative}/${entry.name}`;
      if (path === 'dist/build-manifest.json') continue;
      if (entry.isDirectory()) await scan(path);
      else if (entry.isFile()) files.push({ path, sha256: sha256(await readFile(join(root, path))) });
      else throw new Error('evaluation_build_link_not_supported');
    }
  }
  await scan('dist'); return files;
}
export function assertEvaluationOutputs(source: { path: string }[], compiled: { path: string }[]) {
  const expected = new Set(source.filter(file => file.path.startsWith('src/') && file.path.endsWith('.ts')).flatMap(file => {
    const base = `dist/${file.path.slice(4, -3)}`; return [`${base}.js`, `${base}.js.map`, `${base}.d.ts`];
  }));
  if (expected.size !== compiled.length || compiled.some(file => !expected.has(file.path))) throw new Error('evaluation_build_output_mismatch_run_npm_build');
}
export async function verifyEvaluationBuild(root: string) {
  let manifest: { version: number; node: string; sourceDigest: string; files: { path: string; sha256: string }[] };
  try { manifest = JSON.parse(await readFile(join(root, 'dist/build-manifest.json'), 'utf8')); }
  catch { throw new Error('evaluation_build_manifest_missing_run_npm_build'); }
  const source = await evaluationCodePin(root); const files = await evaluationBuildFiles(root);
  assertEvaluationOutputs(source.files, files);
  if (manifest.version !== 1 || manifest.node !== process.version || manifest.sourceDigest !== source.digest || digest(manifest.files) !== digest(files))
    throw new Error('evaluation_build_stale_run_npm_build');
  return { sourceDigest: source.digest, filesDigest: digest(files), fileCount: files.length };
}
export function evaluationPins(input: LocalEvaluationCase, suite: string, code: string): EvaluationPins {
  return { suite, code, fixture: digest(input), caseDefinition: digest(input.specification), configuration: digest(evaluationConfiguration),
    environment: { node: process.version, platform: process.platform, arch: process.arch, inference: 'scripted', externalCallsAllowed: false } };
}

/** Executes only fixed synthetic adapters, recording every committed revision. */
export async function runLocalEvaluation(input: LocalEvaluationCase, directory: string, pins: EvaluationPins) {
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const backend = input.specification.backend as EvaluationBackend;
  if (!['sqlite', 'file-journal'].includes(backend)) throw new Error('evaluation_backend_invalid');
  const clock = new FakeClock(evaluationStart); const ids = new SequenceIds();
  const entries: EvaluationEntry[] = []; const observations: EvaluationObservation[] = [];
  const variant = input.specification.variant; let wallStart = performance.now();
  let stage = 'fresh'; let runtime: Runtime; let repository: StateRepository; let channel: LocalChannel; let workId = '';
  let control = 'yield'; let checkpoint: ArtifactRef | null = null; let runError: string | null = null;
  let firstModel = true; let opens = 0; let startedAt = evaluationStart;
  let releaseCancelledReply: () => void = () => {};
  const cancelledReplyGate = new Promise<void>(resolve => { releaseCancelledReply = resolve; });
  const captured = async (state: WorkState, eventTypes: string[]) => observations.push({ at: clock.now(), stage,
    state: structuredClone(state), eventTypes, deliveries: structuredClone(await repository.deliveries(state.id)) });
  const open = async () => {
    repository = openRepository(backend, directory); channel = new LocalChannel(join(directory, 'channel.sqlite'));
    const state: StateRepository = {
      get: id => repository.get(id), receipt: (id, command) => repository.receipt(id, command),
      async commit(request) {
        const result = await repository.commit(request);
        if (result.kind === 'committed') await captured(result.state, request.events.map(e => e.type));
        return result;
      },
      events: (id, cursor) => repository.events(id, cursor), deliveries: id => repository.deliveries(id),
      eventPage: (...args) => repository.eventPage(...args), recentEventMetadata: (...args) => repository.recentEventMetadata(...args), conversationWorkPage: query => repository.conversationWorkPage(query),
      workIdsForConversation: (...args) => repository.workIdsForConversation(...args), runnable: at => repository.runnable(at), close: () => repository.close(),
    };
    const basePlanner = new ScriptedPlanner([]);
    const planner: Planner = { identity: basePlanner.identity, destination: basePlanner.destination, capabilities: basePlanner.capabilities,
      async propose(packet, _signal, options) {
        entries.push({ kind: 'model', at: clock.now(), id: options?.callId ?? `model-${entries.length}`, sourceKey: null });
        clock.advance(evaluationConfiguration.clock.modelMs);
        if (firstModel && (variant === 'cancel_running' || variant === 'mode_change')) {
          firstModel = false;
          const current = await runtime.runtime.state(workId);
          await runtime.runtime.command(workId, `evaluation-${variant}`, actor, current.goal.revision, variant === 'cancel_running' ?
            { kind: 'cancel', reason: 'Synthetic user cancels an entered model call' } :
            { kind: 'mode', mode: 'deep', reason: 'Synthetic user requests deeper work', expectedControlRevision: current.executionControl!.revision });
          if (variant === 'cancel_running') await cancelledReplyGate;
        }
        if (variant === 'model_errors') return { status: 'error', code: 'fixture_model_error', inputTokens: 100, outputTokens: 0 };
        return evaluationReply(input, packet);
      } };
    const original = new FixtureReadTool(variant === 'source_missing' ? [] : input.scenario.evidence);
    const tool: Tool = { definition: original.definition, async execute(task, context) {
      entries.push({ kind: 'tool', at: clock.now(), id: context.attemptId, sourceKey: digest({ tool: task.toolId, version: task.toolVersion, input: task.input }) });
      clock.advance(evaluationConfiguration.clock.toolMs);
      let requested = structuredClone(task);
      if (variant === 'late_counterevidence' && task.id === 'maintenance-ticket') {
        requested.input = { evidenceIds: ['maintenance-ticket', 'denied-ticket'] }; clock.advance(evaluationConfiguration.clock.lateSourceMs);
      }
      const selected = input.scenario.evidence.filter(e => (requested.input['evidenceIds'] as string[]).includes(e.id));
      const newest = Math.max(clock.now(), ...selected.map(e => Math.max(e.observedAt, e.recordedAt)));
      clock.advance(newest - clock.now());
      if (variant === 'tool_errors') return { resultId: `${context.attemptId}:result`, attemptId: context.attemptId, status: 'error',
        effectState: 'none', evidence: [], artifacts: [], output: null, cursor: null, coverage: 'unknown', error: { code: 'fixture_tool_error', retryable: true } };
      return original.execute(requested, context);
    } };
    const sink: MessageSink = { capabilities: { idempotentSend: true }, async send(delivery) {
      entries.push({ kind: 'send', at: clock.now(), id: delivery.id, sourceKey: null }); clock.advance(evaluationConfiguration.clock.sendMs);
      if (variant === 'unknown_delivery' && delivery.kind === 'result') return { status: 'unknown' };
      return channel.send(delivery);
    }, async lookup(delivery) {
      entries.push({ kind: 'lookup', at: clock.now(), id: delivery.id, sourceKey: null }); clock.advance(evaluationConfiguration.clock.lookupMs);
      if (variant === 'unknown_delivery' && delivery.kind === 'result') return { status: 'unknown' };
      return channel.lookup(delivery);
    } };
    runtime = await composeRuntime({ services: { state, artifacts: new FileArtifactStore(join(directory, 'artifacts')), clock, ids, digester, planner, tools: [tool], sink },
      schemas: new AjvSchemas(), owner: `evaluation-${++opens}`, guidanceSource: { async list() { return []; }, async read() { throw new Error('evaluation_guidance_unavailable'); } } });
  };
  const close = async () => { await runtime.planning?.settlePending(); await repository.close(); channel.close(); };
  const run = async (maxSteps: number = evaluationConfiguration.maxStepsPerRun) => {
    try {
      const result = await runtime.workflow.run(workId, actor, { maxSteps, ...(checkpoint ? { previousPacket: checkpoint } : {}) });
      control = result.control.kind; checkpoint = result.checkpoint;
      if (variant === 'cancel_running') stage = 'cancelled_before_late_reply';
      await captured(await runtime.runtime.state(workId), []); return result;
    } finally {
      if (variant === 'cancel_running') { stage = 'late_model_settlement'; releaseCancelledReply(); }
    }
  };
  const reopen = async () => { await close(); stage = 'resumed'; await open(); await captured(await runtime.runtime.state(workId), []); };
  await open();
  try {
    const accepted = await runtime!.workflow.accept(actor, { messageId: input.specification.id, binding: { ...actor, channel: 'test',
      conversationId: input.specification.id, recipientId: actor.principalId, destination: 'local' },
      goal: input.scenario.goal, policy: input.scenario.policy, limits: { ...evaluationConfiguration.limits }, completionRequiresDelivery: true });
    workId = accepted.workId;
    if (variant === 'status_only') {
      observations.length = 0; entries.length = 0; startedAt = clock.now(); wallStart = performance.now(); stage = 'status_only';
      await captured(await runtime!.runtime.state(workId), []);
      await runtime!.conversation.snapshot(workId, actor);
      await captured(await runtime!.runtime.state(workId), []); control = 'unchanged';
    } else {
      if (variant === 'next_day_reply') {
        await runtime!.runtime.command(workId, 'wait-for-user', actor, 1, { kind: 'wait', obligation: { id: 'user-reply', kind: 'response',
          reason: 'Await the declared synthetic reply', status: 'pending', wakeKey: 'reply', dueAt: evaluationStart + 172800000 } });
        stage = 'awaiting_reply'; await run(); const before = entries.filter(e => e.kind === 'model' || e.kind === 'tool').length;
        await run();
        if (entries.filter(e => e.kind === 'model' || e.kind === 'tool').length !== before) throw new Error('evaluation_wait_invoked');
        clock.advance(86400000); await reopen();
        await runtime!.runtime.command(workId, 'user-replied', actor, 1, { kind: 'resolve', obligationId: 'user-reply', reason: 'Declared synthetic reply received' });
      }
      if (variant === 'stored_model_resume' || variant === 'stored_tool_resume') {
        await run(variant === 'stored_model_resume' ? 2 : 5);
        const before = await runtime!.runtime.state(workId);
        const received = variant === 'stored_model_resume' ? before.modelCalls.some(c => c.status === 'received') : before.attempts.some(a => a.status === 'received');
        if (!received) throw new Error('evaluation_expected_stored_response_missing');
        await reopen();
      }
      if (variant === 'compact' && input.specification.mode !== 'fast') {
        await run(3); stage = 'compact'; const state = await runtime!.runtime.state(workId);
        const prepared = await runtime!.context.prepare(state, { callId: 'explicit-compact', maxInputBytes: 1000000, maxInputTokens: 100000,
          maxOutputTokens: 2048, forceCompact: true });
        await transact(runtime!.services, workId, 'explicit-compact', 'context_compacted', {}, next => {
          if (next.revision !== state.revision) throw new Error('evaluation_compact_stale'); next.contextHead = prepared.head;
        });
        checkpoint = null; await reopen();
      }
      if (variant === 'permission_revoked') {
        await run(4);
        if (!(await runtime!.runtime.state(workId)).attempts.some(a => a.status === 'reserved')) throw new Error('evaluation_reservation_missing');
        stage = 'permission_revoked';
        await transact(runtime!.services, workId, 'revoke-tools', 'policy_changed', {}, next => { next.policy.allowedTools = []; });
        checkpoint = null;
      }
      for (let n = 0; n <= evaluationConfiguration.maxRetryWakes; n++) {
        const result = await run();
        if (result.control.kind !== 'wait') break;
        const current = await runtime!.runtime.state(workId);
        if (current.retryWakeAt === null || current.retryWakeAt === undefined) break;
        if (n === evaluationConfiguration.maxRetryWakes) throw new Error('evaluation_retry_limit');
        stage = 'retry_wake'; clock.advance(Math.max(0, current.retryWakeAt - clock.now()));
      }
      if (variant === 'unknown_delivery') await run();
    }
  } catch (error) { runError = error instanceof Error ? error.message : 'evaluation_failed'; }
  try {
    if (!workId) throw new Error(runError ?? 'evaluation_accept_failed');
    await runtime!.planning?.settlePending();
    // Cancellation can return before a provider's late reply has been stored. Pin the settled revision, not the earlier workflow return.
    if (checkpoint && runError === null) checkpoint = (await runtime!.recovery.restore(workId, actor, checkpoint)).artifact;
    const final = await runtime!.runtime.state(workId); await captured(final, []);
    const sample: EvaluationSample = { case: input.specification, observations, entries, finalControl: control, startedAt, finishedAt: clock.now(),
      wallElapsedMs: performance.now() - wallStart, runError };
    const score = scoreEvaluation(sample); const events = await repository!.events(workId, 0); const deliveries = await repository!.deliveries(workId);
    const receiptStates: WorkState[] = []; const receipts: EvaluationReplayBundle['receipts'] = [];
    for (const commandId of [...new Set(events.map(e => e.commandId))]) {
      const receipt = await repository!.receipt(workId, commandId); if (!receipt) throw new Error('evaluation_receipt_missing');
      receiptStates.push(receipt.state); receipts.push({ commandId, digest: receipt.digest, stateRevision: receipt.state.revision, stateDigest: digest(receipt.state) });
    }
    const bundle: EvaluationReplayBundle = { version: 1, workId, pins, sample, sampleDigest: digest(sample), score, scoreDigest: digest(score),
      finalStateDigest: digest(final), eventsDigest: digest(events), deliveriesDigest: digest(deliveries), receipts,
      artifacts: evaluationArtifactRefs([final, receiptStates, sample, checkpoint]), checkpoint };
    await writeFile(join(directory, 'evaluation.json'), JSON.stringify(bundle, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return bundle;
  } finally { await close(); }
}

export async function replayLocalEvaluation(directory: string, pins: EvaluationPins) {
  const bundle = JSON.parse(await readFile(join(directory, 'evaluation.json'), 'utf8')) as EvaluationReplayBundle;
  if (!['sqlite', 'file-journal'].includes(bundle.sample.case.backend)) throw new Error('evaluation_backend_invalid');
  const state = openRepository(bundle.sample.case.backend as EvaluationBackend, directory); const artifacts = new FileArtifactStore(join(directory, 'artifacts'));
  const counts = { commits: 0, artifactWrites: 0 };
  const forbidden = (key: keyof typeof counts) => { counts[key]++; throw new Error(`evaluation_replay_forbidden:${key}`); };
  const readonlyState: StateRepository = { get: id => state.get(id), receipt: (id, command) => state.receipt(id, command),
    commit: async () => forbidden('commits'), events: (id, sequence) => state.events(id, sequence), deliveries: id => state.deliveries(id),
    eventPage: (...args) => state.eventPage(...args), recentEventMetadata: (...args) => state.recentEventMetadata(...args), conversationWorkPage: query => state.conversationWorkPage(query),
    workIdsForConversation: (...args) => state.workIdsForConversation(...args), runnable: at => state.runnable(at), close: () => state.close() };
  const wallStart = performance.now();
  try {
    const result = await replayEvaluation(bundle, pins, actor, { state: readonlyState, digester,
      artifacts: { get: (ref, policy) => artifacts.get(ref, policy), exists: ref => artifacts.exists(ref), put: async () => forbidden('artifactWrites') } });
    return { ...result, entries: counts, externalExecutionCapabilities: 'not_provided' as const, wallElapsedMs: performance.now() - wallStart };
  } finally { await state.close(); }
}

export async function runEvaluationSuite(root: string, directory: string, select?: (input: LocalEvaluationCase) => boolean,
  onCase?: (id: string, passed: boolean) => void) {
  const build = await verifyEvaluationBuild(root);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const all = await loadEvaluationCases(root); const cases = select ? all.filter(select) : all;
  if (!cases.length) throw new Error('evaluation_selection_empty');
  const code = await evaluationCodePin(root); const suite = digest({ configuration: evaluationConfiguration, cases: all });
  if (code.digest !== build.sourceDigest) throw new Error('evaluation_build_changed_before_run');
  const manifest = { version: 1, kind: 'local_synthetic_execution', suite, code, build, configuration: evaluationConfiguration,
    selectedCases: cases.map(c => c.specification.id), fullCaseCount: all.length, actualModelTest: 'not_run' };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const samples: EvaluationSample[] = []; const replays: { caseId: string; result: Awaited<ReturnType<typeof replayLocalEvaluation>> }[] = [];
  for (const input of cases) {
    const pins = evaluationPins(input, suite, code.digest); const path = join(directory, input.specification.id);
    const bundle = await runLocalEvaluation(input, path, pins); samples.push(bundle.sample);
    const result = await replayLocalEvaluation(path, pins); replays.push({ caseId: input.specification.id, result });
    onCase?.(input.specification.id, bundle.score.contractPassed && result.available);
  }
  const unchanged = (await evaluationCodePin(root)).digest === code.digest && digest(await evaluationBuildFiles(root)) === build.filesDigest;
  const summary = summarizeEvaluations(samples); const passed = unchanged && samples.every(s => scoreEvaluation(s).contractPassed) && replays.every(r => r.result.available);
  const byMode = ['auto', 'fast', 'deep'].map(mode => ({ mode, metrics: summarizeEvaluations(samples.filter(sample => sample.case.mode === mode)).overall }));
  const byVariant = [...new Set(samples.map(sample => sample.case.variant))].map(variant => ({ variant,
    metrics: summarizeEvaluations(samples.filter(sample => sample.case.variant === variant)).overall }));
  const report = { manifest: 'manifest.json', passed, codeUnchanged: unchanged, summary, byMode, byVariant, replays,
    caveat: 'Scripted synthetic workflow timings; no actual LLM, MCP, SIEM, EDR, Knox or computer-use calls. Replay checks saved receipt snapshots, not an event-only reducer.' };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return report;
}
