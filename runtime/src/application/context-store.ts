import type { ContextHead } from '../domain/context.js';
import type { WorkState } from '../domain/model.js';
import { artifactBlocked, dataGeneration } from '../domain/data-lifecycle.js';
import { ArtifactSchema, ContextHeadSchema } from './contracts.js';
import { ContextFrameSchema, type ContextFrame } from './context-contracts.js';
import { knowledgeInputsCurrent } from './knowledge-validity.js';
import { asJson } from './plan-validator.js';
import type { RuntimeServices } from './services.js';
import { disclosureLabels } from '../domain/disclosure.js';
import { sameSessionInput, sessionContextCurrent, sessionInputsCurrent } from './session-context.js';
import { personalMemoryContextCurrent, personalMemoryDigest } from './personal-memory-context.js';

type Services = Pick<RuntimeServices, 'state' | 'artifacts' | 'digester' | 'knowledge' | 'inputs' | 'sessions' | 'personalMemories'>;
type Previous = { frame: ContextFrame | null; disposition: 'none' | 'usable' | 'regenerated' };
const changed = () => new Error('context_state_changed');

/** Stores compiler-validated derived frames; publishing a head belongs to the state transaction. */
export class ContextFrameStore {
  constructor(readonly services: Services, readonly maxBytes = 4 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('invalid_context_store_limit');
  }
  private digest(value: unknown) { return this.services.digester.digest(asJson(value)); }
  private async fresh(state: WorkState) {
    const digest = this.digest(state);
    const current = await this.services.state.get(state.id);
    if (!current || this.digest(current) !== digest) throw changed();
    try { if (!(await knowledgeInputsCurrent(this.services, current)) || !(await sessionInputsCurrent(this.services, current))) throw changed(); }
    catch { throw changed(); }
    const latest = await this.services.state.get(state.id);
    if (!latest || this.digest(latest) !== digest) throw changed();
  }
  private frameMatches(frame: ContextFrame, state: WorkState, stage: boolean) {
    const { basis, packet } = frame;
    const { allowedTools: selectedTools, ...packetPolicy } = packet.policy;
    const { allowedTools: permittedTools, ...statePolicy } = state.policy;
    return basis.workId === state.id && packet.workId === state.id && packet.stateRevision === basis.stateRevision &&
      basis.personalMemoryDigest === personalMemoryDigest(this.services, state) && Boolean(packet.personalMemory) === Boolean(state.personalMemorySelection) &&
      sameSessionInput(packet.session?.basis, state.conversation?.session) &&
      this.digest(basis.session ?? null) === this.digest(packet.session ? { basis: packet.session.basis, head: packet.session.head } : null) &&
      basis.goalRevision === state.goal.revision && packet.goal.revision === basis.goalRevision && this.digest(packet.goal) === this.digest(state.goal) &&
      basis.policyDigest === this.digest(state.policy) && basis.dataGeneration === dataGeneration(state) &&
      this.digest(packet.disclosureLabels ?? null) === this.digest(state.disclosureLabels ?? null) &&
      this.digest(packetPolicy) === this.digest(statePolicy) && selectedTools.every(id => permittedTools.includes(id)) &&
      (packet.plan?.revision ?? 0) === basis.planRevision &&
      (!stage || (basis.stateRevision === state.revision && basis.planRevision === (state.plan?.revision ?? 0) && packet.plan?.goalRevision === state.plan?.goalRevision));
  }
  async previous(value: WorkState): Promise<Previous> {
    const state = structuredClone(value);
    await this.fresh(state);
    if (!state.contextHead) return { frame: null, disposition: 'none' };
    let frame: ContextFrame | null = null;
    const parsed = ContextHeadSchema.safeParse(state.contextHead);
    if (parsed.success) {
      const head = parsed.data; const ref = head.artifact;
      if (head.basisRevision < state.revision && ref.byteLength <= this.maxBytes && ref.mediaType === 'application/json' &&
        ref.tenantId === state.policy.tenantId && ref.labels.every(label => state.policy.allowedLabels.includes(label)) &&
        state.policy.allowedLabels.every(label => ref.labels.includes(label)) && !artifactBlocked(state, ref)) {
        try {
          const bytes = await this.services.artifacts.get(ref, state.policy);
          if (bytes.byteLength === ref.byteLength && bytes.byteLength <= this.maxBytes) {
            const candidate = ContextFrameSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
            if (candidate.basis.stateRevision === head.basisRevision && candidate.memo.cycle === head.cycle && this.frameMatches(candidate, state, false) &&
              await sessionContextCurrent(this.services, state, candidate.packet.session) && await personalMemoryContextCurrent(this.services, state, candidate.packet.personalMemory)) frame = candidate;
          }
        } catch { /* Only the derived candidate is discarded; current-state failures are checked below. */ }
      }
    }
    await this.fresh(state);
    return { frame, disposition: frame ? 'usable' : 'regenerated' };
  }
  async stage(value: WorkState, input: ContextFrame): Promise<ContextHead> {
    const state = structuredClone(value);
    let frame: ContextFrame;
    try { frame = ContextFrameSchema.parse(input); }
    catch { throw new Error('context_frame_invalid'); }
    if (!this.frameMatches(frame, state, true) || !(await sessionContextCurrent(this.services, state, frame.packet.session)) ||
      !(await personalMemoryContextCurrent(this.services, state, frame.packet.personalMemory))) throw changed();
    const bytes = new TextEncoder().encode(JSON.stringify(frame));
    if (bytes.byteLength > this.maxBytes) throw new Error('context_frame_too_large');
    await this.fresh(state);
    const labels = disclosureLabels(state).sort();
    const artifact = ArtifactSchema.parse(await this.services.artifacts.put(bytes, { tenantId: state.policy.tenantId, labels, mediaType: 'application/json' }));
    if (artifact.tenantId !== state.policy.tenantId || artifact.mediaType !== 'application/json' || artifact.byteLength !== bytes.byteLength ||
      this.digest([...artifact.labels].sort()) !== this.digest(labels) || artifactBlocked(state, artifact)) throw new Error('context_artifact_invalid');
    await this.fresh(state);
    const stored = await this.services.artifacts.get(artifact, state.policy);
    if (stored.byteLength !== bytes.byteLength || stored.some((byte, index) => byte !== bytes[index])) throw new Error('context_artifact_invalid');
    await this.fresh(state);
    if (!(await sessionContextCurrent(this.services, state, frame.packet.session))) throw changed();
    if (!(await personalMemoryContextCurrent(this.services, state, frame.packet.personalMemory))) throw changed();
    return ContextHeadSchema.parse({ artifact, basisRevision: frame.basis.stateRevision, cycle: frame.memo.cycle });
  }
}
