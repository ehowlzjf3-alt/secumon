import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
const directory = 'evidence/C03-drafts-linux-nas-20260907', root = '/home/shaneee/secumon-linux-test.pCJ0bd';
const controlDirectory = readFileSync(directory + '/control-directory.txt', 'utf8').trim(), control = controlDirectory + '/control';
const native = JSON.parse(readFileSync(directory + '/final/result.json', 'utf8'));
if (native.status !== 'passed' || !native.finishedAt) throw new Error('collected_native_pass_required');
async function audit() {
  const { execFileSync } = await import('node:child_process'); const fs = await import('node:fs'); const root = '/home/shaneee/secumon-linux-test.pCJ0bd';
  const inside = value => value === root || value.startsWith(root + '/');
  const transient = error => ['ENOENT', 'ESRCH'].includes(error?.code);
  const owned = [], observedProcesses = [], inaccessiblePeers = [], unresolved = [], auditErrors = [];
  for (const name of fs.readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
    const pid = Number(name); if (pid === process.pid) continue;
    try {
      if (fs.statSync(`/proc/${pid}`).uid !== process.getuid()) continue;
      const paths = {}, unavailableFields = [];
      for (const field of ['exe', 'cwd']) {
        try { paths[field] = fs.readlinkSync(`/proc/${pid}/${field}`); }
        catch (error) {
          if (['EACCES', 'EPERM'].includes(error.code)) unavailableFields.push({ field, code: error.code });
          else if (!transient(error)) auditErrors.push({ pid, field, code: error.code ?? error.name });
        }
      }
      const isOwned = Object.values(paths).some(inside);
      if (unavailableFields.length) {
        inaccessiblePeers.push({ pid, visiblePaths: paths, unavailableFields, scope: isOwned ? 'observed_owned' : 'unresolved' });
        if (!isOwned) unresolved.push({ pid, visiblePaths: paths, unavailableFields, reason: 'scope_not_proven_from_accessible_paths' });
      }
      if (isOwned) { owned.push(pid); observedProcesses.push({ pid, ...paths, unavailableFields }); }
    } catch (error) { if (!transient(error)) auditErrors.push({ pid, field: 'process_owner', code: error.code ?? error.name }); }
  }
  owned.sort((a, b) => a - b);
  console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), ownedProcesses: owned.length, observedOwnedProcesses: owned.length, ownedPids: owned,
    observedProcesses, inaccessiblePeers, unresolved, auditErrors, globalProcessAbsenceProven: false,
    processAudit: 'all_comm_names_same_uid_observable_proc_executable_or_working_directory_within_dedicated_root_excluding_audit_self',
    processAuditScope: 'Same-UID observable exe/cwd paths; inaccessible peers retain unresolved scope and do not establish global process absence. No comm, cmdline, or environ filter/read.',
    realRoot: fs.realpathSync(root), rootMode: (fs.statSync(root).mode & 0o777).toString(8), defaultNode: execFileSync('/usr/bin/node', ['--version'], { encoding: 'utf8' }).trim(),
    tmp: fs.readdirSync(root + '/tmp').sort(), filesystem: execFileSync('/usr/bin/findmnt', ['--target', root, '--noheadings', '--output', 'FSTYPE,OPTIONS'], { encoding: 'utf8' }).trim() }));
}
const output = execFileSync('ssh', ['-S', control, 'nas', '/usr/bin/env -i PATH=/usr/bin:/bin ' + root + '/node-v24.20.0-linux-x64/bin/node --input-type=module'], {
  input: 'await (' + audit.toString() + ')();', encoding: 'utf8',
});
const cleanup = { ...JSON.parse(output), sshClosed: false }; writeFileSync(directory + '/cleanup.json', JSON.stringify(cleanup, null, 2) + '\n');
if (!Array.isArray(cleanup.auditErrors) || cleanup.auditErrors.length !== 0) throw new Error('process_audit_io_error');
if (cleanup.ownedProcesses !== 0) throw new Error('owned_test_processes_remain');
if (cleanup.realRoot !== root || cleanup.rootMode !== '700' || !/^v18\./.test(cleanup.defaultNode)) throw new Error('dedicated_environment_changed');
execFileSync('ssh', ['-S', control, '-O', 'exit', 'nas']); cleanup.sshClosed = !existsSync(control);
writeFileSync(directory + '/cleanup.json', JSON.stringify(cleanup, null, 2) + '\n');
if (!cleanup.sshClosed) throw new Error('ssh_control_still_present'); rmdirSync(controlDirectory);
const path = directory + '/run-metadata.json', metadata = JSON.parse(readFileSync(path, 'utf8'));
Object.assign(metadata, { status: native.status, finishedAt: native.finishedAt, sessionCompleted: true,
  logsCollected: ['result.json', ...native.steps.map(step => step.name + '.log')], sshClosed: true });
writeFileSync(path, JSON.stringify(metadata, null, 2) + '\n');
console.log(JSON.stringify({ status: native.status, finishedAt: native.finishedAt, cleanup }));
