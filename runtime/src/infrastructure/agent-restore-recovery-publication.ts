import { createHash } from 'node:crypto';
import { linkSync, lstatSync, unlinkSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { AgentRestoreRecoveryPublicationPinSchema, type AgentRestoreRecoveryPublicationPin } from '../application/agent-restore-recovery-apply-contracts.js';
import { completeMetadataPublication, hostMetadataFiles, sameFileIdentity, type MetadataDirectory } from './host-metadata-files.js';
import { openProfileMutationScope } from './agent-profile-files.js';
import { WindowsMetadataFiles } from './windows-metadata-files.js';
import { windowsPublicationResult } from './windows-stream-files.js';
import { lifecycleFail } from './agent-lifecycle-files.js';

const fail = (): never => lifecycleFail('agent_restore_recovery_gate_changed');
const maximum = 65536;
type Parent = { scope: ReturnType<typeof openProfileMutationScope>; directory: MetadataDirectory };

/** A single exact metadata file, staged outside the original tree. Never scans or adopts random candidates. */
function useFiles<T>(paths: readonly string[], action: (files: {
  read(path: string, peer?: string): { pin: AgentRestoreRecoveryPublicationPin; bytes: Buffer } | null;
  publish(source: string, target: string): void; sync(path: string): void; check(): void;
}) => T): T {
  const files = hostMetadataFiles(), parents = new Map<string, Parent>();
  const check = () => { for (const parent of parents.values()) parent.scope.check(); };
  const parent = (path: string) => { const found = parents.get(dirname(path)); if (!found) return fail(); check(); return found; };
  const inspect = (path: string) => {
    const owner = parent(path);
    if (files instanceof WindowsMetadataFiles) {
      const info = files.inspectChild(owner.directory, basename(path)); if (!info) return null;
      const match = /^([a-f0-9]{8}):([a-f0-9]{16})$/.exec(info.identity);
      if (!match || info.kind !== 'regular') return fail();
      return { identity: { volume: match[1]!, object: match[2]! }, links: 1n, size: BigInt(info.bytes), stamp: info.changeToken, native: info };
    }
    let stat;
    try { stat = lstatSync(path, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || typeof process.getuid !== 'function' || stat.uid !== BigInt(process.getuid()) ||
      (stat.mode & 0o177n) !== 0n) return fail();
    return { identity: { volume: String(stat.dev), object: String(stat.ino) }, links: stat.nlink, size: stat.size,
      stamp: [stat.dev, stat.ino, stat.size, stat.mode, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(':'), native: undefined };
  };
  let primary: { error: unknown } | undefined;
  try {
    for (const path of paths) {
      if (parents.has(dirname(path))) continue;
      const scope = openProfileMutationScope(dirname(path), []);
      try {
        const directory = scope.directory(dirname(path), 'owner-writable'); if (!directory) return fail();
        parents.set(dirname(path), { scope, directory });
      } catch (error) { scope.close(); throw error; }
    }
    return action({ check, sync(path) { completeMetadataPublication(files, parent(path).directory); check(); },
      read(path, peer) {
        const before = inspect(path); if (!before) return null;
        if (before.size > BigInt(maximum)) return fail();
        const bytes = files.readStableRegularFile(parent(path).directory, basename(path), { maximum, access: 'private',
          allowLinkedFile(file) {
            if (file.links !== 2n || !peer) return false;
            const other = inspect(peer);
            return other?.links === 2n && sameFileIdentity(other.identity, file.identity);
          } });
        const after = inspect(path); check();
        if (!after || after.stamp !== before.stamp || BigInt(bytes.length) !== before.size) return fail();
        return { bytes, pin: AgentRestoreRecoveryPublicationPinSchema.parse({ identity: before.identity, bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex') }) };
      },
      publish(source, target) {
        if (files instanceof WindowsMetadataFiles) {
          const current = inspect(source); if (!current?.native) return fail();
          const result = files.handle(parent(source).directory).publishExisting(basename(source), files.handle(parent(target).directory), basename(target), current.native);
          windowsPublicationResult(result);
          if (result.publication !== 'created' || result.fileFlush !== 'completed') fail();
        } else linkSync(source, target);
        check();
      },
    });
  } catch (error) { primary = { error }; throw error; }
  finally {
    const errors: unknown[] = [];
    for (const value of [...parents.values()].reverse()) try { value.scope.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError([...(primary ? [primary.error] : []), ...errors], 'agent_restore_recovery_gate_cleanup_failed');
  }
}
export function captureRestoreRecoveryPublication(path: string, expectedBytes: Buffer): AgentRestoreRecoveryPublicationPin {
  return useFiles([path], files => { const file = files.read(path); if (!file || !file.bytes.equals(expectedBytes)) return fail(); return file.pin; });
}
export function publishRestoreRecoveryGate(source: string, target: string, expected: AgentRestoreRecoveryPublicationPin, expectedBytes: Buffer): void {
  AgentRestoreRecoveryPublicationPinSchema.parse(expected);
  if (source === target) fail();
  useFiles([source, target], files => {
    const require = (file: ReturnType<typeof files.read>) => {
      if (!file || !sameFileIdentity(file.pin.identity, expected.identity) || file.pin.bytes !== expected.bytes ||
        file.pin.sha256 !== expected.sha256 || !file.bytes.equals(expectedBytes)) return fail();
    };
    const original = files.read(source, target), current = files.read(target, source);
    if (!original) { require(current); files.sync(target); return; }
    require(original); if (current) require(current); else files.publish(source, target);
    require(files.read(target, source)); files.sync(target);
    if (process.platform !== 'win32') {
      // Only this recorded staging alias may be unlinked, after both names prove the same original object and bytes.
      require(files.read(source, target)); require(files.read(target, source)); files.check(); unlinkSync(source);
    }
    files.sync(source); files.sync(target);
    if (files.read(source)) fail(); require(files.read(target));
  });
}
