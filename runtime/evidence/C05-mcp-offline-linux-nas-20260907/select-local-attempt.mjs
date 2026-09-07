// Select existing successful stages; never runs a build, test, NAS helper or SSH command.
// From runtime with Node 24:
// node evidence/C05-mcp-offline-linux-nas-20260907/select-local-attempt.mjs 2 evidence/C05-mcp-offline-stage-selection-attempt2.json evidence/C05-mcp-offline-terminal-input-attempt2.json
// Derived from the retained initial selector; writes only one explicit native retry namespace.
// First file: {build:"buildN",new:"newN",related:"relatedN",core:"coreN",architecture:"architectureN"}
// Second file: {executions:[{stage,sessionId,exitCode}],synchronous?:[{stage,exitCode}],observedAt?:string,source?:string}
// Supply only actual unified-exec terminal observations. Never infer a sessionId or success from a log.
// Reuses C04-goal-record-local.mjs's wire shape without importing the NAS common module,
// which requires an operator-created SSH configuration even for its pure validation helpers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyEvaluationBuild } from '../../dist/infrastructure/local-evaluation.js';

assert.ok(/^v24\./.test(process.version), 'use the actual Node 24 build runtime');
const runtime = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
assert.equal(realpathSync(process.cwd()), runtime, 'run from runtime');
assert.equal(process.argv.length, 5, 'explicit attempt, stage selection and terminal observations JSON file paths required');
assert.match(process.argv[2], /^[2-9]$/, 'native retry attempt must be 2 through 9');
const attempt = Number(process.argv[2]);
const directory = 'evidence/C05-mcp-offline-linux-nas-20260907';
const selectorPath = directory + '/select-local-attempt.mjs';
const baselineSelectorPath = directory + '/select-local.mjs';
const previousDirectory = directory + '/attempt-' + (attempt - 1);
const previousCollectionPath = directory + '/attempt-' + (attempt - 1) + '-collection.json';
const nativeSteps = ['build', 'new-mcp-offline-tests', 'related-existing-tests', 'typecheck-core', 'architecture', 'architecture-cli-fixtures', 'all-tests', 'fixtures'];
const previousFilePaths = new Set(['result.json', ...nativeSteps.map(name => name + '.log')].map(name => previousDirectory + '/' + name));
const suppliedInputs = process.argv.slice(3).map(path => {
  assert.ok(/^evidence\/C05-mcp-offline-[a-zA-Z0-9-]+\.json$/.test(path), 'bounded local recovery input path required');
  const absolute = resolve(runtime, path), stat = lstatSync(absolute);
  assert.equal(realpathSync(absolute), absolute); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32768);
  const bytes = readFileSync(absolute); assert.ok(bytes.length <= 32768);
  return { path, value: JSON.parse(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
});
assert.notEqual(suppliedInputs[0].path, suppliedInputs[1].path);
const selected = suppliedInputs[0].value, supplied = suppliedInputs[1].value;
const roles = ['build', 'new', 'related', 'core', 'architecture'];
const strictObject = (value, keys) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
strictObject(selected, roles);
for (const role of roles) assert.ok(new RegExp('^' + role + '[1-9][0-9]*$').test(selected[role]), 'explicit numbered stage required: ' + role);
assert.equal(new Set(Object.values(selected)).size, roles.length);
strictObject(supplied, ['executions', ...['synchronous', 'observedAt', 'source'].filter(key => Object.hasOwn(supplied ?? {}, key))]);
if (supplied.observedAt !== undefined) assert.ok(typeof supplied.observedAt === 'string' && Number.isFinite(Date.parse(supplied.observedAt)));
if (supplied.source !== undefined) assert.ok(typeof supplied.source === 'string' && supplied.source.trim().length > 0 && supplied.source.length <= 2048);
const executions = supplied.executions, synchronous = supplied.synchronous ?? [];
assert.ok(Array.isArray(executions) && Array.isArray(synchronous));
assert.equal(executions.length + synchronous.length, roles.length, 'provide exactly the selected terminal observations');
for (const item of executions) {
  strictObject(item, ['stage', 'sessionId', 'exitCode']);
  assert.ok(Number.isSafeInteger(item.sessionId) && item.sessionId > 0, 'actual unified exec sessionId required');
}
for (const item of synchronous) strictObject(item, ['stage', 'exitCode']);
const observations = [...executions, ...synchronous];
assert.equal(new Set(observations.map(item => item.stage)).size, roles.length, 'duplicate stage observation');
for (const item of observations) {
  assert.ok(Object.values(selected).includes(item.stage), 'unselected observation');
  assert.equal(item.exitCode, 0, 'only terminal success may be selected');
}
for (const role of ['new', 'related']) assert.ok(executions.some(item => item.stage === selected[role]), 'new/related require actual sessionId for NAS aliases');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const inputs = new Map(suppliedInputs.map(({ path, sha256 }) => [path, { path, sha256 }]));
function read(path, maximum = 2 * 1024 * 1024) {
  assert.ok(/^evidence\/C05-mcp-offline-[a-zA-Z0-9-]+\.(json|log|mjs)$/.test(path) ||
    path === selectorPath || path === baselineSelectorPath || path === previousCollectionPath || previousFilePaths.has(path), 'fixed local evidence path required');
  const absolute = resolve(runtime, path), stat = lstatSync(absolute);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum);
  assert.equal(realpathSync(absolute), absolute);
  const bytes = readFileSync(absolute); assert.ok(bytes.length <= maximum);
  const digest = sha256(bytes);
  if (inputs.has(path)) assert.equal(inputs.get(path).sha256, digest, 'original evidence changed during selection');
  inputs.set(path, { path, sha256: digest });
  return bytes;
}
// Local collected evidence proves the preceding native attempt has finished in failure.
// Do not import NAS common/configuration or inspect a live remote process here.
const previousResultPath = previousDirectory + '/result.json';
const previous = JSON.parse(read(previousResultPath).toString('utf8'));
const collection = JSON.parse(read(previousCollectionPath).toString('utf8'));
assert.equal(previous.status, 'failed', 'preceding native attempt must be a terminal failure');
assert.ok(Number.isFinite(Date.parse(previous.startedAt)) && Number.isFinite(Date.parse(previous.finishedAt)) &&
  Date.parse(previous.finishedAt) >= Date.parse(previous.startedAt), 'preceding native attempt has no valid terminal interval');
assert.equal(collection.status, 'failed'); assert.equal(collection.finishedAt, previous.finishedAt);
assert.ok(Number.isFinite(Date.parse(collection.collectedAt)) && Date.parse(collection.collectedAt) >= Date.parse(previous.finishedAt));
assert.deepEqual(collection.sourceAndBuild, previous.buildPin);
assert.ok(previous.buildPin && /^[a-f0-9]{64}$/.test(previous.buildPin.sourceDigest) &&
  /^[a-f0-9]{64}$/.test(previous.buildPin.filesDigest) && Number.isSafeInteger(previous.buildPin.fileCount) && previous.buildPin.fileCount > 0);
assert.ok(Array.isArray(previous.steps) && previous.steps.length <= nativeSteps.length &&
  previous.steps.every(step => step && nativeSteps.includes(step.name)) && new Set(previous.steps.map(step => step.name)).size === previous.steps.length);
assert.ok(Array.isArray(collection.files));
const previousNames = ['result.json', ...previous.steps.map(step => step.name + '.log')];
assert.deepEqual(collection.files.map(item => item.file).sort(), [...previousNames].sort(), 'preceding native raw-log collection is incomplete');
for (const item of collection.files) {
  assert.ok(/^[a-f0-9]{64}$/.test(item.sha256));
  read(previousDirectory + '/' + item.file, 128 * 1024 * 1024);
  assert.equal(inputs.get(previousDirectory + '/' + item.file).sha256, item.sha256, 'preceding native evidence changed');
}
read(baselineSelectorPath);
assert.equal(inputs.get(baselineSelectorPath).sha256, 'fef3301375d8edab037c186ac055571c232358d62b8f2a5816153a423a71f98c', 'retained initial selector changed');
const priorFailureEvidence = [previousCollectionPath, ...previousNames.map(name => previousDirectory + '/' + name)];
const priorFailedAttempt = { attempt: attempt - 1, status: previous.status, startedAt: previous.startedAt, finishedAt: previous.finishedAt,
  sourceAndBuild: previous.buildPin, result: inputs.get(previousResultPath), collection: inputs.get(previousCollectionPath),
  meaning: 'Collected preceding native failure is historical evidence, not success for the new source.' };

const pin = await verifyEvaluationBuild(runtime);
const stagePath = stage => `evidence/C05-mcp-offline-${stage}.json`;
const logPath = stage => `evidence/C05-mcp-offline-${stage}.log`;
const stages = Object.fromEntries(roles.map(role => {
  const stage = selected[role], actual = JSON.parse(read(stagePath(stage)).toString('utf8'));
  const log = read(logPath(stage), 128 * 1024 * 1024).toString('utf8');
  assert.equal(actual.stage, stage); assert.equal(actual.exitCode, 0); assert.equal(actual.signal, null);
  assert.equal(actual.status, 'passed'); assert.equal(actual.timedOut, false); assert.equal(actual.node, process.version);
  assert.equal(actual.terminationReason, undefined); assert.deepEqual(actual.errors, []); assert.deepEqual(actual.signals, []);
  assert.equal(actual.groupAbsentConfirmed, true); assert.equal(actual.finalGroupState, 'absent'); assert.equal(actual.logCloseCompleted, true);
  assert.equal(actual.settlementReason, 'child_closed_and_group_absent'); assert.equal(actual.processGroup, actual.pid);
  for (const point of [actual.leaderExit, actual.stdioClose]) {
    assert.equal(point?.code, 0); assert.equal(point.signal, null);
    assert.ok(Number.isFinite(Date.parse(point.at)) && Date.parse(point.at) >= Date.parse(actual.startedAt) && Date.parse(point.at) <= Date.parse(actual.finishedAt));
  }
  assert.ok(Date.parse(actual.stdioClose.at) >= Date.parse(actual.leaderExit.at));
  assert.equal(actual.deadlineMs, ['new', 'related'].includes(role) ? 300000 : 180000);
  assert.ok(Number.isSafeInteger(actual.pid) && actual.pid > 0);
  assert.ok(Number.isFinite(Date.parse(actual.startedAt)) && Date.parse(actual.finishedAt) >= Date.parse(actual.startedAt));
  assert.equal(actual.sourceUnchanged, true); assert.equal(actual.sourceBefore, pin.sourceDigest); assert.equal(actual.sourceAfter, pin.sourceDigest);
  assert.ok(Array.isArray(actual.args) && actual.args.every(value => typeof value === 'string'));
  assert.ok(typeof actual.command === 'string');
  if (['build', 'core', 'architecture'].includes(role)) {
    assert.equal(basename(actual.command), 'npm');
    assert.deepEqual(actual.args, ['run', { build: 'build', core: 'typecheck:core', architecture: 'check:architecture' }[role]]);
  } else {
    assert.equal(basename(actual.command), 'node');
    assert.equal(actual.args[0], '--test'); assert.match(actual.args[1], /^--test-concurrency=[12]$/);
    assert.equal(actual.args[2], '--test-timeout=60000');
    const explicitReporter = actual.args[3]?.startsWith('--test-reporter=');
    if (explicitReporter) assert.equal(actual.args[3], '--test-reporter=tap');
    assert.ok(actual.args.slice(explicitReporter ? 4 : 3).every(value => /^dist\/tests\/[a-z0-9-]+\.test\.js$/.test(value)), 'only explicit selected test files may follow fixed test options');
    assert.deepEqual(actual.buildBefore, pin);
    const files = actual.args.filter(value => /^dist\/tests\/[a-z0-9-]+\.test\.js$/.test(value));
    assert.ok(files.length > 0 && new Set(files).size === files.length, 'explicit unique test files required');
  }
  if (['build', 'new', 'related'].includes(role)) assert.deepEqual(actual.buildAfter, pin);
  return [role, { actual, log }];
}));
if (supplied.observedAt !== undefined) assert.ok(roles.every(role => Date.parse(supplied.observedAt) >= Date.parse(stages[role].actual.finishedAt)), 'terminal observations must follow all selected child completions');
const newFiles = stages.new.actual.args.filter(value => value.startsWith('dist/tests/'));
const relatedFiles = stages.related.actual.args.filter(value => value.startsWith('dist/tests/'));
assert.equal(newFiles.some(file => relatedFiles.includes(file)), false, 'new and related files overlap');
const listPaths = ['evidence/C05-mcp-offline-new-files.json', 'evidence/C05-mcp-offline-related-files.json'];
const selectedLists = listPaths.map(path => JSON.parse(read(path).toString('utf8')));
for (const [actual, expected] of [[newFiles, selectedLists[0]], [relatedFiles, selectedLists[1]]]) {
  assert.ok(Array.isArray(expected) && expected.length > 0 && new Set(expected).size === expected.length);
  assert.deepEqual([...actual].sort(), [...expected].sort(), 'executed file set differs from the prepared selection');
}

// Same TAP/spec summary contract used by mcp-offline-c05-common; no NAS configuration is opened.
function summary(raw) {
  const text = raw.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => {
    const matches = [...text.matchAll(new RegExp('^(?:#|ℹ) ' + key + ' (\\d+)\\r?$', 'gm'))];
    assert.equal(matches.length, 1, 'exactly one final test summary required: ' + key); return [key, Number(matches[0][1])];
  }));
  assert.ok(counts.tests > 0); assert.equal(counts.tests, counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo);
  assert.equal(counts.pass, counts.tests); for (const key of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(counts[key], 0);
  assert.equal(/failureType:\s*['"]?testTimeoutFailure\b/.test(text), false);
  const duration = [...text.matchAll(/^(?:#|ℹ) duration_ms ([\d.]+)\r?$/gm)].at(-1)?.[1];
  assert.ok(duration !== undefined && Number.isFinite(Number(duration)) && Number(duration) >= 0, 'actual duration summary required');
  return { counts, durationMs: Number(duration) };
}
const summaries = { new: summary(stages.new.log), related: summary(stages.related.log) };
const pinPath = `${directory}/local-attempt${attempt}-${selected.build}-pin.json`;
const processPath = `${directory}/tool-exit-observations-attempt${attempt}.json`;
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const prepared = new Map([[pinPath, encode(pin)]]);
read('evidence/C05-mcp-offline-run.mjs'); read(selectorPath);
prepared.set(processPath, encode({ recordedAt: new Date().toISOString(),
  meaning: 'Root-supplied actual unified-exec terminal observations, not inferred from stage logs. Stage finishedAt means child exit followed by log close observed by the stage runner, not the exact OS exit time.',
  executions, synchronous, selectedStages: selected,
  nativeRetrySelection: { attempt, priorFailedAttempt, baselineSelector: inputs.get(baselineSelectorPath) },
  ...(supplied.observedAt === undefined ? {} : { operatorObservedAt: supplied.observedAt }),
  ...(supplied.source === undefined ? {} : { operatorObservationSource: supplied.source }),
  suppliedInputFiles: suppliedInputs.map(({ path, sha256 }) => ({ path, sha256 })),
  stageEvidence: roles.flatMap(role => [inputs.get(stagePath(selected[role])), inputs.get(logPath(selected[role]))]),
  helperSourceObservation: { meaning: 'Read at selection time; not claimed captured before each stage.',
    files: [inputs.get('evidence/C05-mcp-offline-run.mjs'), inputs.get(selectorPath), inputs.get(baselineSelectorPath)] } }));
for (const role of ['new', 'related']) {
  const stage = selected[role], actual = stages[role].actual, observed = executions.find(item => item.stage === stage);
  const evidence = [[logPath(stage), 'original_test_log'], [stagePath(stage), 'original_stage_runner_observation'],
    [pinPath, 'verified_final_build_pin'], [logPath(selected.build), 'successful_build_log'],
    [stagePath(selected.build), 'successful_build_stage_observation'], [processPath, 'recorded_exec_exit_observations'],
    [suppliedInputs[0].path, 'operator_selected_stage_input'], [suppliedInputs[1].path, 'operator_terminal_observation_input'],
    [listPaths[0], 'selected_new_test_files'], [listPaths[1], 'selected_related_test_files'],
    [selectorPath, 'retry_alias_selector_source'], [baselineSelectorPath, 'retained_initial_selector_source'],
    ...priorFailureEvidence.map(path => [path, 'preceding_failed_native_evidence']),
    ...['core', 'architecture'].flatMap(key => [[logPath(selected[key]), 'successful_' + key + '_log'],
      [stagePath(selected[key]), 'successful_' + key + '_stage_observation']])]
    .map(([path, role]) => ({ path, role, sha256: prepared.has(path) ? sha256(prepared.get(path)) : inputs.get(path).sha256 }));
  prepared.set(`${directory}/local-attempt${attempt}-${role}-result.json`, encode({ code: actual.exitCode, signal: actual.signal,
    // The new stage runner records an explicit false; a missing timeout field was rejected above.
    timedOut: actual.timedOut, testNode: actual.node, sourceAndBuild: pin, ...summaries[role], logPath: logPath(stage),
    startedAt: actual.startedAt, finishedAt: actual.finishedAt, timestampMeaning: 'child_exit_then_log_close_observed_by_stage_runner',
    exactFinishedAtCaptured: false,
    processEvidence: { kind: 'exec_tool_and_stage_child_exit', sessionId: observed.sessionId,
      childPid: actual.pid, exitCode: observed.exitCode, path: processPath },
    sourceObservation: { kind: 'per_run_source_and_build_verification', perRunBeforeCaptured: true, pinPath,
      buildLogPath: logPath(selected.build), before: actual.buildBefore, after: actual.buildAfter, runnerPath: stagePath(stage) }, evidence }));
}
// Validate every input and destination before the first write. I/O interruption can still leave
// a partial set of immutable outputs; preserve them for inspection rather than auto-overwriting.
for (const path of prepared.keys()) assert.equal(existsSync(path), false, 'selected output already exists: ' + path);
assert.deepEqual(await verifyEvaluationBuild(runtime), pin);
for (const [path, entry] of inputs) assert.equal(sha256(readFileSync(path)), entry.sha256, 'original evidence changed before publication');
for (const [path, bytes] of prepared) writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ status: 'selected_existing_successes', attempt, priorFailedAttempt, outputs: [...prepared.keys()], sourceAndBuild: pin,
  newTests: summaries.new.counts, relatedTests: summaries.related.counts, testsExecuted: false, sshUsed: false }));
