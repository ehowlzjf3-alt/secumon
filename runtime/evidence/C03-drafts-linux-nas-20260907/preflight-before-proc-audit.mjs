import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const folder = 'evidence/C03-drafts-linux-nas-20260907';
const control = readFileSync(folder + '/control-directory.txt', 'utf8').trim() + '/control';
async function inspect() {
  const fs = await import('node:fs'), { execFileSync } = await import('node:child_process');
  const root = '/home/shaneee/secumon-linux-test.pCJ0bd';
  const link = path => { try { return fs.readlinkSync(path); } catch { return ''; } };
  const inside = value => value === root || value.startsWith(root + '/');
  const owned = execFileSync('/bin/ps', ['-eo', 'pid=,comm=,args='], { encoding: 'utf8' }).split('\n').flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
    return m && Number(m[1]) !== process.pid && /^(node|npm)$/.test(m[2]) &&
      (m[3].includes(root) || inside(link('/proc/' + m[1] + '/exe')) || inside(link('/proc/' + m[1] + '/cwd'))) ? [Number(m[1])] : [];
  });
  const previous = JSON.parse(fs.readFileSync(root + '/evidence-documents-c03/result.json', 'utf8'));
  console.log(JSON.stringify({ at: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
    root: fs.realpathSync(root), rootMode: (fs.statSync(root).mode & 0o777).toString(8), ownedProcesses: owned.length, ownedPids: owned,
    defaultNode: execFileSync('/usr/bin/node', ['--version'], { encoding: 'utf8' }).trim(),
    previous: { status: previous.status, finishedAt: previous.finishedAt },
    filesystem: execFileSync('/usr/bin/findmnt', ['--target', root, '--noheadings', '--output', 'FSTYPE,OPTIONS'], { encoding: 'utf8' }).trim() }));
}
const result = JSON.parse(execFileSync('ssh', ['-S', control, 'nas', '/usr/bin/env -i PATH=/usr/bin:/bin /home/shaneee/secumon-linux-test.pCJ0bd/node-v24.20.0-linux-x64/bin/node --input-type=module'],
  { input: 'await (' + inspect.toString() + ')();', encoding: 'utf8' }));
assert.equal(result.platform, 'linux'); assert.equal(result.node, 'v24.20.0'); assert.equal(result.rootMode, '700');
assert.equal(result.root, '/home/shaneee/secumon-linux-test.pCJ0bd'); assert.equal(result.ownedProcesses, 0);
assert.equal(result.defaultNode, 'v18.20.4'); assert.equal(result.previous.status, 'passed'); assert(result.previous.finishedAt);
writeFileSync(folder + '/preflight.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify(result));
