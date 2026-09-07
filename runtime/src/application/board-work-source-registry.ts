import type { BoardWorkSource, BoardWorkSources } from './board-work-sources.js';
import type { WorkState } from '../domain/model.js';

/** Only sources explicitly registered by the host are addressable. No directory or database discovery. */
export class BoardWorkSourceRegistry implements BoardWorkSources {
  readonly #entries = new Map<string, { tenantId: string; principalId: string; source: BoardWorkSource }>();
  register(owner: { tenantId: string; principalId: string }, source: BoardWorkSource): () => void {
    const id = source.inputs.id;
    if (!owner.tenantId || !owner.principalId || !id || this.#entries.has(id) || this.#entries.size >= 64)
      throw new Error('board_source_registration_invalid');
    let active = true;
    const guard = () => { if (!active) throw new Error('board_source_unregistered'); };
    const inputs = source.inputs;
    const registered: BoardWorkSource = Object.freeze({
      inputs: Object.freeze({ id, identity: inputs.identity ?? inputs,
        state: Object.freeze({ get: async (workId: string) => { guard(); const value = await inputs.state.get(workId); guard(); return value; } }),
        authority: Object.freeze({ resolve: async (identity: Parameters<typeof inputs.authority.resolve>[0]) => {
          guard(); const value = await inputs.authority.resolve(identity); guard(); return value;
        } }),
        inspectInput: async (...args: Parameters<typeof inputs.inspectInput>) => { guard(); return inputs.inspectInput(...args); },
        inspectMemory: async (...args: Parameters<typeof inputs.inspectMemory>) => { guard(); return inputs.inspectMemory(...args); },
        effectsCurrent: async (...args: Parameters<typeof inputs.effectsCurrent>) => { guard(); const value = await inputs.effectsCurrent(...args); guard(); return value; },
        inspectCoverage: async (...args: Parameters<typeof inputs.inspectCoverage>) => { guard(); return inputs.inspectCoverage(...args); },
      }),
      artifacts: Object.freeze({
        get: async (...args: Parameters<typeof source.artifacts.get>) => { guard(); const value = await source.artifacts.get(...args); guard(); return value; },
        exists: async (...args: Parameters<typeof source.artifacts.exists>) => { guard(); const value = await source.artifacts.exists(...args); guard(); return value; },
      }),
      current: async (state: WorkState) => { guard(); const value = await source.current(state); guard(); return value; },
    });
    this.#entries.set(id, { ...owner, source: registered });
    return () => { active = false; this.#entries.delete(id); };
  }
  async resolve(identity: { tenantId: string; principalId: string; workId: string }): Promise<BoardWorkSource | null> {
    let selected: BoardWorkSource | null = null;
    for (const entry of this.#entries.values()) {
      if (entry.tenantId !== identity.tenantId || entry.principalId !== identity.principalId) continue;
      const state = await entry.source.inputs.state.get(identity.workId);
      if (!state || state.policy.tenantId !== identity.tenantId || state.policy.principalId !== identity.principalId) continue;
      if (selected) throw new Error('board_source_ambiguous');
      selected = entry.source;
    }
    return selected;
  }
}
