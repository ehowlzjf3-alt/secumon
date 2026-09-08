import { parseArgs } from 'node:util';
import { AgentLifecycleError } from '../application/agent-lifecycle-contracts.js';
import type { AgentProfileStore } from '../application/agent-profile-contracts.js';
import { bundleAgentEngine, installAgentEngine } from '../infrastructure/agent-engine-release.js';
import { backupAgent, checkAgentLifecycle, inspectAgentBackup, lifecycleInventory, pinAgentEngine, restoreAgentBackup } from '../infrastructure/agent-lifecycle.js';
import { recoverAgentLifecycleLeases } from '../infrastructure/agent-lifecycle-lease.js';
import { inspectAgentHostIdentity, type AgentHostIdentityOptions } from '../infrastructure/agent-host-identities.js';
import { rebindRestoredAgentHostIdentity } from '../infrastructure/agent-host-identity-recovery.js';
import { prepareAgentSqliteRecovery, applyAgentSqliteRecovery, readAgentSqliteRecovery } from '../infrastructure/agent-sqlite-recovery.js';
import { registerAgentEngine } from '../infrastructure/agent-engine-registry.js';
import type { EngineExtensionSelection } from '../application/engine-extension-contracts.js';

const help = `secumon-agent lifecycle <명령> [옵션]
  bundle --destination 새경로                 현재 빌드+의존성의 오프라인 배포 묶음
  install --source 묶음 --destination 새경로 --digest SHA256
  register --engine 기존설치 --digest SHA256   검증된 설치를 호스트 실행 목록에 등록
  status --directory 담당                    핀·유지보수 상태만 조회
  check --directory 담당 --engine 설치경로    배포 지문과 설정/저장 호환 검사
  pin --directory 담당 --engine 설치경로 --offline
  update --directory 담당 --engine 설치경로 --previous 현재배포SHA --backup 백업경로 --offline
  backup --directory 담당 --destination 새경로 --offline
  verify-backup --source 백업경로
  restore --source 백업경로 --directory 원래경로 --digest 백업SHA --offline
  recover-leases --directory 담당 --offline
  identity-status --directory 담당           호스트의 담당 ID 등록과 head 지문 조회
  identity-rebind --directory 복원경로 --source 원백업 --digest 백업SHA --previous 등록headSHA --operation 복원ID --kind local|postgres --offline
  sqlite-recovery-prepare --directory 담당 --operation UUID --kind state|memory|channel --offline
  sqlite-recovery-apply --directory 담당 --operation UUID --digest 준비결과SHA --offline
  sqlite-recovery-status --directory 담당 --operation UUID
모든 설치 대상은 신규 경로입니다. --offline은 구형 엔진/직접 DB 접근도 중지했다는 명시 확인입니다.
restore는 기존 담당 디렉터리를 덮어쓰지 않으며 원래 canonical 경로에만 복원합니다.
identity-rebind는 완료된 같은 백업 복원만 등록합니다. 일반 폴더 복사는 clone으로 새 ID를 만드세요.
SQLite 회복은 원 main/journal을 보존하고 후보를 만든 뒤 명시 적용합니다. prepare는 정본을 바꾸지 않습니다.
apply 중단 뒤에는 같은 operation/digest로 재개합니다. 상태 조회는 과거 영수증이며 현재 DB 검증이 아닙니다.
엔진 되돌리기도 update로 명시합니다. 과거 자료 복원은 이후 자료 손실/외부 효과 취소와 다릅니다.
배포 묶음은 현 OS/CPU 및 Node >=24.20.0 <25용입니다. 네트워크 설치·자동 업데이트는 없습니다.
`;
export async function runAgentLifecycleCli(args: string[], profiles: AgentProfileStore, currentEngine: string,
  hostOptions: { readonly identityRegistryDirectory?: string; readonly extensions?: readonly EngineExtensionSelection[]; readonly requireDeclaredExtensions?: boolean } = {}) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    directory: { type: 'string', default: process.cwd() }, destination: { type: 'string' }, source: { type: 'string' }, engine: { type: 'string' },
    digest: { type: 'string' }, previous: { type: 'string' }, backup: { type: 'string' }, offline: { type: 'boolean', default: false }, json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
    operation: { type: 'string' }, kind: { type: 'string' },
  } });
  if (values.help || positionals[0] === 'help' || !positionals.length) { process.stdout.write(help); return; }
  if (positionals.length !== 1) throw new AgentLifecycleError('lifecycle_command_invalid');
  const required = (value: string | undefined, name: string) => { if (!value) throw new AgentLifecycleError(`lifecycle_${name}_required`); return value; };
  const registryDirectory = hostOptions.identityRegistryDirectory;
  const identityOptions: AgentHostIdentityOptions = {
    engineDirectories: [...new Set([currentEngine, ...(profiles.engineDirectories ?? [])])],
    ...(registryDirectory === undefined ? {} : { registryDirectory }),
  };
  let result: unknown;
  switch (positionals[0]) {
    case 'bundle': result = bundleAgentEngine(currentEngine, required(values.destination, 'destination')); break;
    case 'install': {
      const installed = installAgentEngine(required(values.source, 'source'), required(values.destination, 'destination'), required(values.digest, 'digest'));
      const registration = registerAgentEngine(installed.directory, installed.release.digest);
      result = { ...installed, ...registration }; break;
    }
    case 'register': result = registerAgentEngine(required(values.engine, 'engine'), required(values.digest, 'digest')); break;
    case 'status': { const profile = profiles.inspect(values.directory); result = profile.status === 'ready' ? { agentId: profile.identity.agentId, ...lifecycleInventory(profile.root) } : profile; break; }
    case 'check': result = checkAgentLifecycle(profiles, values.directory, required(values.engine, 'engine'), hostOptions); break;
    case 'pin': result = pinAgentEngine(profiles, values.directory, required(values.engine, 'engine'), { ...hostOptions, offline: values.offline, expectedPrevious: null }); break;
    case 'update': result = pinAgentEngine(profiles, values.directory, required(values.engine, 'engine'), { ...hostOptions, offline: values.offline, expectedPrevious: required(values.previous, 'previous'), backup: required(values.backup, 'backup') }); break;
    case 'backup': result = backupAgent(profiles, values.directory, required(values.destination, 'destination'), values.offline); break;
    case 'verify-backup': result = inspectAgentBackup(required(values.source, 'source')); break;
    case 'restore': result = restoreAgentBackup(profiles, required(values.source, 'source'), values.directory, required(values.digest, 'digest'), values.offline); break;
    case 'recover-leases': result = recoverAgentLifecycleLeases(values.directory, values.offline); break;
    case 'identity-status': {
      const profile = profiles.inspect(values.directory);
      result = profile.status === 'ready' ? { agentId: profile.identity.agentId, root: profile.root,
        registration: inspectAgentHostIdentity(profile, identityOptions) } : profile;
      break;
    }
    case 'identity-rebind': {
      if (values.kind !== 'local' && values.kind !== 'postgres') throw new AgentLifecycleError('lifecycle_restore_kind_required');
      if (!values.offline) throw new AgentLifecycleError('lifecycle_offline_confirmation_required');
      result = await rebindRestoredAgentHostIdentity({ kind: values.kind, directory: values.directory,
        backupDirectory: required(values.source, 'source'), operationId: required(values.operation, 'operation'),
        expectedBackupDigest: required(values.digest, 'digest'), expectedHeadDigest: required(values.previous, 'previous'), offline: true }, identityOptions);
      break;
    }
    case 'sqlite-recovery-prepare': {
      if (values.kind !== 'state' && values.kind !== 'memory' && values.kind !== 'channel') throw new AgentLifecycleError('sqlite_recovery_kind_required');
      result = await prepareAgentSqliteRecovery(profiles, values.directory, { operationId: required(values.operation, 'operation'),
        kind: values.kind, offline: values.offline }, hostOptions); break;
    }
    case 'sqlite-recovery-apply':
      result = await applyAgentSqliteRecovery(profiles, values.directory, { operationId: required(values.operation, 'operation'),
        expectedPreparedDigest: required(values.digest, 'digest'), offline: values.offline }, hostOptions); break;
    case 'sqlite-recovery-status': result = readAgentSqliteRecovery(profiles, values.directory, required(values.operation, 'operation')); break;
    default: throw new AgentLifecycleError('lifecycle_command_invalid');
  }
  process.stdout.write(JSON.stringify(result, null, values.json ? undefined : 2) + '\n');
}
