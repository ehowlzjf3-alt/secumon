import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openAgentLocalProfile, openLocalProfile, localHistoryPolicy, localCompactProvider, runtimeRoot } from './local-profile.js';
import { localCompactStatus, requestLocalCompact } from './local-compact.js';
import { forgetPersonal, getPersonal, recallPersonal, rememberPersonal, revisePersonal, searchPersonal, type PersonalRememberInput } from './local-personal-memory.js';
import { createMemoryDraft, applyMemoryDraft, resumeMemoryDraft, memoryDraftStatus } from './local-memory-drafts.js';
import { conversationView } from './conversation-view.js';
import { formatWorkView } from './work-view-format.js';
import { ArtifactSchema, GoalSchema, PlanProposalSchema, parseContract } from '../application/contracts.js';
import { RESOURCE_TOOL_IDS } from '../application/resource-tools.js';
import { KNOWLEDGE_TOOL_IDS } from '../application/knowledge-tools.js';
import type { Mode, TaskSpec } from '../domain/model.js';
import type { WorkViewLevel } from '../domain/work-view.js';
import type { UserCommand } from '../application/execution-runtime.js';
import type { AgentStoreHostOptions } from '../infrastructure/agent-stores.js';

const help = `범용 런타임 CLI · 합성 자료/로컬 채널 profile
사용법: cli <명령> [work-id] [옵션]
  accept                 요청을 저장하고 접수 안내
  demo                   단순 합성 예제를 접수부터 결과까지 실행
  demo-plan <work-id>     단순 합성 예제의 명시 계획 제출
  plan <work-id> --file <plan.json>
  run <work-id>          저장된 계획을 실행 가능한 범위까지 진행
  status <work-id>       현재 상태·준비·전달 확인
  work-view <work-id>    공개 업무 화면; 조회만 수행
  pause|resume|cancel <work-id> [--goal-revision N] [--reason 설명]
  mode <work-id> --mode auto|fast|deep --control-revision N --goal-revision N --reason 설명
  change-goal <work-id> --file <goal.json> --goal-revision N --control-revision N
  resolve <work-id> --obligation ID --reason 설명 --goal-revision N
  attach <work-id> --conversation ID
  disconnect <work-id>   연결 종료 안내; 업무 취소/변경 없음
  list                  이 대화에 연결된 업무
  messages              로컬 채널에 전달된 접수·질문·결과
  session               담당의 지속 대화 열기 또는 다시 연결
  history               지속 대화의 실제 입력·응답 이력 조회
  input <work-id>        --text 원문 --goal-revision N 으로 현재 업무에 추가 입력
  compact <work-id>      --goal-revision N [--request-id ID]로 대화 문맥만 정리
  context-status <work-id>  문맥 정리 상태·요약 참조 조회; 모델 호출 없음
  memory-remember        --memory-id ID --title 제목 --source-session ID --source-message ID --quote '실제 발언'
  memory-search          --query 검색어 (최대 5개; 이번 업무에 자동 적용하지 않음)
  memory-get             --memory-id ID
  memory-recall <work-id> --memory-id ID --memory-revision N --goal-revision N --state-revision N
  memory-clear <work-id>  --goal-revision N --state-revision N (이번 업무 선택만 해제)
  memory-selected <work-id>  이번 업무에 선택된 기억 참조 조회
  memory-revise          --memory-id ID --memory-revision N --title 제목 --reason 이유 + 출처 옵션
  memory-forget          --memory-id ID --memory-revision N --reason 이유 (원문 이력은 유지)
  memory-draft-create    --memory-id ID --draft-id UUID (편집할 문서 경로 출력)
  memory-draft-apply <work-id> --draft-id UUID --apply-id UUID --goal-revision N --reason 이유 --session ID
  memory-draft-resume    --apply-id UUID --session ID (고정된 편집 내용으로 재개)
  memory-draft-status    --apply-id UUID --session ID (원문·기억 반영 상태만 확인)
  events <work-id>       명시 진단 조회; 사건 종류/번호만 표시
  checkpoint <work-id>   현재 상태에서 재개 패킷을 저장하고 참조 표시
공통: --data-dir 경로 --conversation ID --json --state-backend sqlite|file-journal
담당 실행: --directory 담당경로 [--session ID | --new-session]
담당 접수: accept|demo --text '실제 요청 원문' [--request-id ID]
담당 이력: history [--session ID] [--cursor 값] [--limit 50]
기억 변경·회상: --request-id ID 필수. 정정/기억의 새 발언은 <work-id> --text 원문 --source-message ID --goal-revision N.
기존 발언 출처는 완료된 다른 세션에서도 선택할 수 있습니다. 새 입력은 현재 진행 중인 업무에서만 받습니다.
합성 요약 시험: --compact-provider synthetic (자유 문장 의미 분석 아님)
합성 work/input은 '[합성 예제]'로 시작해야 합니다. 고정 규칙: 외부 전송 금지 · 원문 보존 · 검증 후 완료.
문맥 정리는 원문 이력을 삭제하지 않습니다. provider 미설정이면 요약을 생성하지 않습니다.
담당 저장소는 C01 설정을 사용합니다. --data-dir/--state-backend와 함께 지정하지 않습니다.
저장소는 profile에 기록됩니다. 같은 폴더를 다른 저장소로 바꾸지 않습니다.
접수: --scenario documents-simple|observations-simple --request-id ID [--mode auto|fast|deep]
모드 변경: 두 revision과 이유를 명시합니다. --request-id ID로 같은 명령을 다시 확인할 수 있습니다.
실행: --steps N --resume-file checkpoint.json   완료에서 전달 확인 제외: --analysis-only
공개 화면: --level conversation|details|diagnostics [--cursor 값] [--json]
공개 화면은 등록된 대화에서 조회합니다. details/diagnostics는 명시 선택합니다.
모델 API를 호출하지 않습니다. 프로세스가 없을 때 자동 실행하는 상주 worker는 없습니다.
`;
const actor = { tenantId: 'synthetic', principalId: 'learner' };
function clean(value: string) { return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''); }
function statusLine(snapshot: { status: string; analysisReady: boolean; resultReady: boolean; resultDelivery: string; activeAttempts: number; unresolvedEffects: number; unresolvedDeliveries: number;
  execution: { requestedMode: Mode; strategy: string; pending: { mode: Mode } | null }; budget?: { retryWakeAt: number | null } }) {
  const words: Record<string, string> = { ready: '실행 대기', running: '자료 확인 중', waiting: '응답/전달 대기', paused: '일시 정지', blocked: '진행 제한', cancelled: '취소 반영', failed: '실패', completed: '완료' };
  const pending = snapshot.execution.pending ? ` · 모드 변경 대기 ${snapshot.execution.pending.mode}` : '';
  const wake = snapshot.budget?.retryWakeAt;
  const waiting = snapshot.status === 'waiting' && wake != null && Number.isFinite(new Date(wake).getTime()) ? ` · 다시 확인할 시각 ${new Date(wake).toISOString()}` : '';
  return `${words[snapshot.status] ?? snapshot.status}${waiting} · 모드 ${snapshot.execution.requestedMode} · 전략 ${snapshot.execution.strategy}${pending} · 결과 ${snapshot.resultReady ? '준비됨' : '미준비'} · 전달 ${snapshot.resultDelivery} · 실행 중 ${snapshot.activeAttempts} · 미확정 효과 ${snapshot.unresolvedEffects} · 전달 확인 대기 ${snapshot.unresolvedDeliveries}`;
}
function executionMode(value: string): Mode { if (value !== 'auto' && value !== 'fast' && value !== 'deep') throw new Error('invalid_execution_mode'); return value; }
function explicitRevision(value: string | undefined, kind: 'goal' | 'control' | 'state' | 'memory') {
  if (value === undefined) throw new Error(`${kind}_revision_required`);
  const revision = Number(value); if (!Number.isSafeInteger(revision) || revision < 1) throw new Error(`invalid_${kind}_revision`); return revision;
}
async function jsonFile(path: string | undefined) {
  if (!path) throw new Error('file_option_required'); const bytes = await readFile(path); if (bytes.byteLength > 1048576) throw new Error('input_file_too_large'); return JSON.parse(bytes.toString('utf8')) as unknown;
}
/** Trusted host options apply only to the C01 agent stores; the normal bin keeps its default registry. */
export async function runLocalCli(args = process.argv.slice(2), defaultAgentDirectory?: string, hostOptions: AgentStoreHostOptions = {}) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    'data-dir': { type: 'string' }, directory: { type: 'string' }, 'state-backend': { type: 'string' }, conversation: { type: 'string', default: 'terminal' }, json: { type: 'boolean', default: false },
    session: { type: 'string' }, 'new-session': { type: 'boolean', default: false }, text: { type: 'string' }, limit: { type: 'string', default: '50' }, 'compact-provider': { type: 'string' },
    scenario: { type: 'string', default: 'documents-simple' }, 'request-id': { type: 'string' }, 'goal-revision': { type: 'string' }, 'control-revision': { type: 'string' },
    'memory-id': { type: 'string' }, 'memory-revision': { type: 'string' }, 'state-revision': { type: 'string' }, 'source-session': { type: 'string' },
    'source-message': { type: 'string' }, quote: { type: 'string' }, title: { type: 'string' }, query: { type: 'string' },
    'draft-id': { type: 'string' }, 'apply-id': { type: 'string' },
    mode: { type: 'string' }, reason: { type: 'string' }, level: { type: 'string' }, cursor: { type: 'string' },
    file: { type: 'string' }, 'resume-file': { type: 'string' }, obligation: { type: 'string' }, steps: { type: 'string', default: '40' }, 'analysis-only': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  } });
  const command = positionals[0] ?? 'help'; if (values.help || command === 'help') { process.stdout.write(help); return; }
  const draftCommands = ['memory-draft-create', 'memory-draft-apply', 'memory-draft-resume', 'memory-draft-status'];
  const memoryCommands = ['memory-remember', 'memory-search', 'memory-get', 'memory-recall', 'memory-clear', 'memory-selected', 'memory-revise', 'memory-forget', ...draftCommands];
  const allowed = ['accept', 'demo', 'demo-plan', 'plan', 'run', 'status', 'work-view', 'pause', 'resume', 'cancel', 'mode', 'change-goal', 'resolve', 'attach', 'disconnect', 'list', 'messages', 'events', 'checkpoint', 'session', 'history', 'input', 'compact', 'context-status', ...memoryCommands];
  if (!allowed.includes(command) || positionals.length > 2) throw new Error('unknown_command');
  if ((values['draft-id'] !== undefined || values['apply-id'] !== undefined) && !draftCommands.includes(command)) throw new Error('draft_option_not_supported');
  if (draftCommands.includes(command) && command !== 'memory-draft-apply' && positionals.length > 1) throw new Error('draft_option_not_supported');
  if (['memory-draft-apply', 'memory-draft-resume', 'memory-draft-status'].includes(command) && !values.session) throw new Error('session_id_required');
  if (values.level !== undefined && command !== 'work-view' || values.cursor !== undefined && !['work-view', 'history'].includes(command)) throw new Error('view_option_not_supported');
  const viewLevel = values.level ?? 'conversation';
  if (!['conversation', 'details', 'diagnostics'].includes(viewLevel)) throw new Error('invalid_view_level');
  if (values.cursor !== undefined && values.cursor.length > 256) throw new Error('invalid_view_cursor');
  if (values.mode !== undefined && !['accept', 'demo', 'mode'].includes(command)) throw new Error('mode_option_not_supported');
  if (values['control-revision'] !== undefined && !['mode', 'change-goal'].includes(command)) throw new Error('control_revision_option_not_supported');
  const requestedMode = values.mode === undefined ? undefined : executionMode(values.mode);
  let modeChange: { mode: Mode; goalRevision: number; controlRevision: number; reason: string } | undefined;
  if (command === 'mode') {
    if (!requestedMode) throw new Error('mode_required');
    const goalRevision = explicitRevision(values['goal-revision'], 'goal'); const controlRevision = explicitRevision(values['control-revision'], 'control');
    if (!values.reason?.trim()) throw new Error('mode_reason_required');
    modeChange = { mode: requestedMode, goalRevision, controlRevision, reason: values.reason };
  }
  const goalChange = command === 'change-goal' ? { goalRevision: explicitRevision(values['goal-revision'], 'goal'), controlRevision: explicitRevision(values['control-revision'], 'control') } : undefined;
  const agentDirectory = values.directory ?? defaultAgentDirectory;
  if (memoryCommands.includes(command) && agentDirectory === undefined) throw new Error('agent_directory_required');
  const compactProvider = localCompactProvider(values['compact-provider']);
  if (agentDirectory !== undefined && (values['data-dir'] !== undefined || values['state-backend'] !== undefined)) throw new Error('agent_storage_option_conflict');
  if (agentDirectory === undefined && (compactProvider !== undefined || values.session !== undefined || values['new-session'] || values.text !== undefined || ['session', 'history', 'input', 'compact', 'context-status'].includes(command))) throw new Error('agent_directory_required');
  if (values['new-session'] && (values.session !== undefined || !['session', 'accept', 'demo'].includes(command))) throw new Error('session_option_not_supported');
  if (agentDirectory !== undefined && ['accept', 'demo', 'input'].includes(command) && !values.text?.trim()) throw new Error('session_text_required');
  if (values.text !== undefined && !['accept', 'demo', 'input', 'mode', 'change-goal', 'resolve', 'pause', 'resume', 'cancel', 'memory-remember', 'memory-revise'].includes(command)) throw new Error('session_option_not_supported');
  const profile = agentDirectory === undefined ? await openLocalProfile(values['data-dir'] ?? join(runtimeRoot, '.data', 'cli'), values['state-backend']) : await openAgentLocalProfile(agentDirectory, compactProvider ? { compactProvider } : {}, undefined, hostOptions);
  const isTTY = Boolean(process.stdout.isTTY && !values.json);
  let statusVisible = false;
  const transient = async (id: string) => { if (isTTY) { const snapshot = await profile.conversation.snapshot(id, actor); process.stdout.write(`\r\u001b[2K${clean(statusLine(snapshot))}`); statusVisible = true; } };
  const clear = () => { if (statusVisible) { process.stdout.write('\r\u001b[2K'); statusVisible = false; } };
  async function withCompactProgress<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (!isTTY || !profile.sessions) return action();
    let reading: Promise<void> | null = null;
    const timer = setInterval(() => {
      if (reading) return;
      reading = localCompactStatus(profile, actor, id).then(status => {
        if (!['queued', 'running', 'validating', 'failed', 'unknown'].includes(status.stage)) return;
        process.stdout.write(`\r\u001b[2K문맥 정리: ${status.stage} · 원문 이력 유지`); statusVisible = true;
      }).catch(() => {}).finally(() => { reading = null; });
    }, 500);
    try { return await action(); } finally { clearInterval(timer); await reading; clear(); }
  }
  const interrupt = () => { clear(); process.stderr.write('연결을 종료합니다. 업무를 취소하지 않았습니다. 저장된 업무 ID로 상태를 확인하세요.\n'); process.exit(130); };
  process.once('SIGINT', interrupt);
  try {
    let workId = positionals[1]; const conversationId = values.conversation;
    const session = profile.sessions && command !== 'memory-draft-create' ? await profile.sessions.open(actor, {
      channel: 'cli', conversationId, ...(values.session === undefined ? {} : { sessionId: values.session }), ...(values['new-session'] ? { newSession: true } : {}),
    }) : null;
    async function assertSessionWork(id: string) {
      if (!session) return;
      const state = await profile.runtime.state(id);
      const scope = state.conversation?.session?.scope;
      if (!scope || scope.agentId !== session.scope.agentId || scope.tenantId !== session.scope.tenantId || scope.principalId !== session.scope.principalId || scope.sessionId !== session.scope.sessionId) throw new Error('session_work_unavailable');
    }
    if (session && command === 'attach') throw new Error('session_attach_unsupported');
    if (workId) await assertSessionWork(workId);
    if (memoryCommands.includes(command)) {
      const required = (value: string | undefined, name: string) => { if (!value?.trim()) throw new Error(`${name}_required`); return value; };
      const requestId = () => required(values['request-id'], 'request_id');
      const memoryId = () => required(values['memory-id'], 'memory_id');
      if (command === 'memory-draft-create') {
        const result = await createMemoryDraft(profile, actor, { draftId: required(values['draft-id'], 'draft_id'), memoryId: memoryId() });
        process.stdout.write(JSON.stringify(result, null, values.json ? undefined : 2) + '\n'); return;
      }
      if (!session) throw new Error('personal_memory_unavailable');
      if (draftCommands.includes(command)) {
        const result = command === 'memory-draft-apply' ? await applyMemoryDraft(profile, actor, { draftId: required(values['draft-id'], 'draft_id'), applyId: required(values['apply-id'], 'apply_id'),
            workId: required(workId, 'work_id'), sessionId: session.scope.sessionId, expectedGoalRevision: explicitRevision(values['goal-revision'], 'goal'), reason: required(values.reason, 'reason') }) :
            command === 'memory-draft-resume' ? await resumeMemoryDraft(profile, actor, { applyId: required(values['apply-id'], 'apply_id'), sessionId: session.scope.sessionId }) :
              await memoryDraftStatus(profile, actor, { applyId: required(values['apply-id'], 'apply_id'), sessionId: session.scope.sessionId });
        process.stdout.write(JSON.stringify(result, null, values.json ? undefined : 2) + '\n'); return;
      }
      function source(): PersonalRememberInput['source'] {
        const messageId = required(values['source-message'], 'source_message');
        if (values.text !== undefined) {
          if (values.quote !== undefined || values['source-session'] !== undefined) throw new Error('memory_source_option_conflict');
          return { kind: 'new_input', workId: required(workId, 'work_id'), messageId, rawText: values.text, expectedGoalRevision: explicitRevision(values['goal-revision'], 'goal') };
        }
        return { kind: 'existing', sessionId: required(values['source-session'], 'source_session'), messageId, quote: required(values.quote, 'quote') };
      }
      let result: unknown;
      if (command === 'memory-search') result = await searchPersonal(profile, actor, values.query ?? '');
      else if (command === 'memory-get') result = await getPersonal(profile, actor, memoryId());
      else if (command === 'memory-remember') result = await rememberPersonal(profile, actor, { requestId: requestId(), id: memoryId(), title: required(values.title, 'title'), source: source() });
      else if (command === 'memory-revise') result = await revisePersonal(profile, actor, { requestId: requestId(), id: memoryId(), title: required(values.title, 'title'), source: source(), expectedRevision: explicitRevision(values['memory-revision'], 'memory'), reason: required(values.reason, 'reason') });
      else if (command === 'memory-forget') result = await forgetPersonal(profile, actor, { requestId: requestId(), id: memoryId(), expectedRevision: explicitRevision(values['memory-revision'], 'memory'), reason: required(values.reason, 'reason') });
      else {
        const id = required(workId, 'work_id');
        if (command === 'memory-selected') {
          await profile.personalKnowledge(actor); if (!profile.personalMemories) throw new Error('personal_memory_unavailable');
          result = await profile.personalMemories.selected(id, actor);
        } else result = await recallPersonal(profile, actor, id, { requestId: requestId(), expectedGoalRevision: explicitRevision(values['goal-revision'], 'goal'), expectedStateRevision: explicitRevision(values['state-revision'], 'state'),
          refs: command === 'memory-clear' ? [] : [{ id: memoryId(), revision: explicitRevision(values['memory-revision'], 'memory') }] });
      }
      process.stdout.write(JSON.stringify(result, null, values.json ? undefined : 2) + '\n'); return;
    }
    if (command === 'compact' || command === 'context-status') {
      if (!workId || !session) throw new Error('work_id_required');
      if (isTTY && command === 'compact') { process.stdout.write('대화 문맥 정리 중… 원문 이력은 유지합니다.\n'); }
      const result = command === 'compact' ? await withCompactProgress(workId, () => requestLocalCompact(profile, actor, workId!, {
        requestId: values['request-id'] ?? profile.services.ids.next('compact-request'), expectedGoalRevision: explicitRevision(values['goal-revision'], 'goal'),
      })) : await localCompactStatus(profile, actor, workId);
      process.stdout.write(JSON.stringify(result, null, values.json ? undefined : 2) + '\n'); return;
    }
    if (command === 'session' || command === 'history') {
      if (!session || !profile.sessions) throw new Error('session_unavailable');
      if (command === 'session') await profile.sessions.resume(actor, session.scope.sessionId);
      const limit = Number(values.limit); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('session_limit_invalid');
      const response = command === 'session' ? { session } : { sessionId: session.scope.sessionId,
        ...await profile.sessions.history(actor, session.scope.sessionId, localHistoryPolicy(profile, actor), { limit, ...(values.cursor === undefined ? {} : { cursor: values.cursor }) }) };
      process.stdout.write(JSON.stringify(response, null, values.json ? undefined : 2) + '\n'); return;
    }
    if (command === 'work-view') {
      if (!workId) throw new Error('work_id_required');
      const view = await profile.workView.read(workId, actor, { channel: 'cli', conversationId, destination: 'local', recipientId: actor.principalId, allowDiagnostics: true },
        { level: viewLevel as WorkViewLevel, ...(values.cursor === undefined ? {} : { cursor: values.cursor }) });
      process.stdout.write(values.json ? JSON.stringify(view) + '\n' : formatWorkView(view));
      return;
    }
    const binding = { channel: 'cli' as const, conversationId, recipientId: actor.principalId, destination: 'local', ...actor };
    async function userCommand(id: string, messageId: string, expectedGoalRevision: number, input: UserCommand) {
      const state = await profile.runtime.state(id); const sessionId = state.conversation?.session?.scope.sessionId;
      if (profile.sessions && sessionId) {
        if (values.session !== undefined && values.session !== sessionId) throw new Error('session_work_unavailable');
        const rawText = values.text ?? values.reason ?? command;
        return profile.sessions.command(actor, { sessionId, messageId, workId: id, rawText, expectedGoalRevision, command: input });
      }
      if (values.text !== undefined || values.session !== undefined || input.kind === 'input') throw new Error('session_work_unavailable');
      return profile.runtime.command(id, messageId, actor, expectedGoalRevision, input);
    }
    const shown: { kind: string; text: string }[] = []; let printed = 0;
    let response: unknown;
    async function demoPlan(id: string) {
      const state = await profile.runtime.state(id); const scenario = profile.scenarios.find(s => s.goal.scope === state.goal.scope && s.complexity === 'simple');
      if (!scenario) throw new Error('demo_plan_requires_simple_fixture');
      const checkpoint = scenario.checkpoints.find(c => c.expectedComplete)!;
      const ids = checkpoint.evidenceIds.length ? checkpoint.evidenceIds : scenario.evidence.filter(e => e.coverage === 'complete' && e.status === 'accepted').map(e => e.id);
      const tasks: TaskSpec[] = [{ id: `synthetic-source-g${state.goal.revision}`, description: '합성 예제의 지정 원본 조회', toolId: 'fixture.read', toolVersion: '1', input: { evidenceIds: ids }, dependsOn: [], effect: 'read', maxAttempts: 2, satisfies: state.goal.criteria.map(c => c.id) }];
      await profile.runtime.submitPlan(id, `demo-plan:${state.goal.revision}:${state.plan?.revision ?? 0}`, { baseStateRevision: state.revision, baseGoalRevision: state.goal.revision, basePlanRevision: state.plan?.revision ?? 0, reason: '명시적 합성 예제 계획; 모델 추론 아님', tasks, hypotheses: [] });
    }
    if (command === 'accept' || command === 'demo') {
      const scenario = profile.scenarios.find(s => s.id === values.scenario); if (!scenario) throw new Error('synthetic_scenario_unknown');
      const request = { messageId: values['request-id'] ?? profile.services.ids.next('request'), binding,
        goal: requestedMode ? { ...scenario.goal, mode: requestedMode } : scenario.goal,
        policy: { ...scenario.policy, allowedTools: [...scenario.policy.allowedTools, ...RESOURCE_TOOL_IDS, ...KNOWLEDGE_TOOL_IDS] }, limits: { toolCalls: 30, modelCalls: 5, tokens: 10000, replans: 5, wallTimeMs: 3600000 }, completionRequiresDelivery: !values['analysis-only'] };
      const accepted = session && profile.sessions ? await profile.sessions.accept(actor, { sessionId: session.scope.sessionId, rawText: values.text!, request }) : await profile.workflow.accept(actor, request);
      if (session) await profile.outbox.flush(accepted.workId, actor);
      workId = accepted.workId;
      shown.push({ kind: 'ack', text: accepted.accepted ? `[${workId}] 요청을 접수했습니다.` : `[${workId}] 이미 접수된 요청입니다.` });
      if (!values.json) { process.stdout.write(clean(shown[0]!.text) + '\n'); printed = shown.length; }
      response = { workId, accepted: accepted.accepted, ...(session ? { sessionId: session.scope.sessionId } : {}), snapshot: await profile.conversation.snapshot(workId, actor) };
      if (command === 'demo' && (await profile.runtime.state(workId)).plan === null) await demoPlan(workId);
    }
    if (['run', 'demo'].includes(command)) {
      if (!workId) throw new Error('work_id_required');
      const steps = Number(values.steps); if (!Number.isSafeInteger(steps) || steps < 1 || steps > 1000) throw new Error('invalid_step_limit');
      const previous = values['resume-file'] ? await jsonFile(values['resume-file']) : null;
      const previousPacket = previous === null ? undefined : parseContract(ArtifactSchema, (previous as Record<string, unknown>)['checkpoint']);
      const run = await withCompactProgress(workId, () => profile.workflow.run(workId!, actor, { maxSteps: steps, onStep: () => transient(workId!), ...(previousPacket ? { previousPacket } : {}) }));
      const { snapshot, latest } = await conversationView(profile, workId, actor, conversationId); if (latest) shown.push({ kind: latest.kind, text: latest.text });
      else shown.push({ kind: 'status', text: `[${workId}] ${statusLine(snapshot)}` });
      response = { workId, ...(session ? { sessionId: session.scope.sessionId } : {}), snapshot, messages: shown, checkpoint: run.checkpoint, checkpointStateRevision: run.stateRevision, checkpointGoalRevision: run.goalRevision,
        resumeDisposition: run.resumeDisposition, control: run.stateRevision === snapshot.revision ? run.control : { kind: 'yield', reason: 'state_changed' } };
    } else if (command === 'list') {
      const ids = await profile.conversation.list(actor, 'cli', conversationId); const visible: string[] = [];
      for (const id of ids) { try { await assertSessionWork(id); visible.push(id); } catch (error) { if (!(error instanceof Error && error.message === 'session_work_unavailable')) throw error; } }
      response = { workIds: visible };
    }
    else if (command === 'messages') {
      if (session && profile.sessions) {
        const page = await profile.sessions.history(actor, session.scope.sessionId, localHistoryPolicy(profile, actor), { limit: 100 });
        const messages = page.entries.filter(entry => entry.role === 'assistant'); shown.push(...messages.map(entry => ({ kind: entry.kind, text: entry.text })));
        response = { messages, nextCursor: page.nextCursor };
      } else response = { messages: await profile.services.sink.messages(actor, 'cli', conversationId) };
    }
    else if (command !== 'accept') {
      if (!workId) throw new Error('work_id_required');
      if (command === 'demo-plan') await demoPlan(workId);
      else if (command === 'plan') await profile.runtime.submitPlan(workId, profile.services.ids.next('plan'), parseContract(PlanProposalSchema, await jsonFile(values.file)));
      else if (command === 'attach') await profile.conversation.attach(workId, actor, binding);
      else if (command === 'mode') {
        await userCommand(workId, values['request-id'] ?? profile.services.ids.next('user-command'), modeChange!.goalRevision,
          { kind: 'mode', mode: modeChange!.mode, expectedControlRevision: modeChange!.controlRevision, reason: modeChange!.reason });
      }
      else if (['pause', 'resume', 'cancel', 'change-goal', 'resolve', 'input'].includes(command)) {
        if (['change-goal', 'resolve', 'input'].includes(command) && values['goal-revision'] === undefined) throw new Error('goal_revision_required');
        const state = await profile.runtime.state(workId); const revision = values['goal-revision'] === undefined ? state.goal.revision : Number(values['goal-revision']);
        if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('invalid_goal_revision');
        const commandId = values['request-id'] ?? profile.services.ids.next('user-command');
        if (command === 'change-goal') await userCommand(workId, commandId, goalChange!.goalRevision,
          { kind: 'goal', expectedControlRevision: goalChange!.controlRevision, goal: parseContract(GoalSchema, await jsonFile(values.file)) });
        else if (command === 'resolve') {
          if (!values.obligation || !values.reason) throw new Error('obligation_and_reason_required');
          await userCommand(workId, commandId, revision, { kind: 'resolve', obligationId: values.obligation, reason: values.reason });
        } else if (command === 'input') await userCommand(workId, commandId, revision, { kind: 'input', reason: 'session_input_received' });
        else await userCommand(workId, commandId, revision, { kind: command as 'pause' | 'resume' | 'cancel', reason: values.reason ?? `user_requested_${command}` });
      }
      const checkpoint = command === 'checkpoint' ? await profile.recovery.restore(workId, actor) : null;
      if (checkpoint) shown.push({ kind: 'status', text: `[${workId}] 재개 패킷 저장 · 상태 ${checkpoint.packet.stateRevision} · 참조 ${checkpoint.artifact.id}` });
      response = checkpoint ? { workId, stateRevision: checkpoint.packet.stateRevision, eventCursor: checkpoint.packet.eventCursor, checkpoint: checkpoint.artifact } : command === 'events' ? { workId, events: (await profile.services.state.events(workId, 0)).map(e => ({ sequence: e.sequence, revision: e.revision, type: e.type, at: e.at })) } :
        { workId, ...(command === 'disconnect' ? { disconnected: true, workCancelled: false } : {}), snapshot: await profile.conversation.snapshot(workId, actor) };
      if (command === 'disconnect') shown.push({ kind: 'status', text: `[${workId}] 연결만 종료했습니다. 업무 상태는 바뀌지 않았습니다.` });
    }
    clear();
    if (values.json) process.stdout.write(JSON.stringify(response) + '\n');
    else if (shown.length) { if (shown.length > printed) process.stdout.write((printed ? '\n' : '') + shown.slice(printed).map(m => clean(m.text)).join('\n\n') + '\n'); }
    else if (workId && command !== 'events') process.stdout.write(`[${workId}] ${clean(statusLine(await profile.conversation.snapshot(workId, actor)))}\n`);
    else if (command === 'messages' && !session) process.stdout.write((await profile.services.sink.messages(actor, 'cli', conversationId)).map(m => clean(m.text)).join('\n\n') + '\n');
    else process.stdout.write(JSON.stringify(response, null, 2) + '\n');
  } finally { clear(); process.removeListener('SIGINT', interrupt); await profile.close(); }
}
export function reportCliFailure(error: unknown) {
  const code = error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'cli_request_failed';
  const context = code.startsWith('session_compact_') || code === 'session_context_capacity' ? ' 문맥 정리를 완료하지 못했습니다. 원문 이력은 유지됩니다. 상태를 확인한 뒤 재개해 주세요.' : '';
  process.stderr.write(`오류: ${code}${context}\n`); process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runLocalCli().catch(reportCliFailure);
