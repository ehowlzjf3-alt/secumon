import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { initialize, actor, request } from '../session-flow-helpers.js';
import { openAgentLocalProfile, localHistoryPolicy } from '../../presentation/local-profile.js';
import { createMemoryDraft } from '../../presentation/local-memory-drafts.js';
import { rememberPersonal } from '../../presentation/local-personal-memory.js';
export { actor } from '../session-flow-helpers.js';

export const original = '기억의 원래 내용: 간결한 한국어로 답한다.';
export const edited = '  편집한 기억: 먼저 결론을 설명한다.\r\n출처와 한계도 남긴다.\n';
export function editDraft(path: string, title = '새 작성 원칙', body = edited) {
  const temporary = path + '.editor-save';
  writeFileSync(temporary, `---\nsecumon-memory-draft: 1\ntitle: ${JSON.stringify(title)}\n---\n${body}`, { mode: 0o600 });
  renameSync(temporary, path);
}
export async function draftFixture(t: TestContext, backend: 'sqlite' | 'file-journal' = 'sqlite') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'memory-draft-flow-')));
  mkdirSync(join(base, 'engine'), { mode: 0o700 });
  const directory = initialize(base, backend, 'agent', 'documents');
  const hostOptions = { identityRegistryDirectory: join(base, 'registry') };
  let profile = await openAgentLocalProfile(directory, {}, undefined, hostOptions);
  t.after(async () => { await profile.close(); rmSync(base, { recursive: true, force: true }); });
  const session = await profile.sessions!.open(actor, { channel: 'test', conversationId: 'draft-test' });
  const accepted = await profile.sessions!.accept(actor, { sessionId: session.scope.sessionId, rawText: original, request: request('draft-original') });
  await rememberPersonal(profile, actor, { requestId: 'remember-original', id: 'writing-style', title: '원래 작성 원칙',
    source: { kind: 'existing', sessionId: session.scope.sessionId, messageId: 'draft-original', quote: original } });
  const draft = await createMemoryDraft(profile, actor, { draftId: randomUUID(), memoryId: 'writing-style' });
  const input = { draftId: draft.draftId, applyId: randomUUID(), sessionId: session.scope.sessionId, workId: accepted.workId,
    expectedGoalRevision: accepted.state.goal.revision, reason: '파일에서 편집한 내용을 명시적으로 적용' };
  return { base, directory, hostOptions, session, workId: accepted.workId, draft, input, resume: { applyId: input.applyId, sessionId: input.sessionId },
    get profile() { return profile; },
    async reopen() { await profile.close(); profile = await openAgentLocalProfile(directory, {}, undefined, hostOptions); },
    async history() { return profile.sessions!.history(actor, session.scope.sessionId, localHistoryPolicy(profile, actor), { limit: 50 }); } };
}
