import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
export const directory = 'evidence/C03-migration-linux-nas-20260907';
export const root = '/home/shaneee/secumon-linux-test.pCJ0bd';
export function assertPin(pin) {
  assert.ok(pin && /^[a-f0-9]{64}$/.test(pin.sourceDigest) && /^[a-f0-9]{64}$/.test(pin.filesDigest) && Number.isSafeInteger(pin.fileCount) && pin.fileCount > 0);
  return pin;
}
export function controlPath() {
  const path = readFileSync(directory + '/control-directory.txt', 'utf8').trim(), stat = lstatSync(path);
  assert.ok(isAbsolute(path) && stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700 && stat.uid === process.getuid());
  const canonical = realpathSync(path);
  assert.ok(lstatSync(join(canonical, 'control')).isSocket()); return { directory: canonical, socket: join(canonical, 'control') };
}
export function remoteJson(fn, args = []) {
  const control = controlPath();
  return JSON.parse(execFileSync('ssh', ['-S', control.socket, 'nas', '/usr/bin/env -i PATH=/usr/bin:/bin ' + root + '/node-v24.20.0-linux-x64/bin/node --input-type=module'],
    { input: 'const auditRoot = (' + auditRoot.toString() + '); console.log(JSON.stringify(await (' + fn.toString() + ')(...' + JSON.stringify(args) + ')));',
      encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 }));
}
/** All comm names; only observable same-UID exe/cwd paths establish ownership. */
export async function auditRoot(root) {
  const fs = await import('node:fs'), { execFileSync } = await import('node:child_process');
  const inside = value => value === root || value.startsWith(root + '/');
  const transient = error => ['ENOENT', 'ESRCH'].includes(error?.code);
  const observedProcesses = [], inaccessiblePeers = [], unresolved = [], auditErrors = [];
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
      const owned = Object.values(paths).some(inside);
      if (unavailableFields.length) {
        inaccessiblePeers.push({ pid, visiblePaths: paths, unavailableFields, scope: owned ? 'observed_owned' : 'unresolved' });
        if (!owned) unresolved.push({ pid, visiblePaths: paths, unavailableFields, reason: 'scope_not_proven_from_accessible_paths' });
      }
      if (owned) observedProcesses.push({ pid, ...paths, unavailableFields });
    } catch (error) { if (!transient(error)) auditErrors.push({ pid, field: 'process_owner', code: error.code ?? error.name }); }
  }
  const ownedPids = observedProcesses.map(item => item.pid).sort((a, b) => a - b);
  return { at: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
    realRoot: fs.realpathSync(root), rootMode: (fs.statSync(root).mode & 0o777).toString(8),
    observedOwnedProcesses: ownedPids.length, ownedProcesses: ownedPids.length, ownedPids, observedProcesses,
    inaccessiblePeers, unresolved, auditErrors, globalProcessAbsenceProven: false,
    processAuditScope: 'Same-UID observable exe/cwd inside dedicated root, excluding this audit process; inaccessible peers remain unresolved. No comm/cmdline/environ filter or read.',
    defaultNode: execFileSync('/usr/bin/node', ['--version'], { encoding: 'utf8' }).trim(),
    filesystem: execFileSync('/usr/bin/findmnt', ['--target', root, '--noheadings', '--output', 'FSTYPE,OPTIONS'], { encoding: 'utf8' }).trim() };
}
export function requireCleanAudit(audit) {
  assert.equal(audit.platform, 'linux'); assert.equal(audit.node, 'v24.20.0'); assert.equal(audit.realRoot, root);
  assert.equal(audit.rootMode, '700'); assert.equal(audit.defaultNode, 'v18.20.4');
  assert.deepEqual(audit.auditErrors, []); assert.equal(audit.observedOwnedProcesses, 0);
}
