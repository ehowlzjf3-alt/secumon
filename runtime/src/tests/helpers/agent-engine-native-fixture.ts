import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_ENGINE_NATIVE_PATH } from '../../infrastructure/agent-engine-native.js';

/** Metadata engine fixtures use the actual host-built addon, never a fake native implementation. */
export function copyAgentEngineNativeFixture(engine: string): void {
  const source = fileURLToPath(new URL('../../../native/windows-files/secumon_windows_files.node', import.meta.url));
  const target = join(engine, AGENT_ENGINE_NATIVE_PATH);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, readFileSync(source), { mode: 0o600, flag: 'wx' });
}
