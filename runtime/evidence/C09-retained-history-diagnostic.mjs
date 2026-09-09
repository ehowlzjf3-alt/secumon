// Observe only synthetic workflow status in the existing bounded 544-event fixture.
import { WorkflowRuntime } from '../dist/application/workflow-runtime.js';
const original = WorkflowRuntime.prototype.run;
WorkflowRuntime.prototype.run = async function (...args) {
  const result = await original.apply(this, args);
  const state = await this.services.state.get(args[0]);
  console.log(JSON.stringify({ diagnostic: 'retained_history_wait', control: result.control, status: state.status, reason: state.statusReason,
    attempts: state.attempts.map(a => ({ taskId: a.taskId, status: a.status, adopted: a.adopted })),
    obligations: state.obligations.map(o => ({ id: o.id, status: o.status, wakeKey: o.wakeKey })),
    budget: state.budget.used, progress: state.progress }));
  return result;
};
