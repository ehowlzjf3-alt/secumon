import { fileURLToPath } from 'node:url';
import { FileAgentProfileStore } from '../dist/infrastructure/file-agent-profile.js';
import { applyAgentRestoreRecovery } from '../dist/infrastructure/agent-restore-recovery-apply.js';
const [recoveryDirectory, expectedDigest, registryDirectory, phase] = process.argv.slice(2);
const root = fileURLToPath(new URL('../', import.meta.url));
await applyAgentRestoreRecovery(new FileAgentProfileStore(root), { recoveryDirectory, expectedDigest, offline: true },
  { registryDirectory, engineDirectories: [root] }, { onProgress(current) {
    if (current === phase) process.kill(process.pid, 'SIGKILL');
  } });
throw new Error('requested crash phase was not reached');
