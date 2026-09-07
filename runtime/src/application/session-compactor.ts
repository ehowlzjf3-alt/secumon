import type { WorkState } from '../domain/model.js';
import type { AppliedSessionInput, SessionContext, SessionEntry, SessionHead } from '../domain/session.js';
import type { SessionCompactCandidate, SessionCompactInput, SessionCompactLimits, SessionQuote, SessionSourceManifest, SessionSummaryPublication, SessionSummaryRecord, SessionSummaryView } from '../domain/session-compact.js';
import type { SessionCompactSource } from './session-compact-ports.js';
import type { SessionContextDraft, SessionRepository } from './session-ports.js';
import type { RuntimeServices } from './services.js';
import { SessionCompactCandidateSchema, SessionCompactInputSchema, SessionSummaryRecordSchema } from './session-compact-contracts.js';
import { SessionContextSchema } from './session-contracts.js';
import { SessionOriginals } from './session-originals.js';
import { sameSessionInput } from './session-context.js';

type Services = Pick<RuntimeServices, 'state' | 'artifacts' | 'clock' | 'digester' | 'planner'>;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const interpretation = 'conversation_history_not_verified_evidence' as const;
const defaults: SessionCompactLimits = { maxContextBytes: 65536, maxContextEntries: 256, triggerRatio: 0.8, targetRatio: 0.6,
  keepRecentEntries: 8, maxCompactInputBytes: 49152, maxCompactEntries: 64, maxSummaryBytes: 8192 };
const view = (record: SessionSummaryRecord): SessionSummaryView => ({ ref: record.ref, content: record.content });
const quotes = (content: SessionSummaryRecord['content']): SessionQuote[] => content.retained.flatMap(item => [...item.citations, ...(item.changedBy ? [item.changedBy] : [])]);

/** Summary records remain derived data; original source checks and work call acceptance grant their use. */
export class SessionCompactor implements SessionCompactSource {
  readonly originals: SessionOriginals;
  readonly limits: Readonly<SessionCompactLimits>;
  constructor(readonly services: Services, readonly repository: SessionRepository,
    readonly applied: (state: WorkState) => Promise<AppliedSessionInput | null>, config: Partial<SessionCompactLimits> = {}) {
    this.originals = new SessionOriginals(services, repository);
    this.limits = Object.freeze({ ...defaults, ...config });
    const l = this.limits;
    if (![l.maxContextBytes, l.maxContextEntries, l.keepRecentEntries, l.maxCompactInputBytes, l.maxCompactEntries, l.maxSummaryBytes].every(v => Number.isSafeInteger(v) && v > 0) ||
      l.maxContextEntries > 256 || l.maxCompactEntries > 256 || l.keepRecentEntries >= l.maxContextEntries || l.maxSummaryBytes < 256 || l.maxSummaryBytes > 65536 ||
      !(l.targetRatio > 0 && l.targetRatio < l.triggerRatio && l.triggerRatio < 1)) throw new Error('invalid_session_compact_configuration');
  }
  private digest(value: unknown) { return this.originals.digest(value); }
  private inputDigest(input: SessionCompactInput) { const { inputDigest: _, ...basis } = input; return this.digest(basis); }
  private summaryDigest(record: SessionSummaryPublication | SessionSummaryRecord) {
    return this.digest({ scope: record.scope, content: record.content, workId: record.workId, callId: record.callId,
      inputDigest: record.inputDigest, prefix: record.prefix, previous: record.previous, policyDigest: record.ref.policyDigest });
  }
  private async validateSummary(state: WorkState, basis: AppliedSessionInput, value: SessionSummaryRecord, requireAccepted = true) {
    const record = SessionSummaryRecordSchema.parse(value);
    if (this.digest(record.scope) !== this.digest(basis.scope) || record.ref.throughSequence >= basis.input.sequence ||
      record.ref.throughSequence !== record.prefix.throughSequence || record.ref.policyDigest !== this.originals.policyDigest(state.policy) ||
      record.ref.digest !== this.summaryDigest(record) || bytes(record.content) > this.limits.maxSummaryBytes) throw new Error('session_summary_unavailable');
    const creator = await this.services.state.get(record.workId);
    const call = creator?.modelCalls.find(item => item.id === record.callId);
    if (!creator || this.digest(creator.conversation?.session?.scope ?? null) !== this.digest(basis.scope) || !call ||
      call.purpose !== 'session_compact' || call.compactInputDigest !== record.inputDigest || (requireAccepted && call.status !== 'accepted')) throw new Error('session_summary_unavailable');
    const manifest = await this.originals.manifest(state, basis, record.ref.throughSequence, quotes(record.content));
    if (this.digest(manifest) !== this.digest(record.prefix)) throw new Error('session_summary_source_changed');
    return record;
  }
  private async previous(state: WorkState, basis: AppliedSessionInput): Promise<SessionSummaryRecord | null> {
    let before: { throughSequence: number; revision: number } | undefined;
    // An unpublished/invalid candidate does not hide the last usable accepted prefix.
    for (let n = 0; n < 32; n++) {
      const record = await this.repository.summaryBefore(basis.scope, basis.input.sequence, this.originals.policyDigest(state.policy), before);
      if (!record) return null;
      try { return await this.validateSummary(state, basis, record); }
      catch { before = { throughSequence: record.ref.throughSequence, revision: record.ref.revision }; }
    }
    throw new Error('session_summary_recovery_capacity');
  }
  private async snapshot(state: WorkState, fixed?: SessionContext, allowCapacity = false) {
    const basis = await this.applied(state); if (!basis) return null;
    let summary: SessionSummaryRecord | null = null;
    if (fixed?.schemaVersion === 2) {
      const stored = await this.repository.summary(basis.scope, fixed.summary.ref.id);
      if (!stored || this.digest(view(stored)) !== this.digest(fixed.summary)) throw new Error('session_summary_unavailable');
      summary = await this.validateSummary(state, basis, stored);
    } else if (!fixed) summary = await this.previous(state, basis);
    const entries: SessionEntry[] = [];
    let currentInput: SessionEntry | null = null;
    let capacity: 'entries' | 'bytes' | null = null;
    let totalEntries = 0, totalBytes = 2 + (summary ? bytes(view(summary)) : 0);
    let sourceDigest = summary?.prefix.digest ?? this.originals.seed(basis, state.policy);
    let sourceEntries = summary?.prefix.entries ?? 0;
    for await (const row of this.originals.read(state, basis, summary?.ref.throughSequence ?? 0, basis.input.sequence)) {
      sourceDigest = this.digest({ previous: sourceDigest, source: row.provenance });
      if (!row.eligible) continue;
      sourceEntries++; totalBytes += bytes(row.entry) + (totalEntries > 0 ? 1 : 0); totalEntries++;
      if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(sourceEntries)) throw new Error('session_context_capacity');
      if (row.entry.role === 'user' && row.entry.sequence === basis.input.sequence && row.entry.sourceId === basis.input.messageId) currentInput = row.entry;
      capacity ??= totalEntries > this.limits.maxContextEntries ? 'entries' : totalBytes > this.limits.maxContextBytes ? 'bytes' : null;
      if (capacity && !allowCapacity) throw new Error('session_context_capacity');
      if (!capacity) entries.push(row.entry);
    }
    if (!currentInput) throw new Error('session_current_input_unavailable');
    const body = summary ? { basis, entries, summary: view(summary) } : { basis, entries };
    const candidate = capacity ? null : { throughSequence: basis.input.sequence, digest: this.digest(body), policyDigest: this.digest(state.policy) };
    const sourceManifest = { throughSequence: basis.input.sequence, digest: sourceDigest, entries: sourceEntries };
    return { basis, entries, summary, candidate, currentInput, sourceManifest, capacity, totalEntries, totalBytes };
  }
  private async stateCurrent(state: WorkState) {
    return this.digest(await this.services.state.get(state.id)) === this.digest(state) && sameSessionInput(await this.applied(state) ?? undefined, state.conversation?.session);
  }
  async inspectContext(state: WorkState): Promise<SessionContextDraft | null> {
    if (!(await this.stateCurrent(state))) throw new Error('session_context_changed');
    const snapshot = await this.snapshot(state, undefined, true);
    if (!snapshot) return null;
    if (!(await this.stateCurrent(state))) throw new Error('session_context_changed');
    const common = { basis: snapshot.basis, currentInput: snapshot.currentInput, summary: snapshot.summary ? view(snapshot.summary) : null,
      sourceManifest: snapshot.sourceManifest, totalEntries: snapshot.totalEntries, totalBytes: snapshot.totalBytes };
    if (snapshot.capacity) return structuredClone({ ...common, status: 'capacity', reason: snapshot.capacity });
    if (!snapshot.candidate) throw new Error('session_context_changed');
    return structuredClone({ ...common, status: 'complete', entries: snapshot.entries, candidate: snapshot.candidate });
  }
  async draftCurrent(state: WorkState, draft: SessionContextDraft, signal?: AbortSignal): Promise<boolean> {
    try {
      if (signal?.aborted) return false;
      const current = await this.inspectContext(state);
      return !signal?.aborted && current !== null && this.digest(current) === this.digest(draft);
    } catch { return false; }
  }
  async materializeContext(state: WorkState, draft: SessionContextDraft): Promise<SessionContext> {
    if (draft.status !== 'complete') throw new Error('session_context_capacity');
    if (!(await this.draftCurrent(state, draft))) throw new Error('session_context_changed');
    const { basis, entries, summary, candidate } = draft;
    const head = await this.publishContextHead(basis, candidate);
    if (!(await this.draftCurrent(state, draft))) throw new Error('session_context_changed');
    return SessionContextSchema.parse(summary ? { schemaVersion: 2, basis, entries, summary, head, interpretation } : { schemaVersion: 1, basis, entries, head, interpretation });
  }
  private async publishContextHead(basis: AppliedSessionInput, candidate: Omit<SessionHead, 'revision'> | null) {
    if (!candidate) throw new Error('session_context_capacity');
    let head = await this.repository.head(basis.scope, candidate);
    for (let retry = 0; !head && retry < 8; retry++) {
      const record = await this.repository.get(basis.scope);
      if (record.head && record.head.throughSequence > candidate.throughSequence) { head = await this.repository.retainHead(basis.scope, candidate); break; }
      head = await this.repository.publishHead(basis.scope, record.head?.revision ?? 0, candidate) ?? await this.repository.head(basis.scope, candidate);
    }
    if (!head) throw new Error('session_context_contention');
    return head;
  }
  async context(state: WorkState): Promise<SessionContext | null> {
    const snapshot = await this.snapshot(state); if (!snapshot) return null;
    const { basis, entries, summary, candidate } = snapshot;
    const head = await this.publishContextHead(basis, candidate);
    return summary ? { schemaVersion: 2, basis, entries, summary: view(summary), head, interpretation } : { schemaVersion: 1, basis, entries, head, interpretation };
  }
  async current(state: WorkState, value?: SessionContext, signal?: AbortSignal): Promise<boolean> {
    try {
      if (signal?.aborted) return false;
      if (!value) { await this.applied(state); return !signal?.aborted; }
      const fixed = SessionContextSchema.parse(value);
      const snapshot = await this.snapshot(state, fixed);
      if (!snapshot?.candidate || !sameSessionInput(snapshot.basis, fixed.basis)) return false;
      const head = await this.repository.head(snapshot.basis.scope, snapshot.candidate);
      return !!head && this.digest(head) === this.digest(fixed.head) && this.digest(snapshot.entries) === this.digest(fixed.entries) && !signal?.aborted;
    } catch { return false; }
  }
  async prepareCompact(state: WorkState, options: Parameters<SessionCompactSource['prepareCompact']>[1] = {}): Promise<SessionCompactInput | null> {
    const basis = await this.applied(state); if (!basis) return null;
    const previous = await this.previous(state, basis);
    const first: SessionEntry[] = []; const prefixes: SessionSourceManifest[] = [];
    let totalEntries = 0; let totalBytes = 2 + (previous ? bytes(view(previous)) : 0); let pending = false;
    let sourceDigest = previous?.prefix.digest ?? this.originals.seed(basis, state.policy); let sourceEntries = previous?.prefix.entries ?? 0;
    for await (const row of this.originals.read(state, basis, previous?.ref.throughSequence ?? 0, basis.input.sequence)) {
      pending ||= row.pending;
      sourceDigest = this.digest({ previous: sourceDigest, source: row.provenance });
      if (!row.eligible) continue;
      sourceEntries++;
      totalEntries++; totalBytes += bytes(row.entry) + 1;
      if (!pending && first.length < this.limits.maxCompactEntries) {
        first.push(row.entry); prefixes.push({ throughSequence: row.entry.sequence, digest: sourceDigest, entries: sourceEntries });
      }
    }
    const available = Math.min(this.limits.maxContextBytes, options.maxInputBytes === undefined ? Infinity : Math.floor(options.maxInputBytes * 0.75),
      options.measure || options.maxInputTokens === undefined ? Infinity : options.maxInputTokens * 3);
    if (!options.force && totalBytes < available * this.limits.triggerRatio && totalEntries <= this.limits.maxContextEntries) return null;
    const keep = totalEntries <= this.limits.keepRecentEntries || options.force ? 1 : this.limits.keepRecentEntries;
    let count = Math.min(first.length, totalEntries - keep);
    if (count < 1) {
      if (totalBytes > available || totalEntries > this.limits.maxContextEntries) throw new Error('session_compact_capacity');
      return null;
    }
    const expectedHead = (await this.repository.summaryHead(basis.scope))?.ref ?? null;
    const inputLimit = Math.min(this.limits.maxCompactInputBytes, options.maxInputBytes ?? Infinity, options.maxInputTokens === undefined ? Infinity : options.maxInputTokens * 3);
    // At most 256 source entries: 256,128,64,32,16,8,4,2,1. No candidate owns a model reservation.
    for (let attempt = 0; count > 0 && attempt < 9; attempt++, count = Math.floor(count / 2)) {
      const entries = first.slice(0, count); const throughSequence = entries.at(-1)!.sequence;
      if (throughSequence >= basis.input.sequence) continue;
      const prefix = prefixes[count - 1]!;
      const input: SessionCompactInput = { schemaVersion: 1, purpose: 'session_compact', workId: state.id, basis,
        policyDigest: this.originals.policyDigest(state.policy), inputDigest: '', expectedHead, previous: previous ? view(previous) : null,
        prefix, entries, maxSummaryBytes: Math.max(256, Math.min(this.limits.maxSummaryBytes, Math.floor(available * this.limits.targetRatio * 0.5))), interpretation };
      input.inputDigest = this.inputDigest(input);
      // A full request estimator replaces the byte/token conversion guess, not the configured source-segment cap.
      if (options.measure ? bytes(input) > this.limits.maxCompactInputBytes : bytes(input) + 256 > inputLimit) continue;
      const candidate = SessionCompactInputSchema.parse(input);
      const fit = options.measure?.(structuredClone(candidate)) ?? 'fit';
      if (fit !== 'fit' && fit !== 'too_large') throw new Error('model_input_estimate_invalid');
      if (fit === 'too_large') continue;
      if (!sameSessionInput(await this.applied(state) ?? undefined, basis) ||
        this.digest((await this.repository.summaryHead(basis.scope))?.ref ?? null) !== this.digest(expectedHead)) throw new Error('session_compact_input_changed');
      return candidate;
    }
    throw new Error('session_compact_capacity');
  }
  async compactInputCurrent(state: WorkState, value: SessionCompactInput, signal?: AbortSignal): Promise<boolean> {
    try {
      const input = SessionCompactInputSchema.parse(value); const basis = await this.applied(state);
      if (signal?.aborted || !basis || !sameSessionInput(basis, input.basis) || state.id !== input.workId || input.inputDigest !== this.inputDigest(input) ||
        input.policyDigest !== this.originals.policyDigest(state.policy) || input.prefix.throughSequence >= basis.input.sequence || input.maxSummaryBytes > this.limits.maxSummaryBytes) return false;
      let previous: SessionSummaryRecord | null = null;
      if (input.previous) {
        previous = await this.repository.summary(basis.scope, input.previous.ref.id);
        if (!previous || this.digest(view(previous)) !== this.digest(input.previous) || previous.ref.throughSequence >= input.prefix.throughSequence) return false;
        await this.validateSummary(state, basis, previous);
      }
      const entries: SessionEntry[] = [];
      let digest = previous?.prefix.digest ?? this.originals.seed(basis, state.policy);
      let sourceEntries = previous?.prefix.entries ?? 0;
      for await (const row of this.originals.read(state, basis, input.previous?.ref.throughSequence ?? 0, input.prefix.throughSequence, signal)) {
        if (row.pending) return false;
        digest = this.digest({ previous: digest, source: row.provenance });
        if (row.eligible) { entries.push(row.entry); sourceEntries++; }
        if (entries.length > this.limits.maxCompactEntries) return false;
      }
      const prefix = { throughSequence: input.prefix.throughSequence, digest, entries: sourceEntries };
      return !signal?.aborted && this.digest(entries) === this.digest(input.entries) && this.digest(prefix) === this.digest(input.prefix);
    } catch { return false; }
  }
  private validateCandidate(input: SessionCompactInput, value: SessionCompactCandidate) {
    const candidate = SessionCompactCandidateSchema.parse(value);
    if (candidate.inputDigest !== input.inputDigest || bytes(candidate.content) > input.maxSummaryBytes ||
      bytes(candidate.content) >= bytes({ previous: input.previous?.content ?? null, entries: input.entries })) throw new Error('session_compact_not_reduced');
    const items = new Map(candidate.content.retained.map(item => [item.id, item]));
    if (items.size !== candidate.content.retained.length) throw new Error('session_compact_duplicate_item');
    const users = input.entries.filter(entry => entry.role === 'user');
    if (users.length && !candidate.content.retained.some(item => item.citations.some(citation => users.some(entry =>
      citation.role === 'user' && citation.sequence === entry.sequence && citation.sourceId === entry.sourceId && entry.text.includes(citation.quote)))))
      throw new Error('session_compact_source_anchor_missing');
    for (const old of input.previous?.content.retained ?? []) {
      const item = items.get(old.id);
      if (!item || item.kind !== old.kind) throw new Error('session_compact_protected_item_missing');
      if (this.digest(old) !== this.digest(item) && (!item.changedBy || item.changedBy.sequence <= input.previous!.ref.throughSequence ||
        !item.citations.some(citation => this.digest(citation) === this.digest(item.changedBy)))) throw new Error('session_compact_unproven_change');
    }
    const priorQuotes = new Set((input.previous ? quotes(input.previous.content) : []).map(quote => this.digest(quote)));
    for (const quote of quotes(candidate.content)) {
      if (priorQuotes.has(this.digest(quote))) continue;
      if (!input.entries.some(entry => entry.sequence === quote.sequence && entry.sourceId === quote.sourceId && entry.role === quote.role && entry.text.includes(quote.quote)))
        throw new Error('session_compact_quote_unavailable');
    }
    return candidate;
  }
  async publishCompact(state: WorkState, callId: string, input: SessionCompactInput, value: SessionCompactCandidate): Promise<SessionSummaryRecord> {
    if (!(await this.compactInputCurrent(state, input))) throw new Error('session_compact_input_changed');
    const candidate = this.validateCandidate(input, value);
    const latest = await this.services.state.get(state.id);
    const call = latest?.modelCalls.find(item => item.id === callId);
    if (!latest || ['cancelled', 'paused', 'failed', 'completed'].includes(latest.status) || !call || call.status !== 'received' ||
      call.purpose !== 'session_compact' || call.compactInputDigest !== input.inputDigest || !(await this.compactInputCurrent(latest, input))) throw new Error('session_compact_input_changed');
    const publication: SessionSummaryPublication = { scope: input.basis.scope, workId: state.id, callId, inputDigest: input.inputDigest,
      prefix: input.prefix, previous: input.previous?.ref ?? null, createdAt: this.services.clock.now(), content: candidate.content,
      ref: { id: `summary-${this.digest({ scope: input.basis.scope, callId })}`, throughSequence: input.prefix.throughSequence, policyDigest: input.policyDigest, digest: '' } };
    publication.ref.digest = this.summaryDigest(publication);
    const result = await this.repository.publishSummary(input.basis.scope, input.expectedHead?.revision ?? 0, publication);
    if (!result) throw new Error('session_compact_head_changed');
    return result;
  }
  async compactPublication(state: WorkState, callId: string, input: SessionCompactInput): Promise<SessionSummaryRecord | null> {
    if (!(await this.compactInputCurrent(state, input))) return null;
    const record = await this.repository.publication(input.basis.scope, callId);
    if (!record) return null;
    if (record.workId !== state.id || record.inputDigest !== input.inputDigest || this.digest(record.prefix) !== this.digest(input.prefix) ||
      this.digest(record.previous) !== this.digest(input.previous?.ref ?? null) || record.ref.digest !== this.summaryDigest(record)) throw new Error('session_compact_publication_conflict');
    this.validateCandidate(input, { inputDigest: input.inputDigest, content: record.content });
    return record;
  }
}
