import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
const directory = 'evidence/C01-workspace-read-linux-nas-20260907';
const root = '/home/shaneee/secumon-linux-test.pCJ0bd';
const control = '/tmp/secumon-workspace-read-nas.PktMGw/control';
const names = ['all-tests.log', 'architecture-cli-fixtures.log', 'architecture.log', 'build.log', 'fixtures.log', 'result.json', 'workspace-targeted.log', 'typecheck-core.log', 'workspace-io.log'];
mkdirSync(directory + '/final', { recursive: true });
execFileSync('scp', ['-o', 'ControlPath=' + control, ...names.map(name => 'nas:' + root + '/evidence-workspace-read/' + name), directory + '/final/']);
execFileSync('scp', ['-o', 'ControlPath=' + control, 'nas:' + root + '/runtime/evidence/C01-workspace-read-io/linux-paired-measurement.json', directory + '/final/']);
const native = JSON.parse(readFileSync(directory + '/final/result.json', 'utf8'));
if (!native.finishedAt || native.status === 'running') throw new Error('native_run_not_finished');
async function audit() {
  const { execFileSync } = await import('node:child_process'); const fs = await import('node:fs');
  const root = '/home/shaneee/secumon-linux-test.pCJ0bd';
  const inside = value => value === root || value.startsWith(root + '/');
  const link = path => { try { return fs.readlinkSync(path); } catch { return ''; } };
  const rows = execFileSync('/bin/ps', ['-eo', 'pid=,comm=,args='], { encoding: 'utf8' }).split('\n');
  const owned = rows.flatMap(line => {
    const hit = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (!hit || Number(hit[1]) === process.pid || !/^(node|npm)$/.test(hit[2])) return [];
    const executable = link('/proc/' + hit[1] + '/exe'); const cwd = link('/proc/' + hit[1] + '/cwd');
    return hit[3].includes(root) || inside(executable) || inside(cwd) ? [Number(hit[1])] : [];
  });
  console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), ownedProcesses: owned.length, ownedPids: owned,
    processAudit: 'node_npm_args_or_proc_executable_or_working_directory_within_dedicated_root_excluding_audit_self',
    rootMode: (fs.statSync(root).mode & 0o777).toString(8),
    defaultNode: execFileSync('/usr/bin/node', ['--version'], { encoding: 'utf8' }).trim(),
    tmp: fs.readdirSync(root + '/tmp').sort(),
    filesystem: execFileSync('/usr/bin/findmnt', ['--target', root, '--noheadings', '--output', 'FSTYPE,OPTIONS'], { encoding: 'utf8' }).trim() }));
}
const output = execFileSync('ssh', ['-S', control, 'nas', '/usr/bin/env -i PATH=/usr/bin:/bin ' + root + '/node-v24.20.0-linux-x64/bin/node --input-type=module'], { input: 'await (' + audit.toString() + ')();', encoding: 'utf8' });
const cleanup = JSON.parse(output); cleanup.sshClosed = false;
writeFileSync(directory + '/cleanup.json', JSON.stringify(cleanup, null, 2) + '\n');
if (cleanup.ownedProcesses !== 0) throw new Error('owned_test_processes_remain');
execFileSync('ssh', ['-S', control, '-O', 'exit', 'nas']);
cleanup.sshClosed = !existsSync(control);
writeFileSync(directory + '/cleanup.json', JSON.stringify(cleanup, null, 2) + '\n');
if (!cleanup.sshClosed) throw new Error('ssh_control_still_present');
rmdirSync('/tmp/secumon-workspace-read-nas.PktMGw');
const metadata = JSON.parse(readFileSync(directory + '/run-metadata.json', 'utf8'));
Object.assign(metadata, { status: native.status, finishedAt: native.finishedAt, sessionCompleted: true, logsCollected: [...names, 'linux-paired-measurement.json'], sshClosed: true });
writeFileSync(directory + '/run-metadata.json', JSON.stringify(metadata, null, 2) + '\n');
console.log(JSON.stringify({ status: native.status, finishedAt: native.finishedAt, filesCollected: names.length + 1, cleanup }));
