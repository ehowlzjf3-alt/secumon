import assert from 'node:assert/strict';
import type { MissionRule } from '../application/mission-contracts.js';
import type { AgentExecutionHost } from '../presentation/host-tools.js';
import { hostEntryFixture } from './host-tool-entry-fixture.js';

export const RESIDENT_CONTROL_ENTRY_RULE: MissionRule = { id: 'resident-entry-rule', sourceId: 'resident-entry-events', resourceId: 'original-resource',
  pollIntervalMs: 1000, maxResumes: 2, maxIdlePolls: 2, maxNoProgress: 2 };

/** Registered local callbacks make unexpected model/tool/observation execution visible in every CLI process. */
export function residentControlEntryHost(identityRegistryDirectory: string, withMissions = true) {
  const entry = hostEntryFixture({ text: 'Unused local fixture original.', identityRegistryDirectory });
  const observation = { opens: 0, polls: 0, closes: 0 };
  const host: AgentExecutionHost = { ...entry.host, ...(withMissions ? { missions: { async open() {
    observation.opens++;
    return { sources: [{ id: RESIDENT_CONTROL_ENTRY_RULE.sourceId, destination: 'local', labels: ['public'], async poll() {
      observation.polls++; throw new Error('resident_control_unexpected_poll');
    } }], async close() { observation.closes++; } };
  } } } : {}) };
  return { host, observation, observed: entry.observed, assertIdleAndClosed() {
    assert.equal(entry.observed.modelInputs.length, 0, 'control commands must not call a model');
    assert.equal(entry.observed.reads, 0, 'control commands must not execute a tool');
    assert.equal(observation.polls, 0, 'control commands must not poll observations');
    assert.equal(observation.closes, observation.opens, 'the profile owner closes every opened source');
    assert.equal(entry.observed.toolCloses, entry.observed.toolContexts.length);
  } };
}
