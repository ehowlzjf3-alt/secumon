import type { WebResidentMissionCommandInput, WebResidentMissionCommandResult, WebResidentMissionStatus } from '../web-contracts.js';

type Kind = WebResidentMissionCommandInput['kind'];
type Summary = Pick<WebResidentMissionStatus, 'workId' | 'status' | 'controlRevision' | 'stateRevision' | 'nextPollAt'> & { pendingCount: number };
type Ticket = Readonly<{ workId: string; command: Readonly<WebResidentMissionCommandInput> }>;
const names = { active: '관측 허용', paused: '관측 일시정지', closed: '관측 종료' } as const;
const actions: Record<Kind, string> = { pause: '관측 일시정지', resume: '관측 재개', stop: '관측 종료' };
const rejected = new Set(['resident_control_invalid', 'resident_control_stale', 'resident_control_conflict', 'resident_selection_mismatch', 'resident_mission_closed']);
const count = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** A status read never settles a command whose response was lost. */
export class BrowserResidentMissionControls {
  readonly #views = new Map<string, Summary>();
  readonly #pending = new Map<string, Ticket>();
  view(workId: string) { return this.#views.get(workId) ?? null; }
  pending(workId: string) { return this.#pending.get(workId) ?? null; }
  invalidate(workId: string) { this.#views.delete(workId); }
  clear() { this.#views.clear(); this.#pending.clear(); }
  receive(workId: string, value: WebResidentMissionStatus) {
    const previous = this.view(workId);
    if (value.workId !== workId || !Object.hasOwn(names, value.status) || !count(value.controlRevision) || !count(value.stateRevision) ||
      !count(value.nextPollAt) || !Array.isArray(value.pending) || previous &&
      (value.stateRevision < previous.stateRevision || value.controlRevision < previous.controlRevision)) throw new Error('resident_view_invalid');
    const summary: Summary = Object.freeze({ workId, status: value.status, controlRevision: value.controlRevision,
      stateRevision: value.stateRevision, nextPollAt: value.nextPollAt, pendingCount: value.pending.length });
    this.#views.set(workId, summary); return summary;
  }
  prepare(workId: string, kind: Kind, nextId: () => string): Ticket {
    const pending = this.pending(workId);
    if (pending) { if (pending.command.kind !== kind) throw new Error('resident_command_pending'); return pending; }
    const value = this.view(workId);
    if (!value || value.status === 'closed' || kind === 'pause' && value.status !== 'active' || kind === 'resume' && value.status !== 'paused')
      throw new Error('resident_view_required');
    const ticket = Object.freeze({ workId, command: Object.freeze({ commandId: nextId(), expectedControlRevision: value.controlRevision, kind }) });
    this.#pending.set(workId, ticket); return ticket;
  }
  complete(ticket: Ticket, result: WebResidentMissionCommandResult) {
    if (this.pending(ticket.workId) !== ticket || result.commandId !== ticket.command.commandId || typeof result.replayed !== 'boolean' ||
      !count(result.appliedControlRevision) || !count(result.appliedStateRevision) ||
      result.appliedControlRevision < ticket.command.expectedControlRevision || result.current.controlRevision < result.appliedControlRevision ||
      result.current.stateRevision < result.appliedStateRevision) throw new Error('resident_response_mismatch');
    const value = this.receive(ticket.workId, result.current); this.#pending.delete(ticket.workId); return value;
  }
  reject(ticket: Ticket, code: string | null) {
    if (this.pending(ticket.workId) !== ticket || !code || !rejected.has(code)) return false;
    this.#pending.delete(ticket.workId); this.invalidate(ticket.workId); return true;
  }
}

interface Host {
  request<T>(path: string, body?: unknown): Promise<T>;
  epoch(): number;
  nextId(): string;
  errorText(error: unknown): string;
  errorCode(error: unknown): string | null;
}
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const write = (id: string, value: string) => { element(id).textContent = value; };

export function installResidentMissionsUI(host: Host) {
  const controls = new BrowserResidentMissionControls();
  let enabled = false, busy = false, selected = '', generation = 0;
  const panel = element<HTMLDetailsElement>('resident-missions');
  const input = element<HTMLInputElement>('resident-work-id');
  const active = (epoch: number, token: number) => enabled && host.epoch() === epoch && token === generation;
  const notice = (value: string) => write('resident-notice', value);
  function render() {
    const view = controls.view(selected), pending = controls.pending(selected);
    panel.setAttribute('aria-busy', String(busy)); input.disabled = busy || !enabled;
    element<HTMLButtonElement>('resident-read').disabled = busy || !enabled;
    element('resident-summary').hidden = !view;
    if (view) {
      write('resident-status', names[view.status]); element('resident-status').dataset.state = view.status;
      const next = new Date(view.nextPollAt);
      const when = view.status === 'active' && !Number.isNaN(next.getTime()) ? ` · 다음 조회 가능 시각 ${next.toLocaleString('ko-KR')}` : '';
      write('resident-counts', `대기 사건 ${view.pendingCount}개${when}`);
    } else { write('resident-status', ''); write('resident-counts', ''); }
    element('resident-actions').hidden = !view && !pending;
    for (const kind of ['pause', 'resume', 'stop'] as const) {
      element<HTMLButtonElement>(`resident-${kind}`).disabled = busy || !enabled || Boolean(pending) || !view || view.status === 'closed' ||
        kind === 'pause' && view.status !== 'active' || kind === 'resume' && view.status !== 'paused';
    }
    element('resident-retry').hidden = !pending;
    element<HTMLButtonElement>('resident-retry').disabled = busy || !enabled;
    element('resident-pending').hidden = !pending;
    write('resident-pending', pending ? `${actions[pending.command.kind]} 요청의 결과를 확인한 뒤 다음 제어를 할 수 있습니다.` : '');
  }
  async function read() {
    if (!enabled || busy) return;
    const workId = input.value.trim();
    if (!workId || workId.length > 256 || /[\x00-\x1f\x7f/]/.test(workId)) { notice('상시 임무의 제어 업무 ID를 입력해 주세요.'); return; }
    const epoch = host.epoch(), token = ++generation; selected = workId; busy = true; render(); notice('상태 조회 요청을 받았습니다. 확인 중입니다.');
    try {
      const result = await host.request<WebResidentMissionStatus>(`/api/resident-missions/${encodeURIComponent(workId)}/status`);
      if (!active(epoch, token)) return;
      const value = controls.receive(workId, result);
      notice(`현재 상태: ${names[value.status]}.${controls.pending(workId) ? ' 이전 요청은 같은 요청으로 다시 확인해 주세요.' : ''}`);
    } catch (error) {
      if (active(epoch, token)) { controls.invalidate(workId); notice(host.errorText(error)); }
    } finally { if (active(epoch, token)) { busy = false; render(); } }
  }
  async function send(ticket: Ticket, retry: boolean) {
    if (!enabled || busy) return;
    const epoch = host.epoch(), token = ++generation; busy = true; render();
    notice(retry ? '같은 요청으로 처리 결과를 다시 확인합니다.' : `${actions[ticket.command.kind]} 요청을 받았습니다. 처리 중입니다.`);
    try {
      const result = await host.request<WebResidentMissionCommandResult>(`/api/resident-missions/${encodeURIComponent(ticket.workId)}/commands`, ticket.command);
      if (!active(epoch, token)) return;
      const view = controls.complete(ticket, result);
      notice(`${result.replayed ? '기존 요청의 처리 기록을 확인했습니다.' : `${actions[ticket.command.kind]} 요청을 반영했습니다.`} 현재 상태: ${names[view.status]}.`);
    } catch (error) {
      if (active(epoch, token)) {
        const definite = controls.reject(ticket, host.errorCode(error));
        controls.invalidate(ticket.workId);
        notice(`${host.errorText(error)} ${definite ? '상태를 다시 조회한 뒤 제어해 주세요.' : '요청 ID와 최초 기준은 유지했습니다. 같은 요청으로 다시 확인해 주세요.'}`);
      }
    } finally { if (active(epoch, token)) { busy = false; render(); } }
  }
  element('resident-form').addEventListener('submit', event => { event.preventDefault(); void read(); });
  input.addEventListener('input', () => { if (!busy) { selected = ''; notice(''); render(); } });
  for (const kind of ['pause', 'resume', 'stop'] as const) element(`resident-${kind}`).addEventListener('click', () => {
    if (!enabled || busy || element<HTMLButtonElement>(`resident-${kind}`).disabled) return;
    try { void send(controls.prepare(selected, kind, host.nextId), false); }
    catch { notice('상태를 먼저 조회하거나 이전 요청의 처리 결과를 확인해 주세요.'); }
  });
  element('resident-retry').addEventListener('click', () => { const ticket = controls.pending(selected); if (ticket) void send(ticket, true); });
  function clear() { generation++; enabled = false; busy = false; selected = ''; controls.clear(); input.value = ''; panel.hidden = true; panel.open = false; notice(''); render(); }
  return {
    clear,
    configure(available: boolean) { if (!available) clear(); else { enabled = true; panel.hidden = false; render(); } },
  };
}
