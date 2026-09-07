import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [operation, engine, root, scenario] = process.argv.slice(2);
if (!engine || !root || !['publish', 'race'].includes(operation ?? '') || !['valid', 'malformed', 'mismatch'].includes(scenario ?? '')) {
  throw new Error('invalid_agent_profile_concurrency_worker_arguments');
}
const enginePath = engine; const rootPath = root; const configPath = join(rootPath, 'config.json');
const originalLstat = fs.lstatSync;
type TreeEntry = { path: string; kind: string; mode: number; sha256?: string };
function tree(): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const visit = (path: string, name: string) => {
    const stat = originalLstat(path); const mode = stat.mode & 0o777;
    if (stat.isDirectory()) {
      entries.push({ path: name, kind: 'directory', mode });
      for (const child of fs.readdirSync(path).sort()) visit(join(path, child), name ? `${name}/${child}` : child);
    } else if (stat.isFile()) entries.push({ path: name, kind: 'file', mode, sha256: createHash('sha256').update(fs.readFileSync(path)).digest('hex') });
    else throw new Error('unexpected_concurrency_fixture_file');
  };
  visit(rootPath, ''); return entries;
}
function failure(error: unknown) {
  if (!error) return null;
  const value = error as Error & { code?: string };
  return { name: value.name, message: value.message, code: value.code ?? null, stack: value.stack ?? null };
}
function output(value: unknown) { fs.writeSync(1, JSON.stringify(value) + '\n'); }

if (operation === 'publish') {
  const { FileAgentProfileStore } = await import('../../infrastructure/file-agent-profile.js');
  const profile = new FileAgentProfileStore(enginePath).initialize(rootPath);
  // Negative cases damage only the synthetic fixture after the competing initializer has succeeded.
  if (scenario === 'malformed') fs.writeFileSync(configPath, '{synthetic-malformed-config', { mode: 0o600 });
  if (scenario === 'mismatch') fs.writeFileSync(configPath, JSON.stringify({ ...profile.config,
    identity: { ...profile.identity, agentId: randomUUID() } }), { mode: 0o600 });
  output({ status: profile.status, identity: profile.identity, scenario, mutation: scenario === 'valid' ? null : scenario });
} else {
  let injections = 0; let metadataAbsentAtBoundary = false; let child: unknown = null; let publishedTree: TreeEntry[] | null = null;
  // Only this isolated worker mocks lstat. The competing initializer runs real production code in another process.
  Reflect.set(fs, 'lstatSync', ((...args: unknown[]) => {
    try { return Reflect.apply(originalLstat, fs, args); }
    catch (error) {
      if (injections === 0 && String(args[0]) === configPath && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        injections += 1; metadataAbsentAtBoundary = !fs.existsSync(join(rootPath, '.secumon'));
        const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'publish', enginePath, rootPath, scenario!],
          { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
        let reply: unknown = null; try { reply = JSON.parse(result.stdout); } catch {}
        child = { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: failure(result.error), reply };
        if (result.status !== 0) throw new Error(`competing_initializer_failed:${result.stderr}:${result.error ?? ''}`);
        publishedTree = tree();
      }
      // Keep the original observation: this caller still saw no config before the competing publication.
      throw error;
    }
  }) as typeof fs.lstatSync);
  syncBuiltinESMExports();
  let parent: unknown = null; let parentFailure: unknown;
  try {
    const { FileAgentProfileStore } = await import('../../infrastructure/file-agent-profile.js');
    const profile = new FileAgentProfileStore(enginePath).initialize(rootPath);
    parent = { status: profile.status, identity: profile.identity };
  } catch (error) { parentFailure = error; }
  finally { Reflect.set(fs, 'lstatSync', originalLstat); syncBuiltinESMExports(); }
  output({ scenario, injections, metadataAbsentAtBoundary, child, parent, failure: failure(parentFailure),
    publishedTree, finalTree: tree() });
}
