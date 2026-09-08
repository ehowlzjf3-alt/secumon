import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PeerRequest } from '../application/peer-contracts.js';
import { PEER_TOOL_IDS } from '../application/peer-agents.js';
import type { HostPeerContext, HostPeerRegistration, OpenedHostPeers } from '../presentation/host-peers.js';
import { peerProbe } from './peer-service-fixture.js';

export function setPeersFeature(directory: string, enabled: boolean) {
  const path = join(directory, 'config.json'), config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, features: { ...config.features, peers: enabled } }), { mode: 0o600 });
}
export function peerRegistrationProbe() {
  const source = peerProbe(), counts = { opens: 0, closes: 0 }, contexts: HostPeerContext[] = [];
  const controls: { beforeOpen?: () => Promise<void>; beforeClose?: () => Promise<void> } = {};
  const peers = new Map([['reviewer', source.peer]]), allowedTools = [...PEER_TOOL_IDS];
  const lease: OpenedHostPeers = { peers, allowedTools, async close() {
    assert.equal(this, lease); counts.closes++; await controls.beforeClose?.();
  } };
  const registration: HostPeerRegistration = { async open(context) {
    assert.equal(this, registration); counts.opens++; contexts.push(context); await controls.beforeOpen?.(); return lease;
  } };
  return { ...source, registration, lease, peers, allowedTools, counts, contexts, lifecycle: controls };
}
export function registrationRequest(context: HostPeerContext): PeerRequest {
  return { schemaVersion: 1, id: 'registration-request', kind: 'consult', text: 'Check the bound peer callback.',
    from: { agentId: context.agentId, tenantId: context.policy.tenantId, principalId: context.policy.principalId,
      workId: 'caller-work', goalRevision: 1, planRevision: 0 }, policyDigest: 'a'.repeat(64), generation: 0,
    labels: ['public'], deadlineAt: 10000, target: null };
}
