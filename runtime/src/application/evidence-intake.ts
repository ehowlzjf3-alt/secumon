import type { Attempt, Evidence, ToolResult, WorkState } from '../domain/model.js';
import { accessibleEvidence, historicalEvidence } from '../domain/completion.js';
import { validSupersession } from '../domain/evidence-access.js';
import type { Digester } from './ports.js';
import { asJson } from './plan-validator.js';

export function validateEvidence(result: ToolResult, attempt: Attempt, state: WorkState, digester: Digester): void {
  if (result.attemptId !== attempt.id) throw new Error('attempt_identity_mismatch');
  if (attempt.effect === 'read' && result.effectState !== 'none') throw new Error('unexpected_effect');
  if (attempt.effect === 'write' && result.status === 'success' && result.effectState !== 'confirmed') throw new Error('unconfirmed_write');
  if (result.status === 'error' || result.status === 'cancelled') {
    if (result.evidence.length || result.artifacts.length) throw new Error('failed_result_contains_evidence');
  }
  validateEvidenceRecords(result.evidence, attempt.scope, state, digester);
  for (const ref of result.artifacts) if (ref.tenantId !== state.policy.tenantId || ref.labels.some(label => !state.policy.allowedLabels.includes(label))) throw new Error('artifact_scope_invalid');
}

export function validateEvidenceRecords(incoming: Evidence[], scope: string, state: WorkState, digester: Digester): void {
  const allowed = (ref: { tenantId: string; labels: string[] }) => ref.tenantId === state.policy.tenantId && ref.labels.every(l => state.policy.allowedLabels.includes(l));
  const records = new Map<string, Evidence>(state.evidence.map(e => [e.id, e]));
  if (records.size !== state.evidence.length) throw new Error('ambiguous_evidence');
  const seen = new Set<string>();
  for (const e of incoming) {
    if (!allowed(e) || e.scope !== scope || e.observedAt > e.recordedAt) throw new Error('evidence_scope_or_time_invalid');
    if (seen.has(e.id)) throw new Error('duplicate_result_evidence');
    seen.add(e.id);
    const old = records.get(e.id);
    if (old && digester.digest(asJson({ ...old, access: old.access ?? 'available' })) !== digester.digest(asJson({ ...e, access: e.access ?? 'available' }))) throw new Error('evidence_id_collision');
    if ((e.access ?? 'available') !== 'available') throw new Error('evidence_access_unavailable');
    records.set(e.id, e);
  }
  for (const e of incoming) {
    for (const id of [...e.derivedFrom, ...e.supersedes]) {
      const ref = records.get(id);
      if (!ref || !allowed(ref) || ref.scope !== scope || (ref.access ?? 'available') !== 'available') throw new Error('unavailable_evidence_reference');
      if (e.supersedes.includes(id) && !validSupersession(e, ref)) throw new Error('invalid_supersession');
      if (ref.labels.some(label => !e.labels.includes(label))) throw new Error('evidence_labels_not_inherited');
    }
    if (e.artifact && !allowed(e.artifact)) throw new Error('artifact_scope_invalid');
    if (e.artifact && e.labels.some(label => !e.artifact!.labels.includes(label))) throw new Error('artifact_labels_insufficient');
  }
  const visiting = new Set<string>(); const visited = new Set<string>(); const inheritedLabels = new Map<string, Set<string>>();
  for (const root of seen) {
    const stack = [{ id: root, finished: false }];
    while (stack.length) {
      const entry = stack.pop()!;
      if (entry.finished) {
        const record = records.get(entry.id)!; const labels = new Set(record.labels);
        for (const id of [...record.derivedFrom, ...record.supersedes]) for (const label of inheritedLabels.get(id) ?? []) labels.add(label);
        inheritedLabels.set(entry.id, labels); visiting.delete(entry.id); visited.add(entry.id); continue;
      }
      if (visited.has(entry.id)) continue;
      if (visiting.has(entry.id)) throw new Error('cyclic_evidence');
      visiting.add(entry.id); stack.push({ id: entry.id, finished: true });
      const record = records.get(entry.id)!;
      for (const id of [...record.derivedFrom, ...record.supersedes]) if (records.has(id)) stack.push({ id, finished: false });
    }
  }
  const all = [...records.values()];
  const current = new Set(accessibleEvidence(all, state.policy, scope).map(e => e.id));
  const historical = new Set(historicalEvidence(all, state.policy, scope).map(e => e.id));
  for (const e of incoming) {
    if ([...inheritedLabels.get(e.id)!].some(label => !e.labels.includes(label))) throw new Error('evidence_labels_not_inherited');
    if (e.derivedFrom.some(id => !current.has(id))) throw new Error('derived_evidence_not_current');
    if (e.supersedes.some(id => !historical.has(id))) throw new Error('unavailable_evidence_reference');
  }
}
