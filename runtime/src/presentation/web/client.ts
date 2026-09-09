import type { Criterion, Mode } from '../../domain/model.js';
import type { WorkView, WorkViewLevel, WorkViewResult } from '../../domain/work-view.js';
import type { WebAcceptInput, WebAcceptResult, WebAttachResult, WebCommandInput, WebCommandResult, WebCompactStatus, WebCompactResult, WebConversation, WebInput, WebGoalBasis, WorkbenchConfig, WorkCard, WorkList } from '../web-contracts.js';
import { BrowserReadQueue, BrowserRequestIdentity, compactStatusText, receiveCompactStatus, coalescedRefresh, goalDraftFromView, goalDraftIsStale, goalForSubmission, messageKey, nearConversationEnd, needsResultRecheck, newBrowserWork, receiveWorkView, unavailableWork, type BrowserGoalDraft, type BrowserWorkState } from './view-state.js';
import { installPersonalMemoryUI } from './personal-memory.js';
import { installResidentMissionsUI } from './resident-missions.js';
import { requestGoalDraft, requestGoalForSubmission, sourceReadFailure, type BrowserRequestGoalDraft } from './view-state.js';

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id); if (!value) throw new Error('missing_ui_element'); return value as T;
}
function text(id: string, value: string) { const target = element(id); if (target.textContent !== value) target.textContent = value; }
function node<K extends keyof HTMLElementTagNameMap>(tag: K, content = '', className = '') {
  const value = document.createElement(tag); value.textContent = content; value.className = className; return value;
}
const modeNames: Record<Mode, string> = { auto: '자동', fast: '빠르게', deep: '깊게' };
const statuses: Record<string, string> = { ready: '실행 대기', running: '자료 확인 중', waiting: '응답·전달 대기', paused: '일시 정지', blocked: '진행 제한', cancelled: '취소됨', failed: '실패', completed: '완료' };
const deliveryNames: Record<string, string> = { pending: '로컬 저장 대기', sending: '로컬 저장 확인 중', unknown: '저장 여부 미확인', delivered: '로컬 저장 확인', failed: '로컬 저장 실패', superseded: '이전 버전', not_prepared: '답변 미준비', unavailable: '답변 재확인 필요' };
const states = new Map<string, BrowserWorkState>(); const cards = new Map<string, WorkCard>();
const cardNodes = new Map<string, HTMLButtonElement>(); const messageNodes = new Map<string, HTMLElement>();
const answerDrafts = new Map<string, string>(); const runs = new Set<string>();
const pendingDrafts = new WeakSet<object>();
const viewReads = new BrowserReadQueue();
const acceptIdentity = new BrowserRequestIdentity();
const inputIdentity = new BrowserRequestIdentity();
const compactIdentity = new BrowserRequestIdentity();
const compactRequests = new Set<string>();
const contextStates = new Map<string, WebCompactStatus>();
let historyCursor: string | null = null; let historyReading = false; let persistentSessionId: string | null = null;
let csrf = ''; let config: WorkbenchConfig | null = null; let selectedId: string | null = null;
let selectionEpoch = 0; let sessionEpoch = 0; let stream: EventSource | null = null; let nextCursor: string | null = null;
let listEpoch = 0; let modeDraft: { workId: string; goalRevision: number; controlRevision: number } | null = null;
let goalDraft: BrowserGoalDraft | BrowserRequestGoalDraft | null = null;
const goalRetries = new WeakMap<BrowserRequestGoalDraft, Extract<WebCommandInput, { kind: 'request-goal' }>>();
let lastAnnouncement = ''; let questionSignature = ''; let detailsLoading: object | null = null; let diagnosticsLoading: object | null = null;
let connectionToken = new URLSearchParams(location.hash.slice(1)).get('connect');
type NoticeKind = 'action' | 'read' | 'connection';
let noticeKind: NoticeKind = 'action';
if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);

class RequestError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const knownErrors: Record<string, string> = {
  stale_session_input: '편집 중 새 입력이 들어왔습니다. 작성한 내용은 유지했습니다. 최신 기준을 다시 읽어 주세요.',
  stale_work_policy: '업무 권한이 바뀌었습니다. 현재 상태를 다시 확인해 주세요.',
  work_unavailable: '이 업무를 현재 대화에서 볼 수 없습니다.', work_view_unavailable: '현재 권한으로 업무를 표시할 수 없습니다.',
  stale_goal: '목표가 바뀌었습니다. 최신 상태를 확인한 뒤 다시 요청해 주세요.', goal_revision_conflict: '목표가 바뀌었습니다. 작성한 내용은 유지했습니다.',
  stale_control: '진행 방식이 바뀌었습니다. 최신 상태를 확인해 주세요.', workbench_run_active: '이 업무는 이미 실행 중입니다.',
  work_view_contention: '업무가 갱신되고 있습니다. 잠시 뒤 새로고침해 주세요.',
  work_view_knowledge_changed: '연결된 기억이나 출처의 최신성을 확인할 수 없어 이전 답변을 숨겼습니다. 개인 기억 상태를 확인해 재선택하거나 이번 업무의 선택을 해제해 주세요.',
  knowledge_source_unavailable: '기억의 원문 출처를 확인할 수 없습니다. 원문 상태와 접근 범위를 확인해 주세요.',
  personal_memory_selection_stale: '기억 선택을 확인하는 동안 업무가 바뀌었습니다. 기억 상태를 새로고침해 주세요.',
  personal_memory_changed: '기억이나 원문 출처가 바뀌었습니다. 현재 기억을 확인한 뒤 다시 선택해 주세요.',
  stale_user_command: '목표가 바뀌었습니다. 작성한 내용은 유지했습니다. 최신 상태를 확인한 뒤 다시 요청해 주세요.',
  stale_execution_control: '진행 방식이 바뀌었습니다. 작성한 내용은 유지했습니다. 현재 상태를 확인해 주세요.',
  web_list_cursor_invalid: '목록 조회 위치가 만료되었거나 현재 연결과 다릅니다. 목록 새로고침으로 다시 확인해 주세요.',
  idempotency_conflict: '같은 요청 식별자로 다른 내용이 도착했습니다. 현재 상태를 먼저 확인해 주세요.',
  session_text_required: '실제 요청 원문을 입력해 주세요.', session_work_unavailable: '이 업무의 대화 연결을 확인할 수 없습니다.',
  session_context_capacity: '현재 문맥의 용량을 넘었습니다. 원문은 유지됩니다. 문맥 정리 설정과 상태를 확인해 주세요.',
  session_compact_capacity: '이번 정리 입력도 용량을 넘었습니다. 원문은 유지됩니다. 설정을 확인해야 합니다.',
  session_compact_unavailable: '요약기가 연결되지 않았습니다. 원문은 유지되며 새 요약을 만들지 않았습니다.',
  session_compact_pending: '문맥 정리를 진행 중입니다. 완료 상태를 확인한 뒤 실행을 이어갈 수 있습니다.',
  session_compact_failed: '문맥 정리를 반영하지 못했습니다. 원문과 기존 요약은 유지됩니다.',
  session_current_input_unavailable: '현재 입력의 원문과 접근 권한을 확인할 수 없습니다. 이력은 자동 삭제하지 않습니다.',
  knowledge_revision_conflict: '기억의 버전이 바뀌었습니다. 최신 기억을 확인한 뒤 다시 요청해 주세요.',
  personal_memory_revision_changed: '선택한 기억의 버전이 바뀌었습니다. 검색 결과를 새로고침하세요.',
  personal_memory_state_changed: '업무 입력이나 상태가 바뀌었습니다. 최신 상태에서 기억을 다시 선택하세요.',
  knowledge_command_conflict: '같은 요청 식별자로 다른 기억 변경이 도착했습니다. 처리 상태를 확인하세요.',
  knowledge_contention: '기억이나 출처가 변경 중입니다. 최신 상태를 확인한 뒤 다시 요청해 주세요.',
  personal_memory_draft_operation_missing: '아직 접수된 적용 요청이 없습니다. 최초 적용 응답이 끊겼다면 같은 초안과 적용 ID로 다시 적용하세요.',
  personal_memory_draft_missing: '초안 파일을 찾을 수 없습니다. 기존 초안 ID와 파일을 확인하세요.',
  personal_memory_draft_invalid: '초안 형식이나 저장된 정보를 확인할 수 없습니다. 표시된 파일 형식을 확인하세요.',
  personal_memory_draft_conflict: '같은 ID에 다른 내용이 연결돼 있습니다. 새 ID를 만들기 전에 기존 적용 상태를 확인하세요.',
  personal_memory_draft_source_conflict: '적용 요청과 사용자 원문 기록이 일치하지 않습니다. 같은 ID를 유지하고 원본을 확인해야 합니다.',
  personal_memory_draft_outcome_unknown: '원문 또는 기억의 반영 결과를 확정하지 못했습니다. 같은 적용 ID로 상태를 확인하세요.',
  personal_memory_draft_contention: '초안 파일이 변경 중입니다. 편집기 저장을 마친 뒤 같은 요청으로 확인하세요.',
  personal_memory_draft_limit_exceeded: '초안 저장 한도를 넘었습니다. 기존 초안과 적용 기록을 확인하세요.',
};
function errorText(error: unknown): string {
  if (error instanceof RequestError) {
    if (error.status === 401) return '연결이 만료되었습니다. 서버가 표시한 새 연결 주소로 열어 주세요.';
    if (sourceReadFailure(error.code)) return knownErrors[error.code]!;
    if (error.status === 403) return '현재 연결의 권한으로 이 요청을 처리할 수 없습니다.';
    if (error.status === 429) return '조회가 많습니다. 잠시 뒤 다시 확인해 주세요.';
    return knownErrors[error.code] ?? `요청을 처리하지 못했습니다. ${/^[a-z][a-z0-9_]{0,90}$/.test(error.code) ? `(${error.code})` : ''}`;
  }
  return '연결을 확인하지 못했습니다. 같은 명령을 자동으로 다시 보내지 않습니다.';
}
function announce(value: string) { if (lastAnnouncement !== value) { lastAnnouncement = value; text('announcer', value); } }
function connection(value: string, connected: boolean) { text('connection', value); element('connection').dataset.connected = String(connected); }
function notice(value: string, kind: NoticeKind = 'action') { noticeKind = kind; text('work-notice', value); }
function selectionKey() {
  const agentId = config?.persistentSession?.agentId;
  return agentId && persistentSessionId ? `work-selection:${JSON.stringify([agentId, persistentSessionId])}` : null;
}
function rememberSelection(id: string) {
  const key = selectionKey(); if (!key) return;
  try { sessionStorage.setItem(key, id); } catch { /* Selection is optional when browser storage is unavailable. */ }
}
function rememberedSelection(): string | null {
  const key = selectionKey(); if (!key) return null;
  try {
    const id = sessionStorage.getItem(key);
    return id && id.length <= 256 && !/[\x00-\x1f\x7f/]/.test(id) ? id : null;
  } catch { return null; }
}
function expireSession() {
  sessionEpoch++; selectionEpoch++; viewReads.invalidate(); detailsLoading = null; diagnosticsLoading = null; csrf = ''; stream?.close(); stream = null;
  for (const [id, state] of states) states.set(id, unavailableWork(state));
  cards.clear(); cardNodes.clear(); nextCursor = null; element('work-list').replaceChildren(); renderListSummary(); discardProtectedForms();
  element('session-notice').hidden = false; text('session-notice', '연결이 만료되었습니다. 서버가 표시한 새 연결 주소로 다시 열어 주세요. 업무는 취소되지 않았습니다.');
  connection('연결 필요', false); clearVisibleWork();
  element('history-list').replaceChildren(); element('persistent-conversation').hidden = true; historyCursor = null; persistentSessionId = null; contextStates.clear();
  memoryUI.clear();
  residentUI.clear();
}
function discardProtectedForms() {
  element<HTMLDialogElement>('goal-dialog').close(); element<HTMLDialogElement>('mode-dialog').close(); goalDraft = null; modeDraft = null;
  element<HTMLTextAreaElement>('goal-title').value = ''; element('criteria-list').replaceChildren();
}
async function request<T>(path: string, body?: unknown, connecting = false): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(connecting ? {} : { 'X-Work-CSRF': csrf }) }, body: JSON.stringify(body),
  }) });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const object = value && typeof value === 'object' ? value as { code?: unknown; error?: { code?: unknown } | string } : {};
    const code = typeof object.code === 'string' ? object.code : typeof object.error === 'string' ? object.error : typeof object.error?.code === 'string' ? object.error.code : 'request_failed';
    if (response.status === 401 && !connecting) expireSession();
    throw new RequestError(response.status, code);
  }
  return value as T;
}
function current() { return selectedId ? states.get(selectedId)?.current ?? null : null; }
function clearVisibleWork() {
  messageNodes.clear(); element('message-list').replaceChildren(); element('details-content').replaceChildren(); element('diagnostics-content').replaceChildren();
  element('answer-form').hidden = true; element('new-messages').hidden = true; element('conversation-empty').hidden = false;
  element('input-form').hidden = true;
  element('review-memory').hidden = true;
  element('context-panel').hidden = true; text('context-status', ''); text('context-reference', '');
  text('work-title', '현재 내용을 확인할 수 없습니다.'); text('work-status', '조회 중단'); text('work-mode', ''); text('work-delivery', ''); text('reply-route', ''); text('updated-at', '');
  for (const id of ['run', 'pause', 'resume', 'cancel', 'edit-mode', 'edit-goal']) element<HTMLButtonElement>(id).disabled = true;
}
function invalidate(id: string, reason: string, source = false) {
  listEpoch++;
  const state = states.get(id); if (state) states.set(id, unavailableWork(state));
  cards.delete(id); cardNodes.get(id)?.remove(); cardNodes.delete(id);
  renderListSummary();
  if (selectedId === id) {
    selectionEpoch++; viewReads.invalidate(); detailsLoading = null; diagnosticsLoading = null; stream?.close(); stream = null;
    discardProtectedForms(); clearVisibleWork(); text('work-ref', id); notice(reason, 'read');
    text('work-title', source ? '기억·원문 재확인 필요' : '현재 내용을 확인할 수 없습니다.');
    element('review-memory').hidden = !source || !config?.persistentSession;
    connection(source ? '원문 재확인 필요' : '현재 조회 불가', false);
  }
}
function card(card: WorkCard) {
  cards.set(card.workId, card); let button = cardNodes.get(card.workId);
  if (!button) { button = node('button', '', 'work-card'); button.type = 'button'; button.dataset.workId = card.workId;
    button.append(node('div', '', 'work-card-title'), node('div', '', 'work-card-meta'));
    button.addEventListener('click', () => { void selectWork(card.workId); }); cardNodes.set(card.workId, button); element('work-list').append(button); }
  button.setAttribute('aria-current', String(card.workId === selectedId)); button.querySelector('.work-card-title')!.textContent = card.title;
  button.querySelector('.work-card-meta')!.textContent = `${needsResultRecheck(card) ? '결과 재확인 필요' : statuses[card.progress.status] ?? card.progress.status} · ${modeNames[card.mode.requested]}`;
  renderListSummary();
}
function renderListSummary() {
  element('more-works').hidden = !nextCursor; element('list-empty').hidden = cards.size > 0;
  text('list-empty', selectedId && states.get(selectedId)?.unavailable ? '선택한 업무의 내용을 현재 확인할 수 없습니다. 업무 화면의 안내를 확인해 주세요.' :
    nextCursor ? '이 페이지에는 표시할 업무가 없습니다. 더 보기를 눌러 계속 확인하세요.' : '아직 업무가 없습니다. 위에서 첫 업무를 접수하세요.');
  text('list-count', `${cards.size}개`);
}
async function loadWorks(more = false) {
  const epoch = ++listEpoch; const auth = sessionEpoch;
  try {
    const result = await request<WorkList>(`/api/works${more && nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : ''}`);
    if (epoch !== listEpoch || auth !== sessionEpoch) return;
    if (!more) { const ids = new Set(result.items.map(item => item.workId)); for (const [id, button] of cardNodes) if (!ids.has(id)) { button.remove(); cardNodes.delete(id); cards.delete(id); } }
    result.items.forEach(card); nextCursor = result.nextCursor;
    renderListSummary();
  } catch (error) { text('list-empty', errorText(error)); element('list-empty').hidden = false; }
}
function acceptView(id: string, result: WorkViewResult, generation: number, level: WorkViewLevel) {
  const state = states.get(id); if (!state) return false;
  const next = receiveWorkView(state, result, generation, level); if (next === state) return false;
  states.set(id, next);
  if (next.current) card(next.current);
  if (selectedId === id) {
    renderWork(next.current!); element('review-memory').hidden = true;
    if (noticeKind === 'read' || noticeKind === 'connection') notice('');
    connection('연결됨', true);
  }
  return true;
}
async function readView(level: WorkViewLevel = 'conversation', force = false): Promise<WorkView | null> {
  const id = selectedId; if (!id) return null;
  const epoch = selectionEpoch; const auth = sessionEpoch;
  return viewReads.enqueue(async () => {
    if (selectedId !== id || epoch !== selectionEpoch || auth !== sessionEpoch) return null;
    const state = states.get(id)!; const generation = state.generation; const cursor = force ? undefined : state.cursors[level];
    try {
      const result = await request<WorkViewResult>(`/api/works/${encodeURIComponent(id)}/view?level=${level}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (selectedId !== id || selectionEpoch !== epoch || sessionEpoch !== auth) return null;
      acceptView(id, result, generation, level);
      return states.get(id)?.views[level] ?? null;
    } catch (error) {
      if (selectedId !== id || epoch !== selectionEpoch || auth !== sessionEpoch) return null;
      if (error instanceof RequestError && (sourceReadFailure(error.code) || [401, 403, 404].includes(error.status)))
        invalidate(id, errorText(error), sourceReadFailure(error.code));
      else notice(errorText(error), 'read');
      return null;
    }
  }, null);
}
function connectStream(id: string) {
  stream?.close(); const epoch = selectionEpoch; const auth = sessionEpoch; const cursor = states.get(id)?.cursors.conversation;
  const source = new EventSource(`/api/works/${encodeURIComponent(id)}/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`); stream = source;
  const active = () => stream === source && selectedId === id && selectionEpoch === epoch && sessionEpoch === auth;
  const refresh = coalescedRefresh(async () => { await readView('conversation', true); if (active()) await refreshExtras(); }, active);
  source.addEventListener('open', () => { if (active()) { connection('연결됨', true); if (noticeKind === 'connection') notice(''); } });
  source.addEventListener('view', event => {
    if (!active()) return;
    try {
      const result = JSON.parse((event as MessageEvent<string>).data) as WorkViewResult;
      if (result.kind !== 'snapshot' || result.view.workId !== id || result.view.level !== 'conversation') throw new Error('invalid_stream_snapshot');
      void refresh('view');
    } catch { invalidate(id, '현재 상태를 읽을 수 없습니다. 새로고침해 주세요.'); }
  });
  source.addEventListener('unchanged', () => { if (active()) { connection('연결됨', true); void refresh('unchanged'); } });
  source.addEventListener('context-status', event => {
    if (!active()) return;
    try {
      const status = JSON.parse((event as MessageEvent<string>).data) as WebCompactStatus;
      if (status.workId !== id) return;
      const next = receiveCompactStatus(contextStates.get(id), status); contextStates.set(id, next); renderContext(next);
    } catch { text('context-status', '문맥 상태를 확인하지 못했습니다. 원문 이력은 유지됩니다.'); }
  });
  source.addEventListener('unavailable', event => {
    if (!active()) return;
    try { if ((JSON.parse((event as MessageEvent<string>).data) as { code?: string }).code === 'session_expired') { expireSession(); return; } } catch { /* Treat unreadable unavailability as a closed boundary. */ }
    invalidate(id, '현재 자료나 접근 상태를 확인할 수 없어 이전 답변을 숨겼습니다. 상태를 다시 확인합니다.');
    // The stream hides detailed failures. Read the existing view endpoint before choosing a source/access explanation.
    const pendingEpoch = selectionEpoch;
    void readView('conversation', true).then(view => { if (view && selectedId === id && selectionEpoch === pendingEpoch) connectStream(id); });
  });
  source.addEventListener('error', () => { if (active()) {
    connection('재연결 중', false); notice('연결이 끊어져 마지막 확인 상태를 표시합니다. 업무를 취소하지 않았습니다.', 'connection');
    void refresh('view');
  } });
}
async function selectWork(id: string) {
  if (selectedId) answerDrafts.set(selectedId, element<HTMLTextAreaElement>('answer-text').value);
  selectionEpoch++; viewReads.invalidate(); detailsLoading = null; diagnosticsLoading = null; stream?.close(); stream = null; discardProtectedForms(); selectedId = id;
  rememberSelection(id);
  if (!states.has(id)) states.set(id, newBrowserWork(id)); else states.set(id, { ...states.get(id)!, generation: states.get(id)!.generation + 1 });
  questionSignature = ''; messageNodes.clear(); element('message-list').replaceChildren();
  element<HTMLTextAreaElement>('answer-text').value = answerDrafts.get(id) ?? '';
  element<HTMLTextAreaElement>('input-text').value = '';
  element('empty-work').hidden = true; element('selected-work').hidden = false;
  for (const [workId, button] of cardNodes) button.setAttribute('aria-current', String(workId === id));
  clearVisibleWork(); text('work-title', cards.get(id)?.title ?? '업무를 불러오는 중'); text('work-ref', id); notice('');
  const epoch = selectionEpoch; await readView('conversation', true);
  if (selectedId !== id || epoch !== selectionEpoch || !current()) return;
  connectStream(id); void refreshExtras(); void memoryUI.refresh();
}
function renderMessages(view: WorkView) {
  const container = element('conversation'); const stick = nearConversationEnd(container.scrollTop, container.scrollHeight, container.clientHeight);
  const wanted = new Set<string>(); let added = false;
  for (const message of view.messages) {
    const key = messageKey(view, message); wanted.add(key); let article = messageNodes.get(key);
    if (!article) { article = node('article', '', 'message'); article.dataset.kind = message.kind; article.append(node('div', '', 'message-label'), node('div', '', 'message-body'));
      messageNodes.set(key, article); element('message-list').append(article); added = true; }
    const name = { ack: '접수', question: '확인이 필요해요', result: '작업 결과', failure: '진행 안내' }[message.kind];
    const label = article.querySelector('.message-label')!; label.textContent = name;
    if (message.deliveryStatus !== 'delivered') label.append(node('span', `준비된 내용 · ${deliveryNames[message.deliveryStatus] ?? '전달 여부 미확인'}`, 'delivery-note'));
    const body = article.querySelector('.message-body')!; if (body.textContent !== message.text) body.textContent = message.text;
  }
  for (const [key, article] of messageNodes) if (!wanted.has(key)) { article.remove(); messageNodes.delete(key); }
  element('conversation-empty').hidden = view.messages.length > 0;
  if (stick) { container.scrollTop = container.scrollHeight; element('new-messages').hidden = true; }
  else if (added) element('new-messages').hidden = false;
  if (added) announce('업무에 새 메시지가 있습니다.');
}
function renderQuestions(view: WorkView) {
  const questions = view.questions ?? []; const signature = JSON.stringify(questions); const choice = element<HTMLSelectElement>('question-choice');
  if (signature !== questionSignature) { const previous = choice.value; choice.replaceChildren(...questions.map(question => { const option = node('option', question.reason); option.value = question.id; return option; }));
    if (questions.some(question => question.id === previous)) choice.value = previous; questionSignature = signature; }
  element('answer-form').hidden = !questions.length || ['cancelled', 'failed'].includes(view.progress.status);
}
function renderWork(view: WorkView) {
  text('work-title', view.title); text('work-ref', `${view.workId} · 목표 ${view.goalRevision}`);
  text('reply-route', view.reply.observingPrimary ? '이 대화에서 답변을 확인합니다.' : `다른 대화(${view.reply.channel})의 업무를 보고 있습니다. 기본 답변 경로는 유지됩니다.`);
  text('work-status', needsResultRecheck(view) ? '결과 재확인 필요' : statuses[view.progress.status] ?? view.progress.status);
  element('work-status').dataset.state = needsResultRecheck(view) ? 'waiting' : view.progress.status;
  text('work-mode', `${modeNames[view.mode.requested]}${view.mode.pending ? ` → ${modeNames[view.mode.pending]} 변경 대기` : ''}`);
  text('work-delivery', deliveryNames[view.progress.resultDelivery] ?? view.progress.resultDelivery);
  text('updated-at', `확인 ${new Date(view.progress.updatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`);
  renderMessages(view); renderQuestions(view);
  element('input-form').hidden = !config?.persistentSession || ['completed', 'cancelled', 'failed'].includes(view.progress.status);
  element<HTMLButtonElement>('run').disabled = runs.has(view.workId) || ['cancelled', 'failed', 'paused', 'completed'].includes(view.progress.status);
  text('run', runs.has(view.workId) ? '실행 중…' : '실행');
  element<HTMLButtonElement>('pause').disabled = ['paused', 'cancelled', 'failed'].includes(view.progress.status);
  element<HTMLButtonElement>('resume').disabled = view.progress.status !== 'paused';
  const immutable = ['cancelled', 'failed'].includes(view.progress.status);
  element<HTMLButtonElement>('cancel').disabled = immutable;
  element<HTMLButtonElement>('edit-mode').disabled = immutable || view.progress.status === 'completed';
  element<HTMLButtonElement>('edit-goal').disabled = immutable;
  element('context-panel').hidden = !config?.persistentSession;
  const context = contextStates.get(view.workId); if (context) renderContext(context); else {
    text('context-status', '문맥 정리 상태를 확인합니다.');
    element<HTMLButtonElement>('compact').disabled = !config?.compactProvider || ['paused', 'completed', 'cancelled', 'failed'].includes(view.progress.status);
  }
  if (view.details) renderDetails(view); else if (element<HTMLDetailsElement>('details-disclosure').open) text('details-content', '최신 상세를 확인하고 있습니다.');
  if (view.diagnostics) renderDiagnostics(view); else if (element<HTMLDetailsElement>('diagnostics-disclosure').open) text('diagnostics-content', '최신 진단을 확인하고 있습니다.');
  updateGoalGuard(view);
  if (modeDraft?.workId === view.workId && (modeDraft.goalRevision !== view.goalRevision || modeDraft.controlRevision !== view.mode.revision)) text('mode-error', '업무나 진행 방식이 바뀌었습니다. 작성한 이유는 유지했습니다. 현재 상태를 확인한 뒤 다시 열어 주세요.');
}
function renderContext(status: WebCompactStatus) {
  if (status.workId !== selectedId || !config?.persistentSession) return;
  text('context-status', compactStatusText(status));
  text('context-reference', status.summary ? `요약 ${status.summary.revision} · ${status.summary.throughSequence}번 기록까지 · 참조 ${status.summary.id}` : '아직 적용된 요약 참조가 없습니다.');
  text('compact-provider-note', config.compactProvider === 'registered' ?
    (config.modelInfo?.execution === 'deterministic_fixture' ? '등록된 로컬 전송 대역의 정해진 요약 규칙을 시험합니다. 실제 모델/API는 호출하지 않습니다.' : '호스트에 등록된 요약기를 사용합니다. 원문 이력은 계속 저장합니다.') :
    config.compactProvider === 'synthetic' ? "합성 규칙 시험 전용입니다. work/input은 '[합성 예제]'로 시작하며 ‘외부 전송 금지 · 원문 보존 · 검증 후 완료’만 구조화합니다. 실제 모델의 의미 보존 품질을 검증한 것은 아닙니다." : '요약기가 연결되지 않았습니다. 원문 이력은 계속 저장합니다.');
  element<HTMLButtonElement>('compact').disabled = !config.compactProvider || compactRequests.has(status.workId) || ['queued', 'running', 'validating'].includes(status.stage) ||
    ['paused', 'completed', 'cancelled', 'failed'].includes(current()?.progress.status ?? 'failed');
}
function updateGoalGuard(view: WorkView | null) {
  if (!goalDraft || goalDraft.workId !== selectedId) return;
  if ('expectedInput' in goalDraft && goalRetries.has(goalDraft)) {
    element('goal-form').querySelector<HTMLButtonElement>('button[type=submit]')!.disabled = pendingDrafts.has(goalDraft); return;
  }
  const stale = goalDraftIsStale(goalDraft, view);
  element('goal-form').querySelector<HTMLButtonElement>('button[type=submit]')!.disabled = stale || pendingDrafts.has(goalDraft);
  if (stale) text('goal-error', '목표 또는 진행 방식이 바뀌었습니다. 작성한 내용은 유지했습니다. ‘입력 유지하고 최신 기준 읽기’로 현재 방식을 확인한 뒤 제출해 주세요.');
}
function section(title: string, items: { title: string; body: string }[]) {
  const group = node('section', '', 'detail-section'); group.append(node('h4', title));
  if (!items.length) group.append(node('p', '아직 없습니다.', 'muted'));
  for (const item of items) { const row = node('div', '', 'detail-item'); row.append(node('strong', item.title), node('p', item.body)); group.append(row); }
  return group;
}
function renderDetails(view: WorkView) {
  const detail = view.details; if (!detail) return;
  const target = element('details-content'); target.replaceChildren(
    section('현재 목표', [{ title: detail.goal.description, body: `자료 범위: ${detail.goal.scope}` }]),
    section('실행 계획', detail.plan?.tasks.map(task => ({ title: task.description, body: `${task.status} · ${task.toolId}` })) ?? []),
    section('가설과 검토', detail.hypotheses.map(hypothesis => ({ title: hypothesis.claim, body: hypothesis.reviewRequired ? '근거가 바뀌어 다시 검토해야 합니다.' : `${hypothesis.status ?? '미평가'} · 지지 ${hypothesis.supportCount ?? 0} · 반증 ${hypothesis.counterCount ?? 0}` }))),
    section('근거', detail.evidence.map(evidence => ({ title: evidence.sourceId, body: `${evidence.coverage} · ${evidence.locator}` }))),
  );
  if (Object.values(detail.omitted).some(count => count > 0)) target.append(node('p', `표시 생략: 계획 ${detail.omitted.tasks} · 가설 ${detail.omitted.hypotheses} · 근거 ${detail.omitted.evidence}`, 'help-text'));
}
function renderDiagnostics(view: WorkView) {
  const diagnostics = view.diagnostics; if (!diagnostics) return;
  element('diagnostics-content').replaceChildren(section('최근 실행 사건', diagnostics.events.map(event => ({ title: `${event.sequence}. ${event.type}`, body: `상태 ${event.revision} · ${new Date(event.at).toLocaleTimeString('ko-KR')}` }))));
  if (diagnostics.omittedEvents) element('diagnostics-content').append(node('p', `${diagnostics.omittedEvents}개 이전 사건은 생략했습니다.`, 'help-text'));
}
async function refreshExtras() {
  const epoch = selectionEpoch;
  if (element<HTMLDetailsElement>('details-disclosure').open && !detailsLoading) {
    const ticket = {}; detailsLoading = ticket;
    try { await readView('details'); } finally { if (detailsLoading === ticket) detailsLoading = null; }
  }
  if (epoch !== selectionEpoch) return;
  if (element<HTMLDetailsElement>('diagnostics-disclosure').open && !diagnosticsLoading) {
    const ticket = {}; diagnosticsLoading = ticket;
    try { await readView('diagnostics'); } finally { if (diagnosticsLoading === ticket) diagnosticsLoading = null; }
  }
}
async function sendCommand(id: string, command: WebCommandInput) {
  const epoch = selectionEpoch; const auth = sessionEpoch;
  if (command.kind === 'run') { runs.add(id); if (current()?.workId === id) renderWork(current()!); }
  try {
    const result = await request<WebCommandResult>(`/api/works/${encodeURIComponent(id)}/commands`, command);
    if (auth !== sessionEpoch) return result;
    if (selectedId === id && epoch === selectionEpoch) { notice(result.duplicate ? '저장된 요청을 다시 확인했습니다. 현재 상태를 확인합니다.' : '요청을 반영했습니다.'); await readView('conversation', true); void refreshExtras(); }
    void loadWorks(); void loadHistory(); return result;
  } catch (error) {
    if (selectedId === id && epoch === selectionEpoch && auth === sessionEpoch) { notice(errorText(error)); await readView('conversation', true); }
    throw error;
  } finally { if (command.kind === 'run') { runs.delete(id); if (current()?.workId === id) renderWork(current()!); } }
}
function nextRequestId() { return crypto.randomUUID(); }
const residentUI = installResidentMissionsUI({ request, epoch: () => sessionEpoch, nextId: nextRequestId, errorText,
  errorCode: error => error instanceof RequestError ? error.code : null, storage: () => sessionStorage });
const memoryUI = installPersonalMemoryUI({ request, current, workId: () => selectedId, epoch: () => sessionEpoch, errorText,
  sessionId: () => persistentSessionId, documentDrafts: () => config?.memoryDrafts === true,
  writable: () => config?.personalMemoryWritable === true,
  refresh: async () => { const view = await readView('conversation', true); if (view && selectedId === view.workId && !stream) connectStream(view.workId); await loadHistory(); await loadWorks(); } });
element('review-memory').addEventListener('click', () => {
  element<HTMLDetailsElement>('personal-memory').open = true;
  element('personal-memory').scrollIntoView({ block: 'nearest' }); void memoryUI.refresh();
});
async function loadHistory(more = false) {
  if (!config?.persistentSession || historyReading || !element<HTMLDetailsElement>('persistent-conversation').open) return;
  const auth = sessionEpoch; historyReading = true;
  try {
    const page = await request<WebConversation>(`/api/conversation${more && historyCursor ? `?cursor=${encodeURIComponent(historyCursor)}` : ''}`);
    if (auth !== sessionEpoch) return;
    if (!more) element('history-list').replaceChildren();
    persistentSessionId = page.sessionId; text('persistent-session-id', page.sessionId);
    for (const entry of page.entries) {
      const item = node('article', '', 'history-entry');
      item.append(node('strong', entry.role === 'user' ? '사용자' : '담당'), node('span', ` · ${entry.kind} · ${entry.workId}`, 'muted'), node('p', entry.text));
      if (entry.role === 'user') {
        const remember = node('button', '이 발언을 기억 출처로 선택', 'button quiet'); remember.type = 'button';
        remember.disabled = config?.personalMemoryWritable !== true;
        remember.addEventListener('click', () => { memoryUI.chooseSource({ sessionId: page.sessionId, messageId: entry.sourceId, quote: entry.text }); }); item.append(remember);
      }
      element('history-list').append(item);
    }
    historyCursor = page.nextCursor; element('more-history').hidden = historyCursor === null; text('history-error', '');
  } catch (error) {
    if (auth === sessionEpoch) { element('history-list').replaceChildren(); historyCursor = null; element('more-history').hidden = true; text('history-error', errorText(error)); }
  } finally { historyReading = false; }
}
element('persistent-conversation').addEventListener('toggle', () => { void loadHistory(); });
element('refresh-history').addEventListener('click', () => { void loadHistory(); });
element('more-history').addEventListener('click', () => { void loadHistory(true); });
element('compact').addEventListener('click', () => {
  const view = current(); if (!view || element<HTMLButtonElement>('compact').disabled) return;
  const auth = sessionEpoch; const epoch = selectionEpoch;
  const payload = { workId: view.workId, expectedGoalRevision: view.goalRevision };
  const requestId = compactIdentity.forPayload(payload, nextRequestId);
  compactRequests.add(view.workId); element<HTMLButtonElement>('compact').disabled = true;
  text('context-status', '문맥 정리를 요청했습니다. 원문 이력은 유지합니다.');
  void request<WebCompactResult>(`/api/works/${encodeURIComponent(view.workId)}/compact`, { requestId, expectedGoalRevision: view.goalRevision }).then(result => {
    if (auth !== sessionEpoch || epoch !== selectionEpoch || selectedId !== view.workId) return;
    compactIdentity.complete(requestId); const next = receiveCompactStatus(contextStates.get(view.workId), result.status); contextStates.set(view.workId, next); renderContext(next);
  }).catch(error => { if (auth === sessionEpoch && epoch === selectionEpoch && selectedId === view.workId) text('context-status', errorText(error)); })
    .finally(() => { compactRequests.delete(view.workId); if (auth === sessionEpoch && epoch === selectionEpoch && selectedId === view.workId) {
      const status = contextStates.get(view.workId); element<HTMLButtonElement>('compact').disabled = !config?.compactProvider || Boolean(status && ['queued', 'running', 'validating'].includes(status.stage)) ||
        ['paused', 'completed', 'cancelled', 'failed'].includes(current()?.progress.status ?? 'failed');
    } });
});
element('input-form').addEventListener('submit', event => {
  event.preventDefault(); const view = current(); const button = element<HTMLButtonElement>('input-submit'); if (!view || button.disabled) return;
  const rawText = element<HTMLTextAreaElement>('input-text').value; if (!rawText.trim()) return;
  const payload = { workId: view.workId, rawText, expectedGoalRevision: view.goalRevision };
  const requestId = inputIdentity.forPayload(payload, nextRequestId); const auth = sessionEpoch; button.disabled = true;
  const input: WebInput = { requestId, rawText, expectedGoalRevision: view.goalRevision };
  void request<WebCommandResult>(`/api/works/${encodeURIComponent(view.workId)}/inputs`, input).then(async result => {
    if (auth !== sessionEpoch) return; inputIdentity.complete(requestId);
    if (selectedId === view.workId) {
      if (element<HTMLTextAreaElement>('input-text').value === rawText) element<HTMLTextAreaElement>('input-text').value = '';
      notice(result.duplicate ? '이미 저장된 입력입니다.' : '입력을 저장했습니다.'); await readView('conversation', true);
    }
    void loadHistory(); void loadWorks();
  }).catch(error => { if (auth === sessionEpoch && selectedId === view.workId) notice(errorText(error)); }).finally(() => { button.disabled = false; });
});
for (const kind of ['run', 'pause', 'resume', 'cancel'] as const) element(kind).addEventListener('click', () => {
  const view = current(); if (!view) return;
  const rawText = element(kind).textContent ?? kind;
  void sendCommand(view.workId, { requestId: nextRequestId(), expectedGoalRevision: view.goalRevision, kind, ...(config?.persistentSession ? { rawText } : {}) }).catch(() => undefined);
});
element('refresh-list').addEventListener('click', () => { void loadWorks(); });
element('more-works').addEventListener('click', () => { void loadWorks(true); });
element('refresh-work').addEventListener('click', () => { if (selectedId) void selectWork(selectedId); });
element('new-messages').addEventListener('click', () => { const area = element('conversation'); area.scrollTop = area.scrollHeight; element('new-messages').hidden = true; });
element('conversation').addEventListener('scroll', () => { const area = element('conversation'); if (nearConversationEnd(area.scrollTop, area.scrollHeight, area.clientHeight)) element('new-messages').hidden = true; });
for (const id of ['details-disclosure', 'diagnostics-disclosure']) element(id).addEventListener('toggle', () => { void refreshExtras(); });
element('start-after-accept').addEventListener('change', () => text('create-submit', element<HTMLInputElement>('start-after-accept').checked ? '접수하고 시작' : '접수만'));
element('scenario').addEventListener('change', () => text('scenario-description', config?.scenarios.find(scenario => scenario.id === element<HTMLSelectElement>('scenario').value)?.description ?? ''));
element('create-form').addEventListener('submit', event => {
  event.preventDefault(); if (element<HTMLButtonElement>('create-submit').disabled) return; void (async () => {
    const button = element<HTMLButtonElement>('create-submit'); button.disabled = true; text('create-error', ''); const auth = sessionEpoch;
    try {
      const title = element<HTMLInputElement>('new-title').value.trim(); const start = element<HTMLInputElement>('start-after-accept').checked;
      const rawText = element<HTMLTextAreaElement>('request-text').value;
      const payload = config?.generalRequests ? { mode: element<HTMLSelectElement>('new-mode').value as Mode, rawText } :
        { scenarioId: element<HTMLSelectElement>('scenario').value as WebAcceptInput['scenarioId'], mode: element<HTMLSelectElement>('new-mode').value as Mode, ...(title ? { title } : {}), ...(config?.persistentSession ? { rawText } : {}) };
      const input = { requestId: acceptIdentity.forPayload(payload, nextRequestId), ...payload };
      const accepted = await request<WebAcceptResult>(config?.generalRequests ? '/api/requests' : '/api/works', input); if (auth !== sessionEpoch) return;
      if (accepted.sessionId) persistentSessionId = accepted.sessionId;
      await selectWork(accepted.workId); void loadWorks(); void loadHistory();
      if (current()?.workId === accepted.workId) { acceptIdentity.complete(input.requestId); element<HTMLInputElement>('new-title').value = ''; element<HTMLTextAreaElement>('request-text').value = ''; }
      if (window.matchMedia('(max-width:720px)').matches) element<HTMLDetailsElement>('create-panel').open = false;
      const view = current(); if (start && view?.workId === accepted.workId) void sendCommand(view.workId, { requestId: nextRequestId(), expectedGoalRevision: view.goalRevision, kind: 'run' }).catch(() => undefined);
    } catch (error) { text('create-error', errorText(error)); } finally { button.disabled = false; }
  })();
});
element('attach-form').addEventListener('submit', event => {
  event.preventDefault(); const button = element('attach-form').querySelector<HTMLButtonElement>('button[type=submit]')!; if (button.disabled) return;
  void (async () => { text('attach-error', ''); button.disabled = true; const auth = sessionEpoch;
    try { const result = await request<WebAttachResult>('/api/attach', { requestId: nextRequestId(), workId: element<HTMLInputElement>('attach-id').value.trim() });
      if (auth !== sessionEpoch) return; await selectWork(result.workId); void loadWorks(); }
    catch (error) { text('attach-error', errorText(error)); } finally { button.disabled = false; }
  })();
});
element('answer-form').addEventListener('submit', event => {
  event.preventDefault(); const view = current(); if (!view) return;
  const submittedText = element<HTMLTextAreaElement>('answer-text').value; const reason = submittedText.trim(); const obligationId = element<HTMLSelectElement>('question-choice').value;
  if (!reason || !obligationId || element<HTMLButtonElement>('answer-submit').disabled) return;
  element<HTMLButtonElement>('answer-submit').disabled = true;
  void sendCommand(view.workId, { requestId: nextRequestId(), expectedGoalRevision: view.goalRevision, kind: 'resolve', obligationId, reason, ...(config?.persistentSession ? { rawText: submittedText } : {}) }).then(async () => {
    if (answerDrafts.get(view.workId) === submittedText) answerDrafts.delete(view.workId);
    if (selectedId === view.workId && element<HTMLTextAreaElement>('answer-text').value === submittedText) element<HTMLTextAreaElement>('answer-text').value = '';
    if (config?.generalRequests) await sendCommand(view.workId, { requestId: nextRequestId(), expectedGoalRevision: view.goalRevision, kind: 'run' });
  }).catch(() => undefined).finally(() => { element<HTMLButtonElement>('answer-submit').disabled = false; });
});
element('edit-mode').addEventListener('click', () => {
  const view = current(); if (!view) return; modeDraft = { workId: view.workId, goalRevision: view.goalRevision, controlRevision: view.mode.revision };
  element('mode-form').querySelector<HTMLButtonElement>('button[type=submit]')!.disabled = false;
  element<HTMLSelectElement>('mode-choice').value = view.mode.requested; text('mode-error', ''); element<HTMLDialogElement>('mode-dialog').showModal();
});
element('close-mode').addEventListener('click', () => element<HTMLDialogElement>('mode-dialog').close());
element('mode-form').addEventListener('submit', event => {
  event.preventDefault(); const draft = modeDraft; if (!draft || pendingDrafts.has(draft)) return;
  pendingDrafts.add(draft); element('mode-form').querySelector<HTMLButtonElement>('button[type=submit]')!.disabled = true;
  void sendCommand(draft.workId, { requestId: nextRequestId(), expectedGoalRevision: draft.goalRevision, expectedControlRevision: draft.controlRevision,
    kind: 'mode', mode: element<HTMLSelectElement>('mode-choice').value as Mode, reason: element<HTMLTextAreaElement>('mode-reason').value.trim(),
    ...(config?.persistentSession ? { rawText: element<HTMLTextAreaElement>('mode-reason').value } : {}) }).then(() => {
      if (modeDraft === draft) element<HTMLDialogElement>('mode-dialog').close();
    }).catch(error => { if (modeDraft === draft) text('mode-error', errorText(error)); }).finally(() => {
      pendingDrafts.delete(draft); if (modeDraft === draft) element('mode-form').querySelector<HTMLButtonElement>('button[type=submit]')!.disabled = false;
    });
});
function inputField(label: string, name: string, value: string, type = 'text') {
  const wrapper = node('label', label); const input = node('input'); input.dataset.field = name; input.type = type; input.value = value; input.required = true;
  wrapper.append(input); return wrapper;
}
function selectField(label: string, name: string, options: [string, string][], value: string) {
  const wrapper = node('label', label); const select = node('select'); select.dataset.field = name;
  select.append(...options.map(([value, title]) => { const option = node('option', title); option.value = value; return option; })); select.value = value; wrapper.append(select); return wrapper;
}
function addCriterion(criterion?: Criterion) {
  const row = node('section', '', 'criterion'); row.dataset.criterionId = criterion?.id ?? `condition-${nextRequestId()}`;
  const heading = node('div', '', 'criterion-title'); heading.append(node('span', '완료 조건')); const remove = node('button', '삭제', 'button quiet'); remove.type = 'button'; remove.addEventListener('click', () => row.remove()); heading.append(remove);
  const grid = node('div', '', 'criterion-grid'); const description = inputField('조건 설명', 'description', criterion?.description ?? ''); description.className = 'full';
  const valueType = criterion?.equals === null || criterion?.equals === undefined ? 'null' : typeof criterion.equals;
  const equals = inputField('비교할 값', 'equals', criterion?.equals === null || criterion?.equals === undefined ? '' : String(criterion.equals));
  equals.querySelector('input')!.required = false;
  grid.append(description, inputField('확인할 자료 항목', 'key', criterion?.key ?? ''), selectField('판정', 'operator', [['present', '값이 있음'], ['equals', '값이 같음']], criterion?.operator ?? 'present'),
    selectField('비교 값 종류', 'valueType', [['number', '숫자'], ['string', '문자'], ['boolean', '참 / 거짓'], ['null', '비어 있음']], valueType), equals,
    inputField('독립 원자료 최소 개수', 'minIndependentSources', String(criterion?.minIndependentSources ?? 1), 'number'));
  const count = grid.querySelector<HTMLInputElement>('[data-field=minIndependentSources]')!; count.min = '1'; count.max = '1000'; count.step = '1';
  const coverage = node('label', '', 'check-label'); const check = node('input'); check.type = 'checkbox'; check.dataset.field = 'coverage'; check.checked = criterion?.requireCompleteCoverage ?? true; coverage.append(check, document.createTextNode('수집 범위가 완전한 자료만 인정')); grid.append(coverage);
  const updateValue = () => { const present = grid.querySelector<HTMLSelectElement>('[data-field=operator]')!.value === 'present';
    grid.querySelector<HTMLSelectElement>('[data-field=valueType]')!.disabled = present; grid.querySelector<HTMLInputElement>('[data-field=equals]')!.disabled = present || grid.querySelector<HTMLSelectElement>('[data-field=valueType]')!.value === 'null'; };
  grid.addEventListener('change', updateValue); updateValue(); row.append(heading, grid); element('criteria-list').append(row);
}
async function loadGoalDraft(preserveInputs = false) {
  if (config?.generalRequests) {
    const id = selectedId, epoch = selectionEpoch, previous = goalDraft; if (!id) return;
    const basis = await request<WebGoalBasis>(`/api/works/${encodeURIComponent(id)}/goal-basis`);
    if (selectedId !== id || selectionEpoch !== epoch || preserveInputs && previous !== goalDraft) return;
    goalDraft = requestGoalDraft(basis);
    if (!preserveInputs || previous?.workId !== id) element<HTMLTextAreaElement>('goal-title').value = basis.description;
    element('goal-criteria').hidden = true; text('goal-heading', '이 업무의 목표 변경');
    text('goal-description', '같은 업무의 목표를 바꿉니다. 원문·근거·사용량은 유지하며, 저장 후 ‘실행’으로 이어갑니다.');
    text('goal-preserved-mode', `‘${modeNames[basis.mode]}’ 방식을 유지합니다.`);
    text('goal-error', preserveInputs ? '입력은 유지했습니다. 최신 기준으로 변경 내용을 확인해 주세요.' : '');
    element('goal-form').querySelector<HTMLButtonElement>('button[type=submit]')!.disabled = false;
    if (!element<HTMLDialogElement>('goal-dialog').open) element<HTMLDialogElement>('goal-dialog').showModal();
    return;
  }
  const id = selectedId; const epoch = selectionEpoch; const previous = goalDraft; const view = await readView('details', true);
  if (!id || id !== selectedId || epoch !== selectionEpoch) return;
  if (preserveInputs && goalDraft !== previous) return;
  const draft = view ? goalDraftFromView(view) : null;
  if (!draft) { notice('현재 목표를 안전하게 편집할 수 없습니다. 상태를 새로 확인해 주세요.'); return; }
  goalDraft = draft;
  element('goal-criteria').hidden = false;
  const keepInputs = preserveInputs && previous?.workId === id;
  if (!keepInputs) { element<HTMLTextAreaElement>('goal-title').value = draft.original.description; element('criteria-list').replaceChildren(); draft.original.criteria.forEach(addCriterion); }
  text('goal-preserved-mode', `이 목표 변경에서도 ‘${modeNames[draft.original.mode]}’ 방식을 유지합니다.${view?.mode.pending ? ' 현재 요청한 방식이 적용 대기 중입니다.' : ''}`);
  text('goal-error', keepInputs ? '작성한 내용은 유지했습니다. 최신 목표와 진행 방식을 기준으로 제출합니다. 완료 조건을 확인해 주세요.' : '');
  element('goal-form').querySelector<HTMLButtonElement>('button[type=submit]')!.disabled = false;
  if (!element<HTMLDialogElement>('goal-dialog').open) element<HTMLDialogElement>('goal-dialog').showModal();
}
element('edit-goal').addEventListener('click', () => { void loadGoalDraft().catch(error => notice(errorText(error))); });
element('reload-goal').addEventListener('click', () => { void loadGoalDraft(true).catch(error => text('goal-error', errorText(error))); });
element('close-goal').addEventListener('click', () => element<HTMLDialogElement>('goal-dialog').close());
element('add-criterion').addEventListener('click', () => addCriterion());
element('goal-form').addEventListener('submit', event => {
  event.preventDefault(); const draft = goalDraft; if (!draft || pendingDrafts.has(draft)) return;
  if ('expectedInput' in draft) {
    const rawText = element<HTMLTextAreaElement>('goal-title').value;
    pendingDrafts.add(draft); updateGoalGuard(current());
    void (async () => {
      let command = goalRetries.get(draft);
      if (command && command.rawText !== rawText) throw new Error('goal_retry_text_changed');
      if (!command) {
        const latest = await request<WebGoalBasis>(`/api/works/${encodeURIComponent(draft.workId)}/goal-basis`);
        if (goalDraft !== draft || selectedId !== draft.workId) return;
        command = requestGoalForSubmission(draft, latest, rawText, nextRequestId());
        goalRetries.set(draft, command);
      }
      const result = await sendCommand(draft.workId, command); goalRetries.delete(draft);
      if (goalDraft === draft) {
        element<HTMLDialogElement>('goal-dialog').close();
        notice(result.duplicate ? '저장된 목표 변경 요청을 확인했습니다. 현재 업무 상태를 확인해 주세요.' : '목표 변경을 접수했습니다. ‘실행’을 누르면 이어갑니다.');
      }
    })().catch(error => {
      if (error instanceof RequestError && error.status >= 400 && error.status < 500) goalRetries.delete(draft);
      if (goalDraft === draft) text('goal-error', error instanceof Error && error.message === 'goal_retry_text_changed' ?
        '이전 전송의 결과를 확인해야 합니다. 같은 내용으로 재전송하거나, 최신 기준을 읽고 새 요청을 작성해 주세요.' : errorText(error));
    }).finally(() => { pendingDrafts.delete(draft); if (goalDraft === draft) updateGoalGuard(current()); });
    return;
  }
  if (goalDraftIsStale(draft, current())) { updateGoalGuard(current()); return; }
  try {
    const criteria = [...element('criteria-list').querySelectorAll<HTMLElement>('.criterion')].map((row): Criterion => {
      const value = (name: string) => row.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field=${name}]`)!.value;
      const operator = value('operator') as 'present' | 'equals'; const type = value('valueType'); const input = value('equals');
      let equals: Criterion['equals'] = null;
      if (operator === 'equals') {
        if (type === 'number') { if (!input.trim() || !Number.isFinite(Number(input))) throw new Error('invalid_number'); equals = Number(input); }
        else if (type === 'boolean') { if (!['true', 'false', '참', '거짓'].includes(input.trim())) throw new Error('invalid_boolean'); equals = ['true', '참'].includes(input.trim()); }
        else if (type === 'string') equals = input;
      }
      const minIndependentSources = Number(value('minIndependentSources')); if (!Number.isSafeInteger(minIndependentSources) || minIndependentSources < 1) throw new Error('invalid_count');
      return { id: row.dataset.criterionId!, description: value('description'), key: value('key'), operator, equals, minIndependentSources,
        requireCompleteCoverage: row.querySelector<HTMLInputElement>('[data-field=coverage]')!.checked };
    });
    if (!criteria.length) { text('goal-error', '완료 조건을 하나 이상 남겨 주세요.'); return; }
    const edits = { description: element<HTMLTextAreaElement>('goal-title').value.trim(), criteria };
    pendingDrafts.add(draft); element('goal-form').querySelector<HTMLButtonElement>('button[type=submit]')!.disabled = true;
    void (async () => {
      const view = await readView('conversation', true);
      if (goalDraft !== draft || selectedId !== draft.workId) return;
      if (goalDraftIsStale(draft, view)) { updateGoalGuard(view); return; }
      const goal = goalForSubmission(draft, view, edits);
      await sendCommand(draft.workId, { requestId: nextRequestId(), expectedGoalRevision: draft.original.revision, expectedControlRevision: draft.controlRevision, kind: 'goal', goal,
        ...(config?.persistentSession ? { rawText: element<HTMLTextAreaElement>('goal-title').value } : {}) });
      if (goalDraft === draft) element<HTMLDialogElement>('goal-dialog').close();
    })().catch(error => { if (goalDraft === draft) text('goal-error', errorText(error)); }).finally(() => {
      pendingDrafts.delete(draft); if (goalDraft === draft) updateGoalGuard(current());
    });
  } catch { text('goal-error', '비교할 숫자와 원자료 개수를 확인해 주세요. 참/거짓 값은 true 또는 false로 입력합니다.'); }
});

async function start() {
  try {
    let session: { csrf: string; config: WorkbenchConfig };
    try { session = await request('/api/session', undefined, true); }
    catch (error) {
      if (!(error instanceof RequestError && error.status === 401 && connectionToken)) throw error;
      const token = connectionToken; connectionToken = null; session = await request('/api/session', { token }, true);
    }
    connectionToken = null; csrf = session.csrf; config = session.config; persistentSessionId = config.persistentSession?.sessionId ?? null; connection('연결됨', true);
    residentUI.configure(config.residentMissions === true, config.persistentSession && persistentSessionId ? {
      agentId: config.persistentSession.agentId, sessionId: persistentSessionId, conversationId: config.conversationId,
    } : null);
    element('request-text-field').hidden = !config.persistentSession; element<HTMLTextAreaElement>('request-text').required = Boolean(config.persistentSession);
    element('persistent-conversation').hidden = !config.persistentSession;
    element('personal-memory').hidden = !config.persistentSession;
    element('memory-document-tools').hidden = !config.memoryDrafts;
    memoryUI.configure();
    element('memory-backend').textContent = config.personalMemoryBackend === 'documents' ? '문서 저장' : config.personalMemoryBackend === 'postgres' ? 'PostgreSQL 저장' : config.personalMemoryBackend === 'sqlite' ? 'SQLite 저장' : '';
    element('attach-form').closest('details')!.hidden = Boolean(config.persistentSession);
    element<HTMLSelectElement>('scenario').replaceChildren(...config.scenarios.map(scenario => { const option = node('option', scenario.title); option.value = scenario.id; return option; }));
    element('fixture-fields').hidden = Boolean(config.generalRequests);
    element<HTMLSelectElement>('scenario').required = !config.generalRequests;
    element('edit-goal').hidden = false;
    text('model-environment', config.modelInfo?.selection === 'registered' ?
      (config.modelInfo.execution === 'deterministic_fixture' ? '로컬 작업실 · 등록된 전송 대역 시험 · 실제 모델/API 미호출' : '로컬 작업실 · 호스트 등록 모델') :
      '로컬 학습환경 · 합성 자료 · 실제 모델 미연결');
    if (config.generalRequests) {
      const fixture = config.modelInfo?.execution !== 'host_transport';
      element('request-text-field').querySelector('.help-text')!.textContent = fixture ?
        '요청을 접수하고 답변·질문·도구 실행을 이어갑니다. 현재는 정해진 문구를 처리하는 로컬 시험 제공자입니다.' :
        '요청을 접수하고 호스트에 등록된 모델로 답변·질문·도구 실행을 이어갑니다.';
      element<HTMLTextAreaElement>('request-text').placeholder = fixture ?
        '로컬 시험 제공자는 문서에 명시된 시험 문구만 처리합니다.' : '일반 요청을 입력하세요.';
    }
    text('scenario-description', config.scenarios[0]?.description ?? ''); element('diagnostics-disclosure').hidden = !config.allowDiagnostics;
    await loadWorks(); await loadHistory();
    const remembered = rememberedSelection(); if (remembered && csrf) await selectWork(remembered);
  } catch (error) { connectionToken = null; connection('연결 필요', false); element('session-notice').hidden = false; text('session-notice', errorText(error)); element<HTMLButtonElement>('create-submit').disabled = true; }
}
window.addEventListener('pagehide', () => { stream?.close(); stream = null; residentUI.clear(); });
window.addEventListener('pageshow', event => { if (event.persisted) void start(); });
void start();
