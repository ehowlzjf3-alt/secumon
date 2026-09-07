import type { WorkState } from '../domain/model.js';
import { collectionCoverageCandidates } from '../domain/read-coverage.js';
import type { RuntimeServices } from './services.js';
import type { ToolContracts } from './tool-contracts.js';
import { ReadCheckpoints } from './read-checkpoints.js';
import type { SourceInputInspection } from './source-input-inspection.js';
import { uniqueKnowledgeDependencies } from './knowledge-validity.js';
import { asJson } from './plan-validator.js';

/** Authenticates the checkpoint summaries used by completion without issuing a tool call. */
export class ReadCoverageProofs {
  constructor(readonly services: RuntimeServices, readonly contracts: ToolContracts) {}
  async current(input: WorkState): Promise<boolean> {
    const state = structuredClone(input);
    const candidates = new Map(state.goal.criteria.flatMap(criterion => criterion.requireCollection ?
      collectionCoverageCandidates(state.goal, state.policy, state.attempts, criterion.requireCollection).map(attempt => [attempt.id, attempt] as const) : []));
    try {
      const checkpoints = new ReadCheckpoints(this.services, this.contracts);
      for (const attempt of candidates.values()) await checkpoints.read(state, attempt.id, attempt.readProgress!.head);
      return true;
    } catch { return false; }
  }
  async inspect(input: WorkState): Promise<SourceInputInspection> {
    const state = structuredClone(input), checkpoints = new ReadCheckpoints(this.services, this.contracts);
    const candidates = new Map(state.goal.criteria.flatMap(criterion => criterion.requireCollection ?
      collectionCoverageCandidates(state.goal, state.policy, state.attempts, criterion.requireCollection).map(attempt => [attempt.id, attempt] as const) : []));
    const inspections: SourceInputInspection[] = [];
    for (const attempt of candidates.values()) inspections.push(await checkpoints.inspectInputs(state, attempt.id, attempt.readProgress!.head));
    return { version: this.services.digester.digest(asJson(inspections.map(value => value.version))), sourceWorkIds: [state.id],
      knowledgeDependencies: uniqueKnowledgeDependencies(inspections.flatMap(value => value.knowledgeDependencies)),
      bytesRead: inspections.reduce((sum, value) => sum + value.bytesRead, 0), current: async () => {
        for (const inspection of inspections) if (!(await inspection.current())) return false;
        return (await this.services.state.get(state.id))?.revision === state.revision;
      } };
  }
}
