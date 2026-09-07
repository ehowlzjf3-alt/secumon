import type { KnowledgeCard, KnowledgeSearch, PersonalMemoryRef } from '../../domain/knowledge.js';
import type { WorkView } from '../../domain/work-view.js';
import type { PersonalRememberInput } from '../local-personal-memory.js';
import { BrowserRequestIdentity } from './view-state.js';
import type { MemoryDraftApplyInput, MemoryDraftStatus } from '../../application/personal-memory-draft-contracts.js';

interface Host {
  request<T>(path: string, body?: unknown): Promise<T>;
  current(): WorkView | null;
  workId(): string | null;
  epoch(): number;
  refresh(): Promise<unknown>;
  errorText(error: unknown): string;
  sessionId(): string | null;
  documentDrafts(): boolean;
}
type Source = Extract<PersonalRememberInput['source'], { kind: 'existing' }>;
type Draft = { id: string; revision: number | null; source: Source | null; workId: string | null; goalRevision: number | null };
type DocumentDraft = { draftId: string; applyId: string; memoryId: string; title: string; baseRevision: number;
  path: string | null; applyInput: MemoryDraftApplyInput | null; complete: boolean };
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const write = (id: string, value: string) => { element(id).textContent = value; };
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className = '') => {
  const value = document.createElement(tag); value.textContent = text; value.className = className; return value;
};

export function memoryDraftStatusText(value: MemoryDraftStatus): string {
  const messages: Record<MemoryDraftStatus['stage'], string> = {
    prepared: '적용 내용을 저장했습니다. 사용자 입력과 기억 반영 상태를 확인해 같은 적용을 재개할 수 있습니다.',
    source_pending: '사용자 입력의 반영이 대기 중입니다. 기억 정정 완료와 구분해 확인합니다.',
    source_rejected: '사용자 입력이 거절됐습니다. 이 적용으로 기억 정정이 완료됐다고 볼 수 없습니다.',
    memory_pending: '사용자 입력은 반영됐고 기억 정정은 아직 완료되지 않았습니다.',
    complete: `이 적용 요청은 기억 버전 ${value.appliedRevision ?? '확인 불가'}로 기록됐습니다.`,
    unchanged: '편집 내용이 기존 기억과 같아 새 정정을 만들지 않았습니다.',
  };
  return messages[value.stage];
}

/** Explicit user commands only: search is not recall and a memory card is not evidence. */
export function installPersonalMemoryUI(host: Host) {
  let draft: Draft | null = null; let pending = false; let searchEpoch = 0; let selectionRead = 0;
  let selection: { workId: string; goalRevision: number; stateRevision: number } | null = null;
  let documentDraft: DocumentDraft | null = null;
  const documentDrafts = new Map<string, DocumentDraft>();
  const identities = new Map<string, BrowserRequestIdentity>();
  const identity = (key: string) => { let value = identities.get(key); if (!value) { value = new BrowserRequestIdentity(); identities.set(key, value); } return value; };
  const opened = () => !element<HTMLDetailsElement>('personal-memory').hidden && element<HTMLDetailsElement>('personal-memory').open;
  const status = (value: string) => write('memory-status', value);
  const documentStatus = (value: string) => write('memory-draft-status', value);
  function documentButtons() {
    element<HTMLButtonElement>('memory-draft-apply').disabled = pending || !documentDraft?.path || documentDraft.complete;
    element<HTMLButtonElement>('memory-draft-check').disabled = pending;
    element<HTMLButtonElement>('memory-draft-resume').disabled = pending;
    element<HTMLInputElement>('memory-draft-reason').readOnly = Boolean(documentDraft?.applyInput);
  }
  function showDocumentDraft(value: DocumentDraft) {
    const same = documentDraft === value; documentDraft = value;
    element('memory-draft-apply-form').hidden = false;
    write('memory-draft-title', `${value.title} · 원래 기억 버전 ${value.baseRevision}`);
    element<HTMLInputElement>('memory-draft-path').value = value.path ?? '';
    element<HTMLInputElement>('memory-draft-id').value = value.draftId;
    element<HTMLInputElement>('memory-draft-apply-id').value = value.applyId;
    element<HTMLInputElement>('memory-draft-lookup').value = value.applyId;
    if (!same) { element<HTMLInputElement>('memory-draft-reason').value = value.applyInput?.reason ?? ''; element('memory-draft-result').hidden = true; }
    write('memory-draft-target', value.applyInput ? `최초 적용 대상: ${value.applyInput.workId} · 목표 ${value.applyInput.expectedGoalRevision}. 같은 요청은 이 대상과 내용을 유지합니다.` : '적용할 진행 중인 업무를 선택하세요. 파일 저장만으로 기억을 바꾸지 않습니다.');
    write('memory-draft-apply', value.applyInput ? '같은 요청 다시 적용' : '현재 업무에 명시 적용');
    documentButtons();
  }
  function showDocumentResult(value: MemoryDraftStatus) {
    documentStatus(memoryDraftStatusText(value));
    const sources: Record<MemoryDraftStatus['sourceStatus'], string> = { not_received: '아직 접수되지 않음', pending: '반영 대기', applied: '반영됨', rejected: '거절됨' };
    const current = value.currentStatus === null ? '확인 불가' : { active: '활성', retracted: '철회', deleted: '잊기 처리' }[value.currentStatus];
    const rows = [['적용 ID', value.applyId], ['초안 ID', value.draftId], ['대상 업무', value.workId], ['기억 ID', value.memoryId],
      ['시작 버전', String(value.baseRevision)], ['이 요청의 반영 버전', value.appliedRevision === null ? '아직 없음' : String(value.appliedRevision)],
      ['현재 기억 버전', value.currentRevision === null ? '확인 불가' : String(value.currentRevision)], ['현재 기억 상태', current],
      ['사용자 입력 상태', sources[value.sourceStatus]], ['원문 메시지 ID', value.sourceMessageId], ...(value.reason ? [['상태 사유', value.reason]] : [])];
    element('memory-draft-result').replaceChildren(...rows.flatMap(([label, value]) => [node('dt', label!), node('dd', value!)]));
    element('memory-draft-result').hidden = false;
    if (documentDraft?.applyId === value.applyId) { documentDraft.complete = ['complete', 'unchanged'].includes(value.stage); documentButtons(); }
  }
  async function beginDocumentDraft(card: KnowledgeCard) {
    if (pending || !host.documentDrafts()) return;
    const key = JSON.stringify([card.id, card.revision]);
    let value = documentDrafts.get(key);
    if (!value || value.complete) { value = { draftId: crypto.randomUUID(), applyId: crypto.randomUUID(), memoryId: card.id, title: card.title,
      baseRevision: card.revision, path: null, applyInput: null, complete: false }; documentDrafts.set(key, value); }
    showDocumentDraft(value);
    if (value.path) { documentStatus('기존 초안과 적용 ID를 다시 표시했습니다. 편집기에서 파일을 저장한 뒤 적용하세요.'); return; }
    const saved = value, epoch = host.epoch(); pending = true; documentButtons(); documentStatus('초안 만들기를 접수했습니다. 경로를 확인합니다.');
    try {
      const result = await host.request<{ draftId: string; path: string; baseRevision: number; title: string }>('/api/memory-drafts/create', { draftId: saved.draftId, memoryId: saved.memoryId });
      if (epoch !== host.epoch()) return;
      saved.path = result.path; saved.baseRevision = result.baseRevision; saved.title = result.title;
      showDocumentDraft(saved); documentStatus('초안을 만들었습니다. 표시된 파일을 사용자 편집기로 열어 수정하고 저장하세요.');
    } catch (error) { if (epoch === host.epoch()) documentStatus(`${host.errorText(error)} 초안 ID를 유지했습니다. 같은 카드의 버튼으로 다시 확인할 수 있습니다.`); }
    finally { pending = false; if (epoch === host.epoch()) documentButtons(); }
  }
  async function refreshAfterDocumentResult() {
    try { await host.refresh(); await search(); await selected(); }
    catch { status('기억 관리 상태는 위에 유지했습니다. 업무 화면은 별도로 새로고침하세요.'); }
  }
  async function applyDocumentDraft() {
    const saved = documentDraft; if (pending || !saved?.path || saved.complete) return;
    if (!saved.applyInput) {
      const sessionId = host.sessionId(), view = host.current();
      const basis = view ?? (selection?.workId === host.workId() ? selection : null);
      if (!sessionId || !basis || basis.workId !== host.workId() || view && ['completed', 'cancelled', 'failed'].includes(view.progress.status)) {
        documentStatus('이 대화에서 입력을 받을 진행 중인 업무를 선택하고 상태를 확인하세요.'); return;
      }
      const reason = element<HTMLInputElement>('memory-draft-reason').value.trim(); if (!reason) return;
      saved.applyInput = { draftId: saved.draftId, applyId: saved.applyId, sessionId, workId: basis.workId, expectedGoalRevision: basis.goalRevision, reason };
    }
    const epoch = host.epoch(); pending = true; showDocumentDraft(saved); documentStatus('명시 적용 요청을 접수했습니다. 원문 반영과 기억 정정 결과를 확인합니다.');
    try {
      const result = await host.request<MemoryDraftStatus>('/api/memory-drafts/apply', saved.applyInput);
      if (epoch !== host.epoch()) return;
      showDocumentResult(result); await refreshAfterDocumentResult();
    } catch (error) { if (epoch === host.epoch()) documentStatus(`${host.errorText(error)} 적용 ID와 최초 대상은 유지했습니다. 상태를 확인하거나 같은 적용을 재개하세요.`); }
    finally { pending = false; if (epoch === host.epoch()) documentButtons(); }
  }
  async function checkDocumentApplication(resume: boolean) {
    if (pending || !host.documentDrafts()) return;
    const sessionId = host.sessionId(), applyId = element<HTMLInputElement>('memory-draft-lookup').value.trim();
    if (!sessionId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(applyId)) { documentStatus('현재 대화와 올바른 적용 ID를 확인하세요.'); return; }
    const epoch = host.epoch(); pending = true; documentButtons(); documentStatus(resume ? '같은 적용 요청을 재개합니다.' : '적용 상태를 확인합니다.');
    try {
      const result = await host.request<MemoryDraftStatus>(resume ? '/api/memory-drafts/resume' : `/api/memory-drafts/status?applyId=${encodeURIComponent(applyId)}&sessionId=${encodeURIComponent(sessionId)}`,
        resume ? { applyId, sessionId } : undefined);
      if (epoch !== host.epoch()) return;
      showDocumentResult(result); if (resume) await refreshAfterDocumentResult();
    } catch (error) { if (epoch === host.epoch()) documentStatus(`${host.errorText(error)} 적용 ID는 유지했습니다.`); }
    finally { pending = false; if (epoch === host.epoch()) documentButtons(); }
  }
  function showDraft(value: Draft, title: string, quote: string) {
    draft = value; element('memory-form').hidden = false;
    element<HTMLInputElement>('memory-title').value = title; element<HTMLTextAreaElement>('memory-quote').value = quote;
    element<HTMLTextAreaElement>('memory-quote').readOnly = value.source !== null;
    element<HTMLInputElement>('memory-reason').value = ''; element<HTMLInputElement>('memory-reason').required = value.revision !== null;
    write('memory-editing', value.revision === null ? '새 개인 기억' : `기억 정정 · 현재 버전 ${value.revision}`);
    write('memory-source', value.source ? `선택한 대화 발언 · ${value.source.messageId}` : '새 발언을 현재 업무에 저장한 뒤 기억합니다.');
    write('memory-save', value.revision === null ? '기억 저장' : '정정 저장');
    element<HTMLDetailsElement>('personal-memory').open = true;
  }
  function chooseSource(source: Omit<Source, 'kind'>) {
    if (pending) return;
    const prior = draft;
    showDraft({ id: prior?.id ?? crypto.randomUUID(), revision: prior?.revision ?? null, source: { kind: 'existing', ...source }, workId: null, goalRevision: null },
      prior ? element<HTMLInputElement>('memory-title').value : '', source.quote);
    status('발언을 선택했습니다. 기억 이름을 확인한 뒤 저장하세요.');
  }
  async function selected() {
    const workId = host.workId(); const epoch = host.epoch(); const read = ++selectionRead;
    selection = null; element<HTMLButtonElement>('memory-clear').disabled = true;
    if (!workId) { selection = null; write('memory-selected', '업무를 선택하면 연결된 기억을 확인합니다.'); return; }
    try {
      const result = await host.request<{ workId: string; goalRevision: number; stateRevision: number; refs: PersonalMemoryRef[]; available: boolean; selectionId: string | null }>(`/api/works/${encodeURIComponent(workId)}/memories`);
      if (epoch !== host.epoch() || host.workId() !== workId || read !== selectionRead) return;
      selection = result;
      element<HTMLButtonElement>('memory-clear').disabled = pending;
      write('memory-selected', !result.available ? '선택한 기억의 버전이나 원문 출처를 재확인해야 합니다. 최신 기억을 검색해 다시 선택하거나 이번 업무의 선택을 해제하세요. 별도로 남은 검토 요청은 업무에서 확인합니다.' :
        result.refs.length ? `이번 업무의 기억: ${result.refs.map(ref => `${ref.id} (버전 ${ref.revision})`).join(', ')}` : '이번 업무에 선택한 개인 기억이 없습니다.');
    } catch (error) { if (epoch === host.epoch() && host.workId() === workId && read === selectionRead) {
      selection = null; element<HTMLButtonElement>('memory-clear').disabled = true; write('memory-selected', host.errorText(error));
    } }
  }
  async function mutate(key: string, path: string, payload: Record<string, unknown>, message: string) {
    if (pending) return false;
    const epoch = host.epoch(); const workId = host.workId(); const requestIdentity = identity(key); const requestId = requestIdentity.forPayload(payload, () => crypto.randomUUID());
    pending = true; element<HTMLButtonElement>('memory-save').disabled = true; status('요청을 접수하고 결과를 확인합니다.');
    try {
      await host.request(path, { ...payload, requestId });
      if (epoch !== host.epoch()) return false;
      requestIdentity.complete(requestId); if (workId !== host.workId()) return true;
      status(message); await host.refresh(); await search(); await selected(); return true;
    } catch (error) {
      if (epoch === host.epoch() && workId === host.workId()) { status(`${host.errorText(error)} 작성한 내용과 요청 식별자는 유지했습니다.`); await host.refresh(); await selected(); }
      return false;
    } finally { pending = false; if (epoch === host.epoch()) { element<HTMLButtonElement>('memory-save').disabled = false; element<HTMLButtonElement>('memory-clear').disabled = !selection || selection.workId !== host.workId(); } }
  }
  async function recall(refs: { id: string; revision: number }[]) {
    if (pending) return;
    const workId = host.workId(), epoch = host.epoch();
    await selected(); if (host.workId() !== workId || host.epoch() !== epoch) return;
    const basis = selection;
    if (!basis || basis.workId !== host.workId()) { status('업무를 선택하고 기억 상태를 새로고침하세요.'); return; }
    await mutate('recall', `/api/works/${encodeURIComponent(basis.workId)}/memories`, { refs, expectedGoalRevision: basis.goalRevision, expectedStateRevision: basis.stateRevision },
      refs.length ? '선택한 기억을 이번 업무에 연결했습니다. 다음 문맥을 만들 때 유효성을 다시 확인합니다.' : '이번 업무의 기억 선택을 해제했습니다. 장기 기억은 유지합니다.');
  }
  function renderCard(card: KnowledgeCard) {
    const item = node('article', '', 'memory-card');
    item.append(node('strong', card.title), node('span', ` · 버전 ${card.revision}`, 'muted'), node('p', card.body), node('p', card.id, 'help-text'));
    const recallButton = node('button', '이번 업무에 사용', 'button secondary'); recallButton.type = 'button';
    recallButton.addEventListener('click', () => { void recall([{ id: card.id, revision: card.revision }]); });
    const revise = node('button', '정정', 'button quiet'); revise.type = 'button';
    revise.addEventListener('click', () => {
      if (pending) return; const view = host.current(); const basis = view ?? (selection?.workId === host.workId() ? selection : null);
      showDraft({ id: card.id, revision: card.revision, source: null, workId: basis?.workId ?? null, goalRevision: basis?.goalRevision ?? null }, card.title, '');
      status('새 발언을 입력하거나 위 대화 기록에서 적용된 발언을 고르세요.');
    });
    const forgetReason = node('input', ''); forgetReason.type = 'text'; forgetReason.maxLength = 1000; forgetReason.placeholder = '잊는 이유'; forgetReason.setAttribute('aria-label', `${card.title} 잊는 이유`);
    const forget = node('button', '잊기', 'button quiet danger'); forget.type = 'button';
    forget.addEventListener('click', () => {
      if (!forgetReason.value.trim()) { status('잊는 이유를 입력하세요.'); forgetReason.focus(); return; }
      void mutate(`forget:${card.id}`, '/api/memories/forget', { id: card.id, expectedRevision: card.revision, reason: forgetReason.value }, '현재 개인 기억에서 제외했습니다. 과거 대화 원문과 기록·백업은 유지됩니다.');
    });
    item.append(recallButton, revise);
    if (host.documentDrafts()) {
      const completed = documentDrafts.get(JSON.stringify([card.id, card.revision]))?.complete === true;
      const create = node('button', completed ? '새 문서 초안 만들기' : '문서 초안 만들기', 'button secondary'); create.type = 'button';
      create.addEventListener('click', () => { void beginDocumentDraft(card); }); item.append(create);
    }
    item.append(forgetReason, forget); return item;
  }
  async function search() {
    if (!opened()) return;
    const epoch = host.epoch(); const read = ++searchEpoch;
    element('memory-cards').replaceChildren();
    try {
      const result = await host.request<Pick<KnowledgeSearch, 'cards' | 'index'>>(`/api/memories?query=${encodeURIComponent(element<HTMLInputElement>('memory-query').value)}`);
      if (epoch !== host.epoch() || read !== searchEpoch) return;
      element('memory-cards').replaceChildren(...result.cards.map(renderCard));
      write('memory-index-status', result.index.complete && result.index.status === 'ready' ? `최대 5개 중 ${result.cards.length}개 표시. 검색만으로 문맥에 넣지 않습니다.` :
        `일부 검색 결과만 확인했습니다 (${result.index.status}). 빈 결과여도 기억이 없다는 뜻은 아닙니다. 새로고침해 다시 확인하세요.`);
    } catch (error) { if (epoch === host.epoch() && read === searchEpoch) { element('memory-cards').replaceChildren(); write('memory-index-status', host.errorText(error)); } }
  }
  element('memory-search-form').addEventListener('submit', event => { event.preventDefault(); void search(); });
  element('memory-draft-apply-form').addEventListener('submit', event => { event.preventDefault(); void applyDocumentDraft(); });
  element('memory-draft-status-form').addEventListener('submit', event => { event.preventDefault(); void checkDocumentApplication(false); });
  element('memory-draft-resume').addEventListener('click', () => { void checkDocumentApplication(true); });
  element('personal-memory').addEventListener('toggle', () => { if (opened()) { void search(); void selected(); } });
  element('memory-refresh').addEventListener('click', () => { void search(); void selected(); });
  element('memory-clear').addEventListener('click', () => { void recall([]); });
  element('memory-new').addEventListener('click', () => {
    if (pending) return; const view = host.current();
    if (!view || ['completed', 'cancelled', 'failed'].includes(view.progress.status)) { status('새 발언을 받을 진행 중인 업무를 선택하세요. 기존 발언은 대화 기록에서 선택할 수 있습니다.'); return; }
    showDraft({ id: crypto.randomUUID(), revision: null, source: null, workId: view.workId, goalRevision: view.goalRevision }, '', '');
  });
  element('memory-dismiss').addEventListener('click', () => { if (!pending) { draft = null; element('memory-form').hidden = true; } });
  element('memory-form').addEventListener('submit', event => {
    event.preventDefault(); if (!draft || pending) return; const saved = draft;
    const title = element<HTMLInputElement>('memory-title').value; const quote = element<HTMLTextAreaElement>('memory-quote').value; const reason = element<HTMLInputElement>('memory-reason').value;
    if (!saved.source && (!saved.workId || !saved.goalRevision || host.workId() !== saved.workId)) { status('새 발언을 저장할 업무가 바뀌었습니다. 발언을 다시 선택하거나 새 편집을 여세요.'); return; }
    const sourceKey = identity(`source:${saved.id}`); const sourcePayload = { id: saved.id, workId: saved.workId, goalRevision: saved.goalRevision, quote };
    const source = saved.source ?? { kind: 'new_input', workId: saved.workId!, expectedGoalRevision: saved.goalRevision!, rawText: quote,
      messageId: sourceKey.forPayload(sourcePayload, () => `memory-source-${crypto.randomUUID()}`) };
    const revise = saved.revision !== null;
    const payload = { id: saved.id, title, source, ...(revise ? { expectedRevision: saved.revision, reason } : {}) };
    void mutate(`save:${saved.id}`, `/api/memories/${revise ? 'revise' : 'remember'}`, payload, revise ? '기억을 정정했습니다. 기존 버전 선택은 다시 확인해야 합니다.' : '선택한 발언을 개인 기억에 저장했습니다.').then(ok => {
      if (ok && draft === saved) { draft = null; element('memory-form').hidden = true; }
    });
  });
  return { chooseSource, refresh: async () => { if (opened()) { await search(); await selected(); } }, clear: () => {
    draft = null; selection = null; selectionRead++; searchEpoch++; identities.clear(); element('memory-cards').replaceChildren(); element('memory-form').hidden = true; element('personal-memory').hidden = true;
    documentDraft = null; documentDrafts.clear(); element('memory-draft-apply-form').hidden = true; element('memory-draft-result').replaceChildren(); element('memory-draft-result').hidden = true;
    element('memory-document-tools').hidden = true; documentStatus(''); write('memory-draft-title', ''); write('memory-draft-target', '');
    for (const id of ['memory-draft-id', 'memory-draft-apply-id', 'memory-draft-path', 'memory-draft-reason', 'memory-draft-lookup']) element<HTMLInputElement>(id).value = '';
    for (const id of ['memory-title', 'memory-quote', 'memory-reason', 'memory-query']) element<HTMLInputElement>(id).value = '';
    write('memory-status', ''); write('memory-selected', ''); write('memory-index-status', '');
  } };
}
