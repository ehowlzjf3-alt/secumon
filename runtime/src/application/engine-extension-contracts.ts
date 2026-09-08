import { z } from 'zod';
import { frozen } from './resource-contracts.js';

const capability = z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/);
const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;
/** Engine calling convention, separate from provider revisions and remote wire protocols. */
export const EngineApiDeclarationSchema = z.strictObject({
  version: z.number().int().positive(), requires: z.array(capability).max(64).refine(unique),
});
export const EngineExtensionSupportSchema = z.strictObject({
  versions: z.array(z.number().int().positive()).min(1).max(16).refine(unique),
  capabilities: z.array(capability).max(128).refine(unique),
});
export type EngineApiDeclaration = z.infer<typeof EngineApiDeclarationSchema>;
export interface EngineApiRegistration { readonly engineApi?: EngineApiDeclaration }
export const ENGINE_EXTENSION_SUPPORT = frozen(EngineExtensionSupportSchema.parse({ versions: [1], capabilities: [
  'model.turn', 'model.compact', 'tools', 'tools.collections', 'tools.computer', 'knox', 'board', 'archive', 'peers', 'a2a', 'missions', 'budget', 'postgres',
] }));
const SelectionSchema = z.strictObject({ kind: z.enum(['model', 'tools', 'knox', 'board', 'archive', 'peers', 'a2a', 'missions', 'budget', 'postgres']),
  name: z.string().trim().min(1).max(256), engineApi: EngineApiDeclarationSchema.optional() });
export type EngineExtensionSelection = z.infer<typeof SelectionSchema>;
export interface EngineExtensionCheckOptions {
  /** Only trusted host code supplies this inventory; omission means not inspected. */
  readonly extensions?: readonly EngineExtensionSelection[];
  readonly requireDeclaredExtensions?: boolean;
}
export class EngineExtensionError extends Error {
  constructor(readonly code: string) { super(code); }
}
const fail = (code: string): never => { throw new EngineExtensionError(code); };
function declaration(value: unknown): EngineApiDeclaration | undefined {
  if (value === undefined) return undefined;
  const parsed = EngineApiDeclarationSchema.safeParse(value);
  if (!parsed.success) return fail('engine_extension_declaration_invalid');
  parsed.data.requires.sort(); return frozen(parsed.data);
}
export function inspectEngineExtensions(support: z.infer<typeof EngineExtensionSupportSchema> | undefined,
  options: EngineExtensionCheckOptions = {}) {
  if (options.requireDeclaredExtensions !== undefined && typeof options.requireDeclaredExtensions !== 'boolean') fail('engine_extension_policy_invalid');
  const strict = options.requireDeclaredExtensions === true;
  if (strict && options.extensions === undefined) fail('engine_extension_inventory_required');
  const inventory = options.extensions === undefined ? undefined : z.array(SelectionSchema).max(64).safeParse(options.extensions);
  if (inventory && !inventory.success) fail('engine_extension_inventory_invalid');
  const selected = inventory?.success ? inventory.data : undefined;
  if (selected && !unique(selected.map(value => `${value.kind}:${value.name}`))) fail('engine_extension_inventory_invalid');
  const supported = support === undefined ? undefined : EngineExtensionSupportSchema.safeParse(support);
  if (supported && !supported.success) fail('engine_extension_support_invalid');
  const parsed = supported?.success ? supported.data : undefined;
  const registrations = (selected ?? []).map(value => {
    const api = declaration(value.engineApi);
    if (!api) {
      if (strict) fail('engine_extension_declaration_required');
      return { kind: value.kind, name: value.name, status: 'undeclared' as const };
    }
    if (!parsed) fail('engine_extension_support_undeclared');
    if (!parsed!.versions.includes(api.version)) fail('engine_extension_api_incompatible');
    if (api.requires.some(value => !parsed!.capabilities.includes(value))) fail('engine_extension_capability_unsupported');
    return { kind: value.kind, name: value.name, status: 'verified' as const, engineApi: api };
  });
  if (strict && !parsed) fail('engine_extension_support_undeclared');
  return frozen({ status: selected !== undefined && parsed !== undefined && registrations.every(value => value.status === 'verified') ? 'verified' as const : 'unverified' as const,
    inventory: selected === undefined ? 'not_provided' as const : 'provided' as const, engineSupportDeclared: parsed !== undefined, registrations });
}
/** Captures only metadata; factories keep their original this binding and ownership. */
export function captureEngineApi(registration: EngineApiRegistration) {
  const api = declaration(registration.engineApi);
  inspectEngineExtensions(ENGINE_EXTENSION_SUPPORT, { extensions: [{ kind: 'tools', name: 'registration', ...(api ? { engineApi: api } : {}) }] });
  return { ...(api ? { engineApi: api } : {}), assertCurrent() {
    if (JSON.stringify(declaration(registration.engineApi)) !== JSON.stringify(api)) fail('engine_extension_declaration_changed');
  } };
}
