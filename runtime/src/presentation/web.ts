import { openAgentWeb } from './agent-web.js';

async function main() {
  const opened = await openAgentWeb(process.argv.slice(2));
  if (!opened) return;
  process.stdout.write(`로컬 Web 작업실 · ${opened.notice}\n저장소: ${opened.profile.stateBackend}\n최초 연결: ${opened.server.connectUrl}\n브라우저를 닫아도 업무는 취소되지 않습니다. 서버 종료 뒤에는 새 명시 실행으로 재개합니다.\n`);
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    void opened.close().catch(() => { process.exitCode = 1; process.stderr.write('로컬 서버 종료 확인 필요\n'); });
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
void main().catch(error => {
  const code = error instanceof Error && ['invalid_web_port', 'state_backend_mismatch', 'invalid_compact_provider', 'agent_directory_required',
    'agent_turn_provider_unavailable', 'agent_model_registration_invalid', 'agent_storage_option_conflict', 'session_option_not_supported'].includes(error.message) ? error.message : 'local_web_start_failed';
  process.stderr.write(`${code}\n`); process.exitCode = 1;
});
