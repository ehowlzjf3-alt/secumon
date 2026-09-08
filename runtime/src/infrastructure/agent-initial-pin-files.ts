import { join } from 'node:path';
import { AgentSetupOperationSchema } from '../application/agent-profile-contracts.js';
import type { EnginePin } from '../application/agent-lifecycle-contracts.js';
import { lifecycleFail, lifecycleNames } from './agent-lifecycle-files.js';
import { readProfileBytes, readProfileJson } from './agent-profile-files.js';
import { FileBoundaryFault, hostMetadataFiles, releaseMetadataDirectory, sameFileIdentity } from './host-metadata-files.js';

export const initialEnginePinBytes = (pin: EnginePin) => Buffer.from(JSON.stringify(pin, null, 2) + '\n');

/** Only an exact schema-3 first-pin candidate can survive an interrupted initial publication. */
export function initialEnginePinHistoryNames(root: string, names: string[]): string[] {
  let pending = names.filter(name => /^\.secumon-init-[a-f0-9-]+\.pending$/.test(name));
  if (!pending.length) return names;
  const operation = readProfileJson(join(root, '.secumon', 'setup-operation.json'), AgentSetupOperationSchema, [1, 2, 3], 512 * 1024);
  if (operation?.schemaVersion !== 3) return lifecycleFail('engine_pin_history_invalid');
  const expected = initialEnginePinBytes(operation.initialEngine.pin);
  const files = hostMetadataFiles(), folder = files.inspectDirectory(join(root, '.secumon', 'engine-pins'), 'private');
  if (!folder) return lifecycleFail('engine_pin_history_invalid');
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        for (const name of pending) {
          const bytes = files.readStableRegularFile(folder, name, { maximum: 65536, access: 'private',
            allowLinkedFile: (candidate, siblings) => {
              const published = siblings.inspect('00000001.json');
              return candidate.links === 2n && published?.kind === 'regular' && published.links === 2n &&
                sameFileIdentity(candidate.identity, published.identity);
            } });
          if (!bytes.equals(expected)) lifecycleFail('engine_pin_history_invalid');
        }
        break;
      } catch (error) {
        if (attempt !== 0 || !(error instanceof FileBoundaryFault) || error.code !== 'missing') throw error;
        // The publishing peer can remove its temporary link between listing and reading it.
        names = lifecycleNames(join(root, '.secumon', 'engine-pins'), 1025);
        if (names.length > 1024) lifecycleFail('engine_pin_limit');
        pending = names.filter(name => /^\.secumon-init-[a-f0-9-]+\.pending$/.test(name));
      }
    }
    if (names.includes('00000001.json') && !readProfileBytes(join(root, '.secumon', 'engine-pins', '00000001.json'), 65536)?.equals(expected))
      lifecycleFail('engine_pin_history_invalid');
    if (!files.inspectDirectory(join(root, '.secumon', 'engine-pins'), 'private', folder)) lifecycleFail('engine_pin_history_invalid');
    return names.filter(name => !pending.includes(name));
  } finally { releaseMetadataDirectory(files, folder); }
}
