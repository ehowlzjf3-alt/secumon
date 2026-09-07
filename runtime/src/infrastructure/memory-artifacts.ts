import type { ArtifactStore } from '../application/ports.js';
import { ArtifactSchema, parseContract } from '../application/contracts.js';
import type { ArtifactRef, Policy } from '../domain/model.js';
import { sha256 } from './digest.js';

export class MemoryArtifactStore implements ArtifactStore {
  #objects = new Map<string, { ref: ArtifactRef; bytes: Uint8Array }>();
  async put(bytes: Uint8Array, attributes: { tenantId: string; labels: string[]; mediaType: string }): Promise<ArtifactRef> {
    const labels = [...new Set(attributes.labels)].sort();
    const hash = sha256(bytes);
    const id = sha256(JSON.stringify({ hash, tenantId: attributes.tenantId, labels, mediaType: attributes.mediaType }));
    const ref = parseContract(ArtifactSchema, { id, sha256: hash, byteLength: bytes.length, ...attributes, labels });
    this.#objects.set(id, { ref: structuredClone(ref), bytes: bytes.slice() });
    return ref;
  }
  async get(ref: ArtifactRef, policy: Policy) {
    if (ref.tenantId !== policy.tenantId || !ref.labels.every(l => policy.allowedLabels.includes(l))) throw new Error('artifact_access_denied');
    const object = this.#objects.get(ref.id);
    if (!object || JSON.stringify(object.ref) !== JSON.stringify(ref)) throw new Error('artifact_unavailable');
    return object.bytes.slice();
  }
  async exists(ref: ArtifactRef) { const object = this.#objects.get(ref.id); return Boolean(object && JSON.stringify(object.ref) === JSON.stringify(ref)); }
}
