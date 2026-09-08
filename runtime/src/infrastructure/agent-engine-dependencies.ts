import { createHash } from 'node:crypto';
import { join, posix } from 'node:path';
import { AgentLifecycleError, LifecycleEntrySchema, type LifecycleEntry } from '../application/agent-lifecycle-contracts.js';
import { lifecycleLimits, lifecycleRoot } from './agent-lifecycle-files.js';
import { FileBoundaryFault, hostMetadataFiles, releaseMetadataDirectory, type MetadataDirectory } from './host-metadata-files.js';

const manifestLimit = Math.min(lifecycleLimits.fileBytes, 4 * 1024 * 1024);
const key = (path: string) => process.platform === 'win32' ? path.toUpperCase() : path;
const packageName = (name: string) => /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(name) &&
  name.split('/').every(part => !['.', '..'].includes(part.replace(/^@/, '')));
const fail = (code: string): never => { throw new AgentLifecycleError(code); };
type Requirement = { name: string; target: string; optional: boolean };
type Manifest = { name: string; requirements: Requirement[] };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('engine_dependency_manifest_invalid');
  return value as Record<string, unknown>;
}
function declarations(value: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (value === undefined) return result;
  for (const [name, specifier] of Object.entries(object(value))) {
    if (!packageName(name) || typeof specifier !== 'string' || !specifier.trim()) return fail('engine_dependency_manifest_invalid');
    result.set(name, specifier);
  }
  return result;
}
function targetName(name: string, specifier: string) {
  if (!specifier.startsWith('npm:')) return name;
  const alias = specifier.slice(4), separator = alias.indexOf('@', 1);
  const target = separator < 0 ? alias : alias.slice(0, separator);
  if (!packageName(target)) return fail('engine_dependency_manifest_invalid');
  return target;
}
function manifest(bytes: Buffer): Manifest {
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString('utf8')); }
  catch (cause) { throw new AgentLifecycleError('engine_dependency_manifest_invalid', { cause }); }
  const value = object(raw);
  if (typeof value['name'] !== 'string' || !packageName(value['name'])) return fail('engine_dependency_manifest_invalid');
  const dependencies = declarations(value['dependencies']), optional = declarations(value['optionalDependencies']);
  const peers = declarations(value['peerDependencies']);
  const meta = value['peerDependenciesMeta'] === undefined ? {} : object(value['peerDependenciesMeta']);
  const requirements: Requirement[] = [];
  // npm optionalDependencies override declarations under dependencies with the same name.
  for (const [name, specifier] of optional) dependencies.set(name, specifier);
  for (const [name, specifier] of dependencies)
    requirements.push({ name, target: targetName(name, specifier), optional: optional.has(name) });
  for (const [name, specifier] of peers) {
    const detail = Object.hasOwn(meta, name) ? object(meta[name]) : {};
    if (detail['optional'] !== undefined && typeof detail['optional'] !== 'boolean') return fail('engine_dependency_manifest_invalid');
    requirements.push({ name, target: targetName(name, specifier), optional: detail['optional'] === true });
  }
  return { name: value['name'], requirements };
}

/**
 * Checks production package presence inside an already captured engine tree without loading package code.
 * npm remains responsible for version/range resolution. This does not validate exports, entry points,
 * platform suitability, install scripts, or dynamically undeclared imports. The bundler retains its
 * final source-tree fence after copying; this function neither installs nor adopts outside packages.
 */
export function assertAgentEngineDependencies(input: string, entries: readonly LifecycleEntry[]): void {
  const files = hostMetadataFiles(), directories = new Map<string, { path: string; reference: MetadataDirectory }>();
  let failure: Error | undefined;
  try {
    const root = lifecycleRoot(input), indexed = new Map<string, LifecycleEntry>();
    if (entries.length > lifecycleLimits.entries) return fail('engine_dependency_limit');
    for (const entry of entries) {
      if (!LifecycleEntrySchema.safeParse(entry).success || indexed.has(key(entry.path))) return fail('engine_dependency_unsafe');
      indexed.set(key(entry.path), entry);
    }
    const rootReference = files.inspectDirectory(root, 'owner-writable');
    if (!rootReference) return fail('engine_dependency_missing');
    directories.set('', { path: root, reference: rootReference });
    function check(path: string, reference: MetadataDirectory) {
      const current = files.inspectDirectory(path, 'owner-writable', reference);
      if (!current) return fail('engine_dependency_changed');
      if (current !== reference) releaseMetadataDirectory(files, current);
    }
    function directory(relative: string): MetadataDirectory | null {
      check(root, rootReference!);
      if (!relative) return rootReference;
      let parent = '';
      for (const part of relative.split('/')) {
        parent = parent ? `${parent}/${part}` : part;
        const held = directories.get(key(parent));
        if (held) { check(held.path, held.reference); continue; }
        const entry = indexed.get(key(parent)), path = join(root, ...parent.split('/'));
        if (entry && entry.kind !== 'directory') return fail('engine_dependency_unsafe');
        const reference = files.inspectDirectory(path, 'owner-writable');
        if (!reference) {
          if (entry) return fail('engine_dependency_changed');
          return null;
        }
        directories.set(key(parent), { path, reference });
        if (!entry) return fail('engine_dependency_changed');
      }
      return directories.get(key(relative))!.reference;
    }
    let bytesRead = 0, requirementsRead = 0;
    const manifests = new Map<string, Manifest>();
    function read(relative: string): Manifest {
      const cached = manifests.get(key(relative)); if (cached) return cached;
      if (manifests.size >= lifecycleLimits.entries) return fail('engine_dependency_limit');
      const path = relative ? `${relative}/package.json` : 'package.json', entry = indexed.get(key(path));
      if (!entry) return fail('engine_dependency_missing');
      if (entry.kind !== 'file') return fail('engine_dependency_unsafe');
      if (entry.bytes > manifestLimit || bytesRead + entry.bytes > lifecycleLimits.bytes) return fail('engine_dependency_limit');
      const parent = directory(relative); if (!parent) return fail('engine_dependency_changed');
      const bytes = files.readStableRegularFile(parent, 'package.json', { maximum: manifestLimit, access: 'owner-writable' });
      if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
        return fail('engine_dependency_changed');
      bytesRead += bytes.length;
      const value = manifest(bytes); requirementsRead += value.requirements.length;
      if (requirementsRead > lifecycleLimits.entries) return fail('engine_dependency_limit');
      manifests.set(key(relative), value); return value;
    }
    function resolve(from: string, name: string): string | null {
      // Visit every ancestor (including @scope), but do not append node_modules to a node_modules ancestor.
      for (let current = from;; current = posix.dirname(current) === '.' ? '' : posix.dirname(current)) {
        if (posix.basename(current) !== 'node_modules') {
          const candidate = `${current ? `${current}/` : ''}node_modules/${name}`;
          if (directory(candidate)) return candidate;
        }
        if (!current) return null;
      }
    }
    const pending = [''], visited = new Set<string>();
    for (let index = 0; index < pending.length; index++) {
      const path = pending[index]!; if (visited.has(key(path))) continue;
      visited.add(key(path));
      for (const requirement of read(path).requirements) {
        const selected = resolve(path, requirement.name);
        if (selected === null) {
          if (requirement.optional) continue;
          return fail('engine_dependency_missing');
        }
        if (read(selected).name !== requirement.target) return fail('engine_dependency_name_mismatch');
        if (!visited.has(key(selected))) pending.push(selected);
      }
    }
    for (const held of directories.values()) check(held.path, held.reference);
  } catch (error) {
    const code = error instanceof FileBoundaryFault && error.code === 'too_large' ? 'engine_dependency_limit'
      : error instanceof FileBoundaryFault && (error.code === 'changed' || error.code === 'missing') ? 'engine_dependency_changed' : 'engine_dependency_unsafe';
    failure = error instanceof AgentLifecycleError && error.code.startsWith('engine_dependency_') ? error : new AgentLifecycleError(code, { cause: error });
    throw failure;
  } finally {
    const errors: unknown[] = [];
    for (const held of [...directories.values()].reverse()) try { releaseMetadataDirectory(files, held.reference); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], 'engine_dependency_close_failed');
  }
}
