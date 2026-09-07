#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores, type AgentStoreHostOptions } from '../infrastructure/agent-stores.js';
import { AgentProfileError } from '../application/agent-profile-contracts.js';
import type { AgentProfileStatus } from '../application/agent-profile-contracts.js';
import { PersonalMemoryMigrationError } from '../application/personal-memory-migration-contracts.js';
import { AgentLifecycleError } from '../application/agent-lifecycle-contracts.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const help = `secumon-agent · 담당 디렉터리 설정
사용법: secumon-agent [init|status|repair|clone|version|help] [옵션]
  명령 생략   신규 담당을 기본값으로 준비하거나 기존 담당 상태 표시
  init        담당 ID와 설정·저장 영역 준비; 기존 설정 보존
  status      현재 상태 조회; 파일 생성 없음
  repair      복구 가능한 부분 설정을 기존 ID로 이어서 준비
  clone       원본의 설정·스킬로 새 담당 준비; 기억·대화·진행 작업은 복사하지 않음
  version     설치 엔진 버전 표시
  work <명령> 담당의 합성 작업 실행·지속 대화 접수/이력 (work help로 옵션 확인)
  chat <명령> 일반 원문 요청·후속 대화 (chat help; synthetic 또는 registered 제공자 명시)
  memory-migrate <명령> 기존 SQLite 개인 기억의 명시적 문서 이관 (memory-migrate help)
  lifecycle <명령> 오프라인 설치·엔진 핀·업데이트·자료 백업/복원 (lifecycle help)
옵션: --directory 경로 --name 이름 --purpose 담당목적 --json --help
작업 상태: init --state-backend sqlite|file-journal (새 담당 선택; 기본 sqlite)
repair --state-backend는 기존 선택 확인용이며 생략하면 저장된 선택을 따릅니다.
개인 기억: init --personal-memory sqlite|documents (새 담당만 선택; 기본 sqlite)
documents는 개인 기억의 정본을 문서로 저장합니다. 업무 근거 기억은 SQLite를 유지합니다.
기존 담당은 저장방식을 자동 전환하지 않습니다. status에서 적용된 설정을 확인하세요.
복제: clone --directory 원본 --destination 새경로 [--name 이름] [--resume]
--resume은 중단된 복제를 같은 ID로 이어갑니다. 원본과 대상 변경은 검증합니다.
기본 경로는 현재 디렉터리입니다. 설정 명령은 작업을 실행하지 않습니다. 실제 모델은 연결하지 않습니다.
`;
/** Trusted setup/lifecycle/work/chat host configuration; normal bin startup uses the default host registry. */
export async function runAgentCli(args: string[], hostOptions: AgentStoreHostOptions = {}) {
  if (args[0] === 'lifecycle') {
    const { runAgentLifecycleCli } = await import('./agent-lifecycle-cli.js');
    await runAgentLifecycleCli(args.slice(1), new FileAgentProfileStore(root), root, hostOptions); return;
  }
  if (args[0] === 'chat') {
    const { runAgentTurnCli, reportAgentTurnCliFailure } = await import('./agent-turn-cli.js');
    const { createLocalContractHost } = await import('./local-contract-model.js');
    const chatArgs = args.slice(1);
    await runAgentTurnCli(chatArgs, { ...createLocalContractHost(), ...hostOptions }).catch(error => reportAgentTurnCliFailure(error, chatArgs.includes('--json'))); return;
  }
  if (args[0] === 'memory-migrate') {
    const { runMemoryMigrationCli } = await import('./memory-migration-cli.js');
    await runMemoryMigrationCli(args.slice(1), new FileAgentProfileStore(root), [root]); return;
  }
  if (args[0] === 'work') {
    const { runLocalCli, reportCliFailure } = await import('./cli.js');
    await runLocalCli(args.slice(1), process.cwd(), hostOptions).catch(reportCliFailure); return;
  }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    directory: { type: 'string', default: process.cwd() }, name: { type: 'string' }, purpose: { type: 'string' },
    json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    destination: { type: 'string' }, resume: { type: 'boolean' },
    'personal-memory': { type: 'string' },
    'state-backend': { type: 'string' },
  } });
  if (values.help || positionals.length === 1 && positionals[0] === 'help') { process.stdout.write(help); return; }
  const command = values.version ? 'version' : positionals[0] ?? 'open';
  if (positionals.length > 1 || !['open', 'init', 'status', 'repair', 'clone', 'version'].includes(command)) throw new AgentProfileError('agent_command_invalid');
  const personalMemory = values['personal-memory'];
  if (personalMemory !== undefined && command !== 'init') throw new AgentProfileError('agent_option_not_supported');
  if (personalMemory !== undefined && personalMemory !== 'sqlite' && personalMemory !== 'documents') throw new AgentProfileError('agent_setup_options_invalid');
  const stateBackend = values['state-backend'];
  if (stateBackend !== undefined && !['init', 'repair'].includes(command)) throw new AgentProfileError('agent_option_not_supported');
  if (stateBackend !== undefined && stateBackend !== 'sqlite' && stateBackend !== 'file-journal') throw new AgentProfileError('agent_setup_options_invalid');
  if ((!['open', 'init', 'repair', 'clone'].includes(command) && values.name !== undefined) ||
    (!['open', 'init', 'repair'].includes(command) && values.purpose !== undefined) ||
    (command !== 'clone' && (values.destination !== undefined || values.resume !== undefined))) throw new AgentProfileError('agent_option_not_supported');
  if (command === 'clone' && !values.destination) throw new AgentProfileError('agent_clone_destination_required');
  const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  if (command === 'version') { process.stdout.write(values.json ? JSON.stringify({ version, configSchema: 1, defaultConfigSchema: 1, configSchemas: [1, 2], setupSchemas: [1, 2] }) + '\n' : `secumon-agent ${version}\n`); return; }
  const store = new FileAgentProfileStore(root);
  let status: AgentProfileStatus;
  if (command === 'status') status = store.inspect(values.directory);
  else if (command === 'clone') status = store.clone(values.directory, values.destination!, { resume: values.resume ?? false, ...(values.name === undefined ? {} : { name: values.name }) });
  else status = store.initialize(values.directory, { repair: command === 'repair', ...(values.name === undefined ? {} : { name: values.name }), ...(values.purpose === undefined ? {} : { purpose: values.purpose }),
    ...(personalMemory === undefined ? {} : { personalMemory }), ...(stateBackend === undefined ? {} : { stateBackend }) });
  let storageInitialized = false;
  if (status.status === 'ready' && command !== 'status') {
    const stores = await openAgentStores(store, status.root, undefined, hostOptions); await stores.close(); storageInitialized = true;
  }
  const result = { ...status, engineVersion: version, storageInitialized, runtimeConnected: false };
  if (values.json) process.stdout.write(JSON.stringify(result) + '\n');
  else if (status.status === 'ready') {
    const memory = status.effectivePersonalMemory.backend === 'documents' ? '문서 (documents)' : status.effectivePersonalMemory.backend === 'postgres' ? 'PostgreSQL' : 'SQLite';
    const pgPurposes = status.config.storage.postgres?.purposes ?? [];
    const migration = status.personalMemoryMigration ? `개인 기억 이관: ${status.personalMemoryMigration.phase} (${status.personalMemoryMigration.operationId})\n` : '';
    process.stdout.write(`${status.config.name} · ${status.identity.agentId}\n담당 디렉터리 준비 완료: ${status.root}\n작업 상태: ${pgPurposes.includes('state') ? 'postgres' : status.config.storage.state} · 개인 기억: ${memory} · 업무 근거 기억: ${pgPurposes.includes('knowledge') ? 'PostgreSQL' : 'SQLite'}\n${migration}secumon-agent chat help로 일반 원문 요청·후속 대화, work help로 합성 작업 명령을 확인할 수 있습니다. 설정 과정에서 모델을 호출하지 않았습니다.\n`);
  }
  else if (status.status === 'uninitialized') process.stdout.write(`담당 설정이 없습니다: ${status.root}\nsecumon-agent init으로 준비할 수 있습니다.\n`);
  else process.stdout.write(`기존 담당의 복구가 필요합니다: ${status.missing.join(', ')}\n${status.recovery === 'clone' ? '원본을 지정해 secumon-agent clone --directory 원본 --destination 대상 --resume으로 이어갈 수 있습니다.' : status.recoverable ? 'secumon-agent repair로 기존 ID를 유지하여 복구할 수 있습니다.' : '기존 설정/ID의 복원 자료가 필요합니다.'}\n`);
}
export function reportAgentCliFailure(error: unknown) {
  const message = error instanceof AgentProfileError || error instanceof PersonalMemoryMigrationError || error instanceof AgentLifecycleError ? error.code : 'agent_setup_failed';
  process.stderr.write(message + '\n'); process.exitCode = 1;
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { await runAgentCli(process.argv.slice(2)); } catch (error) { reportAgentCliFailure(error); }
}
