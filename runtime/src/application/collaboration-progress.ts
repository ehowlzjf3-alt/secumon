import { z } from 'zod';
import type { TaskSpec, ToolResult, WorkState } from '../domain/model.js';
import type { Tool } from './ports.js';
import { ArchiveDocumentSchema } from './archive-contracts.js';
import { BoardReadPageSchema, BoardRequestPageSchema } from './board-contracts.js';
import { collaborationToolKind } from './collaboration-tool-identity.js';
import { toolAllowed } from './tool-contracts.js';
import { budgetProgressKeys } from './budget-progress.js';
import { a2aProgressKeys } from './a2a-progress.js';
import { missionProgressKeys } from './mission-progress.js';

const archiveCard = ArchiveDocumentSchema.omit({ body: true });
const search = z.strictObject({ kind: z.literal('archive_reference'), provider: z.string(), documents: z.array(archiveCard).max(50), truncated: z.boolean() });
const get = z.strictObject({ kind: z.literal('archive_reference'), provider: z.string(), document: ArchiveDocumentSchema.nullable() });

/** Called only for adopted results after the runtime validates the current tool and any required proof. */
export function collaborationProgressKeys(state: WorkState, task: TaskSpec, result: ToolResult, tool: Tool | undefined,
  key: (kind: string, value: unknown) => string): string[] {
  const kind = collaborationToolKind(tool);
  if (!kind || !tool || tool.definition.id !== task.toolId || tool.definition.version !== task.toolVersion ||
    tool.definition.effect !== task.effect || !toolAllowed(tool.definition, state.policy) || result.evidence.length ||
    !['complete', 'partial'].includes(result.coverage)) return [];
  if (kind === 'a2a') return a2aProgressKeys(task, result, tool, key);
  if (kind === 'board-command') {
    if (task.effect !== 'write' || result.status !== 'success' || result.effectState !== 'confirmed' ||
      result.effectReceipt?.provider !== 'board' || result.effectReceipt.outcome !== 'applied' || result.effectReceipt.origin !== 'execution') return [];
    // New task/post IDs and revision refreshes cannot credit the same publication again.
    const { expectedRevision: _revision, id: _id, causeId: _cause, expiresAt: _expiry, dueAt: _due, ...content } = task.input;
    const stable = { ...content };
    for (const field of ['labels', 'evidenceIds', 'quotedPostIds']) if (Array.isArray(stable[field])) stable[field] = [...stable[field]].sort();
    return [key('board-command', { toolId: task.toolId, content: stable })];
  }
  if (task.effect !== 'read' || result.effectState !== 'none') return [];
  if (kind === 'mission') return tool.definition.provider === 'mission' && tool.definition.destination === 'local' ? missionProgressKeys(task, result, key) : [];
  if (kind === 'budget') return budgetProgressKeys(state, task, result, key);
  if (kind === 'archive-search' || kind === 'archive-get') {
    if (result.artifacts.length) return [];
    const cardKey = (document: z.infer<typeof archiveCard>) => {
      const { revision: _revision, ...content } = archiveCard.parse(document);
      return key('archive-card', { provider: tool.definition.provider, version: tool.definition.version, content });
    };
    if (kind === 'archive-search') {
      const page = search.safeParse(result.output);
      if (!page.success || page.data.provider !== tool.definition.provider) return [];
      return [...new Set(page.data.documents.filter(document => document.status === 'active').map(cardKey))];
    }
    const page = get.safeParse(result.output);
    if (!page.success || page.data.provider !== tool.definition.provider || !page.data.document ||
      page.data.document.id !== task.input['id'] || page.data.document.status !== 'active') return [];
    const { body, ...cardWithRevision } = page.data.document;
    const { revision: _revision, ...card } = cardWithRevision;
    return [cardKey(cardWithRevision), key('archive-body', { provider: tool.definition.provider, version: tool.definition.version, content: card, body })];
  }
  if (kind === 'board-read') {
    const page = BoardReadPageSchema.safeParse(result.output);
    if (!page.success || page.data.id !== task.input['boardId']) return [];
    const basis = { boardId: page.data.id, roleId: page.data.roleId };
    // The first permitted view supplies the address/role required for a new discussion.
    // Publication IDs and cause IDs are addresses, not new content. Reply/quote references still identify the discussion being answered.
    return [key('board-access', basis), ...page.data.posts.map(({ id: _id, causeId: _cause, createdAt: _created, retractedAt: _retracted, generation: _generation, citations, ...post }) =>
      key('board-post', { ...basis, post, citations: citations.map(({ observedAt: _observed, recordedAt: _recorded, ...citation }) => citation) }))];
  }
  const page = BoardRequestPageSchema.safeParse(result.output);
  if (!page.success || page.data.boardId !== task.input['boardId']) return [];
  return [key('board-request-access', { boardId: page.data.boardId, roleId: page.data.roleId }),
    ...page.data.requests.map(({ updatedAt: _updatedAt, ...request }) => key('request-metadata', { boardId: page.data.boardId, roleId: page.data.roleId, request }))];
}
