import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { windowFixture } from '../dist/tests/session-window-helpers.js';

const cleanup = [], report = { kind: 'bounded_synthetic_fixture_diagnostic', node: process.version,
  source: 'existing build only; no build or test runner', files: {}, stages: [], cleanup: false };
for (const relative of ['./C04-window-fixture-diagnostic.mjs', '../dist/tests/session-window-helpers.js',
  '../dist/application/session-compactor.js', '../dist/application/planning-runtime.js']) {
  report.files[relative] = createHash('sha256').update(readFileSync(new URL(relative, import.meta.url))).digest('hex');
}
try {
  const f = await windowFixture({ after: fn => cleanup.push(fn) }, 17);
  f.planner.estimateCompactInput = (input, options) => ({ tokens: input.entries.length * 10000,
    bytes: Buffer.byteLength(JSON.stringify({ compact: input, options })), method: 'synthetic_entry_window' });
  const source = f.services.sessionCompacts, publish = source.publishCompact.bind(source);
  source.publishCompact = async (...args) => {
    try { return await publish(...args); }
    catch (error) { report.stages.push({ phase: 'publish_error', message: error.message, stack: error.stack }); throw error; }
  };
  const call = await f.compactPlanning.requestCompact(f.workId, { force: true, requestId: 'reduced-once' });
  report.stages.push({ phase: 'reserved', call });
  await f.compactPlanning.execute(f.workId, call.id);
  let state = await f.current(), current = state.modelCalls.find(value => value.id === call.id);
  report.stages.push({ phase: 'executed', call: current, workStatus: state.status,
    reply: current.replyArtifact ? JSON.parse(Buffer.from(await f.services.artifacts.get(current.replyArtifact, state.policy)).toString()) : null });
  const adopted = await f.compactPlanning.adopt(f.workId, call.id);
  state = await f.current();
  report.stages.push({ phase: 'adopted', adopted, call: state.modelCalls.find(value => value.id === call.id), workStatus: state.status });
} catch (error) { report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  for (const fn of cleanup.reverse()) await fn();
  report.cleanup = true;
  writeFileSync(new URL('./C04-window-fixture-diagnostic.json', import.meta.url), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ output: fileURLToPath(new URL('./C04-window-fixture-diagnostic.json', import.meta.url)),
    cleanup: report.cleanup, stages: report.stages.map(({ phase, adopted, call, reply, message }) =>
      ({ phase, adopted, status: call?.status, reason: call?.reason, reply, message })), error: report.error }, null, 2));
}
