import { spawn } from 'node:child_process';
import { open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluationCodePin, verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';

const [stage, command, ...args] = process.argv.slice(2);
if (!stage || !/^[a-z0-9-]+$/.test(stage) || !command) throw new Error('invalid_stage');
const root = resolve('.');
const file = resolve('evidence', `C05-mcp-${stage}`);
const result = { stage, command, args, node: process.version, startedAt: new Date().toISOString(),
  sourceBefore: (await evaluationCodePin(root)).digest };
if (stage.startsWith('new') || stage.startsWith('related')) result.buildBefore = await verifyEvaluationBuild(root);
const output = await open(`${file}.log`, 'wx', 0o600);
try {
  const child = spawn(command, args, { cwd: root, env: process.env, stdio: ['ignore', output.fd, output.fd] });
  result.pid = child.pid;
  const timer = setTimeout(() => { result.timedOut = true; child.kill('SIGTERM'); }, 180000);
  try {
    const [code, signal] = await new Promise((ok, reject) => { child.once('error', reject); child.once('exit', (code, signal) => ok([code, signal])); });
    result.exitCode = code; result.signal = signal;
  } finally { clearTimeout(timer); }
} finally { await output.close(); }
result.finishedAt = new Date().toISOString();
result.sourceAfter = (await evaluationCodePin(root)).digest;
result.sourceUnchanged = result.sourceBefore === result.sourceAfter;
if (result.exitCode === 0 && (stage.startsWith('build') || stage.startsWith('new') || stage.startsWith('related')))
  result.buildAfter = await verifyEvaluationBuild(root);
await writeFile(`${file}.json`, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ stage, exitCode: result.exitCode, sourceUnchanged: result.sourceUnchanged, log: `${file}.log` }));
process.exitCode = result.exitCode ?? 1;
