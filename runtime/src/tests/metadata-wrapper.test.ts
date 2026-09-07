import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readProfileBytes, syncProfileDirectory } from '../infrastructure/agent-profile-files.js';
import { hostMetadataFiles } from '../infrastructure/host-metadata-files.js';

const execute = promisify(execFile);
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'metadata-wrapper-')));
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}
test('profile wrapper preserves absent reads, zero-byte reads and original missing sync error', () => {
  const f = fixture(); try {
    assert.equal(readProfileBytes(join(f.root, 'absent'), 1024), null);
    writeFileSync(join(f.root, 'empty'), '', { mode: 0o600 });
    assert.deepEqual(readProfileBytes(join(f.root, 'empty'), 0), Buffer.alloc(0));
    assert.throws(() => syncProfileDirectory(join(f.root, 'absent')), (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT');
  } finally { f.close(); }
});
test('common diagnostics include directory checks without replacing consumer read counters', () => {
  const f = fixture(); try {
    const path = join(f.root, 'value'); writeFileSync(path, 'value', { mode: 0o600 });
    const files = hostMetadataFiles(); const before = files.diagnostics();
    assert.deepEqual(readProfileBytes(path, 5), Buffer.from('value'));
    const after = files.diagnostics();
    assert.equal(after.dataBytes - before.dataBytes, 5); assert.ok(after.directoryChecks > before.directoryChecks);
    assert.equal(after.fileOpens - before.fileOpens, after.fileCloses - before.fileCloses);
    assert.equal(readFileSync(path, 'utf8'), 'value'); assert.equal(Object.isFrozen(after), true);
  } finally { f.close(); }
});
for (const stage of ['open', 'named-lstat'] as const) test(`profile wrapper preserves ${stage} disappearance error and closes opened files`, async () => {
  const f = fixture(); try {
    const path = join(f.root, 'value'); writeFileSync(path, 'value', { mode: 0o600 });
    const profileUrl = new URL('../infrastructure/agent-profile-files.js', import.meta.url).href;
    const script = `import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      import {readProfileBytes} from ${JSON.stringify(profileUrl)};
      const [path,stage]=process.argv.slice(1);
      const original={open:fs.openSync,close:fs.closeSync,read:fs.readSync,lstat:fs.lstatSync};
      const descriptors=new Set(); let opens=0,closes=0,bytesRead=0,removedAt=null,errorCode=null,syscall=null;
      fs.openSync=(file,...args)=>{
        if(String(file)===path&&stage==='open') {fs.unlinkSync(path);removedAt='open';}
        const fd=original.open(file,...args);
        if(String(file)===path) {descriptors.add(fd);opens++;}
        return fd;
      };
      fs.closeSync=fd=>{original.close(fd);if(descriptors.delete(fd))closes++;};
      fs.readSync=(fd,...args)=>{const count=original.read(fd,...args);if(descriptors.has(fd))bytesRead+=count;return count;};
      fs.lstatSync=(file,...args)=>{
        if(String(file)===path&&stage==='named-lstat'&&bytesRead>0&&removedAt===null) {
          fs.unlinkSync(path);removedAt='named-lstat';
        }
        return original.lstat(file,...args);
      };
      syncBuiltinESMExports();
      try {readProfileBytes(path,1024);} catch(error) {errorCode=error.code;syscall=error.syscall??null;}
      finally {
        fs.openSync=original.open;fs.closeSync=original.close;fs.readSync=original.read;fs.lstatSync=original.lstat;
        syncBuiltinESMExports();
      }
      process.stdout.write(JSON.stringify({errorCode,syscall,removedAt,opens,closes,bytesRead,openDescriptors:descriptors.size,exists:fs.existsSync(path)}));`;
    const result = await execute(process.execPath, ['--input-type=module', '--eval', script, path, stage], { timeout: 15000 });
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.removedAt, stage); assert.equal(observed.exists, false);
    assert.equal(observed.errorCode, stage === 'open' ? 'agent_metadata_unsafe' : 'ENOENT');
    assert.equal(observed.syscall, stage === 'open' ? null : 'lstat');
    assert.equal(observed.opens, stage === 'open' ? 0 : 1); assert.equal(observed.closes, observed.opens);
    assert.equal(observed.openDescriptors, 0); assert.equal(observed.bytesRead, stage === 'open' ? 0 : 5);
  } finally { f.close(); }
});
test('emulated unsupported platform refuses profile and standalone journal writes before creating files', async () => {
  const f = fixture(); try {
    const profileUrl = new URL('../infrastructure/agent-profile-files.js', import.meta.url).href;
    const journalUrl = new URL('../infrastructure/file-journal-state.js', import.meta.url).href;
    const script = `import {profileDirectory,publishProfileBytes} from ${JSON.stringify(profileUrl)};
      import {FileJournalStateRepository} from ${JSON.stringify(journalUrl)};
      import {join} from 'node:path';
      const original=process.platform; const errors=[];
      Object.defineProperty(process,'platform',{value:'win32'});
      try {
        for(const action of [()=>profileDirectory(join(process.argv[1],'profile'),true),
          ()=>publishProfileBytes(join(process.argv[1],'metadata.json'),Buffer.from('value')),
          ()=>new FileJournalStateRepository(join(process.argv[1],'journal'))]) {
          try {action();errors.push(null);} catch(error) {errors.push(error.code);}
        }
      } finally {Object.defineProperty(process,'platform',{value:original});}
      process.stdout.write(JSON.stringify(errors));`;
    const result = await execute(process.execPath, ['--input-type=module', '--eval', script, f.root], { timeout: 15000 });
    assert.deepEqual(JSON.parse(result.stdout), ['agent_platform_unsupported', 'agent_platform_unsupported', 'journal_platform_unsupported']);
    assert.deepEqual(readdirSync(f.root), []);
  } finally { f.close(); }
});
