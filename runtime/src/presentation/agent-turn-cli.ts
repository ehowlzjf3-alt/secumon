import { parseArgs } from 'node:util';
import { openAgentTurnProfile, type AgentTurnProfile } from './agent-turn-profile.js';
import { authorizedWork } from '../application/work-resources.js';
import type { SessionScope } from '../domain/session.js';
import type { WorkflowRunResult } from '../application/workflow-runtime.js';
import { SYNTHETIC_AGENT_TURN_REQUESTS } from '../infrastructure/synthetic-agent-turn.js';
import { closeAgentTurnResources } from './host-models.js';
import type { AgentExecutionHost } from './host-tools.js';
import { createLocalContractHost } from './local-contract-model.js';
import { agentTurnModelNotice, syntheticTurnNotice } from './agent-model-notice.js';

const help = `secumon-agent chat · 일반 요청 진입
사용법: secumon-agent chat <명령> --directory 담당경로 --provider synthetic|registered [옵션]
  session   지속 대화 열기; --session ID로 다시 연결, --new-session으로 새 대화
  ask       --message-id ID --text 원문으로 새 업무 접수 후 실행
  followup  --work ID --message-id ID --goal-revision N --text 원문
            --obligation ID가 있으면 해당 질문에 답변, 없으면 기존 업무에 추가 입력
  goal      --work ID --message-id ID --goal-revision N --control-revision N --text 새 목표
            같은 업무의 목표를 명시 교체 후 실행; --mode 생략 시 최초 접수의 모드 유지
  resume    --work ID로 중단된 접수 적용 후 선택 업무 실행
            일시정지 해제는 --message-id ID --goal-revision N --text 지시를 함께 전달
  pause     --work ID --message-id ID --goal-revision N --text 지시로 일시정지
  cancel    위와 같은 옵션으로 작업 취소; 지속 대화는 유지
  status    --work ID의 현재 상태·질문·결과 조회
  history   실제 입력과 전달된 응답 이력 조회
공통: --session ID --conversation ID --json --help
실행: --steps N (기본 100, 최대 1000); ask|goal --mode auto|fast|deep (ask 기본 auto)
목표 변경: status의 목표·제어 버전 사용; 같은 message-id 재전송은 다시 실행하지 않음
이력: --limit N (기본 50, 최대 100) --cursor 값
합성 문맥 정리: --compact-provider synthetic (명시할 때만 연결; 원문 이력 보존)
등록 모델: --provider registered (config.json의 model.profile 이름 사용; compact는 등록된 제공자를 사용)
기본 등록 local-contract-v1은 네트워크 없는 구조화 전송 대역입니다. 호스트는 등록표를 별도로 주입할 수 있습니다.
${syntheticTurnNotice}
지원하는 고정 원문:
${Object.values(SYNTHETIC_AGENT_TURN_REQUESTS).map(value => `  ${value}`).join('\n')}
`;
function clean(value: string) { return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ''); }
function integer(value: string | undefined, fallback: number, maximum: number, code: string) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error(code);
  return number;
}
async function selectedWork(profile: AgentTurnProfile, workId: string, scope: SessionScope, conversationId: string) {
  const state = await authorizedWork(profile.services.state, workId, profile.actor);
  const basis = state.conversation?.session?.scope;
  if (!state.goal.responseRequirement || !basis || basis.tenantId !== scope.tenantId || basis.agentId !== scope.agentId ||
      basis.principalId !== scope.principalId || basis.sessionId !== scope.sessionId ||
      !state.conversation?.bindings.some(binding => binding.channel === 'cli' && binding.conversationId === conversationId &&
        binding.session?.sessionId === scope.sessionId)) throw new Error('session_work_unavailable');
  return state;
}
async function view(profile: AgentTurnProfile, workId: string, scope: SessionScope, conversationId: string) {
  for (let retry = 0; retry < 8; retry++) {
    const state = await selectedWork(profile, workId, scope, conversationId);
    const [snapshot, deliveries] = await Promise.all([profile.conversation.snapshot(workId, profile.actor), profile.services.state.deliveries(workId)]);
    if (snapshot.revision !== state.revision || (await selectedWork(profile, workId, scope, conversationId)).revision !== state.revision) continue;
    const scoped = deliveries.filter(delivery => delivery.status === 'delivered' && delivery.goalRevision === state.goal.revision &&
      delivery.context?.binding.channel === 'cli' && delivery.context.binding.conversationId === conversationId && delivery.context.binding.session?.sessionId === scope.sessionId);
    const failures = new Map<string, string>();
    if (['blocked', 'failed'].includes(state.status) && scoped.some(delivery => delivery.kind === 'failure')) {
      const binding = state.conversation!.bindings.find(binding => binding.channel === 'cli' && binding.conversationId === conversationId &&
        binding.session?.sessionId === scope.sessionId)!;
      // Reuse the current disclosure projection; stored failure text can belong to an earlier restriction.
      const projected = await profile.workView.read(workId, profile.actor, { channel: 'cli', conversationId,
        destination: binding.destination, recipientId: binding.recipientId, allowDiagnostics: false }, { level: 'conversation' }).catch((error: unknown) => {
        // A changed memory source withholds the optional notice without hiding the status snapshot.
        if (error instanceof Error && error.message === 'work_view_knowledge_changed') return null;
        throw error;
      });
      if (projected && (projected.kind !== 'snapshot' || projected.view.revision !== state.revision) ||
          (await selectedWork(profile, workId, scope, conversationId)).revision !== state.revision) continue;
      for (const message of projected?.kind === 'snapshot' ? projected.view.messages : [])
        if (message.kind === 'failure' && message.deliveryStatus === 'delivered') failures.set(message.id, message.text);
    }
    const messages = scoped.filter(delivery =>
      (delivery.kind === 'failure' && failures.has(delivery.id) || delivery.kind === 'ack' || delivery.kind === 'result' && snapshot.resultReady && state.conversation?.result?.id === delivery.id ||
        delivery.kind === 'question' && !['cancelled', 'paused', 'failed'].includes(state.status) &&
          delivery.context!.obligationIds.some(id => snapshot.pendingQuestions.some(question => question.id === id))))
      .map(delivery => ({ id: delivery.id, kind: delivery.kind, text: failures.get(delivery.id) ?? delivery.text }));
    return { snapshot, messages };
  }
  throw new Error('conversation_view_contention');
}

export async function runAgentTurnCli(args: string[], host: AgentExecutionHost = createLocalContractHost()) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    directory: { type: 'string', default: process.cwd() }, provider: { type: 'string' }, 'compact-provider': { type: 'string' },
    session: { type: 'string' }, 'new-session': { type: 'boolean', default: false }, conversation: { type: 'string', default: 'terminal' },
    'message-id': { type: 'string' }, text: { type: 'string' }, work: { type: 'string' }, 'goal-revision': { type: 'string' },
    'control-revision': { type: 'string' }, obligation: { type: 'string' },
    mode: { type: 'string' }, steps: { type: 'string' }, limit: { type: 'string' }, cursor: { type: 'string' },
    json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  } });
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') { process.stdout.write(help); return; }
  if (positionals.length !== 1 || !['session', 'ask', 'followup', 'goal', 'resume', 'pause', 'cancel', 'status', 'history'].includes(command)) throw new Error('chat_command_invalid');
  if (values.provider !== 'synthetic' && values.provider !== 'registered') throw new Error('agent_turn_provider_unavailable');
  if (values['compact-provider'] !== undefined && values['compact-provider'] !== 'synthetic') throw new Error('invalid_compact_provider');
  if (values.provider === 'registered' && values['compact-provider'] !== undefined) throw new Error('invalid_compact_provider');
  if (values['new-session'] && (values.session !== undefined || !['session', 'ask'].includes(command))) throw new Error('session_option_not_supported');
  const controlRequest = ['pause', 'cancel'].includes(command) || command === 'resume' && values['message-id'] !== undefined;
  const executes = ['ask', 'followup', 'goal', 'resume'].includes(command), receives = controlRequest || ['ask', 'followup', 'goal'].includes(command);
  if ((values.text !== undefined || values['message-id'] !== undefined) && !receives ||
      values.mode !== undefined && !['ask', 'goal'].includes(command) || values.obligation !== undefined && command !== 'followup' ||
      values['goal-revision'] !== undefined && !['followup', 'goal', 'resume', 'pause', 'cancel'].includes(command) ||
      values['control-revision'] !== undefined && command !== 'goal' ||
      values.steps !== undefined && !executes || (values.limit !== undefined || values.cursor !== undefined) && command !== 'history' ||
      values.work !== undefined && !['followup', 'goal', 'resume', 'pause', 'cancel', 'status'].includes(command)) throw new Error('chat_option_not_supported');
  if (receives && !values.text?.trim()) throw new Error('session_text_required');
  if (receives && !values['message-id']) throw new Error('message_id_required');
  if (['followup', 'goal', 'resume', 'pause', 'cancel', 'status'].includes(command) && !values.work) throw new Error('work_id_required');
  if ((controlRequest || ['followup', 'goal'].includes(command)) && values['goal-revision'] === undefined) throw new Error('goal_revision_required');
  if (command === 'goal' && values['control-revision'] === undefined) throw new Error('control_revision_required');
  const mode = values.mode ?? 'auto'; if (!['auto', 'fast', 'deep'].includes(mode)) throw new Error('invalid_execution_mode');
  const steps = integer(values.steps, 100, 1000, 'invalid_step_limit'), limit = integer(values.limit, 50, 100, 'invalid_history_limit');
  const goalRevision = values['goal-revision'] === undefined ? undefined : integer(values['goal-revision'], 1,
    command === 'goal' ? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER, 'invalid_goal_revision');
  const controlRevision = values['control-revision'] === undefined ? undefined : integer(values['control-revision'], 1,
    Number.MAX_SAFE_INTEGER - 1, 'invalid_control_revision');
  if (values.cursor !== undefined && values.cursor.length > 256) throw new Error('invalid_history_cursor');
  const profile = await openAgentTurnProfile(values.directory, { provider: values.provider,
    ...(values['compact-provider'] === undefined ? {} : { compactProvider: 'synthetic' }) }, host);
  const notice = agentTurnModelNotice(profile.modelInfo);
  let failure: { error: unknown } | undefined;
  try {
    const session = await profile.sessions.open(profile.actor, { channel: 'cli', conversationId: values.conversation,
      ...(values.session === undefined ? {} : { sessionId: values.session }), ...(values['new-session'] ? { newSession: true } : {}) });
    const sessionId = session.scope.sessionId;
    if (command === 'session') {
      process.stdout.write(values.json ? JSON.stringify({ provider: profile.provider, modelInfo: profile.modelInfo, notice, session }) + '\n' : `${notice}\n대화: ${sessionId}\n`); return;
    }
    if (command === 'history') {
      const page = await profile.sessions.history(profile.actor, sessionId, profile.policy, { limit, ...(values.cursor === undefined ? {} : { cursor: values.cursor }) });
      process.stdout.write(values.json ? JSON.stringify({ provider: profile.provider, modelInfo: profile.modelInfo, notice, sessionId, ...page }) + '\n' :
        `${notice}\n${page.entries.map(entry => `${entry.role === 'user' ? '사용자' : '담당'}: ${clean(entry.text)}`).join('\n\n')}${page.nextCursor ? `\n다음 이력: --cursor ${page.nextCursor}` : ''}\n`); return;
    }
    let workId = values.work, accepted: boolean | undefined, created: boolean | undefined, run: WorkflowRunResult | undefined, noticePrinted = false;
    const printed = new Set<string>();
    if (command === 'ask') {
      const result = await profile.turns.accept(profile.actor, { sessionId, messageId: values['message-id']!, rawText: values.text!,
        binding: { channel: 'cli', conversationId: values.conversation, destination: 'local', recipientId: profile.actor.principalId,
          tenantId: profile.actor.tenantId, principalId: profile.actor.principalId }, scope: profile.scope, mode: mode as 'auto' | 'fast' | 'deep',
        policy: profile.policy, limits: profile.limits });
      workId = result.workId; accepted = result.accepted;
      await profile.outbox.flush(workId, profile.actor);
      if (!values.json) {
        const ack = (await view(profile, workId, session.scope, values.conversation)).messages.find(message => message.kind === 'ack');
        process.stdout.write(`${notice}\n${ack ? clean(ack.text) : `[${workId}] 요청이 저장되었습니다. 접수 안내 전달 대기 중입니다.`}\n`);
        noticePrinted = true;
        if (ack) printed.add(ack.id);
      }
    } else {
      if (command === 'resume') {
        const existing = await profile.services.state.get(workId!);
        if (existing) await selectedWork(profile, workId!, session.scope, values.conversation);
        else if (!(await profile.sessions.repository.pending(session.scope, 256)).some(input => input.workId === workId && input.kind === 'work'))
          throw new Error('work_unavailable');
        await profile.sessions.resume(profile.actor, sessionId);
      }
      await selectedWork(profile, workId!, session.scope, values.conversation);
      if (controlRequest) {
        const result = await profile.sessions.command(profile.actor, { sessionId, messageId: values['message-id']!, workId: workId!,
          rawText: values.text!, expectedGoalRevision: goalRevision!,
          command: { kind: command as 'pause' | 'resume' | 'cancel', reason: 'cli_user_command' } });
        created = result.created;
        if (!values.json) { process.stdout.write(`${notice}\n[${workId}] ${created ? '작업 제어 지시를 접수했습니다.' : '이미 접수한 지시입니다. 현재 상태를 표시합니다.'}\n`); noticePrinted = true; }
      } else if (command === 'followup') {
        const result = await profile.turns.followUp(profile.actor, { sessionId, messageId: values['message-id']!, workId: workId!,
          rawText: values.text!, expectedGoalRevision: goalRevision!, action: values.obligation === undefined ? { kind: 'continue' } : { kind: 'clarify', obligationId: values.obligation } });
        created = result.created;
        if (!values.json) { process.stdout.write(`${notice}\n[${workId}] 추가 입력을 접수했습니다.\n`); noticePrinted = true; }
      } else if (command === 'goal') {
        const result = await profile.turns.changeGoal(profile.actor, { sessionId, messageId: values['message-id']!, workId: workId!,
          rawText: values.text!, expectedGoalRevision: goalRevision!, expectedControlRevision: controlRevision!,
          ...(values.mode === undefined ? {} : { mode: mode as 'auto' | 'fast' | 'deep' }) });
        created = result.created;
        if (!values.json) {
          process.stdout.write(`${notice}\n[${workId}] ${created ? '목표 변경을 접수했습니다.' :
            '이미 접수한 목표 변경입니다. 현재 상태만 표시합니다. 계속 실행하려면 chat resume을 사용하세요.'}\n`);
          noticePrinted = true;
        }
      }
    }
    const newInput = command === 'ask' ? accepted : receives ? created : true;
    if (executes && newInput) run = await profile.workflow.run(workId!, profile.actor, { maxSteps: steps,
      ...(goalRevision === undefined ? {} : { expectedGoalRevision: command === 'goal' ? goalRevision + 1 : goalRevision }) });
    const current = await view(profile, workId!, session.scope, values.conversation);
    if (values.json) process.stdout.write(JSON.stringify({ provider: profile.provider, modelInfo: profile.modelInfo, notice, sessionId, workId, ...current,
      ...(accepted === undefined ? {} : { accepted }), ...(created === undefined ? {} : { created }), ...(run === undefined ? {} : { run }) }) + '\n');
    else {
      if (!noticePrinted) process.stdout.write(notice + '\n');
      const messages = current.messages.filter(message => !printed.has(message.id) && (command === 'ask' || message.kind !== 'ack'));
      if (messages.length) process.stdout.write(messages.map(message => clean(message.text)).join('\n\n') + '\n');
      const names: Record<string, string> = { ready: '실행 대기', running: '진행 중', waiting: '확인 대기', completed: '완료', blocked: '진행 제한', failed: '실패', paused: '일시 정지', cancelled: '취소' };
      const wait = run?.control.kind === 'wait' && run.control.reason === 'model_call_pending' ? ' · 진행 중인 호출의 응답 또는 실행권 만료 대기' : '';
      process.stdout.write(`[${workId}] ${names[current.snapshot.status] ?? current.snapshot.status}${wait} · 대화 ${sessionId}\n`);
      if (command === 'status') process.stdout.write(`목표 버전 ${current.snapshot.goalRevision} · 제어 버전 ${current.snapshot.execution.revision}\n`);
    }
  } catch (error) { failure = { error }; throw error; }
  finally { await closeAgentTurnResources([profile.close], failure); }
}

export function reportAgentTurnCliFailure(error: unknown, json: boolean) {
  const code = error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'chat_request_failed';
  const detail = code.startsWith('session_compact_') || code === 'session_context_capacity' ? '문맥 정리를 완료하지 못했습니다. 저장한 원문 이력은 유지됩니다.' : undefined;
  process.stderr.write(json ? JSON.stringify({ code, ...(detail ? { detail } : {}) }) + '\n' : `오류: ${code}${detail ? ` · ${detail}` : ''}\n`);
  process.exitCode = 1;
}
