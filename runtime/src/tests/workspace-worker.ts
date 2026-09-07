import { FileWorkspaceStore } from '../infrastructure/file-workspaces.js';

const root = process.argv[2]; if (!root) throw new Error('workspace_root_missing');
const store = new FileWorkspaceStore(root);
process.once('message', async (value: { content: string }) => {
  try {
    const file = await store.stage('work', 'attempt', 'report.txt', Buffer.from(value.content), { tenantId: 'tenant-a', labels: ['synthetic'], lifecycleGeneration: 0 });
    process.send!({ type: 'result', stored: true, file }, () => process.disconnect());
  } catch (error) {
    process.send!({ type: 'result', stored: false, code: error instanceof Error ? error.message : 'workspace_failure' }, () => process.disconnect());
  }
});
process.send!({ type: 'ready' });
