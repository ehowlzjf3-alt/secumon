import { openAgentLocalProfile } from '../../presentation/local-profile.js';
import { applyMemoryDraft } from '../../presentation/local-memory-drafts.js';
import { actor } from '../session-flow-helpers.js';
import { MemoryDraftApplySchema } from '../../application/personal-memory-draft-contracts.js';

const [directory, serialized, stage, identityRegistryDirectory] = process.argv.slice(2);
if (!directory || !serialized || !identityRegistryDirectory || !['intent', 'source', 'memory', 'run'].includes(stage!)) throw new Error('worker_arguments_required');
const profile = await openAgentLocalProfile(directory, {}, undefined, { identityRegistryDirectory }), input = MemoryDraftApplySchema.parse(JSON.parse(serialized));
async function stop() { process.send?.({ reached: stage }); await new Promise<void>(() => { setInterval(() => {}, 1000); }); }
if (stage === 'intent') {
  const bind = profile.memoryDrafts!.store.bind.bind(profile.memoryDrafts!.store);
  profile.memoryDrafts!.store.bind = async (...args) => { const result = await bind(...args); await stop(); return result; };
} else if (stage === 'source') {
  const original = profile.sessions!.inputOnly.bind(profile.sessions!);
  profile.sessions!.inputOnly = async (...args) => { const result = await original(...args); await stop(); return result; };
} else if (stage === 'memory') {
  const original = profile.personalKnowledge;
  profile.personalKnowledge = async (...args) => {
    const service = await original(...args), revise = service.revisePersonal.bind(service);
    service.revisePersonal = async (...values) => { const result = await revise(...values); await stop(); return result; };
    return service;
  };
}
try { const result = await applyMemoryDraft(profile, actor, input); process.send?.({ result }); }
finally { await profile.close(); process.disconnect?.(); }
