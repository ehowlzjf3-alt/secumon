import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAgentEngine } from '../infrastructure/agent-engine-preparation.js';
import { captureLifecycleTree } from '../infrastructure/agent-lifecycle-files.js';
import { hostMetadataFiles, releaseMetadataDirectory, sameFileIdentity } from '../infrastructure/host-metadata-files.js';

test('preparation revalidates the selected engine registration after its final source manifest read',
  { skip: process.platform === 'win32' ? 'POSIX temporary bundle and metadata hook; native Windows execution is separate.' : false }, t => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'engine-preparation-revalidation-')));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const source = join(base, 'source'), agent = join(base, 'agent');
    const preparationDirectory = join(base, 'prepared'), registryDirectory = join(base, 'registry');
    for (const directory of [source, agent, join(source, 'dist/presentation'), join(source, 'node_modules/zod')])
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value) + '\n', { mode: 0o600 });
    json(join(source, 'package.json'), { name: 'long-horizon-runtime', version: '0.0.1-revalidation', type: 'module',
      engines: { node: '>=24.20.0 <25' }, dependencies: { zod: '0.0.1' } });
    json(join(source, 'node_modules/zod/package.json'), { name: 'zod', version: '0.0.1' });
    // The real bundler/installer verifies this small metadata tree; neither stub is ever executed.
    writeFileSync(join(source, 'dist/presentation/agent-cli.js'), 'throw new Error("metadata_only_fixture");\n', { mode: 0o600 });
    writeFileSync(join(agent, 'original.md'), 'Preparation does not own or initialize this agent.\n', { mode: 0o600 });
    const options = { preparationDirectory, registryDirectory };
    const prepared = prepareAgentEngine(source, agent, options);
    assert.equal(prepared.source, 'prepared');
    const folder = join(preparationDirectory, prepared.releaseDigest), selectedPath = join(folder, 'selected.json');
    const selectedBytes = readFileSync(selectedPath), sourceBytes = readFileSync(join(source, 'package.json'));
    const names = readdirSync(registryDirectory); assert.equal(names.length, 1);
    const registrationName = names[0]!, registrationPath = join(registryDirectory, registrationName);
    const registration = JSON.parse(readFileSync(registrationPath, 'utf8')) as Record<string, unknown>;
    assert.equal(registration['directory'], prepared.directory); assert.equal(registration['releaseDigest'], prepared.releaseDigest);
    const changedBytes = Buffer.from(JSON.stringify({ ...registration, version: 'changed-during-source-reread' }) + '\n');
    const sourceBefore = captureLifecycleTree(source), agentBefore = captureLifecycleTree(agent), preparedBefore = captureLifecycleTree(preparationDirectory);
    const files = hostMetadataFiles();
    function identity(path: string) {
      const held = files.inspectDirectory(path, 'owner-writable'); assert.ok(held);
      try { return { ...held.identity }; } finally { releaseMetadataDirectory(files, held); }
    }
    const sourceIdentity = identity(source), selectorIdentity = identity(folder), registryIdentity = identity(registryDirectory);
    const original = files.readStableRegularFile, events: string[] = [];
    let selectedRead = false, mutations = 0;
    try {
      files.readStableRegularFile = function (directory, leaf, policy) {
        const bytes = original.call(this, directory, leaf, policy);
        if (leaf === 'selected.json' && sameFileIdentity(directory.identity, selectorIdentity)) {
          assert.deepEqual(bytes, selectedBytes); selectedRead = true; events.push('selector');
        }
        if (leaf === 'package.json' && sameFileIdentity(directory.identity, sourceIdentity)) {
          assert.deepEqual(bytes, sourceBytes); events.push(selectedRead ? 'source-after-selector' : 'source-before-selector');
          if (selectedRead && mutations === 0) {
            writeFileSync(registrationPath, changedBytes); mutations++; events.push('registry-changed');
          }
        }
        if (leaf === registrationName && sameFileIdentity(directory.identity, registryIdentity) && mutations > 0) {
          assert.deepEqual(bytes, changedBytes); events.push('registry-read-after-change');
        }
        return bytes;
      };
      assert.throws(() => prepareAgentEngine(source, agent, options), /^Error: engine_installation_(conflict|changed)$/);
    } finally { files.readStableRegularFile = original; }
    assert.equal(mutations, 1); assert.equal(selectedRead, true);
    assert.ok(events.indexOf('source-before-selector') >= 0);
    assert.ok(events.indexOf('selector') > events.indexOf('source-before-selector'));
    assert.ok(events.indexOf('source-after-selector') > events.indexOf('selector'));
    assert.equal(events[events.indexOf('registry-changed') - 1], 'source-after-selector');
    assert.ok(events.indexOf('registry-read-after-change') > events.indexOf('registry-changed'));
    assert.deepEqual(captureLifecycleTree(source), sourceBefore); assert.deepEqual(captureLifecycleTree(agent), agentBefore);
    assert.deepEqual(captureLifecycleTree(preparationDirectory), preparedBefore); assert.deepEqual(readFileSync(selectedPath), selectedBytes);
    assert.deepEqual(readdirSync(registryDirectory), names);
    assert.deepEqual(readFileSync(registrationPath), changedBytes, 'the altered registration is rejected and never silently repaired');
  });
