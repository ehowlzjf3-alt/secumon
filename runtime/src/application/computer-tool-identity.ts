import type { Tool } from './ports.js';

const observationTools = new WeakSet<Tool>();

/** Local adapter identity, never inferred from model output or serialized tool metadata. */
export function markComputerObservationTool(tool: Tool): void { observationTools.add(tool); }
export function isComputerObservationTool(tool: Tool | undefined): boolean { return tool !== undefined && observationTools.has(tool); }

/** Registration binds callbacks into a new object while retaining the original adapter identity. */
export function copyComputerObservationIdentity(source: Tool, snapshot: Tool): Tool {
  if (observationTools.has(source)) observationTools.add(snapshot);
  return snapshot;
}
