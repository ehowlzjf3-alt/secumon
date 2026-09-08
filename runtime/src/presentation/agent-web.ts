import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { openAgentLocalProfile, openLocalProfile, localCompactProvider, runtimeRoot } from './local-profile.js';
import { LocalWorkbench, agentTurnWorkbenchProfile, type LocalWorkbenchProfile } from './local-workbench.js';
import { openAgentTurnProfile } from './agent-turn-profile.js';
import { startWebServer } from './web-server.js';
import { closeAgentTurnResources } from './host-models.js';
import type { AgentExecutionHost } from './host-tools.js';
import { createLocalContractHost } from './local-contract-model.js';
import { agentTurnModelNotice } from './agent-model-notice.js';

const help = `로컬 Web 작업실
node dist/presentation/web.js [--data-dir 경로] [--state-backend sqlite|file-journal] [--port 0] [--conversation web]
담당 저장소: --directory 담당경로 [--session 대화ID | --new-session]
일반 요청: --directory 담당경로 --provider synthetic|registered
등록 모델은 config.json의 model.profile 이름을 사용합니다. 기본 local-contract-v1은 네트워크 없는 전송 대역입니다.
합성 요약 시험: --provider synthetic --compact-provider synthetic
127.0.0.1만 수신하며 최초 연결 URL은 이 로컬 profile의 일회 접속 권한입니다. 화면 닫기는 취소가 아닙니다.
프로세스 재시작 뒤 저장된 업무는 명시 실행으로 재개합니다.
`;

/** Host registration is supplied at startup and is never selected by an HTTP request. */
export async function openAgentWeb(args: string[], host: AgentExecutionHost = createLocalContractHost()) {
  const { values } = parseArgs({ args, strict: true, options: {
    'data-dir': { type: 'string' }, directory: { type: 'string' }, session: { type: 'string' }, 'new-session': { type: 'boolean' },
    'state-backend': { type: 'string' }, port: { type: 'string', default: '0' }, 'compact-provider': { type: 'string' },
    conversation: { type: 'string', default: 'web' }, help: { type: 'boolean', short: 'h' }, provider: { type: 'string' },
  } });
  if (values.help) { process.stdout.write(help); return null; }
  if (!/^\d+$/.test(values.port) || !Number.isSafeInteger(Number(values.port)) || Number(values.port) > 65535) throw new Error('invalid_web_port');
  if (values.directory !== undefined && (values['data-dir'] !== undefined || values['state-backend'] !== undefined)) throw new Error('agent_storage_option_conflict');
  const compactProvider = localCompactProvider(values['compact-provider']);
  if (values.directory === undefined && (compactProvider !== undefined || values.session !== undefined || values['new-session'])) throw new Error('agent_directory_required');
  if (values.session !== undefined && values['new-session']) throw new Error('session_option_not_supported');
  if (values.provider !== undefined && values.provider !== 'synthetic' && values.provider !== 'registered') throw new Error('agent_turn_provider_unavailable');
  if (values.provider && !values.directory) throw new Error('agent_directory_required');
  if (values.provider === 'registered' && values['compact-provider'] !== undefined) throw new Error('invalid_compact_provider');
  const general = values.provider ? await openAgentTurnProfile(values.directory!, { provider: values.provider,
    ...(compactProvider ? { compactProvider } : {}) }, host) : null;
  const profile: LocalWorkbenchProfile = general ? agentTurnWorkbenchProfile(general) : values.directory === undefined ?
    await openLocalProfile(values['data-dir'] ?? join(runtimeRoot, '.data', 'web'), values['state-backend']) :
    await openAgentLocalProfile(values.directory, compactProvider ? { compactProvider } : {});
  try {
    const workbench = new LocalWorkbench(profile, general?.actor ?? { tenantId: 'synthetic', principalId: 'learner' }, values.conversation,
      { ...(values.session === undefined ? {} : { sessionId: values.session }), ...(values['new-session'] ? { newSession: true } : {}) });
    await workbench.initializeSession();
    const server = await startWebServer(workbench, { port: Number(values.port) });
    let closing: Promise<void> | undefined;
    return { profile, workbench, server, extensions: general?.extensions ?? null, notice: general ? agentTurnModelNotice(general.modelInfo) : '로컬 학습환경 · 합성 자료 · 실제 모델 미연결',
      close: () => closing ??= closeAgentTurnResources([server.close, profile.close]) };
  } catch (error) { await closeAgentTurnResources([profile.close], { error }); throw error; }
}
