import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

if (!process.version.startsWith('v24.')) throw new Error('node24_required');
const directory = fileURLToPath(new URL('.', import.meta.url));
const runtime = resolve(directory, '../..');
const require = createRequire(pathToFileURL(resolve(runtime, 'package.json')));
const ts = require('typescript');
const source = resolve(directory, 'src/tests/context-selection-convergence.test.ts');
const generated = resolve(directory, 'context-selection-convergence.probe.test.mjs');
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const paths = [source, ...['application/context-compiler', 'application/context-selection', 'infrastructure/structured-planner'].flatMap(name =>
  [resolve(runtime, `src/${name}.ts`), resolve(runtime, `dist/${name}.js`)])];
const observe = () => Object.fromEntries(paths.map(path => [path, digest(path)]));
const before = observe();
const result = ts.transpileModule(readFileSync(source, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, fileName: source, reportDiagnostics: true,
});
if (result.diagnostics?.some(value => value.category === ts.DiagnosticCategory.Error)) throw new Error('probe_transpile_failed');
const basis = pathToFileURL(resolve(runtime, 'dist/tests/context-selection-convergence.test.js'));
const code = result.outputText.replace(/from (['"])(\.[^'"]+)\1/g,
  (_whole, quote, specifier) => `from ${quote}${new URL(specifier, basis).href}${quote}`);
writeFileSync(generated, code, { flag: 'wx', mode: 0o600 });
const logPath = resolve(directory, 'baseline1.log'), fd = openSync(logPath, 'wx', 0o600);
const startedAt = new Date().toISOString(); let timedOut = false;
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=15000', generated], {
  cwd: runtime, stdio: ['ignore', fd, fd],
});
const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30000);
let completion;
try { completion = await new Promise((resolveRun, reject) => {
  child.once('error', reject); child.once('close', (code, signal) => resolveRun({ code, signal }));
}); } finally { clearTimeout(timer); closeSync(fd); }
const after = observe();
const record = { schemaVersion: 1, kind: 'isolated_staged_regression_against_current_dist', node: process.version,
  executable: process.execPath, startedAt, finishedObservedAt: new Date().toISOString(), timedOut, ...completion,
  note: 'Only the staged test was transpiled. Product source and dist were imported unchanged; no typecheck, shared build, model or network call.',
  before, after, unchanged: JSON.stringify(before) === JSON.stringify(after), generatedSha256: digest(generated), logPath, logSha256: digest(logPath) };
writeFileSync(resolve(directory, 'baseline1.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ code: record.code, signal: record.signal, timedOut, unchanged: record.unchanged, logPath }));
if (!record.unchanged || timedOut) process.exitCode = 1;
