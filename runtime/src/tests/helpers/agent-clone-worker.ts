import fs from 'node:fs';
import { basename, sep } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const [engine, source, target, phase, command = 'clone'] = process.argv.slice(2);
if (!engine || !source || !target || !phase) throw new Error('worker_arguments_required');
const original = fs.linkSync;
function pause() {
  fs.writeSync(1, 'checkpoint\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
fs.linkSync = (existing, destination) => {
  const path = String(destination); const name = basename(path);
  if (phase === 'before-complete' && name === 'clone-complete.json') pause();
  original(existing, destination);
  if (phase === 'change-target-config' && path.includes(`${sep}skills${sep}`)) {
    const configPath = `${target}${sep}config.json`;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    fs.writeFileSync(configPath, JSON.stringify({ ...config, name: 'changed during copy' }));
  }
  if (phase === name || phase === 'skill' && path.includes(`${sep}skills${sep}`)) pause();
};
syncBuiltinESMExports();
const { FileAgentProfileStore } = await import('../../infrastructure/file-agent-profile.js');
const store = new FileAgentProfileStore(engine);
const result = command === 'initialize' ? store.initialize(target) : store.clone(source, target, { resume: command === 'resume' });
fs.writeSync(1, JSON.stringify(result) + '\n');
