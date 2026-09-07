import type { Evidence, Policy } from './model.js';

export function validSupersession(replacement: Evidence, previous: Evidence): boolean {
  return replacement.id !== previous.id && replacement.tenantId === previous.tenantId && replacement.scope === previous.scope &&
    replacement.sourceId === previous.sourceId && replacement.lineageId === previous.lineageId && previous.observedAt <= replacement.observedAt &&
    previous.observedAt <= previous.recordedAt && replacement.observedAt <= replacement.recordedAt;
}

export function evidenceView(evidence: Evidence[], policy: Policy, scope: string, view: 'current' | 'historical'): Evidence[] {
  const records = new Map<string, Evidence>(); const ambiguous = new Set<string>();
  for (const record of evidence) { if (records.has(record.id)) ambiguous.add(record.id); else records.set(record.id, record); }
  const superseded = new Set<string>();
  if (view === 'current') for (const replacement of records.values()) {
    if (ambiguous.has(replacement.id)) continue;
    for (const id of replacement.supersedes) {
      const previous = records.get(id);
      if (previous && !ambiguous.has(id) && validSupersession(replacement, previous)) superseded.add(id);
    }
  }
  const authorized = (record: { tenantId: string; labels: string[] }) => record.tenantId === policy.tenantId && record.labels.every(label => policy.allowedLabels.includes(label));
  const candidates = new Map<string, Evidence>();
  for (const record of records.values()) {
    if (ambiguous.has(record.id) || !authorized(record) || record.scope !== scope || (record.access ?? 'available') !== 'available' ||
        (record.artifact && !authorized(record.artifact)) || (view === 'current' && (record.status !== 'accepted' || superseded.has(record.id)))) continue;
    candidates.set(record.id, record);
  }
  const remaining = new Map<string, number>(); const dependents = new Map<string, string[]>(); const queue: string[] = [];
  for (const record of candidates.values()) {
    const parents = [...new Set(record.derivedFrom)]; remaining.set(record.id, parents.length);
    if (!parents.length) queue.push(record.id);
    for (const parent of parents) {
      const children = dependents.get(parent) ?? []; children.push(record.id); dependents.set(parent, children);
    }
  }
  const visible = new Set<string>();
  for (let position = 0; position < queue.length; position++) {
    const id = queue[position]!; visible.add(id);
    for (const child of dependents.get(id) ?? []) {
      const count = remaining.get(child)! - 1; remaining.set(child, count); if (count === 0) queue.push(child);
    }
  }
  return evidence.filter(record => visible.has(record.id));
}
