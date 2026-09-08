import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const probe = fileURLToPath(new URL('./helpers/agent-launch-process-probe.js', import.meta.url));
test('selected engine terminal preserves argv, cwd, stdin, stderr, exit status and forwards a signal sent only to its parent',
  { skip: process.platform === 'win32' ? 'POSIX SIGTERM process observation; native Windows remains separate.' : false, timeout: 20000 }, async t => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-launch-terminal-'))), engine = join(base, 'engine');
    const target = join(engine, 'dist', 'presentation'); mkdirSync(target, { recursive: true, mode: 0o700 });
    // This fixture proves terminal transport only; installed release validation has a separate full-runtime test.
    writeFileSync(join(target, 'agent-cli.js'), `
process.on('SIGTERM', () => { process.stderr.write('target-terminated\\n'); process.exitCode = 23; process.stdin.destroy(); clearTimeout(timer); });
const timer = setTimeout(() => process.exit(39), 10000);
process.stdin.setEncoding('utf8');
process.stdin.once('data', text => process.stdout.write(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), text }) + '\\n'));
`, { mode: 0o600 });
    const args = ['--text', '문장; $(touch forbidden)', '--directory=literal', 'space value'];
    const child = spawn(process.execPath, [probe, engine, ...args], { cwd: base, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); rmSync(base, { recursive: true, force: true }); });
    let stdout = '', stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr += value; });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.setEncoding('utf8'); child.stdout.on('data', value => { stdout += value; if (stdout.includes('\n')) resolve(); });
      child.once('error', reject); child.once('close', () => { if (!stdout.includes('\n')) reject(new Error('terminal_child_closed_before_input')); });
    });
    child.stdin.write('전달할 입력\n');
    await ready;
    assert.deepEqual(JSON.parse(stdout.trim()), { cwd: base, args, text: '전달할 입력\n' });
    assert.equal(child.kill('SIGTERM'), true);
    assert.deepEqual(await closed, { code: 23, signal: null });
    assert.equal(stderr, 'target-terminated\n');
  });
