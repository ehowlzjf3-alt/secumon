// Reads completed local test evidence. It does not run tests, start peers, or contact services.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const directory = path.join(__dirname, 'mcp-collections-final');
const logPath = path.join(__dirname, 'P3-mcp-collections-targeted-final.log');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = file => { const bytes = fs.readFileSync(file); return { path: 'runtime/' + path.relative(root, file), bytes: bytes.length, sha256: hash(bytes) }; };
const integer = (value, minimum = 0) => { assert.ok(Number.isSafeInteger(value) && value >= minimum, `invalid integer: ${String(value)}`); return value; };
const digest = value => assert.match(value, /^[a-f0-9]{64}$/);
const sum = (rows, value) => rows.reduce((total, row) => total + value(row), 0);
const sameIds = (actual, expected) => assert.deepEqual(actual, expected);
const events = (audit, name) => audit.filter(row => row.event === name);
const method = (audit, name) => audit.filter(row => row.event === 'method' && row.method === name);
const backends = ['sqlite', 'file-journal'];

function validateAudit(audit, expectedPid) {
  assert.ok(Array.isArray(audit)); integer(expectedPid, 1);
  const allowed = new Set(['start', 'method', 'call', 'handler-ready', 'response-sent', 'close']);
  for (const [index, row] of audit.entries()) {
    assert.equal(row.sequence, index + 1); assert.equal(row.pid, expectedPid); assert.ok(allowed.has(row.event), `unexpected audit event ${row.event}`);
  }
  assert.equal(events(audit, 'start').length, 1); assert.equal(audit[0].event, 'start');
  assert.equal(events(audit, 'close').length, 1); assert.equal(audit.at(-1).event, 'close');
  assert.equal(audit.at(-1).reason, 'stdin-ended');
  const calls = events(audit, 'call');
  assert.equal(method(audit, 'server/discover').length, 1); assert.equal(method(audit, 'tools/list').length, 1);
  assert.equal(method(audit, 'tools/call').length, calls.length);
  assert.equal(events(audit, 'method').length, calls.length + 2);
  assert.equal(events(audit, 'handler-ready').length, calls.length); assert.equal(events(audit, 'response-sent').length, calls.length);
  assert.equal(new Set(calls.map(row => row.requestId)).size, calls.length);
  for (const call of calls) {
    assert.ok(['documents.batch', 'observations.page'].includes(call.tool));
    assert.equal(typeof call.requestId, 'string'); assert.ok(call.requestId.length > 0);
    assert.deepEqual(Object.keys(call.query), ['ids']);
    assert.ok(Array.isArray(call.query.ids) && call.query.ids.length > 0 && call.query.ids.length <= 4);
    assert.equal(new Set(call.query.ids).size, call.query.ids.length);
    assert.ok(call.query.ids.every(id => ['a', 'b', 'c', 'd'].includes(id)));
    assert.ok(call.snapshot === null || /^mcpc-snapshot:[a-f0-9]{64}$/.test(call.snapshot));
    assert.ok(call.cursor === null || /^mcpc-cursor:[a-f0-9]{64}$/.test(call.cursor));
    if (call.retryIds !== null) {
      assert.ok(Array.isArray(call.retryIds) && call.retryIds.length > 0);
      assert.equal(new Set(call.retryIds).size, call.retryIds.length);
      assert.ok(call.retryIds.every(id => call.query.ids.includes(id)));
    }
    for (const event of ['handler-ready', 'response-sent']) {
      const responses = events(audit, event).filter(row => row.requestId === call.requestId); assert.equal(responses.length, 1);
      const response = responses[0];
      for (const key of ['tool', 'query', 'requestId', 'retryIds', 'snapshot', 'cursor']) assert.deepEqual(response[key], call[key]);
      if (event === 'handler-ready' || response.returnedIds !== undefined) {
        assert.ok(Array.isArray(response.returnedIds)); assert.equal(new Set(response.returnedIds).size, response.returnedIds.length);
        assert.ok(response.returnedIds.every(id => call.query.ids.includes(id)));
      } else {
        // Whole-tool isError is logged without a record list in response-sent; handler-ready explicitly records [].
        sameIds(events(audit, 'handler-ready').find(row => row.requestId === call.requestId).returnedIds, []);
      }
    }
  }
  return { pid: expectedPid, starts: 1, closes: 1, methods: calls.length + 2, calls, returned: events(audit, 'handler-ready').map(row => row.returnedIds) };
}

function validateTransport(transport, audit) {
  for (const name of ['generation', 'activeCalls', 'processStarts', 'processCloses', 'wireRequests', 'toolCalls', 'listPages', 'requestBytes', 'responseBytes', 'protocolErrors']) integer(transport[name]);
  assert.equal(transport.pid, null); assert.equal(transport.closed, true); assert.equal(transport.connected, false);
  assert.equal(transport.dirty, true); assert.equal(transport.activeCalls, 0); assert.equal(transport.discovering, false);
  assert.equal(transport.processStarts, 1); assert.equal(transport.processCloses, 1); assert.equal(transport.protocolErrors, 0);
  assert.equal(transport.toolCalls, audit.calls.length); assert.equal(transport.wireRequests, audit.methods);
  assert.equal(transport.listPages, 1); assert.ok(transport.requestBytes > 0 && transport.responseBytes > 0);
}

function integrationCase(row, audit) {
  const family = row.family;
  assert.ok(['documents', 'observations'].includes(family)); assert.ok(backends.includes(row.adapter));
  const cases = [
    ['normal', /^MCP collection (documents|observations) preserves individual raw pages and verifies offline$/, family === 'documents' ? 1 : 2, 'normal'],
    ['partial', /^MCP collection (documents|observations) resumes only partial items with original success unchanged$/, family === 'documents' ? 2 : 3, 'partial'],
    ['empty', /^MCP empty page is preserved and losing its original rejects the result$/, 3, 'empty'],
    ['snapshot-change', /^MCP collection rejects snapshot-change after keeping its first page$/, 2, 'snapshot-change'],
    ['cursor-loop', /^MCP collection rejects cursor-loop after keeping its first page$/, 2, 'cursor-loop'],
    ['error', /^MCP error does not become EOF or automatic retry$/, 1, 'error'],
    ['rate-limit', /^MCP rate-limit does not become EOF or automatic retry$/, 1, 'rate-limit'],
    ['raw-loss', /^MCP accepted raw response substitution blocks parent resume before sending$/, 1, 'partial'],
    ['query-change', /^MCP changed query cannot reuse a partial parent$/, 1, 'partial'],
    ['before-send', /^MCP authority change before-send prevents page acceptance$/, 0, 'normal'],
    ['after-reply', /^MCP authority change after-reply prevents page acceptance$/, 1, 'normal'],
  ];
  const label = row.test.slice(`${row.adapter}: `.length);
  assert.ok(row.test.startsWith(`${row.adapter}: `));
  const matches = cases.filter(([_kind, pattern]) => pattern.test(label)); assert.equal(matches.length, 1, row.test);
  const [kind, , calls, mode] = matches[0]; assert.equal(row.mode, mode); assert.equal(audit.calls.length, calls);
  const tool = family === 'documents' ? 'documents.batch' : 'observations.page';
  for (const call of audit.calls) { assert.equal(call.tool, tool); sameIds(call.query.ids, ['a', 'b', 'c', 'd']); }
  if (kind === 'normal') {
    sameIds(audit.returned, family === 'documents' ? [['a', 'b', 'c', 'd']] : [['a', 'b'], ['c', 'd']]);
  } else if (kind === 'partial') {
    assert.equal(audit.calls[0].retryIds, null); assert.equal(audit.calls[0].cursor, null);
    sameIds(audit.calls[1].retryIds, ['b']); assert.equal(audit.calls[1].cursor, null); assert.ok(audit.calls[1].snapshot);
    sameIds(audit.returned, family === 'documents' ? [['a', 'b', 'c', 'd'], ['b']] : [['a', 'b'], ['b'], ['c', 'd']]);
    if (family === 'observations') { assert.equal(audit.calls[2].retryIds, null); assert.ok(audit.calls[2].cursor);
      assert.equal(audit.calls[2].snapshot, audit.calls[1].snapshot); }
  } else if (kind === 'empty') {
    assert.equal(family, 'observations'); sameIds(audit.returned, [['a', 'b'], [], ['c', 'd']]);
  } else if (kind === 'error' || kind === 'rate-limit') {
    assert.equal(family, 'documents'); sameIds(audit.returned, [[]]);
  }
  return kind;
}

function recoveryCase(row, before, after) {
  assert.equal(row.schemaVersion, 1); assert.equal(row.kind, 'mcp_collection_recovery');
  assert.ok(backends.includes(row.backend)); assert.ok(['intent', 'partial', 'page'].includes(row.stage));
  const marker = row.marker; assert.equal(marker.schemaVersion, 1); assert.equal(marker.backend, row.backend); assert.equal(marker.stage, row.stage);
  assert.equal(marker.workerPid, row.shutdown.worker.pid); assert.equal(marker.peerPid, row.shutdown.peerBefore.pid);
  assert.notEqual(row.shutdown.peerBefore.pid, row.shutdown.peerAfter.pid); assert.notEqual(marker.workerPid, marker.peerPid);
  assert.equal(row.shutdown.worker.signal, 'SIGKILL'); assert.equal(row.shutdown.peerBefore.reason, 'stdin-ended');
  for (const check of Object.values(row.shutdown)) { integer(check.pid, 1); assert.equal(check.probe, 'ESRCH'); }
  assert.equal(row.tempCleaned, true); digest(marker.checkpointDigest);
  assert.equal(marker.callCount, 1); assert.equal(marker.serverCalls, before.calls.length);
  assert.equal(marker.acceptedResponses, row.stage === 'intent' ? 0 : 1);
  assert.equal(before.calls.length, row.stage === 'intent' ? 0 : 1); assert.equal(after.calls.length, 1);
  assert.equal(row.final.deadlineAt, marker.deadlineAt); assert.ok(row.final.revision > marker.revision);
  assert.deepEqual(row.final.budget.limits, marker.budget.limits); assert.equal(row.final.budget.reservedToolCalls, 0);
  assert.equal(marker.budget.used.toolCalls, 1); assert.equal(marker.budget.used.modelCalls, 0); assert.equal(row.final.budget.used.modelCalls, 0);
  const attempts = row.final.attempts; assert.equal(attempts.length, row.stage === 'intent' ? 3 : 2);
  const original = attempts.find(attempt => attempt.id === marker.attemptId); assert.ok(original);
  assert.equal(original.owner, marker.owner); assert.equal(original.status, 'failed'); assert.equal(original.adopted, false);
  assert.deepEqual(original.readProgress.head, marker.head); assert.equal(original.readProgress.callCount, 1);
  const successor = attempts.find(attempt => attempt.id === original.readProgress.successorAttemptId); assert.ok(successor);
  assert.notEqual(successor.owner, marker.owner); assert.equal(successor.adopted, true);
  const progress = successor.readProgress;
  assert.equal(progress.operationId, original.readProgress.operationId); assert.equal(progress.callCount, 2);
  assert.notEqual(after.calls[0].requestId, marker.request.requestId);
  const expectedIds = row.stage === 'partial' ? ['a', 'b'] : ['a', 'b', 'c', 'd'];
  for (const call of [...before.calls, ...after.calls]) sameIds(call.query.ids, expectedIds);
  if (row.stage === 'intent') {
    assert.equal(marker.maxCalls, 2); assert.equal(marker.remainingCalls, 1); sameIds(marker.completedItemIds, []);
    assert.equal(row.final.budget.used.toolCalls, 3); assert.equal(successor.status, 'partial'); assert.equal(progress.phase, 'partial');
    assert.equal(progress.unknownCalls, 1); assert.equal(progress.remainingCalls, 0); assert.equal(progress.completedItems, 2);
    assert.equal(after.calls[0].retryIds, null); assert.equal(after.calls[0].cursor, null); assert.equal(after.calls[0].snapshot, null);
    sameIds(after.returned, [['a', 'b']]);
    const limited = attempts.find(attempt => attempt.id === progress.successorAttemptId); assert.ok(limited);
    assert.equal(limited.status, 'partial'); assert.equal(limited.adopted, true); assert.equal(limited.readProgress.callCount, 2);
    assert.equal(limited.readProgress.remainingCalls, 0); assert.equal(limited.readProgress.unknownCalls, 1);
    assert.equal(limited.readProgress.operationId, progress.operationId); assert.equal(limited.readProgress.successorAttemptId, null);
  } else {
    assert.equal(marker.maxCalls, 3); assert.equal(marker.remainingCalls, 2); assert.equal(row.final.budget.used.toolCalls, 2);
    assert.equal(successor.status, 'succeeded'); assert.equal(progress.phase, 'complete'); assert.equal(progress.unknownCalls, 0);
    assert.equal(progress.remainingCalls, 1); assert.equal(progress.successorAttemptId, null); assert.ok(after.calls[0].snapshot);
    if (row.stage === 'partial') {
      sameIds(marker.completedItemIds, ['a']); sameIds(after.calls[0].retryIds, ['b']); assert.equal(after.calls[0].cursor, null);
      sameIds(after.returned, [['b']]); assert.equal(progress.completedItems, 2);
    } else {
      sameIds(marker.completedItemIds, ['a', 'b']); assert.equal(after.calls[0].retryIds, null); assert.ok(after.calls[0].cursor);
      sameIds(after.returned, [['c', 'd']]); assert.equal(progress.completedItems, 4);
    }
  }
  return { backend: row.backend, stage: row.stage, status: 'passed', originalOwner: marker.owner, successorOwner: successor.owner,
    workerPid: marker.workerPid, peers: [before.pid, after.pid], callsBeforeKill: before.calls.length, callsAfterReconstruction: after.calls.length,
    returnedAfterReconstruction: after.returned.flat(), operationCallCount: progress.callCount,
    unknownCalls: progress.unknownCalls, remainingCalls: progress.remainingCalls, collectionStatus: progress.phase,
    deadlineAt: row.final.deadlineAt, workLogicalToolCalls: row.final.budget.used.toolCalls,
    recordedModelCalls: row.final.budget.used.modelCalls };
}

async function main() {
  const names = fs.readdirSync(directory).sort(); assert.equal(names.length, 32); assert.ok(names.every(name => /^[a-f0-9]{20}(?:-recovery)?\.json$/.test(name)));
  const files = names.map(name => path.join(directory, name));
  const rows = files.map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
  const integration = rows.filter(row => row.kind === undefined); const recovery = rows.filter(row => row.kind === 'mcp_collection_recovery');
  assert.equal(integration.length, 26); assert.equal(recovery.length, 6); assert.equal(new Set(rows.map(row => row.test)).size, 32);
  rows.forEach(row => digest(row.codeDigest)); assert.equal(new Set(rows.map(row => row.codeDigest)).size, 1);
  const codeDigest = rows[0].codeDigest;
  const log = fs.readFileSync(logPath, 'utf8');
  for (const [name, count] of [['tests', 127], ['pass', 127], ['fail', 0], ['cancelled', 0], ['skipped', 0], ['todo', 0]]) {
    assert.match(log, new RegExp(`^ℹ ${name} ${count}$`, 'm'));
  }
  assert.ok(!/^✖ /m.test(log) && !/^not ok /m.test(log));
  for (const row of rows) {
    assert.equal(typeof row.test, 'string'); assert.ok(log.includes('✔ ' + row.test + ' ('), `no passing test line: ${row.test}`);
    assert.ok(row.error === undefined || row.error === null); assert.ok(row.errors === undefined || Array.isArray(row.errors) && row.errors.length === 0);
    if (row.status !== undefined) assert.equal(row.status, 'passed');
  }
  const evaluation = await import(pathToFileURL(path.join(root, 'dist/infrastructure/local-evaluation.js')).href);
  const build = await evaluation.verifyEvaluationBuild(root); assert.equal(build.sourceDigest, codeDigest);
  const testSources = ['src/tests/mcp-read-collections.test.ts', 'src/tests/mcp-read-collections-recovery.test.ts',
    'src/tests/helpers/mcp-collection-worker.ts', 'src/tests/helpers/mcp-collection-binding.ts',
    'src/tests/helpers/mcp-collection-fixture-server.ts', 'src/tests/helpers/mcp-collection-fixture-contracts.ts'].map(name => pin(path.join(root, name)));
  const allAudits = []; const cases = [];
  for (const row of integration) {
    assert.equal(row.shutdown.ownedPeerStopped, true); const audit = validateAudit(row.audit, row.shutdown.pid);
    validateTransport(row.transport, audit); const kind = integrationCase(row, audit); allAudits.push(audit);
    cases.push({ test: row.test, backend: row.adapter, family: row.family, kind, status: 'passed', calls: audit.calls.length,
      requestFrames: row.transport.wireRequests, listPages: row.transport.listPages, requestFrameBytes: row.transport.requestBytes,
      decodedListAndCallBytes: row.transport.responseBytes, returnedIds: audit.returned, snapshot: structuredClone(row.transport) });
  }
  const expectedKinds = { normal: 4, partial: 4, empty: 2, 'snapshot-change': 2, 'cursor-loop': 2, error: 2, 'rate-limit': 2,
    'raw-loss': 2, 'query-change': 2, 'before-send': 2, 'after-reply': 2 };
  for (const [kind, count] of Object.entries(expectedKinds)) assert.equal(cases.filter(row => row.kind === kind).length, count);
  for (const backend of backends) assert.equal(integration.filter(row => row.adapter === backend).length, 13);
  for (const backend of backends) for (const family of ['documents', 'observations']) for (const kind of ['normal', 'partial'])
    assert.equal(cases.filter(row => row.backend === backend && row.family === family && row.kind === kind).length, 1);
  const recoveryCases = [];
  for (const row of recovery) {
    const before = validateAudit(row.beforeAudit, row.shutdown.peerBefore.pid);
    const after = validateAudit(row.afterAudit, row.shutdown.peerAfter.pid);
    validateTransport(row.transport, after); recoveryCases.push(recoveryCase(row, before, after)); allAudits.push(before, after);
  }
  for (const backend of backends) for (const stage of ['intent', 'partial', 'page'])
    assert.equal(recovery.filter(row => row.backend === backend && row.stage === stage).length, 1);
  assert.equal(allAudits.length, 38);
  const common = { schemaVersion: 1, status: 'passed', codeDigest, targetedLog: pin(logPath), build,
    buildManifest: pin(path.join(root, 'dist/build-manifest.json')), measurements: files.map(pin), testSources,
    scope: { transport: 'owned local read-only MCP stdio fixture', protocol: '2026-07-28',
      actualModelCalls: 0, externalServiceCalls: 0, declarationBasis: 'Pinned local test configuration and synthetic fixture implementation; no general network-absence audit.',
      excluded: ['company MCP', 'HTTP/OAuth', 'Knox', 'live models', 'production data', 'write effects'] } };
  const normalCells = cases.filter(row => row.kind === 'normal').map(({ snapshot: _snapshot, ...row }) => ({ ...row, logicalTaskExecutions: 1,
    collectionResult: 'success', observationBasis: 'passing integration assertions plus call/record audit' }));
  const protocol = { ...common, checkedFields: ['32 unique passing row names', '26 integration rows and 6 recovery rows', 'one current source/build digest',
    'audit PID/sequence/start/close/request identity', 'SDK toolCalls/wireRequests/listPages match current-session audit', 'fixture case matrix and returned ID groups'],
    checks: { measurementRows: 32, integrationRows: 26, recoveryRows: 6, targetedTests: 127, targetedPassed: 127,
      targetedFailed: 0, normalReadCells: normalCells.length, currentSessionTransportRows: rows.length,
      historicalPreKillAuditOnlySessions: recovery.length, observedFixtureSessions: allAudits.length,
      observedFixtureCalls: sum(allAudits, row => row.calls.length), measuredSDKToolCalls: sum(rows, row => row.transport.toolCalls) },
    normalCells, integrationCases: cases.map(({ snapshot: _snapshot, ...row }) => row),
    limits: ['These are synthetic collection results, not goal-completion or model-quality measurements.',
      'MCP requestFrameBytes covers serialized attempted requests/notifications; decodedListAndCallBytes excludes handshake and notification results.',
      'Six pre-kill peer sessions have fixture audits but no SDK counter snapshot; do not sum later snapshots as if they covered those sessions.',
      'Raw artifacts preserve SDK-decoded JSON, not packet captures. Audit snapshot fields are the requested snapshot, not a second independent copy of the reply.',
      'The mapper pins the first accepted snapshot for subsequent pages; the initial snapshot is not independently authenticated against a host content hash.',
      'rate-limit is a whole-tool isError fixture. No per-item rate-limit, automatic cooldown, or real service latency is measured.'] };
  const recoverySummary = { ...common, checkedFields: ['2 backends x 3 SIGKILL stages', 'original worker and both peer ESRCH records',
    'original owner/head/deadline/operation identity preserved', 'new request identity and exact resumed returned IDs',
    'unknown intent consumes maxCalls and exhausted successor adds no MCP call', 'post-cleanup tempCleaned true'],
    checks: { actualWorkerSigkillCases: 6, intentBeforeWireCases: 2, partialBatchCases: 2, acceptedPageCases: 2,
      afterReconstructionCallsPerCase: 1, successfulCollectionResumes: 4, budgetLimitedPartialResumes: 2,
      sameProcessPartialResumeIntegrationCases: 4, beforeSendAuthorityCases: 2, afterReplyAuthorityCases: 2,
      corruptedParentRawBlockedCases: 2, missingEmptyRawBlockedCases: 2 },
    cases: recoveryCases, assertionProvenance: { successfulPrefixExactBodyPreservation: 'Asserted by the passing recovery/integration tests; complete raw item bodies are not duplicated in these summary rows.',
      priorSnapshotAndNextCursorPreservation: 'Passing recovery tests compare the reconstructed checkpoint with the pre-kill original.',
      offlineProofValidation: 'Passing integration tests close the MCP peer, reopen repositories/runtime, then validate without another call.' },
    limits: ['A new worker/peer is explicitly reconstructed after killing an owned worker; this is not automatic production failover or a power-loss test.',
      'SIGKILL-at-intent occurs before tools/call reaches the peer. Its durable intent remains unknown and keeps its budget charge.',
      'The partial/page stages already committed accepted raw pages before SIGKILL; successful prefixes are not requested again.',
      'Policy change before-send and after-reply are separate tests; these 32 rows do not establish late cancelled reply delivery.'] };
  const shutdown = { ...common, checkedFields: ['26 integration closed peers with stored PID and passing ESRCH assertion',
    '6 killed workers and 12 recovery peer ESRCH records', '38 fixture starts and stdin-ended closes',
    '32 current SDK snapshots closed, idle and zero protocolErrors', 'integration awaited rm verified by passing after-hook; recovery rm plus ENOENT probe'],
    checks: { measuredRows: 32, integrationPeerInstances: 26, recoveryPeerInstances: 12, workerSigkillInstances: 6,
      observedFixtureStarts: sum(allAudits, row => row.starts), observedFixtureCloses: sum(allAudits, row => row.closes),
      measuredSDKStarts: sum(rows, row => row.transport.processStarts), measuredSDKCloses: sum(rows, row => row.transport.processCloses),
      allOwnedProcessesStopped: true, integrationTemporaryRemovalCompletedCases: 26, recoveryTemporaryAbsenceProbedCases: 6 },
    cleanupEvidence: [...integration.map(row => ({ test: row.test, peer: row.shutdown.pid, probe: 'ESRCH asserted by passing test',
      temporaryDirectory: 'awaited rm after row write completed in the passing after-hook; no separate ENOENT field in row' })),
    ...recovery.map(row => ({ test: row.test, ...row.shutdown, temporaryDirectory: 'tempCleaned true after rm and ENOENT assertion' }))],
    limits: ['Process and cleanup claims cover these owned fixture instances only. The script reads recorded probes; it does not signal or probe current PIDs.',
      'PIDs can later be reused. Counts refer to recorded instances, not all processes on the host.',
      'Local fixture audits cannot prove absence of arbitrary network activity by unrelated processes.'] };
  const outputs = [['P3-mcp-collections-protocol-final.json', protocol], ['P3-mcp-collections-recovery-final.json', recoverySummary],
    ['P3-mcp-collections-shutdown-final.json', shutdown]];
  for (const [name] of outputs) assert.equal(fs.existsSync(path.join(__dirname, name)), false, `refuse to replace existing summary: ${name}`);
  for (const [name, value] of outputs) fs.writeFileSync(path.join(__dirname, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: 'passed', codeDigest, rows: 32, integrationRows: 26, recoveryRows: 6,
    normalCells: normalCells.length, fixtureInstances: allAudits.length, fixtureCalls: sum(allAudits, row => row.calls.length), outputs: outputs.map(([name]) => name) }));
}
main().catch(error => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
