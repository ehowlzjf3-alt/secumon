import { WorkflowRuntime } from '../dist/application/workflow-runtime.js';

// Read-only observations of the unchanged build2 execution. This does not change control or state.
const run = WorkflowRuntime.prototype.run;
WorkflowRuntime.prototype.run = async function (...args) {
  const result = await run.apply(this, args);
  const state = await this.execution.state(args[0]);
  if (state.conversation) process.stderr.write(JSON.stringify({ diagnostic: 'return-progress', workId: state.id,
    control: result.control, progress: state.progress, task: state.plan?.tasks.map(t => ({ id: t.id, toolId: t.toolId })),
    attempts: state.attempts.map(a => ({ id: a.id, taskId: a.taskId, status: a.status, adopted: a.adopted, error: a.error })),
    calls: state.modelCalls.map(c => ({ id: c.id, status: c.status, reason: c.reason, outcome: c.outcome })),
    grants: state.budgetGrants }) + '\n');
  return result;
};
