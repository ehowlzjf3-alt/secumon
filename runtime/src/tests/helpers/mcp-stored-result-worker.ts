import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtifactRef, WorkState } from '../../domain/model.js';
import type { ArtifactStore, StateRepository } from '../../application/ports.js';
import type { AgentExecutionHost } from '../../presentation/host-tools.js';
import { openAgentTurnProfile } from '../../presentation/agent-turn-profile.js';
import { acceptMcpRequest, createMcpFixtureHost, initializeMcpAgent, MCP_AGENT_TOOL, readMcpAudit,
  type McpFixtureHostOptions } from '../mcp-agent-profile-helper.js';

export type StoredResultStage = 'intent' | 'artifact' | 'response' | 'receive';
export interface StoredResultMarker {
  stage: StoredResultStage; backend: 'sqlite' | 'file-journal'; workerPid: number; peerPid: number;
  directory: string; auditFile: string; agentId: string; workId: string; attemptId: string;
  originalClock: number; state: WorkState; raw: { ref: ArtifactRef; text: string } | null;
}

// The original fixture supplies all model/MCP behavior. Only the host's logical
// call limit is reduced, so recovery must work after that one call is exhausted.
export function storedResultHost(options: McpFixtureHostOptions) {
  const fixture = createMcpFixtureHost(options), registration = fixture.host.tools!;
  const host: AgentExecutionHost = { ...fixture.host, tools: { async open(context, assembly) {
    const opened = await registration.open(context, assembly);
    return { ...opened, limits: { ...opened.limits, toolCalls: 1 } };
  } } };
  return { ...fixture, host };
}

async function main() {
  const [base, selectedBackend, selectedStage] = process.argv.slice(2);
  assert.ok(base && process.send);
  assert.ok(selectedBackend === 'sqlite' || selectedBackend === 'file-journal');
  assert.ok(['intent', 'artifact', 'response', 'receive'].includes(selectedStage!));
  const backend = selectedBackend, stage = selectedStage as StoredResultStage;
  // This isolated process uses the actual profile clock with one fixed historical
  // value. The parent reopens at real time: lease expired, work deadline still live.
  // It does not claim monotonic clocks or a physical commit timestamp guarantee.
  const realNow = Date.now, originalClock = realNow() - 60_000;
  Date.now = () => originalClock;
  const ready = initializeMcpAgent(join(base, 'agent'), backend), auditFile = join(base, 'peer.jsonl');
  const configured = storedResultHost({ auditFile, documentValue: 47 });
  const profile = await openAgentTurnProfile(ready.root, { provider: 'registered' }, configured.host);
  let workId = '', attemptId = '', raw: StoredResultMarker['raw'] = null;
  let checkpointSent = false;
  async function checkpoint(): Promise<never> {
    assert.equal(checkpointSent, false); checkpointSent = true;
    const state = await profile.runtime.state(workId), peer = readMcpAudit(auditFile).find(row => row.event === 'start');
    assert.ok(peer?.pid); assert.equal(state.budget.limits.toolCalls, 1);
    const marker: StoredResultMarker = { stage, backend, workerPid: process.pid, peerPid: peer.pid,
      directory: ready.root, auditFile, agentId: profile.agentId, workId, attemptId, originalClock, state, raw };
    await new Promise<void>((resolve, reject) => process.send!({ kind: 'stored-result-checkpoint', marker }, error => error ? reject(error) : resolve()));
    return new Promise<never>(() => { setInterval(() => {}, 1000); });
  }
  const put = profile.services.artifacts.put.bind(profile.services.artifacts);
  profile.services.artifacts.put = async (...args: Parameters<ArtifactStore['put']>) => {
    const ref = await put(...args);
    let parsed: { kind?: string } | null = null;
    try { parsed = JSON.parse(Buffer.from(args[0]).toString('utf8')) as { kind?: string }; } catch { /* Only the decoded MCP envelope is a checkpoint. */ }
    if (parsed?.kind === 'mcp_decoded_response') {
      raw = { ref, text: Buffer.from(args[0]).toString('utf8') };
      if (stage === 'artifact') await checkpoint();
    }
    return ref;
  };
  const commit = profile.services.state.commit.bind(profile.services.state);
  profile.services.state.commit = async (...args: Parameters<StateRepository['commit']>) => {
    const result = await commit(...args), prefix = stage === 'intent' ? 'mcp-intent' : stage === 'response' ? 'mcp-response' : stage === 'receive' ? 'receive' : null;
    if (prefix && args[0].commandId === `${prefix}:${attemptId}` && (result.kind === 'committed' || result.kind === 'duplicate')) await checkpoint();
    return result;
  };
  try {
    const accepted = await acceptMcpRequest(profile, 'stored-result-request'); workId = accepted.workId;
    assert.ok(profile.planning);
    const call = await profile.planning.reserve(workId);
    await profile.planning.execute(workId, call.id); assert.equal(await profile.planning.adopt(workId, call.id), true);
    const planned = await profile.runtime.state(workId), task = planned.plan!.tasks.find(value => value.toolId === MCP_AGENT_TOOL);
    assert.ok(task);
    const attempt = await profile.runtime.reserve(workId, task.id); attemptId = attempt.id;
    assert.equal(attempt.leaseUntil - attempt.startedAt, 30_000);
    await profile.runtime.execute(workId, attemptId);
    throw new Error('stored_result_checkpoint_not_reached');
  } finally {
    profile.services.artifacts.put = put; profile.services.state.commit = commit;
    Date.now = realNow; await profile.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
