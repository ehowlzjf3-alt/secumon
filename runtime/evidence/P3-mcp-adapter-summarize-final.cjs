const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const relative = file => 'runtime/' + path.relative(root, file);
const pin = file => { const bytes = fs.readFileSync(file); return { path: relative(file), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; };
const write = (name, value) => fs.writeFileSync(path.join(__dirname, name), JSON.stringify(value, null, 2) + '\n');
const directory = path.join(__dirname, 'mcp-adapter-final-v2');
const files = fs.readdirSync(directory).filter(file => file.endsWith('.json')).sort().map(file => path.join(directory, file));
const rows = files.map(file => JSON.parse(fs.readFileSync(file)));
assert.equal(rows.length, 44);
assert.equal(new Set(rows.map(row => row.codeDigest)).size, 1);
const codeDigest = rows[0].codeDigest;
const logPath = path.join(__dirname, 'P3-mcp-adapter-targeted-final-v2.log');
const log = fs.readFileSync(logPath, 'utf8');
assert.match(log, /^ℹ pass 58$/m); assert.match(log, /^ℹ fail 0$/m); assert.match(log, /^ℹ cancelled 0$/m);
for (const row of rows) {
  assert.ok(log.includes('✔ ' + row.test + ' ('));
  assert.equal(row.shutdown.ownedProcessStopped, true); assert.equal(row.shutdown.temporaryFilesCleaned, true);
  assert.equal(row.snapshot.pid, null); assert.equal(row.snapshot.activeCalls, 0);
  assert.equal(row.snapshot.processStarts, row.snapshot.processCloses);
  assert.equal(row.snapshot.toolCalls, row.audit.filter(entry => entry.event === 'call').length);
}
const good = rows.filter(row => /family [01] stores/.test(row.test)); assert.equal(good.length, 4);
const cells = good.map(row => {
  assert.equal(row.snapshot.toolCalls, 1); assert.equal(row.snapshot.wireRequests, 4); assert.equal(row.snapshot.listPages, 1);
  return { adapter: row.adapter, family: row.family === 0 ? 'documents' : 'observations', logicalToolCalls: 1,
    mcpToolCalls: row.snapshot.toolCalls, allRequestFrames: row.snapshot.wireRequests, listPages: row.snapshot.listPages,
    requestFrameBytes: row.snapshot.requestBytes, decodedListAndCallBytes: row.snapshot.responseBytes,
    serverHandlerCalls: row.audit.filter(entry => entry.event === 'call').length, actualModelCalls: 0 };
}).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const delayed = rows.find(row => row.test.includes('lost delayed response')); assert.ok(delayed);
assert.equal(delayed.snapshot.toolCalls, 1); assert.ok(delayed.audit.some(entry => entry.event === 'response-delayed'));
assert.ok(delayed.audit.some(entry => entry.method === 'notifications/cancelled'));
const cleanupFault = rows.find(row => row.test.includes('uncertain exit preserves')); assert.ok(cleanupFault); assert.equal(cleanupFault.snapshot.toolCalls, 1); assert.equal(cleanupFault.snapshot.processCloses, 1);
const crashed = rows.find(row => row.test.includes('crashed peer')); assert.ok(crashed);
assert.equal(crashed.snapshot.processStarts, 2); assert.equal(crashed.snapshot.toolCalls, 2);
assert.deepEqual(crashed.audit.filter(entry => entry.event === 'call').map(entry => entry.id), ['crash', 'good']);
const preserved = rows.filter(row => row.test.includes('received result survives reopen')); assert.equal(preserved.length, 2);
const rejectedAfterReply = rows.filter(row => row.test.includes('after a real reply')); assert.equal(rejectedAfterReply.length, 4);
const suppressed = rows.filter(row => row.test.includes('request intent prevents')); assert.equal(suppressed.length, 2);
for (const row of [...preserved, ...rejectedAfterReply, ...suppressed]) assert.equal(row.snapshot.toolCalls, 1);
write('P3-mcp-adapter-protocol-final.json', { schemaVersion: 1, codeDigest, evidenceKind: 'local test assertions and instrumented SDK/fixture counters',
  targetedLog: pin(logPath), measurements: files.map(pin), checks: { normalReadCells: 4, onlyApprovedReadTools: true,
    negotiatedVersionCheckedByTests: '2026-07-28', allRecordedCallCountsMatchFixture: true }, cells,
  limits: ['One execution per normal cell; no latency distribution or model quality measurement.',
    'requestFrameBytes covers serialized attempted requests and notifications; decodedListAndCallBytes excludes handshake and notification responses.',
    'SDK normalized JSON is preserved; these artifacts are not a packet capture.', 'The fixture audit labels server/discover as other; the negotiated revision is checked through the SDK and retained envelope.'] });
write('P3-mcp-adapter-recovery-final.json', { schemaVersion: 1, codeDigest, targetedLog: pin(logPath),
  checks: { delayedReplyCancelledAfterHandler: true, cleanupFailureRetainsSent: true, hiddenCallRetriesInTestedScenarios: 0, explicitReconnectProcesses: 2,
    storedResultReopenCases: preserved.length, postReplyAuthorityCases: rejectedAfterReply.length, repeatedIntentBlockedCases: suppressed.length },
  delayedReply: delayed, explicitReconnect: crashed, cleanupFailure: cleanupFault, limits: ['Peer crash is fixture process.exit(23), not a worker SIGKILL or power-loss test.',
    'Cancellation is observed as loss of a delayed response and a sent request; it is not a rollback receipt.',
    'Reopen exercises both persistent repositories and reconstructed tool validators in the same test process.'] });
write('P3-mcp-adapter-shutdown-final.json', { schemaVersion: 1, codeDigest,
  checks: { measuredFixtureInstances: rows.length, observedChildStarts: rows.reduce((n, row) => n + row.snapshot.processStarts, 0),
    observedChildCloses: rows.reduce((n, row) => n + row.snapshot.processCloses, 0), allOwnedProcessesStopped: true, allTemporaryDirectoriesRemoved: true },
  evidence: files.map(pin), note: 'Rows are emitted after adapter close, owned pid ESRCH checks or SDK adapter exit wait, and temporary-directory removal assertions. Two transport tests without fixture rows are covered by the test log.' });
console.log(JSON.stringify({ codeDigest, normalCells: cells.length, measurementRows: rows.length, childStarts: rows.reduce((n, row) => n + row.snapshot.processStarts, 0), cells }));
