import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sha256 } from '../infrastructure/digest.js';

const execute = promisify(execFile);
const worker = fileURLToPath(new URL('./helpers/journal-empty-directory-race-worker.js', import.meta.url));
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'journal-directory-race-'))); const root = join(base, 'journal');
  return { base, root, folder: join(root, sha256('directory-race-work')), close: () => rmSync(base, { recursive: true, force: true }) };
}
async function race(f: ReturnType<typeof fixture>, scenario: 'replace-empty' | 'remove-created') {
  const { stdout, stderr } = await execute(process.execPath, [worker, f.root, scenario],
    { timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout); const diagnostics = JSON.stringify({ result, stderr });
  assert.equal(result.scenario, scenario, diagnostics); assert.equal(result.injections, 1, diagnostics);
  assert.equal(result.result, null, diagnostics); assert.equal(result.headerPreserved, true, diagnostics);
  assert.equal(result.writeOpensAfterBoundary, 0, diagnostics); assert.deepEqual(result.stages, [], diagnostics);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'format.json'), 'utf8')).kind, 'long-horizon-file-journal');
  return result;
}

test('journal listing rejects an empty work directory replaced after its first missing record observation', { timeout: 20000 }, async () => {
  const f = fixture(); try {
    const result = await race(f, 'replace-empty');
    assert.equal(result.observedDirectoriesAtBoundary, 1); assert.equal(result.replacementIdentityChanged, true);
    assert.equal(result.code, 'journal_directory_changed', JSON.stringify(result));
    const original = join(f.base, 'preserved-empty-work');
    assert.deepEqual(readdirSync(original), []); assert.deepEqual(readdirSync(f.folder), []);
    assert.notEqual(statSync(original).ino, statSync(f.folder).ino);
    assert.deepEqual(readdirSync(f.root).sort(), [sha256('directory-race-work'), 'format.json'].sort());
  } finally { f.close(); }
});

test('journal commit preserves the original missing-directory cause if its newly created work folder disappears', { timeout: 20000 }, async () => {
  const f = fixture(); try {
    const result = await race(f, 'remove-created');
    assert.equal(result.observedDirectoriesAtBoundary, 0);
    assert.equal(result.code, 'journal_directory_unavailable', JSON.stringify(result));
    assert.equal(result.causeCode, 'ENOENT'); assert.equal(result.originalMissingCause, true);
    assert.equal(existsSync(f.folder), false); assert.deepEqual(readdirSync(f.root), ['format.json']);
    assert.deepEqual(readdirSync(f.base), ['journal']);
  } finally { f.close(); }
});
