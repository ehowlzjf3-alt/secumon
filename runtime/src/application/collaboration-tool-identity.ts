import type { Tool } from './ports.js';

type Kind = 'archive-search' | 'archive-get' | 'board-read' | 'board-requests' | 'board-command' | 'budget' | 'a2a' | 'mission';
const identities = new WeakMap<Tool, Kind>();

/** Native adapter identity is not inferred from serialized metadata or model-provided output. */
export function markCollaborationTool(tool: Tool, kind: Kind): Tool { identities.set(tool, kind); return tool; }
export function collaborationToolKind(tool: Tool | undefined): Kind | undefined { return tool && identities.get(tool); }
export function copyCollaborationToolIdentity(source: Tool, snapshot: Tool): Tool {
  const kind = identities.get(source); if (kind) identities.set(snapshot, kind); return snapshot;
}
