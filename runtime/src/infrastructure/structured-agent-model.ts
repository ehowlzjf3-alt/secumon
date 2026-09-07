import type { AgentTurnProvider, AgentTurnPrompt } from '../application/agent-turn-types.js';
import { asJson } from '../application/plan-validator.js';
import type { ModelCapabilities, ModelIdentity, ModelInputEstimationProfile, Planner } from '../application/ports.js';
import { frozen } from '../application/resource-contracts.js';
import { Sha256Digester } from './digest.js';
import type { StructuredAgentTurnAdapter } from './structured-agent-turn.js';
import type { StructuredSessionCompactAdapter } from './structured-session-compact.js';

const compositionVersion = 'structured-agent-model-v1';
const digester = new Sha256Digester();

/** One registered model, with separate request adapters and the runtime's existing call ledger. */
export class StructuredAgentModel implements Planner, AgentTurnProvider {
  readonly identity: ModelIdentity;
  readonly destination: string;
  readonly capabilities: ModelCapabilities;
  readonly prompt: AgentTurnPrompt;
  readonly inputEstimation: ModelInputEstimationProfile;
  readonly turn: StructuredAgentTurnAdapter['turn'];
  readonly estimateTurnInput: StructuredAgentTurnAdapter['estimateTurnInput'];
  readonly estimateContextPreview: StructuredAgentTurnAdapter['estimateContextPreview'];
  readonly propose: StructuredAgentTurnAdapter['propose'];
  readonly compact: StructuredSessionCompactAdapter['compact'];
  readonly estimateCompactInput: StructuredSessionCompactAdapter['estimateCompactInput'];

  constructor(turn: StructuredAgentTurnAdapter, compact: StructuredSessionCompactAdapter) {
    if (digester.digest(asJson(turn.identity)) !== digester.digest(asJson(compact.identity)) ||
        turn.destination !== compact.destination ||
        digester.digest(asJson(turn.capabilities)) !== digester.digest(asJson(compact.capabilities)))
      throw new Error('structured_agent_model_mismatch');
    this.identity = frozen(structuredClone(turn.identity));
    this.destination = turn.destination;
    this.capabilities = frozen(structuredClone(turn.capabilities));
    this.prompt = frozen(structuredClone(turn.prompt));
    const profiles = [turn.inputEstimation, compact.inputEstimation];
    const kind = profiles.some(profile => profile.kind === 'legacy_adapter_revision') ? 'legacy_adapter_revision' :
      profiles.some(profile => profile.kind === 'conservative_estimate') ? 'conservative_estimate' : 'tokenizer';
    this.inputEstimation = frozen({ id: compositionVersion, revision: '1', kind,
      templateRevision: `${compositionVersion}:${digester.digest(asJson({ version: 1,
        turn: { estimation: turn.inputEstimation, prompt: { version: turn.prompt.version, digest: turn.prompt.digest } },
        compact: { estimation: compact.inputEstimation },
      }))}` });
    // Capture receivers and implementations together; a detached host method still uses the original adapter.
    this.turn = turn.turn.bind(turn);
    this.estimateTurnInput = turn.estimateTurnInput.bind(turn);
    this.estimateContextPreview = turn.estimateContextPreview.bind(turn);
    this.propose = turn.propose.bind(turn);
    this.compact = compact.compact.bind(compact);
    this.estimateCompactInput = compact.estimateCompactInput.bind(compact);
    Object.freeze(this);
  }
}
