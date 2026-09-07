import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

// Path simulation on the invoking host; this does not execute native Windows I/O.
// Only the adjacent evidence JSON is written. Product files are read unchanged.
const runtimeRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const windowsRoot = 'C:\\secumon-runtime';
const checkerPath = join(runtimeRoot, 'scripts', 'check-architecture.mjs');
const checker = readFileSync(checkerPath, 'utf8');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const guard = "if (inspected === 0) failures.push({ file: 'src', dependency: 'no_core_files_inspected' });\n";
assert.equal(checker.split('.split(sep)[0]').length - 1, 2, 'Expected both repaired layer checks');
assert.ok(checker.includes(guard), 'Expected the current empty-scan guard');

// Reconstruct the reviewed defect from the current file, rather than claiming
// that this is a preserved historical file or running a changed product file.
const legacy = checker.replaceAll('.split(sep)[0]', ".split('/')[0]").replace(guard, '');
const sourceBody = source => source.replace(/^import .*;\r?\n/gm, '');
const toLocalPath = path => {
  const relative = win32.relative(windowsRoot, path);
  assert.ok(relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative));
  return join(runtimeRoot, ...relative.split(win32.sep));
};

function simulate(id, source, { forbiddenImport = false, emptyTree = false } = {}) {
  const output = [];
  const processState = { exitCode: 0 };
  const actualReads = new Map();
  let injected = false;
  const context = {
    ts, process: processState, sep: win32.sep,
    resolve: (...parts) => win32.resolve(windowsRoot, ...parts),
    dirname: win32.dirname, relative: win32.relative,
    readdirSync: (path, options) => emptyTree ? [] : readdirSync(toLocalPath(path), options),
    readFileSync: (path, encoding) => {
      const bytes = readFileSync(toLocalPath(path));
      actualReads.set(win32.relative(windowsRoot, path).split(win32.sep).join('/'), sha256(bytes));
      const inject = forbiddenImport && path.endsWith('\\domain\\model.ts');
      if (inject) injected = true;
      return (inject ? "import fs from 'node:fs';\n" : '') + bytes.toString(encoding);
    },
    console: { log: value => output.push(JSON.parse(value)) }
  };
  vm.runInNewContext(sourceBody(source), context, { filename: `${id}.mjs`, timeout: 30000 });
  assert.equal(output.length, 1, 'Expected one checker report');
  if (forbiddenImport) assert.equal(injected, true, 'Forbidden import injection was not exercised');
  const filesRead = [...actualReads].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return {
    id, checkerVariantSha256: sha256(source), forbiddenImportInjectedInMemory: injected,
    filesystemView: emptyTree ? 'empty_tree_in_memory' : 'actual_repository_read_through_windows_path_mapping',
    ...output[0], exitCode: processState.exitCode,
    sourceFilesRead: filesRead.length, sourceFilesReadDigest: sha256(JSON.stringify(filesRead))
  };
}

const cases = [
  simulate('legacy_reconstructed_in_memory', legacy),
  simulate('current_source', checker),
  simulate('current_source_with_forbidden_import', checker, { forbiddenImport: true }),
  simulate('current_source_with_empty_tree', checker, { emptyTree: true })
];
const [old, current, forbidden, empty] = cases;
const checks = {
  legacyIncorrectlyPassesWithoutInspection: old.inspected === 0 && old.failures.length === 0 && old.exitCode === 0,
  currentInspectsCoreAndPasses: current.inspected > 0 && current.failures.length === 0 && current.exitCode === 0,
  currentRejectsForbiddenImport: forbidden.inspected === current.inspected && forbidden.exitCode === 1 &&
    forbidden.failures.length === 1 && forbidden.failures[0].file === 'domain\\model.ts' && forbidden.failures[0].dependency === 'node:fs',
  currentRejectsEmptyInspection: empty.inspected === 0 && empty.exitCode === 1 &&
    empty.failures.length === 1 && empty.failures[0].dependency === 'no_core_files_inspected',
  negativeControlUsesSameSourceFiles: current.sourceFilesReadDigest === forbidden.sourceFilesReadDigest
};
const evidence = {
  schemaVersion: 1, recordedAt: new Date().toISOString(),
  status: Object.values(checks).every(Boolean) ? 'passed' : 'failed',
  scope: 'architecture_checker_path_simulation',
  nativeWindowsExecution: false,
  host: { platform: process.platform, arch: process.arch, node: process.version, typescript: ts.version },
  pathApi: 'node:path.win32',
  productChecker: { path: 'scripts/check-architecture.mjs', sha256: sha256(checker) },
  evidenceScript: { path: 'evidence/C01-architecture-path-simulation.mjs', sha256: sha256(readFileSync(fileURLToPath(import.meta.url))) },
  legacyReconstruction: 'Current checker with both split(sep) expressions changed to split(\'/\') and the empty-scan guard removed in memory; not a preserved historical source snapshot.',
  limitations: [
    'Actual filesystem calls execute on the recorded host through a Windows-to-host path mapping.',
    'Does not validate native Windows filesystem permissions, reparse points, durability, process behavior, or installed CLI behavior.',
    'The forbidden import and empty source tree exist only in memory; product files are not modified.',
    'No NAS connection or model/API call is performed.'
  ],
  cases, checks
};
writeFileSync(join(runtimeRoot, 'evidence', 'C01-architecture-path-simulation.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ status: evidence.status, nativeWindowsExecution: false, cases: cases.map(({ id, inspected, failures, exitCode }) => ({ id, inspected, failures, exitCode })), checks }));
if (evidence.status !== 'passed') process.exitCode = 1;
