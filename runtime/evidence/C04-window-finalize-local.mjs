import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';

const pin = await verifyEvaluationBuild(process.cwd());
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const pinPath = 'evidence/C04-window-local-build2-pin.json', buildLogPath = 'evidence/C04-window-build2.log';
save(pinPath, pin);
save('evidence/C04-window-local-build2-manifest.json', read('dist/build-manifest.json'));
const processPath = 'evidence/C04-window-tool-exit-observations.json';
save(processPath, { recordedAt: new Date().toISOString(), source: 'Visible exec/write_stdin terminal results; child timing and pid are separately recorded by the stage runner',
  observations: [{ sessionId: 13370, exitCode: 0, logPath: 'evidence/C04-window-new3.log' },
    { sessionId: 76952, exitCode: 0, logPath: 'evidence/C04-window-related1.log' },
    { sessionId: 90667, exitCode: 0, logPath: buildLogPath }] });
for (const [name, stage, sessionId] of [['new', 'new3', 13370], ['related', 'related1', 76952]]) {
  const rawPath = `evidence/C04-window-${stage}.json`, raw = read(rawPath), logPath = `evidence/C04-window-${stage}.log`;
  assert.equal(raw.exitCode, 0); assert.equal(raw.signal, null); assert.notEqual(raw.timedOut, true);
  assert.equal(raw.sourceUnchanged, true); assert.deepEqual(raw.buildBefore, pin); assert.deepEqual(raw.buildAfter, pin);
  assert.equal(raw.node, process.version);
  const text = readFileSync(logPath, 'utf8');
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => {
    const match = [...text.matchAll(new RegExp('^(?:#|ℹ) ' + key + ' (\\d+)\\r?$', 'gm'))].at(-1); assert.ok(match);
    return [key, Number(match[1])];
  }));
  assert.equal(counts.pass, counts.tests); assert.ok(counts.tests > 0);
  for (const key of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(counts[key], 0);
  const evidence = [[logPath, 'original_test_log'], [rawPath, 'original_stage_runner_observation'], [pinPath, 'verified_final_build_pin'],
    [buildLogPath, 'successful_build_log'], [processPath, 'recorded_exec_exit_observations']].map(([path, role]) =>
    ({ path, role, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
  save(`evidence/C04-window-${name}-result.json`, { code: 0, signal: null, timedOut: false, testNode: raw.node,
    sourceAndBuild: pin, counts, logPath, durationMs: Number(text.match(/(?:#|ℹ) duration_ms ([\d.]+)/)?.[1]),
    startedAt: raw.startedAt, finishedAt: raw.finishedAt, timestampMeaning: 'child_exit_then_log_close_observed_by_stage_runner',
    processEvidence: { kind: 'exec_tool_and_stage_child_exit', sessionId, childPid: raw.pid, exitCode: 0, path: processPath },
    sourceObservation: { kind: 'per_run_source_and_build_verification', perRunBeforeCaptured: true, pinPath, buildLogPath,
      before: raw.buildBefore, after: raw.buildAfter, runnerPath: rawPath }, evidence });
}
console.log(JSON.stringify({ pin, new: read('evidence/C04-window-new-result.json').counts, related: read('evidence/C04-window-related-result.json').counts }));
