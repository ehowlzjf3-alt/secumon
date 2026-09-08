import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileAgentProfileStore } from '../infrastructure/file-agent-profile.js';
import { openAgentStores } from '../infrastructure/agent-stores.js';
import type { KnoxMessage, KnoxTransport } from '../infrastructure/knox-channel.js';
import { openAgentKnox, type KnoxRoute } from '../presentation/agent-knox.js';
import type { AgentExecutionHost } from '../presentation/host-tools.js';
import { hostEntryFixture, HOST_ENTRY_PROFILE } from './host-tool-entry-fixture.js';

export const KNOX_DESTINATION = 'knox-local-fixture';
export const KNOX_REPLY = '담당에게 등록한 원본 문서의 확인 결과입니다.';
const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));

export function knoxEntryFixture(t: TestContext, backend: 'sqlite' | 'file-journal', idempotentSend = false) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'knox-entry-'))), directory = join(base, 'agent');
  const profiles = new FileAgentProfileStore(runtimeRoot), ready = profiles.initialize(directory);
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...ready.config, model: { profile: HOST_ENTRY_PROFILE },
    storage: { ...ready.config.storage, state: backend } }), { mode: 0o600 });
  const registry = join(base, 'registry'), h = hostEntryFixture({ text: KNOX_REPLY, identityRegistryDirectory: registry });
  const wire = { sends: [] as KnoxMessage[], lookups: [] as KnoxMessage[], unknownSend: false,
    lookup: 'remote' as 'remote' | 'unknown' | 'absent', receipts: new Map<string, string>() };
  const transport: KnoxTransport = { capabilities: { idempotentSend },
    async send(message, signal) {
      assert.equal(signal.aborted, false); wire.sends.push(structuredClone(message));
      let externalId = wire.receipts.get(message.idempotencyKey);
      if (!externalId) { externalId = `fixture-message-${wire.receipts.size + 1}`; wire.receipts.set(message.idempotencyKey, externalId); }
      return wire.unknownSend ? { status: 'unknown' } : { status: 'delivered', externalId };
    },
    async lookup(message, signal) {
      assert.equal(signal.aborted, false); wire.lookups.push(structuredClone(message));
      if (wire.lookup === 'unknown' || wire.lookup === 'absent') return { status: wire.lookup };
      const externalId = wire.receipts.get(message.idempotencyKey);
      return externalId ? { status: 'delivered', externalId } : { status: 'absent' };
    } };
  const host: AgentExecutionHost = { ...h.host, knox: { destination: KNOX_DESTINATION, transport } };
  const opened = new Set<Awaited<ReturnType<typeof openAgentKnox>>>();
  const owner = { tenantId: 'company', principalId: 'operator', agentId: ready.identity.agentId };
  async function open(route: Partial<KnoxRoute> = {}, selectedHost = host) {
    const app = await openAgentKnox(directory, { tenantId: owner.tenantId, principalId: owner.principalId,
      conversationId: 'conversation-a', ...route }, { provider: 'registered' }, selectedHost);
    opened.add(app); return app;
  }
  async function close(app: Awaited<ReturnType<typeof open>>) { await app.close(); opened.delete(app); }
  async function withStores<T>(action: (stores: Awaited<ReturnType<typeof openAgentStores>>) => Promise<T>) {
    const stores = await openAgentStores(profiles, directory, undefined, { identityRegistryDirectory: registry });
    try { return await action(stores); } finally { await stores.close(); }
  }
  async function image(workId: string, sessionId: string) {
    return withStores(async stores => {
      const state = await stores.state.get(workId); assert.ok(state);
      return { state, events: await stores.state.events(workId, 0), deliveries: await stores.state.deliveries(workId),
        session: await stores.sessions.get({ ...owner, sessionId }),
        pending: await stores.sessions.pending({ ...owner, sessionId }, 256),
        history: await stores.sessions.history({ ...owner, sessionId }, state.policy, { limit: 100 }) };
    });
  }
  t.after(async () => {
    const errors: unknown[] = [];
    for (const app of opened) try { await app.close(); } catch (error) { errors.push(error); }
    try { rmSync(base, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'knox_fixture_cleanup_failed');
  });
  return { base, directory, registry, owner, host, observed: h.observed, wire, open, close, withStores, image };
}
