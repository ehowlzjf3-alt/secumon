import type { WorkView, WorkViewLevel, WorkViewMessage, WorkViewResult } from '../../domain/work-view.js';
import type { Goal } from '../../domain/model.js';
import type { WebCompactStatus, WebGoalBasis, WebCommandInput } from '../web-contracts.js';

/** A source-currentness failure is not proof that the caller lost access to the work. */
export function sourceReadFailure(code: string): boolean {
  return ['work_view_knowledge_changed', 'knowledge_source_unavailable', 'personal_memory_selection_stale',
    'personal_memory_revision_changed', 'personal_memory_changed', 'session_current_input_unavailable'].includes(code);
}

export interface BrowserWorkState {
  workId: string;
  generation: number;
  revision: number;
  goalRevision: number;
  current: WorkView | null;
  cursors: Partial<Record<WorkViewLevel, string>>;
  views: Partial<Record<WorkViewLevel, WorkView>>;
  unavailable: boolean;
}
export function newBrowserWork(workId: string): BrowserWorkState {
  return { workId, generation: 0, revision: 0, goalRevision: 0, current: null, cursors: {}, views: {}, unavailable: false };
}
export function uniqueMessages(messages: WorkViewMessage[]): WorkViewMessage[] {
  const selected = new Map<string, WorkViewMessage>();
  for (const message of messages) selected.set(message.id, structuredClone(message));
  return [...selected.values()];
}
export function unavailableWork(state: BrowserWorkState): BrowserWorkState {
  return { ...state, generation: state.generation + 1, current: null, views: {}, cursors: {}, unavailable: true };
}
/** The request generation is captured before I/O. Every accepted snapshot invalidates older in-flight reads. */
export function receiveWorkView(state: BrowserWorkState, result: WorkViewResult, generation: number, level: WorkViewLevel): BrowserWorkState {
  if (generation !== state.generation) return state;
  if (result.kind === 'unchanged') return state;
  const view = result.view;
  if (view.workId !== state.workId || view.level !== level || view.revision < state.revision || view.goalRevision < state.goalRevision) return state;
  const snapshot = structuredClone(view); snapshot.messages = uniqueMessages(snapshot.messages);
  return { ...state, generation: state.generation + 1, revision: view.revision, goalRevision: view.goalRevision, current: snapshot,
    views: { [level]: snapshot }, cursors: { [level]: result.cursor }, unavailable: false };
}
export function messageKey(view: WorkView, message: WorkViewMessage): string { return `${view.goalRevision}:${message.id}`; }
export function nearConversationEnd(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight < 72;
}

/** Serialized reads carry the queue epoch from enqueue, including while a prior read is pending. */
export class BrowserReadQueue {
  #epoch = 0;
  #tail: Promise<unknown> = Promise.resolve();
  invalidate() { this.#epoch++; this.#tail = Promise.resolve(); }
  enqueue<T>(read: () => Promise<T>, discarded: T): Promise<T> {
    const epoch = this.#epoch;
    const next = this.#tail.then(() => epoch === this.#epoch ? read() : discarded);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

/** Changed stream events request a fresh read; unchanged events never add network reads. */
export function coalescedRefresh(refresh: () => Promise<void>, active: () => boolean) {
  let running: Promise<void> | null = null; let again = false;
  return (event: 'view' | 'unchanged'): Promise<void> => {
    if (event === 'unchanged' || !active()) return running ?? Promise.resolve();
    if (running) { again = true; return running; }
    running = (async () => {
      do { again = false; if (!active()) return; await refresh(); } while (again && active());
    })().finally(() => { running = null; });
    return running;
  };
}

/** Keep the receipt identity for an explicit retry after a lost response; never retransmit by itself. */
export class BrowserRequestIdentity {
  #pending: { fingerprint: string; id: string } | null = null;
  forPayload(payload: unknown, nextId: () => string): string {
    const fingerprint = JSON.stringify(payload);
    if (this.#pending?.fingerprint !== fingerprint) this.#pending = { fingerprint, id: nextId() };
    return this.#pending.id;
  }
  complete(id: string) { if (this.#pending?.id === id) this.#pending = null; }
}

export function needsResultRecheck(view: Pick<WorkView, 'progress'>): boolean {
  return view.progress.status === 'completed' && !view.progress.resultReady;
}

export interface BrowserGoalDraft { workId: string; controlRevision: number; original: Goal }
export interface BrowserRequestGoalDraft {
  workId: string; controlRevision: number; expectedInput: WebGoalBasis['expectedInput'];
  original: { revision: number; description: string; mode: Goal['mode'] };
}
export function requestGoalDraft(basis: WebGoalBasis): BrowserRequestGoalDraft {
  return { workId: basis.workId, controlRevision: basis.expectedControlRevision, expectedInput: structuredClone(basis.expectedInput),
    original: { revision: basis.expectedGoalRevision, description: basis.description, mode: basis.mode } };
}
export function requestGoalForSubmission(draft: BrowserRequestGoalDraft, latest: WebGoalBasis, rawText: string, requestId: string): Extract<WebCommandInput, { kind: 'request-goal' }> {
  if (draft.workId !== latest.workId || draft.original.revision !== latest.expectedGoalRevision || draft.controlRevision !== latest.expectedControlRevision ||
    draft.expectedInput.messageId !== latest.expectedInput.messageId || draft.expectedInput.sequence !== latest.expectedInput.sequence ||
    draft.expectedInput.digest !== latest.expectedInput.digest) throw new Error('stale_session_input');
  if (!rawText.trim() || rawText.length > 10000) throw new Error('session_text_required');
  return { kind: 'request-goal', requestId, rawText, mode: draft.original.mode, expectedGoalRevision: draft.original.revision,
    expectedControlRevision: draft.controlRevision, expectedInput: structuredClone(draft.expectedInput) };
}
export function goalDraftFromView(view: WorkView): BrowserGoalDraft | null {
  const goal = view.details?.goal;
  if (!goal?.editable || !goal.criteria || goal.revision === undefined) return null;
  return { workId: view.workId, controlRevision: view.mode.revision, original: {
    revision: goal.revision, description: goal.description, scope: goal.scope, mode: view.mode.pending ?? view.mode.requested,
    criteria: structuredClone(goal.criteria),
  } };
}
export function goalDraftIsStale(draft: Pick<BrowserGoalDraft, 'workId' | 'controlRevision'> & { original: { revision: number } }, view: WorkView | null): boolean {
  return !view || draft.workId !== view.workId || draft.original.revision !== view.goalRevision || draft.controlRevision !== view.mode.revision;
}
export function goalForSubmission(draft: BrowserGoalDraft, view: WorkView | null, edits: Pick<Goal, 'description' | 'criteria'>): Goal {
  if (goalDraftIsStale(draft, view)) throw new Error('stale_goal_draft');
  return { ...structuredClone(draft.original), revision: draft.original.revision + 1, description: edits.description, criteria: structuredClone(edits.criteria) };
}
export function receiveCompactStatus(previous: WebCompactStatus | undefined, next: WebCompactStatus): WebCompactStatus {
  if (previous && previous.workId === next.workId && previous.sessionId === next.sessionId &&
    previous.stateRevision > next.stateRevision) return previous;
  return next;
}

export function compactStatusText(status: WebCompactStatus): string {
  const messages: Record<WebCompactStatus['stage'], string> = {
    idle: '저장된 문맥 정리 요청이 없습니다. 실행 시 필요 여부를 확인합니다.',
    needed: '문맥 정리가 필요합니다. 실행을 이어가기 전에 정리 상태를 확인해 주세요.',
    queued: '문맥 정리를 접수했습니다. 시작을 기다립니다.',
    running: '문맥을 정리하고 있습니다. 추가 입력이나 취소는 계속 사용할 수 있습니다.',
    validating: '요약 후보가 원문과 현재 입력에 맞는지 확인하고 있습니다.',
    ready: '문맥 정리를 반영했습니다. 다음 작업은 요약 참조와 최근 원문을 함께 사용합니다.',
    failed: '문맥 정리를 반영하지 못했습니다. 기존 요약과 원문 이력은 유지됩니다.',
    unknown: '정리 결과의 수신 여부를 확인해야 합니다. 같은 요청을 무조건 다시 실행하지 않습니다.',
    cancelled: '문맥 정리가 취소되었거나 새 입력으로 적용 대상이 바뀌었습니다.',
  };
  return `${messages[status.stage]} 원문 이력은 삭제하지 않습니다.`;
}
