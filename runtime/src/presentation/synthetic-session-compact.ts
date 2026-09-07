import { ScriptedPlanner } from '../infrastructure/fakes.js';
import type { ModelCallOptions, SessionCompactReply } from '../application/ports.js';
import type { SessionCompactInput, SessionRetainedItem } from '../domain/session-compact.js';

export interface SyntheticCompactRule {
  role: 'user' | 'assistant';
  quote: string;
  text: string;
  kind: SessionRetainedItem['kind'];
  exactText: string;
  entryKind?: string;
}
export interface SyntheticCompactExtension {
  userTexts: readonly string[];
  rules: readonly SyntheticCompactRule[];
}

/** Explicit local fixture adapter. It does not interpret arbitrary conversation text. */
export class SyntheticSessionCompactPlanner extends ScriptedPlanner {
  override readonly identity = { provider: 'synthetic', model: 'local-session-rules', revision: '1' };
  readonly #extension: SyntheticCompactExtension | undefined;
  constructor(scripts: ConstructorParameters<typeof ScriptedPlanner>[0], extension?: SyntheticCompactExtension) {
    super(scripts); this.#extension = extension === undefined ? undefined : structuredClone(extension);
  }
  estimateCompactInput(compact: SessionCompactInput, options: ModelCallOptions) {
    const bytes = new TextEncoder().encode(JSON.stringify({ compact, options })).byteLength;
    // No tokenizer or model runs here. The ledger requires a positive input reservation;
    // byte limits, one call and the normal output reservation still apply independently.
    return { bytes, tokens: 1, method: 'synthetic_rule_engine_no_model_tokens' };
  }
  async compact(input: SessionCompactInput, signal: AbortSignal, _options: ModelCallOptions): Promise<SessionCompactReply> {
    if (signal.aborted) return { status: 'cancelled', code: 'cancelled', inputTokens: 0, outputTokens: 0 };
    const users = input.entries.filter(entry => entry.role === 'user' && (this.#extension ? ['work', 'input', 'command'] : ['work', 'input']).includes(entry.kind));
    const retained: SessionRetainedItem[] = structuredClone(input.previous?.content.retained ?? []);
    const rules = [
      { quote: '외부 전송 금지', text: '합성 예제의 자료는 외부로 전송하지 않는다.', kind: 'constraint' as const },
      { quote: '원문 보존', text: '합성 예제의 대화 원문을 유지한다.', kind: 'constraint' as const },
      { quote: '검증 후 완료', text: '합성 예제의 완료 판정에는 검증이 필요하다.', kind: 'decision' as const },
    ];
    if (users.some(entry => !(entry.text.startsWith('[합성 예제]') && rules.some(rule => entry.text.includes(rule.quote))) &&
      !this.#extension?.userTexts.includes(entry.text))) return {
      status: 'refused', code: 'synthetic_compact_fixture_required', inputTokens: 0, outputTokens: 0,
    };
    for (const entry of users) for (const rule of rules) {
      if (!entry.text.includes(rule.quote)) continue;
      const citation = { sequence: entry.sequence, sourceId: entry.sourceId, role: entry.role, quote: rule.quote };
      const existing = retained.find(item => item.text === rule.text);
      if (existing) { existing.citations = [citation]; existing.changedBy = citation; continue; }
      retained.push({ id: `fixture-${entry.sequence}-${rules.indexOf(rule)}`, kind: rule.kind, text: rule.text, status: 'active',
        citations: [citation] });
    }
    for (const entry of input.entries) for (const [index, rule] of (this.#extension?.rules ?? []).entries()) {
      if (entry.role !== rule.role || entry.text !== rule.exactText || !entry.text.includes(rule.quote) ||
          rule.entryKind !== undefined && entry.kind !== rule.entryKind || entry.role === 'user' && !users.includes(entry)) continue;
      const citation = { sequence: entry.sequence, sourceId: entry.sourceId, role: entry.role, quote: rule.quote };
      const existing = retained.find(item => item.text === rule.text);
      if (existing) { existing.citations = [citation]; existing.changedBy = citation; continue; }
      retained.push({ id: `fixture-${entry.sequence}-${rules.length + index}`, kind: rule.kind, text: rule.text, status: 'active', citations: [citation] });
    }
    if (!retained.length) return { status: 'refused', code: 'synthetic_compact_fixture_required', inputTokens: 0, outputTokens: 0 };
    return { status: 'ok', provider: this.identity.provider, model: this.identity.model, inputTokens: 0, outputTokens: 0,
      candidate: { inputDigest: input.inputDigest, content: {
        narrative: `합성 규칙 시험: ${input.prefix.throughSequence}번까지의 기록을 참조한다. 고정 사전에서 확인한 ${this.#extension ? '항목' : '제약·결정'} ${retained.length}개를 유지한다. 자유 문장의 의미를 분석한 결과는 아니다.`, retained,
      } } };
  }
}
