import type { ComputerAction, ComputerElement, ComputerLease, ComputerView } from '../domain/computer-use.js';
import type { ComputerOperationIdentity } from '../domain/computer-operation.js';
import type { ComputerActionResult } from '../application/computer-use-ports.js';

export interface LocalWebApp { query: string; note: string; resultsReady: boolean; savedNote: string; saveCount: number; inputCount: number }
export type LocalWebControl = { kind: 'rerender' | 'handoff' | 'reclaim' } | { kind: 'focus'; focused: boolean }
  | { kind: 'target'; name: 'Query' | 'Search' | 'Note' | 'Save'; disabled?: boolean; hidden?: boolean; duplicate?: boolean };
export interface LocalWebDocument { documentId: string; sessionId: string; epoch: number; surfaceId: string; revision: number; app: LocalWebApp }

/** Serialized fixed renderer code. It performs DOM automation, never native OS input or model-provided script. */
function localWebComputerPage(configuration: { key: string }) {
  type Command = { kind: string; lease?: ComputerLease; request?: Record<string, unknown> };
  type Act = { operationId: string; basis: ComputerView; targetRef: string; action: ComputerAction; deadlineAt: number };
  const form = document.querySelector<HTMLFormElement>('#document-form')!;
  const query = () => document.querySelector<HTMLInputElement>('#query')!;
  const note = () => document.querySelector<HTMLTextAreaElement>('#note')!;
  const text = (id: string, value: string) => { document.getElementById(id)!.textContent = value; };
  const usage = () => ({ transportCalls: 1, internalOperations: 1, imageBytes: 0, waitMs: 0 });
  const integer = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && (v as number) >= min;
  const string = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
  function leaseValid(v: unknown): v is ComputerLease {
    return exact(v, ['sessionId', 'epoch', 'surfaceId', 'fence', 'workId', 'attemptId', 'expiresAt']) &&
      ['sessionId', 'surfaceId', 'workId', 'attemptId'].every(k => string(v[k])) && ['epoch', 'fence'].every(k => integer(v[k], 1)) && integer(v.expiresAt);
  }
  function actionValid(v: unknown): v is ComputerAction {
    return object(v) && (v.kind === 'fill' ? exact(v, ['kind', 'target', 'value']) && typeof v.value === 'string' && v.value.length <= 8192
      : v.kind === 'click' && exact(v, ['kind', 'target'])) && exact(v.target, ['role', 'name']) && string(v.target.role, 128) && string(v.target.name, 1024);
  }
  function viewValid(v: unknown): v is ComputerView {
    if (!exact(v, ['sessionId', 'epoch', 'surfaceId', 'revision', 'focusRevision', 'observedAt', 'elements', 'facts', 'partial', 'omittedCount']) ||
        !string(v.sessionId) || !string(v.surfaceId) || !integer(v.epoch, 1) || !['revision', 'focusRevision', 'observedAt', 'omittedCount'].every(k => integer(v[k])) ||
        typeof v.partial !== 'boolean' || !Array.isArray(v.elements) || v.elements.length > 40 || !object(v.facts) || Object.keys(v.facts).length > 100) return false;
    const refs = new Set<string>();
    for (const e of v.elements) {
      if (!exact(e, ['ref', 'role', 'name', 'value', 'visible', 'enabled']) || !string(e.ref) || !string(e.role, 128) || typeof e.name !== 'string' || e.name.length > 1024 ||
          !(e.value === null || typeof e.value === 'string' && e.value.length <= 8192) || typeof e.visible !== 'boolean' || typeof e.enabled !== 'boolean' || refs.has(e.ref)) return false;
      refs.add(e.ref);
    }
    if (!v.partial && v.omittedCount !== 0) return false;
    return Object.entries(v.facts).every(([k, value]) => string(k) && (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 8192));
  }
  let current: LocalWebDocument;
  let lease: ComputerLease | null = null;
  let revision = 0; let focusRevision = 0; let serverRevision = -1; let refSequence = 0;
  let humanOwned = false; let forcedFocus: boolean | null = null; let controlledFocus = false; let documentInvalid = false;
  let busy = false; let operations = new Map<string, { digest: string; promise: Promise<ComputerActionResult> }>();
  let domInputsDispatched = 0; let domEventsHandled = 0; let bridgeCalls = 0;
  let humanWrites: Promise<void> = Promise.resolve(); let humanIssued = 0; let humanAcknowledged = 0; let humanWriteFailed = false;
  const humanDirty = new Map<string, number>();
  let refs = new WeakMap<Element, string>(); let lastFingerprint = '';
  let pending: { identity: ComputerOperationIdentity; lease: ComputerLease; deadlineAt: number; promise: Promise<LocalWebDocument> | null } | null = null;
  const changes = new Set<() => void>();
  const notify = () => { for (const listener of [...changes]) listener(); };
  const changed = () => { revision++; notify(); };
  const headers = { 'Content-Type': 'application/json', 'X-Fixture-Key': configuration.key };
  let httpCalls = 0; let requestBytes = 0; let responseBytes = 0;
  async function post<T>(path: string, value: unknown): Promise<T> {
    const body = JSON.stringify(value); httpCalls++; requestBytes += new TextEncoder().encode(body).byteLength;
    const response = await fetch(path, { method: 'POST', headers, body, credentials: 'same-origin' });
    const source = await response.text(); responseBytes += new TextEncoder().encode(source).byteLength;
    if (!response.ok) {
      let code = 'computer_fixture_unavailable';
      try { const result = JSON.parse(source) as { error?: string }; if (typeof result.error === 'string' && /^computer_[a-z_]+$/.test(result.error)) code = result.error; } catch { /* Fixed public error only. */ }
      throw new Error(code);
    }
    return JSON.parse(source) as T;
  }
  function nodes(): (HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement)[] {
    return [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('[data-computer-element]')];
  }
  function elements(): ComputerElement[] {
    return nodes().map(node => {
      let ref = refs.get(node); if (!ref) { ref = `web-${current.epoch}-${++refSequence}`; refs.set(node, ref); }
      const style = getComputedStyle(node); const visible = node.isConnected && !node.hidden && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && node.getClientRects().length > 0;
      return { ref, role: node instanceof HTMLButtonElement ? 'button' : 'textbox', name: node.getAttribute('aria-label') ?? '',
        value: node instanceof HTMLButtonElement ? null : node.value, visible,
        enabled: !node.matches(':disabled') && !(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node.readOnly : false) };
    });
  }
  function syncDomRevision(): ComputerElement[] {
    const result = elements(); const fingerprint = JSON.stringify(result);
    if (fingerprint !== lastFingerprint) { lastFingerprint = fingerprint; changed(); }
    return result;
  }
  function applyState(next: LocalWebDocument, acknowledgedHumanSequence?: number) {
    if (next.documentId !== current.documentId || next.epoch !== current.epoch) { documentInvalid = true; lease = null; changed(); return; }
    const newer = next.revision > serverRevision;
    if (newer) {
      serverRevision = next.revision; current.app = next.app; current.revision = next.revision;
      text('results-ready', String(next.app.resultsReady)); text('saved-note', next.app.savedNote);
      text('save-count', String(next.app.saveCount)); text('input-count', String(next.app.inputCount));
      text('search-status', next.app.resultsReady ? '검색 완료' : '검색 대기');
    }
    let cleared = false;
    if (acknowledgedHumanSequence !== undefined) for (const [field, sequence] of humanDirty) {
      if (sequence <= acknowledgedHumanSequence) { humanDirty.delete(field); cleared = true; }
    }
    if (!newer && !cleared) return;
    // Streamed state and old acknowledgements may update outputs, never a newer unacknowledged edit.
    if (!humanDirty.has('Query')) query().value = current.app.query;
    if (!humanDirty.has('Note')) note().value = current.app.note;
    syncDomRevision(); changed();
  }
  function ownerText() { text('owner-status', humanOwned ? '사람이 편집 중' : lease ? '에이전트가 작업 중' : '작업 대기'); }
  function localHandoff() { humanOwned = true; lease = null; focusRevision++; changed(); ownerText(); }
  function control(value: LocalWebControl) {
    if (value.kind === 'rerender') { for (const node of nodes()) node.replaceWith(node.cloneNode(true)); refs = new WeakMap(); syncDomRevision(); }
    else if (value.kind === 'focus') { forcedFocus = value.focused; focusRevision++; changed(); }
    else if (value.kind === 'handoff') localHandoff();
    else if (value.kind === 'reclaim') { humanOwned = false; lease = null; forcedFocus = null; focusRevision++; changed(); ownerText(); }
    else if (value.kind === 'target') {
      const node = nodes().find(item => item.getAttribute('aria-label') === value.name);
      if (!node) throw new Error('computer_target_missing');
      if (value.disabled !== undefined) node.disabled = value.disabled;
      if (value.hidden !== undefined) node.hidden = value.hidden;
      if (value.duplicate) { const clone = node.cloneNode(true) as HTMLElement; clone.removeAttribute('id'); node.parentElement!.append(clone); }
      syncDomRevision();
    }
  }
  function guard(grant: ComputerLease): string | null {
    if (documentInvalid) return 'computer_stale_session';
    if (humanOwned || humanIssued !== humanAcknowledged || humanWriteFailed) return 'computer_human_owned';
    if (!lease || !equal(grant, lease) || grant.sessionId !== current.sessionId || grant.epoch !== current.epoch || grant.surfaceId !== current.surfaceId) return 'computer_stale_lease';
    if (Date.now() >= grant.expiresAt) return 'computer_lease_expired';
    return null;
  }
  function view(): ComputerView {
    const list = syncDomRevision();
    const readVisible = (id: string): string => {
      const node = document.getElementById(id)!; const style = getComputedStyle(node);
      if (node.hidden || !node.isConnected || !node.getClientRects().length || style.display === 'none' || style.visibility !== 'visible') throw new Error('computer_view_invalid');
      return node.textContent ?? '';
    };
    const ready = readVisible('results-ready');
    const saves = readVisible('save-count');
    if (!['true', 'false'].includes(ready ?? '') || !/^\d+$/.test(saves ?? '') || !integer(Number(saves))) throw new Error('computer_view_invalid');
    return { sessionId: current.sessionId, epoch: current.epoch, surfaceId: current.surfaceId, revision, focusRevision,
      observedAt: Date.now(), elements: list, facts: { resultsReady: ready === 'true', savedNote: readVisible('saved-note'), saveCount: Number(saves) }, partial: false, omittedCount: 0 };
  }
  function inputError(grant: ComputerLease, request: Act): string | null {
    const invalid = guard(grant); if (invalid) return invalid;
    if (Date.now() >= request.deadlineAt) return 'computer_deadline';
    const live = view(); const basis = request.basis;
    if (basis.partial) return 'computer_view_partial';
    if (forcedFocus === false || !document.hasFocus() || basis.focusRevision !== focusRevision) return 'computer_focus_changed';
    if (basis.sessionId !== live.sessionId || basis.epoch !== live.epoch || basis.surfaceId !== live.surfaceId || basis.revision !== live.revision || basis.observedAt > Date.now()) return 'computer_stale_view';
    const matches = live.elements.filter(e => e.role === request.action.target.role && e.name === request.action.target.name);
    if (matches.length !== 1) return 'computer_target_ambiguous';
    const target = matches[0]!; const observed = basis.elements.filter(e => e.ref === request.targetRef);
    if (target.ref !== request.targetRef || observed.length !== 1 || !equal(observed[0], target)) return 'computer_target_changed';
    if (!target.visible || !target.enabled) return 'computer_target_unavailable';
    if (request.action.kind === 'fill' ? target.role !== 'textbox' || !['Query', 'Note'].includes(target.name)
      : target.role !== 'button' || !['Search', 'Save'].includes(target.name)) return 'computer_action_unsupported';
    return null;
  }
  function handleInput(event: Event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement)) return;
    if (!target.matches('[data-computer-element]')) return;
    const name = target.getAttribute('aria-label') ?? '';
    if (event.type === 'input' && target instanceof HTMLButtonElement || event.type === 'click' && !(target instanceof HTMLButtonElement)) return;
    if (target instanceof HTMLButtonElement ? !['Search', 'Save'].includes(name) : !['Query', 'Note'].includes(name)) return;
    if (pending) {
      const action = pending.identity.action;
      if (name !== action.target.name || refs.get(target) !== pending.identity.targetRef || pending.promise) return;
      if (action.kind === 'fill' && (target instanceof HTMLButtonElement || target.value !== action.value)) return;
      domEventsHandled++;
      pending.promise = post<LocalWebDocument>('/api/effect', { documentId: current.documentId, lease: pending.lease,
        identity: pending.identity, deadlineAt: pending.deadlineAt, domInputsDispatched, domEventsHandled });
      return;
    }
    // Browser fill helpers differ in isTrusted. Non-bridge form events revoke agent ownership;
    // they use the human-write queue and never receive an agent operation receipt.
    localHandoff();
    const action: ComputerAction = target instanceof HTMLButtonElement ? { kind: 'click', target: { role: 'button', name } }
      : { kind: 'fill', target: { role: 'textbox', name }, value: target.value };
    const sequence = ++humanIssued;
    if (action.kind === 'fill') humanDirty.set(name, sequence);
    // Serialize captured values and Save clicks. Never replay an uncertain human write or save an older value after it fails.
    humanWrites = humanWrites.then(async () => {
      await ready;
      if (humanWriteFailed || documentInvalid) throw new Error('computer_human_write_unconfirmed');
      const next = await post<LocalWebDocument>('/api/human', { documentId: current.documentId, action });
      if (documentInvalid || next.documentId !== current.documentId || next.epoch !== current.epoch) throw new Error('computer_stale_session');
      applyState(next, sequence); humanAcknowledged = sequence;
    }).catch(() => { humanWriteFailed = true; text('notice', '입력한 글은 화면에 보존했습니다. 저장 상태를 확인할 수 없어 추가 저장을 중지했습니다.'); });
  }
  form.addEventListener('input', handleInput); form.addEventListener('click', handleInput);
  form.addEventListener('submit', event => event.preventDefault());
  document.addEventListener('focusin', () => { if (!controlledFocus) { focusRevision++; changed(); } });
  window.addEventListener('blur', () => { focusRevision++; changed(); });
  document.addEventListener('visibilitychange', () => { focusRevision++; changed(); });
  document.getElementById('takeover')!.addEventListener('click', () => {
    localHandoff(); void post('/api/owner', { documentId: current.documentId, human: true }).catch(() => text('notice', '연결 상태를 확인해 주세요.'));
  });
  document.getElementById('return-control')!.addEventListener('click', () => {
    const sequence = humanIssued;
    humanWrites = humanWrites.then(async () => {
      if (humanWriteFailed || humanAcknowledged !== sequence || humanIssued !== sequence || documentInvalid) {
        text('notice', '최신 입력의 저장을 확인한 뒤 에이전트에게 돌려줄 수 있습니다.'); return;
      }
      await post('/api/owner', { documentId: current.documentId, human: false });
      if (humanIssued !== sequence) return;
      humanOwned = false; lease = null; forcedFocus = null; focusRevision++; changed(); ownerText();
    }).catch(() => text('notice', '연결 상태를 확인해 주세요.'));
  });
  const ready = (async () => {
    current = await post<LocalWebDocument>('/api/document', {}); applyState(current); ownerText();
    httpCalls++;
    const response = await fetch('/api/events', { method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify({ documentId: current.documentId }) });
    if (!response.ok || !response.body) throw new Error('computer_fixture_unavailable');
    const reader = response.body.getReader();
    void (async () => {
      const decoder = new TextDecoder(); let buffered = '';
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        responseBytes += chunk.value.byteLength; buffered += decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = buffered.indexOf('\n')) >= 0) {
          const source = buffered.slice(0, end); buffered = buffered.slice(end + 1); if (!source) continue;
          const message = JSON.parse(source) as { kind: 'state'; value: LocalWebDocument } | { kind: 'control'; id: string; value: LocalWebControl } | { kind: 'invalidated' };
          if (message.kind === 'state') applyState(message.value);
          else if (message.kind === 'invalidated') { documentInvalid = true; lease = null; changed(); text('notice', '다른 문서가 연결되었습니다. 이 페이지를 새로고침해 주세요.'); }
          else { control(message.value); await post('/api/control-ack', { documentId: current.documentId, id: message.id }); }
        }
      }
      documentInvalid = true; lease = null; changed(); text('notice', '문서 연결이 끊겼습니다. 입력을 중지했습니다.');
    })().catch(() => { documentInvalid = true; lease = null; changed(); text('notice', '문서 연결을 확인해 주세요.'); });
  })();
  async function act(grant: ComputerLease, request: Act): Promise<ComputerActionResult> {
    const cost = usage(); const result = (status: ComputerActionResult['status'], reason: string | null): ComputerActionResult => ({ operationId: request.operationId, status, reason, usage: cost });
    const key = JSON.stringify([grant.sessionId, grant.epoch, grant.workId, grant.attemptId, request.operationId]); const digest = JSON.stringify({ grant, request });
    const prior = operations.get(key);
    if (prior) return prior.digest === digest ? { ...await prior.promise, usage: cost } : result('unknown', 'computer_operation_conflict');
    // Reload drops this renderer's operation cache, not the old operation's durable effect.
    // A fresh grant can look up its receipt; refusing another dispatch cannot prove historical non-application.
    if (grant.epoch !== current.epoch || grant.surfaceId !== current.surfaceId)
      return result('unknown', 'computer_operation_history_unavailable');
    if (operations.size >= 256) return result('not_applied', 'computer_receipt_limit');
    if (busy) return result('not_applied', 'computer_session_busy');
    let finish!: (v: ComputerActionResult) => void;
    const response = new Promise<ComputerActionResult>(resolve => { finish = resolve; }); operations.set(key, { digest, promise: response });
    busy = true; let dispatched = false;
    try {
      // The last check and DOM dispatch share this renderer turn. Remote runtime authorization is a separate boundary.
      const error = inputError(grant, request); if (error) { finish(result('not_applied', error)); return await response; }
      const target = nodes().find(node => refs.get(node) === request.targetRef)!;
      const identity: ComputerOperationIdentity = { workId: grant.workId, attemptId: grant.attemptId, sessionId: grant.sessionId, epoch: grant.epoch,
        surfaceId: grant.surfaceId, operationId: request.operationId, viewRevision: request.basis.revision, focusRevision: request.basis.focusRevision,
        targetRef: request.targetRef, action: request.action };
      pending = { identity, lease: grant, deadlineAt: request.deadlineAt, promise: null };
      controlledFocus = true; target.focus(); controlledFocus = false;
      const focusError = inputError(grant, request);
      if (focusError) { pending = null; finish(result('not_applied', focusError)); return await response; }
      domInputsDispatched++; dispatched = true;
      if (request.action.kind === 'fill') { (target as HTMLInputElement | HTMLTextAreaElement).value = request.action.value; target.dispatchEvent(new Event('input', { bubbles: true })); }
      else target.click();
      focusRevision++; syncDomRevision(); changed();
      const saving = pending.promise; pending = null;
      if (!saving) { finish(result('unknown', 'computer_input_unconfirmed')); return await response; }
      try { applyState(await saving); finish(result('applied', null)); }
      catch { finish(result('unknown', 'computer_response_unknown')); text('notice', '입력은 전달됐지만 저장 응답을 확인하지 못했습니다. 다시 입력하지 않고 영수증을 조회해야 합니다.'); }
    } catch { finish(result(dispatched ? 'unknown' : 'not_applied', 'computer_driver_failure')); }
    finally { pending = null; controlledFocus = false; busy = false; }
    return response;
  }
  async function request(input: unknown): Promise<unknown> {
    await ready; bridgeCalls++;
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 65536 || !object(input) || typeof input.kind !== 'string') throw new Error('computer_command_invalid');
    const command = structuredClone(input) as Command;
    if (command.kind === 'acquire') {
      if (!exact(command, ['kind', 'request']) || !exact(command.request, ['sessionId', 'workId', 'attemptId', 'deadlineAt']) ||
          !['sessionId', 'workId', 'attemptId'].every(k => string(command.request![k])) || !integer(command.request.deadlineAt)) throw new Error('computer_command_invalid');
      if (documentInvalid) throw new Error('computer_stale_session'); if (humanOwned || humanIssued !== humanAcknowledged || humanWriteFailed) throw new Error('computer_human_owned');
      const result = await post<ComputerLease>('/api/acquire', { documentId: current.documentId, request: command.request });
      if (documentInvalid || humanOwned || humanIssued !== humanAcknowledged || humanWriteFailed) throw new Error('computer_stale_session'); lease = result; ownerText(); return result;
    }
    if (command.kind === 'release') {
      if (!exact(command, ['kind', 'lease']) || !leaseValid(command.lease)) throw new Error('computer_command_invalid');
      await post('/api/release', { documentId: current.documentId, lease: command.lease });
      if (equal(lease, command.lease)) { lease = null; ownerText(); } return null;
    }
    if (!exact(command, ['kind', 'lease', 'request']) || !leaseValid(command.lease) || !object(command.request)) throw new Error('computer_command_invalid');
    const grant = command.lease; const value = command.request;
    if (command.kind === 'act') {
      if (!exact(value, ['operationId', 'basis', 'targetRef', 'action', 'deadlineAt']) || !string(value.operationId) || !string(value.targetRef) || !integer(value.deadlineAt) || !actionValid(value.action) || !viewValid(value.basis)) throw new Error('computer_command_invalid');
      return act(grant, value as unknown as Act);
    }
    const denied = guard(grant); if (denied) throw new Error(denied);
    if (command.kind === 'observe') {
      if (!exact(value, ['maxElements', 'maxBytes']) || !integer(value.maxElements, 1) || value.maxElements > 40 || !integer(value.maxBytes, 1) || value.maxBytes > 32768) throw new Error('computer_command_invalid');
      const observed = view();
      while (observed.elements.length > value.maxElements || new TextEncoder().encode(JSON.stringify(observed)).byteLength > value.maxBytes) {
        if (!observed.elements.length) throw new Error('computer_observation_limit'); observed.elements.pop(); observed.partial = true; observed.omittedCount++;
      }
      return { view: observed, usage: usage() };
    }
    if (command.kind === 'lookup') {
      if (!exact(value, ['identity'])) throw new Error('computer_command_invalid');
      return post('/api/lookup', { documentId: current.documentId, lease: grant, request: value });
    }
    if (command.kind !== 'wait' || !exact(value, ['afterRevision', 'maxWaitMs', 'deadlineAt']) || !integer(value.afterRevision) || !integer(value.maxWaitMs) || value.maxWaitMs > 30000 || !integer(value.deadlineAt)) throw new Error('computer_command_invalid');
    const cost = usage(); const start = Date.now(); const end = Math.min(start + value.maxWaitMs, value.deadlineAt, grant.expiresAt);
    return new Promise(resolve => {
      let done = false; let timer: ReturnType<typeof setTimeout>;
      const check = () => {
        if (done) return; cost.internalOperations++; syncDomRevision(); if (done) return;
        const error = guard(grant); const status = error ? 'interrupted' : Date.now() >= end ? 'timeout' : revision !== value.afterRevision ? 'changed' : null;
        if (!status) return; done = true; clearTimeout(timer); changes.delete(check); cost.waitMs = Date.now() - start; resolve({ status, usage: cost });
      };
      changes.add(check); timer = setTimeout(check, Math.max(0, end - Date.now())); check();
    });
  }
  Object.defineProperty(window, 'secumonComputer', { value: Object.freeze({ request,
    snapshot: () => structuredClone({ ready: !!current, epoch: current?.epoch, revision, focusRevision, humanOwned, documentInvalid,
      domInputsDispatched, domEventsHandled, bridgeCalls, httpCalls, requestBytes, responseBytes,
      humanIssued, humanAcknowledged, humanWriteFailed, humanDirtyFields: [...humanDirty.keys()], nativeOsInput: false, automation: 'typed-dom' }) }), writable: false, configurable: false });
}

export const localWebComputerPageScript = (key: string): string => `(${localWebComputerPage.toString()})(${JSON.stringify({ key })});`;
export const localWebComputerPageHtml = (nonce: string): string => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>문서 실습실</title>
<style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;background:#f3f5f8;color:#17253b;font:16px/1.6 system-ui,sans-serif}main{max-width:840px;margin:auto;padding:32px 20px}h1{font-size:32px;letter-spacing:-1px;margin:4px 0}.eyebrow{font-size:13px;color:#526985}p{margin:8px 0}.card{background:white;border:1px solid #dbe1e9;border-radius:16px;padding:24px;margin:22px 0;box-shadow:0 8px 28px #253a5610}label{display:block;font-weight:650;margin-bottom:8px}input,textarea{width:100%;border:1px solid #aab7c9;border-radius:8px;padding:12px;font:inherit}textarea{min-height:130px;resize:vertical}button{border:0;border-radius:8px;background:#185bc0;color:#fff;padding:11px 18px;font:inherit;font-weight:650;cursor:pointer;margin-top:12px}button.secondary{background:#e8eef7;color:#21476d;margin-right:8px}button:disabled{opacity:.5}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid #e3a932;outline-offset:3px}.row{margin-bottom:24px}.muted{color:#526985;font-size:14px}.facts{display:grid;grid-template-columns:1fr 1fr;gap:12px}.fact{background:#f3f6fb;border-radius:9px;padding:12px}.wide{grid-column:1/-1}output{display:block;font-weight:650;white-space:pre-wrap;overflow-wrap:anywhere}.notice{color:#805000;overflow-wrap:anywhere}#owner-status{font-weight:650;color:#23529a}hr{border:0;border-top:1px solid #e1e6ed;margin:24px 0}@media(max-width:420px){main{padding:20px 12px}.card{padding:18px}.facts{grid-template-columns:1fr}h1{font-size:28px}button{max-width:100%}}</style></head><body><main>
<p class="eyebrow">로컬 실습용 문서 앱 · 생성한 자료 · 실제 모델 미연결</p><h1>문서 실습실</h1><p class="muted">검색과 메모 저장을 직접 확인하는 작은 작업 공간입니다.</p>
<section class="card" aria-label="문서 편집"><p id="owner-status" role="status">연결 중</p><p class="muted">자동화는 이 페이지의 DOM만 조작합니다. OS 키보드·마우스 입력은 사용하지 않습니다.</p>
<form id="document-form"><div class="row"><label for="query">검색어 · Query</label><input id="query" aria-label="Query" data-computer-element maxlength="8192" autocomplete="off"><button type="button" aria-label="Search" data-computer-element>Search · 검색</button><p id="search-status" class="muted" role="status">검색 대기</p></div>
<div class="row"><label for="note">메모 · Note</label><textarea id="note" aria-label="Note" data-computer-element maxlength="8192"></textarea><button type="button" aria-label="Save" data-computer-element>Save · 저장</button></div></form>
<div class="facts" aria-label="앱이 확인한 결과"><div class="fact wide"><span class="muted">저장된 메모 · savedNote</span><output id="saved-note"></output></div><div class="fact"><span class="muted">저장 횟수 · saveCount</span><output id="save-count">0</output></div><div class="fact"><span class="muted">적용된 앱 입력 · inputCount</span><output id="input-count">0</output></div><div class="fact wide"><span class="muted">검색 완료 · resultsReady</span><output id="results-ready">false</output></div></div>
<hr><button id="takeover" type="button" class="secondary">직접 편집하기</button><button id="return-control" type="button" class="secondary">에이전트에게 돌려주기</button><p class="muted">사람이 편집하면 이전 에이전트 입력 권한은 무효화됩니다. 새로고침은 작업 취소가 아닙니다.</p><p id="notice" role="status" class="notice"></p></section></main><script src="/fixture.js"></script></body></html>`;
