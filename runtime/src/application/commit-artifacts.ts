import type { ArtifactStore, CommitRequest, StateRepository } from './ports.js';
import { artifactBlocked } from '../domain/data-lifecycle.js';

export async function commitWithArtifacts(store: StateRepository, artifacts: ArtifactStore, request: CommitRequest, beforeCommit?: () => Promise<void>) {
  const publishedContext = request.events.some(event => event.type === 'model_call_reserved' || event.type === 'context_compacted') ? request.next.contextHead?.artifact : undefined;
  if (publishedContext && artifactBlocked(request.next, publishedContext)) throw new Error('artifact_unavailable');
  const refs = [...request.next.artifacts, ...request.next.evidence.flatMap(e => e.artifact ? [e.artifact] : []), ...request.next.attempts.flatMap(a => [...(a.resultArtifact ? [a.resultArtifact] : []), ...(a.readProgress ? [a.readProgress.head] : [])]),
    ...request.deliveries.flatMap(d => d.context?.artifact ? [d.context.artifact] : []), ...(request.next.conversation?.result ? [request.next.conversation.result.artifact] : []),
    ...request.next.modelCalls.flatMap(c => [c.inputArtifact, ...(c.replyArtifact ? [c.replyArtifact] : [])]), ...(request.next.workspaceCheckpoints?.map(c => c.artifact) ?? []),
    ...(publishedContext ? [publishedContext] : [])];
  const checked = new Map<string, string>();
  for (const ref of refs) {
    const signature = JSON.stringify(ref);
    if (checked.has(ref.id) && checked.get(ref.id) !== signature) throw new Error('artifact_reference_conflict');
    if (!checked.has(ref.id) && !artifactBlocked(request.next, ref) && !(await artifacts.exists(ref))) throw new Error('artifact_unavailable');
    checked.set(ref.id, signature);
  }
  await beforeCommit?.();
  return store.commit(request);
}
