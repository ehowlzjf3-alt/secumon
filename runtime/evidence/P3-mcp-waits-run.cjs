const { spawn } = require('node:child_process');
const { createWriteStream } = require('node:fs');
const { writeFile } = require('node:fs/promises');
const { join } = require('node:path');

(async () => {
  const [name, command, ...args] = process.argv.slice(2);
  if (!name || !command || !/^P3-mcp-waits-[a-z0-9-]+$/.test(name)) throw new Error('invalid run arguments');
  const log = join('evidence', `${name}.log`);
  const output = createWriteStream(log, { flags: 'wx' });
  const startedAt = new Date().toISOString();
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  await new Promise(resolve => output.end(resolve));
  const record = { command: [command, ...args], node: process.version, startedAt,
    finishedAt: new Date().toISOString(), ...result, log };
  await writeFile(join('evidence', `${name}-exit.json`), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(record)); process.exitCode = result.exitCode ?? 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
