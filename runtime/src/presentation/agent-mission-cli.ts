import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { ResidentControlCommand } from '../application/resident-missions.js';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentTurnProfile } from './agent-turn-profile.js';
import { agentMissionCliOptions } from './agent-cli-options.js';
import { closeAgentTurnResources } from './host-models.js';
import type { AgentExecutionHost } from './host-tools.js';
import { createLocalContractHost } from './local-contract-model.js';

const help = `secumon-agent mission · 상시 임무 제어
사용법: secumon-agent mission <status|pause|resume|stop> --directory 담당경로 --provider synthetic|registered
        --work 상시임무ID --session 사용자대화ID [--conversation 대화명] [--json]
  status  현재 관측 상태·제어 버전·대기 사건 수 조회
  pause   관측 일시정지
  resume  관측을 다시 허용
  stop    상시 임무 종료
제어 명령 필수: --command-id 요청ID --control-revision 현재제어버전
현재제어버전은 status의 controlRevision 값이며 0부터 시작합니다.
응답이 끊기면 같은 요청ID·명령·제어버전으로 재전송하세요. 새 의도에는 새 요청ID를 사용합니다.
사용자대화ID와 대화명은 임무 등록 때의 연결을 사용합니다. 대화명 기본값은 terminal입니다.
이 명령은 등록된 임무만 제어합니다. 관측 실행과 이미 접수한 사건 업무의 실행·취소는 별도입니다.
`;
function identifier(value: string | undefined, code: string): string {
  if (!value || value.length > 256 || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error(code);
  return value;
}
function controlRevision(value: string | undefined) {
  if (value === undefined) throw new Error('resident_control_revision_required');
  const number = Number(value);
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(number)) throw new Error('resident_control_revision_invalid');
  return number;
}
function clean(value: string) { return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ''); }

/** A selected existing resident is controlled without opening a session, registering an observer or running a task. */
export async function runAgentMissionCli(args: string[], host: AgentExecutionHost = createLocalContractHost(), defaultDirectory = process.cwd()) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: agentMissionCliOptions(defaultDirectory) });
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') { process.stdout.write(help); return; }
  if (positionals.length !== 1 || !['status', 'pause', 'resume', 'stop'].includes(command)) throw new Error('resident_cli_command_invalid');
  if (values.provider !== 'synthetic' && values.provider !== 'registered') throw new Error('agent_turn_provider_unavailable');
  const workId = identifier(values.work, 'resident_work_id_required'), sessionId = identifier(values.session, 'resident_session_id_required');
  const conversationId = identifier(values.conversation, 'resident_conversation_invalid');
  if (command === 'status' && (values['command-id'] !== undefined || values['control-revision'] !== undefined)) throw new Error('resident_cli_option_not_supported');
  const control: ResidentControlCommand | undefined = command === 'status' ? undefined : {
    commandId: identifier(values['command-id'], 'resident_command_id_required'), expectedControlRevision: controlRevision(values['control-revision']),
    kind: command as ResidentControlCommand['kind'],
  };
  if (new FileAgentProfileStore(fileURLToPath(new URL('../../', import.meta.url))).inspect(values.directory).status !== 'ready') throw new Error('resident_agent_not_ready');
  const profile = await openAgentTurnProfile(values.directory, { provider: values.provider }, host);
  let failure: { error: unknown } | undefined;
  try {
    const driver = profile.createResidentMissions({ policy: profile.policy, limits: profile.limits,
      binding: { tenantId: profile.actor.tenantId, principalId: profile.actor.principalId, channel: 'cli', conversationId,
        destination: 'local', recipientId: profile.actor.principalId } });
    const result = control ? await driver.control(workId, control, sessionId) : await driver.status(workId, sessionId);
    if (values.json) { process.stdout.write(JSON.stringify({ provider: profile.provider, ...result }) + '\n'); return; }
    const status = 'current' in result ? result.current : result;
    const names = { active: '관측 허용', paused: '관측 일시정지', closed: '임무 종료' };
    if ('replayed' in result) process.stdout.write(`${result.replayed ? '이미 처리한 지시입니다. 현재 상태를 표시합니다.' : '상시 임무 제어 지시를 반영했습니다.'}\n`);
    process.stdout.write(`[${clean(workId)}] ${names[status.status]} · 제어 버전 ${status.controlRevision} · 대기 사건 ${status.pending.length}건\n`);
    process.stdout.write(`사용자 대화 ${clean(status.sessionId)}\n`);
  } catch (error) { failure = { error }; throw error; }
  finally { await closeAgentTurnResources([profile.close], failure); }
}

export function reportAgentMissionCliFailure(error: unknown, json: boolean) {
  const code = error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message :
    error instanceof Error && (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS_') ? 'resident_cli_option_invalid' : 'resident_request_failed';
  process.stderr.write(json ? JSON.stringify({ code }) + '\n' : `오류: ${code}\n`); process.exitCode = 1;
}
