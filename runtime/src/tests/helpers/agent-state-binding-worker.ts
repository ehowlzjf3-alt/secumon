import fs from 'node:fs';
import { basename, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const [engine, root, phase, requested] = process.argv.slice(2);
if (!engine || !root || !phase) throw new Error('worker_arguments_required');
function pause() { fs.writeSync(1, 'checkpoint\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
const link = fs.linkSync; const open = fs.openSync;
fs.linkSync = (source, destination) => {
  if (basename(String(destination)) === 'state-profile.json' && phase === 'before-profile') pause();
  link(source, destination);
  if (basename(String(destination)) === 'state-profile.json' && phase === 'published-profile') pause();
};
fs.openSync = (path, flags, mode) => {
  const fd = open(path, flags, mode);
  if (typeof flags === 'number' && (flags & fs.constants.O_EXCL) && basename(String(path)) === phase) pause();
  return fd;
};
syncBuiltinESMExports();
const { FileAgentProfileStore } = await import('../../infrastructure/file-agent-profile.js');
const { openAgentStores } = await import('../../infrastructure/agent-stores.js');
const { AgentConfigSchema } = await import('../../application/agent-profile-contracts.js');
const profiles = new FileAgentProfileStore(engine);
if (requested) {
  if (requested !== 'sqlite' && requested !== 'file-journal') throw new Error('invalid_backend');
  const profile = profiles.inspect(root); if (profile.status !== 'ready') throw new Error('not_ready');
  const selected: typeof profile = { ...profile, config: AgentConfigSchema.parse({ ...profile.config, storage: { ...profile.config.storage, state: requested } }),
    paths: { ...profile.paths, state: join(profile.paths.metadata, requested === 'sqlite' ? 'runtime.sqlite' : 'state-journal') } };
  // Simulates two already-validated host config snapshots racing for the initial assignment.
  profiles.inspect = () => selected;
}
const stores = await openAgentStores(profiles, root); await stores.close();
fs.writeSync(1, JSON.stringify({ backend: stores.profile.config.storage.state }) + '\n');
