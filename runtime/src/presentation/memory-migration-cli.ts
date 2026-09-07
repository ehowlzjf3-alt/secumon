import { parseArgs } from 'node:util';
import type { AgentProfileStore } from '../application/agent-profile-contracts.js';
import { PersonalMemoryMigrationError, PersonalMemoryMigrationOptionsSchema } from '../application/personal-memory-migration-contracts.js';
import { previewPersonalMemoryMigration, applyPersonalMemoryMigration, resumePersonalMemoryMigration,
  personalMemoryMigrationStatus } from '../infrastructure/personal-memory-migration.js';

const help = `개인 기억 이관 · SQLite → 문서 (명시적 오프라인 관리)
memory-migrate preview|apply --directory <담당> --from sqlite --source <memory.sqlite>
  --to documents --target <memory/documents> --operation-id <UUID> --target-store-id <UUID>
  --backup-directory <담당 밖 새 private 경로> --scope all-personal [--json]
apply 추가: --snapshot-digest <preview의 snapshotDigest> --offline-confirmed --effects-reconciled
memory-migrate resume --directory <담당> --operation-id <동일 UUID> [--json]
memory-migrate status --directory <담당> [--operation-id <UUID>] [--json]

preview는 파일을 생성하지 않습니다. apply 전에 해당 담당의 모든 CLI/Web/상주 프로세스를
중지하고 진행 중 외부 효과의 결과를 대조하세요. 두 확인 옵션은 운영자의 확인 기록이며,
프로세스나 외부 효과가 자동으로 검증되었다는 뜻이 아닙니다.
원 기억 ID·최신 내용·저장된 영수증을 보존합니다. 원 DB에 없는 과거 본문은 만들지 않습니다.
source fence 뒤에는 취소/SQLite 자동 복귀가 없으며 같은 operation의 resume을 사용합니다.
`;
export async function runMemoryMigrationCli(args: string[], profiles: AgentProfileStore, forbiddenRoots: readonly string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    directory: { type: 'string', default: process.cwd() }, from: { type: 'string' }, to: { type: 'string' },
    source: { type: 'string' }, target: { type: 'string' }, 'operation-id': { type: 'string' }, 'target-store-id': { type: 'string' },
    'backup-directory': { type: 'string' }, scope: { type: 'string' }, 'snapshot-digest': { type: 'string' },
    'offline-confirmed': { type: 'boolean' }, 'effects-reconciled': { type: 'boolean' },
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || positionals[0] === 'help') { process.stdout.write(help); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !['preview', 'apply', 'resume', 'status'].includes(command ?? '')) throw new PersonalMemoryMigrationError('agent_migration_command_invalid');
  let result: unknown;
  if (command === 'resume' || command === 'status') {
    if (['from', 'to', 'source', 'target', 'target-store-id', 'backup-directory', 'scope', 'snapshot-digest', 'offline-confirmed', 'effects-reconciled']
      .some(key => values[key as keyof typeof values] !== undefined)) throw new PersonalMemoryMigrationError('agent_migration_option_not_supported');
    if (command === 'resume' && !values['operation-id']) throw new PersonalMemoryMigrationError('agent_migration_operation_required');
    result = command === 'resume' ? await resumePersonalMemoryMigration(profiles, values.directory, values['operation-id']!, forbiddenRoots)
      : personalMemoryMigrationStatus(profiles, values.directory, values['operation-id']);
  } else {
    const parsed = PersonalMemoryMigrationOptionsSchema.safeParse({ directory: values.directory, from: values.from, to: values.to,
      source: values.source, target: values.target, operationId: values['operation-id'], targetStoreId: values['target-store-id'],
      backupDirectory: values['backup-directory'], scope: values.scope });
    if (!parsed.success) throw new PersonalMemoryMigrationError('agent_migration_options_invalid');
    if (command === 'preview') {
      if (values['snapshot-digest'] !== undefined || values['offline-confirmed'] !== undefined || values['effects-reconciled'] !== undefined) {
        throw new PersonalMemoryMigrationError('agent_migration_option_not_supported');
      }
      result = previewPersonalMemoryMigration(profiles, parsed.data, forbiddenRoots);
    } else {
      if (!values['snapshot-digest'] || !/^[a-f0-9]{64}$/.test(values['snapshot-digest'])) throw new PersonalMemoryMigrationError('agent_migration_snapshot_required');
      result = await applyPersonalMemoryMigration(profiles, parsed.data, { expectedSnapshotDigest: values['snapshot-digest'],
        offlineConfirmed: values['offline-confirmed'] === true, effectsReconciled: values['effects-reconciled'] === true }, forbiddenRoots);
    }
  }
  // Includes paths, counts and digests; never prints remembered bodies or source audit quotes.
  process.stdout.write(JSON.stringify(result, null, values.json ? undefined : 2) + '\n');
}
