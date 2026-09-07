import { z } from 'zod';
import { dataGeneration } from '../domain/data-lifecycle.js';
import type { KnowledgeDependency, TrustedKnowledgeActor } from '../domain/knowledge.js';
import type { Json, Policy, ToolResult } from '../domain/model.js';
import { PolicySchema } from './contracts.js';
import { parseKnowledgeActor } from './knowledge-contracts.js';
import type { KnowledgeRepository, KnowledgeUserSources, TrustedKnowledgeActorProvider } from './knowledge-ports.js';
import { KnowledgeService } from './knowledge-service.js';
import type { Clock, Digester, StateRepository, Tool } from './ports.js';
import { asJson } from './plan-validator.js';
import type { EffectProofValidator, WorkInputValidator } from './services.js';

export const KNOWLEDGE_TOOL_IDS = ['core.memory.get', 'core.memory.search'] as const;
export interface KnowledgeToolsDependencies {
  states: StateRepository;
  repository: KnowledgeRepository;
  actors: TrustedKnowledgeActorProvider;
  digester: Digester;
  clock: Clock;
  effects?: Pick<EffectProofValidator, 'current'> | undefined;
  inputs?: WorkInputValidator | undefined;
  userSources?: KnowledgeUserSources | undefined;
}
const name = z.string().trim().min(1).max(160);
const size = z.number().int().min(256).max(65536);
const GetSchema = z.strictObject({ id: name, maxBytes: size, memory: z.literal('personal').optional() });
const SearchSchema = z.strictObject({ namespace: name, query: z.string().max(128), limit: z.number().int().min(1).max(50), maxBytes: size,
  memory: z.literal('personal').optional() });
const unavailable = () => new Error('knowledge_unavailable');
const names = (values: string[]) => [...new Set(values)].sort();
const bytes = (value: Json) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
type Context = Parameters<Tool['execute']>[1];
type Reply = { output: Json; dependencies: KnowledgeDependency[]; partial: boolean };

export function createKnowledgeTools(deps: KnowledgeToolsDependencies): {
  tools: Tool[];
  validate(dependencies: KnowledgeDependency[], workId: string, policy: Policy): Promise<boolean>;
} {
  const digest = (value: unknown) => deps.digester.digest(asJson(value));
  function scoped(workId: string, policy: Policy, signal?: AbortSignal, toolId?: string, personal = false) {
    const original = PolicySchema.parse(policy);
    let boundary: string | null = null;
    const actors: TrustedKnowledgeActorProvider = {
      async current(): Promise<TrustedKnowledgeActor> {
        for (let retry = 0; retry < 8; retry++) {
          if (signal?.aborted) throw unavailable();
          const caller = PolicySchema.parse(policy);
          if (caller.tenantId !== original.tenantId || caller.principalId !== original.principalId) throw unavailable();
          const state = await deps.states.get(workId);
          if (!state || state.policy.tenantId !== caller.tenantId || state.policy.principalId !== caller.principalId) throw unavailable();
          const trusted = parseKnowledgeActor(await deps.actors.current());
          if (trusted.tenantId !== caller.tenantId || trusted.principalId !== caller.principalId) throw unavailable();
          if (personal && (!trusted.agentId || state.conversation?.session?.scope.agentId !== trusted.agentId)) throw unavailable();
          const latest = await deps.states.get(workId);
          if (!latest || latest.policy.tenantId !== caller.tenantId || latest.policy.principalId !== caller.principalId) throw unavailable();
          if (signal?.aborted || digest(caller) !== digest(PolicySchema.parse(policy))) throw unavailable();
          if (latest.revision !== state.revision) continue;
          if (toolId && (!state.policy.allowedTools.includes(toolId) || !caller.allowedTools.includes(toolId) ||
            !state.policy.allowedDestinations.includes('local') || !caller.allowedDestinations.includes('local'))) throw unavailable();
          const actor: TrustedKnowledgeActor = { ...trusted,
            allowedLabels: names(trusted.allowedLabels.filter(label => state.policy.allowedLabels.includes(label) && caller.allowedLabels.includes(label))),
            allowedNamespaces: names(trusted.allowedNamespaces), allowedScopes: personal ? names(trusted.allowedScopes) : trusted.allowedScopes.includes(state.goal.scope) ? [state.goal.scope] : [],
            ...(personal ? { allowedDestinations: names((trusted.allowedDestinations ?? caller.allowedDestinations).filter(destination =>
              caller.allowedDestinations.includes(destination) && state.policy.allowedDestinations.includes(destination))) } : {}) };
          const stamp = digest({ actor, caller, policy: state.policy, goalRevision: state.goal.revision, scope: state.goal.scope, generation: dataGeneration(state) });
          if (boundary !== null && boundary !== stamp) throw unavailable();
          boundary = stamp;
          return actor;
        }
        throw unavailable();
      },
    };
    return { service: new KnowledgeService({ ...deps, actors, signal }), current: () => actors.current() };
  }
  function bounded(output: Json, maximum: number, reference: Json): { output: Json; tooLarge: boolean } {
    const byteLength = bytes(output);
    if (byteLength <= maximum) return { output, tooLarge: false };
    let limited: Json = { status: 'too_large', byteLength, reference };
    if (bytes(limited) > maximum) limited = { status: 'too_large', byteLength, reference: { kind: 'knowledge_request', digest: digest(reference) } };
    return { output: limited, tooLarge: true };
  }
  function readTool(toolId: typeof KNOWLEDGE_TOOL_IDS[number], description: string, inputSchema: Json,
    read: (input: Record<string, Json>, context: Context) => Promise<Reply>): Tool {
    return {
      definition: { provider: 'core', id: toolId, version: '1', description, effect: 'read', destination: 'local', labels: [], inputSchema, outputSchema: { type: 'object' } },
      async execute(task, context): Promise<ToolResult> {
        const base = { resultId: `${context.attemptId}:result`, attemptId: context.attemptId, effectState: 'none' as const, evidence: [], artifacts: [], cursor: null };
        const cancelled = (): ToolResult => ({ ...base, status: 'cancelled', coverage: 'unknown', output: null, error: { code: 'cancelled', retryable: false } });
        if (context.signal.aborted) return cancelled();
        try {
          if (task.toolId !== toolId || task.toolVersion !== '1' || task.effect !== 'read') throw unavailable();
          const reply = await read(task.input, context);
          if (context.signal.aborted) return cancelled();
          return { ...base, status: reply.partial ? 'partial' : 'success', coverage: reply.partial ? 'partial' : 'complete',
            output: reply.output, error: null, knowledgeDependencies: reply.dependencies };
        } catch {
          return context.signal.aborted ? cancelled() : { ...base, status: 'error', coverage: 'unknown', output: null, error: { code: 'knowledge_unavailable', retryable: false } };
        }
      },
    };
  }
  const tools: Tool[] = [
    readTool('core.memory.get', 'Read one permitted memory card. Set memory to personal for this agent and user; omit it for work knowledge. Memory is not fresh evidence. Repeat a too_large request with a larger maxBytes.',
      asJson(z.toJSONSchema(GetSchema, { target: 'draft-7' })), async (input, context) => {
        const args = GetSchema.parse(input); const scopedService = scoped(context.workId, context.policy, context.signal, 'core.memory.get', args.memory === 'personal');
        const service = args.memory === 'personal' ? await scopedService.service.forPersonal() : scopedService.service;
        const read = await service.get(args.id); const dependencies = [read.dependency];
        if (!(await service.validateDependencies(dependencies))) throw unavailable();
        const result = bounded(asJson({ status: 'available', card: read.card }), args.maxBytes, { kind: 'memory', id: args.id });
        return { output: result.output, dependencies, partial: result.tooLarge };
      }),
    readTool('core.memory.search', 'Search permitted work knowledge in the current goal scope, or set memory and namespace to personal for this agent and user. Partial coverage includes index lag, errors and truncation. Repeat a too_large request with a larger maxBytes.',
      asJson(z.toJSONSchema(SearchSchema, { target: 'draft-7' })), async (input, context) => {
        const args = SearchSchema.parse(input); const scopedService = scoped(context.workId, context.policy, context.signal, 'core.memory.search', args.memory === 'personal');
        const actor = await scopedService.current();
        if (args.memory !== 'personal' && actor.allowedScopes.length !== 1) throw unavailable();
        const service = args.memory === 'personal' ? await scopedService.service.forPersonal() : scopedService.service;
        const read = await service.search({ namespace: args.namespace, scope: args.memory === 'personal' ? 'personal' : actor.allowedScopes[0]!, text: args.query, limit: args.limit });
        if (!(await service.validateDependencies(read.dependencies))) throw unavailable();
        const result = bounded(asJson({ status: 'available', cards: read.cards, index: { status: read.index.status, complete: read.index.complete, cached: read.index.cached } }),
          args.maxBytes, { kind: 'memory_search', namespace: args.namespace, query: args.query, limit: args.limit });
        return { output: result.output, dependencies: read.dependencies, partial: result.tooLarge || !read.index.complete };
      }),
  ];
  return { tools, async validate(dependencies, workId, policy) {
    try {
      const selected = structuredClone(dependencies), personal = selected.filter(dependency => dependency.owner !== undefined), work = selected.filter(dependency => dependency.owner === undefined);
      if (!selected.length) return await scoped(workId, policy).service.validateDependencies([]);
      if (work.length && !(await scoped(workId, policy).service.validateDependencies(work))) return false;
      if (personal.length && !(await (await scoped(workId, policy, undefined, undefined, true).service.forPersonal()).validateDependencies(personal))) return false;
      return true;
    }
    catch { return false; }
  } };
}
