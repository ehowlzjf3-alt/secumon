import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { verifyEvaluationBuild } from '../dist/infrastructure/local-evaluation.js';
import { parseTestSummary, assertLocalResult, assertLocalStageObservation } from './C04-goal-linux-nas-20260907/goal-c04-common.mjs';

const observations = JSON.parse(readFileSync('evidence/C04-goal-tool-exit-observations.json', 'utf8'));
const pin = await verifyEvaluationBuild(process.cwd());
const build = JSON.parse(readFileSync('evidence/C04-goal-build4.json', 'utf8'));
assert.equal(build.exitCode, 0); assert.deepEqual(build.buildAfter, pin);
assert.equal(build.sourceBefore, pin.sourceDigest); assert.equal(build.sourceAfter, pin.sourceDigest);
const pinPath = 'evidence/C04-goal-local-build4-pin.json';
writeFileSync(pinPath, JSON.stringify(pin, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
for (const [name, stage] of [['new', 'new4'], ['related', 'related1']]) {
  const runnerPath = `evidence/C04-goal-${stage}.json`, logPath = `evidence/C04-goal-${stage}.log`;
  const actual = JSON.parse(readFileSync(runnerPath, 'utf8')), log = readFileSync(logPath, 'utf8');
  const observed = observations.executions.find(item => item.stage === stage);
  assert.ok(observed); assert.equal(observed.exitCode, 0); assert.equal(actual.exitCode, 0);
  const counts = parseTestSummary(log);
  assert.equal(counts.fail, 0); assert.equal(counts.cancelled, 0);
  const duration = [...log.matchAll(/^(?:#|ℹ) duration_ms ([\d.]+)$/gm)].at(-1)?.[1]; assert.ok(duration);
  const result = { code: 0, signal: actual.signal, timedOut: actual.timedOut === true,
    testNode: actual.node, sourceAndBuild: pin, counts, logPath, durationMs: Number(duration),
    startedAt: actual.startedAt, finishedAt: actual.finishedAt, timestampMeaning: 'child_exit_then_log_close_observed_by_stage_runner',
    processEvidence: { kind: 'exec_tool_and_stage_child_exit', sessionId: observed.sessionId,
      childPid: actual.pid, exitCode: observed.exitCode, path: 'evidence/C04-goal-tool-exit-observations.json' },
    sourceObservation: { kind: 'per_run_source_and_build_verification', perRunBeforeCaptured: true,
      pinPath, buildLogPath: 'evidence/C04-goal-build4.log', before: actual.buildBefore, after: actual.buildAfter, runnerPath },
    evidence: [[logPath, 'original_test_log'], [runnerPath, 'original_stage_runner_observation'],
      [pinPath, 'verified_final_build_pin'], ['evidence/C04-goal-build4.log', 'successful_build_log'],
      ['evidence/C04-goal-tool-exit-observations.json', 'recorded_exec_exit_observations']]
      .map(([path, role]) => ({ path, role, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })),
  };
  assertLocalResult(result, pin); assertLocalStageObservation(result, pin, actual);
  writeFileSync(`evidence/C04-goal-${name}-result.json`, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ name, counts, sourceAndBuild: pin }));
}
