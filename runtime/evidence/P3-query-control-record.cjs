const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const root = '/Users/seunghanee/Documents/secumon';
const recordPath = 'runtime/evidence/P3-query-control-local-verification.json';
const priorPath = 'runtime/evidence/P3-web-local-verification.json';
const logPath = 'runtime/evidence/P3-query-control-verify.log';
const costPath = 'runtime/evidence/P3-query-control-read-cost.json';
const costScriptPath = 'runtime/evidence/P3-query-control-read-cost.mjs';
const browserPath = 'runtime/evidence/P3-query-control-browser-verification.json';
const groupCounts = { stateQueries: 28, atomicControl: 17, publicQueries: 8 };
const read = p => fs.readFileSync(path.join(root, p));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = p => JSON.parse(read(p));
const evidence = p => ({ path: p, sha256: hash(read(p)), bytes: read(p).length });
function walk(relative) {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const p = path.join(relative, entry.name);
    if (entry.isDirectory()) return walk(p);
    if (!entry.isFile()) throw new Error('unsupported_verification_file_type:' + p);
    return [p];
  });
}
function logMetric(text, name) {
  const matches = [...text.matchAll(new RegExp('^(?:ℹ |# )' + name + ' ([0-9]+(?:\\.[0-9]+)?)\\s*$', 'gm'))];
  return matches.length === 1 ? Number(matches[0][1]) : null;
}
const log = read(logPath).toString();
const prior = json(priorPath);
const browser = json(browserPath);
const cost = json(costPath);
const costScriptMatchesObservation = hash(read(costScriptPath)) === cost.scriptSha256;
const fixture = json('runtime/evidence/fixture-baseline.json');
const manifest = json('design/extraction-manifest.json');
const architectureRows = log.split('\n').filter(line => line.startsWith('{"inspected":'));
const architecture = architectureRows.length === 1 ? JSON.parse(architectureRows[0]) : {};
const testsPassed = logMetric(log, 'pass');
const testsFailed = logMetric(log, 'fail');
const durationMs = logMetric(log, 'duration_ms');
const originals = [manifest.original, ...manifest.parts, manifest.joined, ...manifest.extraction.files];
const originalMismatches = originals.filter(file => { const bytes = read(file.path); return hash(bytes) !== file.sha256 || file.bytes !== undefined && bytes.length !== file.bytes; }).map(file => file.path);

const links = new Set(); const unclosedCodeBlocks = []; const brokenLinks = [];
const documentFiles = [...walk('design').filter(p => p.endsWith('.md')), 'runtime/README.md'];
for (const p of documentFiles) {
  const text = read(p).toString();
  for (const match of text.matchAll(/\[[^\]]*\]\((?:<(\/[^>\n]+)>|(\/[^)\n]+))\)/g)) links.add(match[1] ?? match[2]);
  let fence = false; for (const line of text.split('\n')) if (/^\s*\x60{3,}/.test(line)) fence = !fence;
  if (fence) unclosedCodeBlocks.push(p);
}
for (const link of links) {
  const target = link.split('#')[0]; const match = /^(.*?)(?::(\d+))?$/.exec(target); const p = match[1]; const line = match[2];
  if (!fs.existsSync(p)) { if (p !== path.join(root, recordPath)) brokenLinks.push(link); }
  else if (line && Number(line) > fs.readFileSync(p, 'utf8').split('\n').length) brokenLinks.push(link);
}
const jsonFiles = [...walk('design'), ...walk('runtime/evidence'), ...walk('runtime/fixtures'), ...walk('runtime/guidance')].filter(p => p.endsWith('.json'));
const invalidJson = []; for (const p of jsonFiles) try { json(p); } catch { invalidJson.push(p); }
const guidance = json('runtime/guidance/catalog.json').entries;
const guidanceMismatches = guidance.filter(entry => { const bytes = read(path.join('runtime/guidance', entry.bodyFile)); return hash(bytes) !== entry.sha256 || bytes.length !== entry.byteLength; }).map(entry => entry.id);
const backlog = json('design/implementation-backlog.json'); const tasks = new Map(backlog.work_items.map(item => [item.id, item]));
const invalidDependencies = backlog.work_items.flatMap(item => item.depends_on.filter(id => !tasks.has(id) || item.status === 'verified' && tasks.get(id).status !== 'verified').map(id => item.id + ':' + id));
if (tasks.size !== backlog.work_items.length) invalidDependencies.push('duplicate_work_item_id');
const workItem = tasks.get('P3-02'); const verifiedWorkItems = backlog.work_items.filter(item => item.status === 'verified').length;
const sourceFiles = [...walk('runtime/src'), ...walk('runtime/scripts'), ...walk('runtime/fixtures'), ...walk('runtime/guidance'),
  ...['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.core.json', '.nvmrc'].map(p => 'runtime/' + p)].sort();
const sources = sourceFiles.map(p => ({ path: p, sha256: hash(read(p)) }));
const priorSources = new Map(prior.sources.map(file => [file.path, file.sha256]));
const sourceChanges = sources.filter(file => priorSources.get(file.path) !== file.sha256).map(file => ({ path: file.path, kind: priorSources.has(file.path) ? 'modified' : 'added' }));
const removedSources = prior.sources.filter(file => !sourceFiles.includes(file.path)).map(file => file.path);
const dependencyLockUnchanged = hash(read('runtime/package-lock.json')) === priorSources.get('runtime/package-lock.json');
const priorLogUnchanged = hash(read(prior.log.path)) === prior.log.sha256;
const priorParentUnchanged = hash(read(prior.priorVerification.path)) === prior.priorVerification.sha256;
const historicalArtifactRefs = [prior.log, prior.priorVerification, prior.browser, ...prior.browser.screenshots, prior.browser.dom, prior.readCost];
const historicalArtifactMismatches = historicalArtifactRefs.filter(ref => hash(read(ref.path)) !== ref.sha256).map(ref => ref.path);
const priorChain = []; const chainSeen = new Set(); let chainPath = priorPath; let chainRecord = prior;
while (chainRecord) {
  if (chainSeen.has(chainPath)) throw new Error('verification_parent_cycle'); chainSeen.add(chainPath);
  const node = { ...evidence(chainPath), testsPassed: chainRecord.testsPassed ?? null, logUnchanged: true, parentUnchanged: true };
  if (chainRecord.log?.path && chainRecord.log?.sha256) node.logUnchanged = hash(read(chainRecord.log.path)) === chainRecord.log.sha256;
  const parent = chainRecord.priorVerification;
  if (parent?.path && parent?.sha256) node.parentUnchanged = hash(read(parent.path)) === parent.sha256;
  priorChain.push(node);
  if (!parent?.path || !parent?.sha256) break;
  chainPath = parent.path; chainRecord = json(chainPath);
}
const historicalChainMismatches = priorChain.filter(item => !item.logUnchanged || !item.parentUnchanged).map(item => item.path);

const requiredCostCode = ['infrastructure/file-journal-state.js', 'infrastructure/sqlite-state.js', 'application/new-work.js', 'application/state-query.js', 'application/store-contract.js'];
const costCodeChecks = Object.entries(cost.implementationSha256 ?? {}).map(([p, observed]) => ({ path: 'runtime/dist/' + p, observedSha256: observed,
  finalSha256: hash(read('runtime/dist/' + p)), matchesFinal: hash(read('runtime/dist/' + p)) === observed }));
const costCodeMismatches = costCodeChecks.filter(file => !file.matchesFinal).map(file => file.path);
for (const p of requiredCostCode) if (!Object.hasOwn(cost.implementationSha256 ?? {}, p)) costCodeMismatches.push('missing:' + p);
const frontendChecks = (browser.frontendCode ?? []).map(file => ({ path: file.path, observedSha256: file.sha256, finalSha256: hash(read(file.path)), matchesFinal: hash(read(file.path)) === file.sha256 }));
const frontendMismatches = frontendChecks.filter(file => !file.matchesFinal).map(file => file.path);
for (const p of ['runtime/dist/presentation/web/client.js', 'runtime/dist/presentation/web/view-state.js']) if (!frontendChecks.some(file => file.path === p)) frontendMismatches.push('missing:' + p);
const serverComparisons = (browser.serverLoadedCode ?? []).map(file => ({ path: file.path, observedSha256: file.sha256, finalSha256: hash(read(file.path)), matchesFinal: hash(read(file.path)) === file.sha256 }));
const frontendStaticComparisons = ['runtime/src/presentation/web/index.html', 'runtime/src/presentation/web/styles.css'].map(p => ({ path: p,
  priorVerifiedSha256: priorSources.get(p), finalSha256: hash(read(p)), unchangedSincePriorFullBrowserCheck: hash(read(p)) === priorSources.get(p) }));
const artifactPaths = [...new Set([costPath, costScriptPath, browserPath, ...browser.screenshots, browser.dom])];
const artifacts = artifactPaths.map(evidence);
const acceptanceEvidence = ['runtime/src/tests/state-query.test.ts', 'runtime/src/tests/goal-control-atomic.test.ts', 'runtime/src/tests/work-query-view.test.ts'];
acceptanceEvidence.forEach(read);
const intermediatePaths = ['P3-query-control-typecheck-1.log', 'P3-query-control-build-1.log', 'P3-query-control-targeted-1.log',
  'P3-query-control-build-2.log', 'P3-query-control-targeted-2.log', 'P3-query-control-build-3.log', 'P3-query-control-targeted-3.log', 'P3-query-control-read-cost.log'];
const intermediate = intermediatePaths.map(name => {
  const p = 'runtime/evidence/' + name; const content = read(p).toString();
  return { ...evidence(p), tests: logMetric(content, 'tests'), passed: logMetric(content, 'pass'), failed: logMetric(content, 'fail'), scope: 'Intermediate observation; final npm run verify is the current acceptance run.' };
});
const failures = { originalMismatches, brokenLinks, unclosedCodeBlocks, invalidJson, guidanceMismatches, invalidDependencies,
  removedSources, historicalArtifactMismatches, historicalChainMismatches, costCodeMismatches, frontendMismatches };

function assertCosts() {
  if (cost.status !== 'passed' || cost.realModelInvoked !== false || cost.externalServiceInvoked !== false || cost.productionDataRead !== false || cost.fixtureCleanup !== 'removed') return false;
  if (cost.fileJournal?.histories?.length !== 2 || cost.fileJournal?.conversationPages?.length !== 2 || !cost.sqlite?.equivalenceAssertionsPassed) return false;
  for (const n of [32, 64]) {
    const entry = cost.fileJournal.histories.find(value => value.seededRevisions === n); if (!entry?.equivalenceAssertionsPassed) return false;
    for (const kind of ['get', 'recentEventMetadata']) {
      const warm = entry.observations.find(value => value.name === 'warm:' + kind);
      const appended = entry.observations.find(value => value.name === 'other-instance-append:' + kind);
      if (warm?.delta.parsedRecords !== 0 || warm?.delta.replayedRecords !== 0 || warm?.delta.recordReads !== n || appended?.delta.parsedRecords !== 1) return false;
    }
  }
  for (const page of cost.fileJournal.conversationPages) {
    if (!page.allMatchingIdsRecoveredWithoutDuplication || page.totalWorks !== 45 || page.requestedCandidateLimit !== 20) return false;
    if (JSON.stringify(page.observations.slice(0, 3).map(value => value.delta.inspectedWorks)) !== '[20,20,5]') return false;
  }
  const statements = cost.sqlite.observations.flatMap(value => value.preparedStatements);
  return statements.length > 0 && statements.every(statement => statement.selectsFullStateOrEventBody === false && !statement.returnedColumnNames.includes('body') &&
    statement.explainQueryPlan.some(plan => /SEARCH .*USING (?:COVERING )?INDEX/i.test(plan.detail)));
}

(async () => {
  const evaluation = await import(pathToFileURL(path.join(root, 'runtime/dist/infrastructure/local-evaluation.js')).href);
  const code = await evaluation.evaluationCodePin(path.join(root, 'runtime'));
  const build = await evaluation.verifyEvaluationBuild(path.join(root, 'runtime'));
  const buildFiles = await evaluation.evaluationBuildFiles(path.join(root, 'runtime'));
  const additionalTests = Object.values(groupCounts).reduce((sum, value) => sum + value, 0);
  const browserPassed = browser.checks.length === 8 && browser.checks.every(check => check.result === 'passed') && browser.consoleErrors.length === 0 &&
    browser.serverStopped === true && browser.fixtureRemoved === true && browser.actualModelCalls === 0 && browser.actualServiceCalls === 0;
  const observedScopePreserved = browser.scope.includes('SQLite') && browser.scope.includes('before final query-schema migration');
  const workItemScopeValid = workItem?.status === 'in_progress' && workItem.verification?.local_contracts === 'verified' && workItem.verification?.record === recordPath &&
    workItem.verification?.actual_model === 'not_run' && verifiedWorkItems === 9;
  const finalFixtureInLog = /"scenarios":\s*4/.test(log) && /"checkpoints":\s*22/.test(log) && /"passed":\s*true/.test(log);
  if (process.version !== 'v24.20.0' || logMetric(log, 'tests') !== 1536 || testsPassed !== 1536 || testsFailed !== 0 || !(durationMs > 0) || prior.testsPassed !== 1483 ||
    prior.testsPassed + additionalTests !== testsPassed || architecture.inspected !== 86 || !Array.isArray(architecture.failures) || architecture.failures.length ||
    !fixture.passed || fixture.scenarios !== 4 || fixture.checkpoints !== 22 || !finalFixtureInLog || !log.includes('> tsc -p tsconfig.core.json') ||
    !log.includes('> tsc -p tsconfig.json && node scripts/record-build.mjs') || originals.length !== 1973 || !dependencyLockUnchanged || !priorLogUnchanged || !priorParentUnchanged ||
    !browserPassed || !observedScopePreserved || !workItemScopeValid || !costScriptMatchesObservation || !assertCosts() || Object.values(failures).some(values => values.length)) {
    throw new Error('verification_incomplete:' + JSON.stringify({ failures, browserPassed, observedScopePreserved, workItemScopeValid, costsValid: assertCosts(),
      costScriptMatchesObservation, tests: logMetric(log, 'tests'), testsPassed, testsFailed, durationMs, originals: originals.length, verifiedWorkItems, backlogRevision: backlog.revision }));
  }
  if (fs.existsSync(path.join(root, '.git'))) throw new Error('unexpected_git_repository');
  const priorResolution = [
    { priorLimit: 'Goal command had no atomic control revision condition across another channel.', currentResult: 'Explicit goal/control revisions are checked in the same mutator and CAS retries; receipt replay is preserved.' },
    { priorLimit: 'Diagnostics selected the tail after requesting complete event bodies.', currentResult: 'The public view requests bounded metadata; SQLite reads indexed metadata, while journal still rechecks full raw history for integrity.' },
    { priorLimit: 'The list discovered all work IDs and could skip unbounded denied items.', currentResult: 'One candidate page per request is rechecked. Journal directory enumeration remains dependent on total stored directories.' },
  ];
  const knownLimits = [...browser.limits, ...cost.notes,
    'Browser observations use final client/view-state code but the explicitly recorded pre-final SQLite server storage implementation. Final schema migration and both persistent stores are covered by automated tests, not a repeat of that browser session.',
    'SQLite metadata/index migration from an older schema validates and backfills prior records; steady bounded-query observations do not measure one-time migration cost.',
    'File-journal warm projections avoid repeated parse/replay but retain full historical record reads and raw hashes. Directory discovery, stat checks, integrity identity maps and cold replay remain costs.',
    'A page limit of 20 bounds candidate work inspection, not every internal I/O operation or a cross-work atomic snapshot. Empty pages may carry a continuation.',
    'Public Web list cursor handles are instance-local, expire after 15 minutes and retain at most 128 entries. Expiry, eviction or restart requires refreshing the first page; cursors confer no authorization.',
    'Query/code observations do not establish a production throughput benchmark, physical disk I/O, actual model quality or billing savings.',
    'Older goal clients must send the explicit control revision. Adding a new field to a previously stored old-format request changes its digest and is not a transparent replay migration.',
    'No organization SSO, real model endpoint, MCP, Knox, product computer-use adapter, operating-system IME or screen-reader acceptance was added by this slice.',
    'The server is not an autonomous persistent scheduler; execution after process loss requires an explicit new run request.',
  ];
  const record = { createdAt: new Date().toISOString(), workItems: ['P3-02'], status: 'verified_local_query_and_control_slice', workItemStatus: workItem.status,
    localContracts: workItem.verification.local_contracts, backlogRevision: backlog.revision,
    scope: 'Bounded metadata/conversation queries, journal parse/replay reuse with integrity rechecks, strict atomic goal/control revisions, and targeted local Web behavior.',
    command: 'npm run verify', exitCode: 0, node: process.version.slice(1), executable: process.execPath, platform: process.platform, architectureHost: process.arch,
    testsPassed, testsFailed, durationMs, previousTotal: prior.testsPassed, additionalTests, newTestGroups: groupCounts,
    log: evidence(logPath), priorVerification: { ...evidence(priorPath), testsPassed: prior.testsPassed, logUnchanged: priorLogUnchanged, parentUnchanged: priorParentUnchanged }, priorChain,
    architecture: { innerFiles: architecture.inspected, violations: architecture.failures.length, coreTypecheck: 'passed' }, dependencyLockUnchanged,
    fixtureScenarios: fixture.scenarios, fixtureCheckpoints: fixture.checkpoints, fixturePassed: fixture.passed, acceptanceEvidence,
    browser: { ...evidence(browserPath), checks: browser.checks.length, backend: 'sqlite', scope: browser.scope, frontendMatchesFinalBuild: true,
      frontendCode: frontendChecks, frontendStaticComparedWithPrior: frontendStaticComparisons, serverLoadedCodeComparedWithFinal: serverComparisons,
      fullFinalServerBrowserRerun: false, screenshots: browser.screenshots.map(evidence), dom: evidence(browser.dom), serverStopped: true, fixtureRemoved: true, consoleErrors: [] },
    readCost: { ...evidence(costPath), status: cost.status, implementationMatchesFinalBuild: true, implementationCode: costCodeChecks,
      script: { ...evidence(costScriptPath), matchesObservedScript: costScriptMatchesObservation },
      historyRevisions: cost.fileJournal.histories.map(value => value.seededRevisions), journalPagingCases: cost.fileJournal.conversationPages.length,
      journalCandidateCounts: [20, 20, 5], sqlitePreparedStatementCount: cost.sqlite.observations.reduce((sum, value) => sum + value.preparedStatements.length, 0),
      sqliteObservationMeaning: cost.sqlite.observationsAre, physicalDiskIoMeasured: false, fixtureCleanup: cost.fixtureCleanup },
    artifacts, intermediate, actualExternalModelCalls: 0, actualServiceCalls: 0, loopbackOnly: true,
    remaining: workItem.remaining, resolvedPriorLocalLimits: priorResolution, knownLimits,
    codeDigest: code.digest, build, buildManifest: evidence('runtime/dist/build-manifest.json'),
    buildFiles: buildFiles.map(file => ({ path: 'runtime/' + file.path, sha256: file.sha256 })),
    originals: { checked: originals.length, unchanged: true },
    static: { links: links.size, json: jsonFiles.length + (jsonFiles.includes(recordPath) ? 0 : 1), jsonBeforeRecord: jsonFiles.length,
      jsonCountIncludesGeneratedRecord: true, failures, guidanceValid: true, verifiedWorkItems },
    generator: { path: __filename, sha256: hash(fs.readFileSync(__filename)) }, gitInitialized: false, sourceChanges, sources,
  };
  fs.writeFileSync(path.join(root, recordPath), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ recordPath, testsPassed, sourceFiles: sources.length, buildFiles: build.fileCount, sourceChanges,
    originals: originals.length, links: links.size, json: record.static.json, localContracts: record.localContracts, workItemStatus: record.workItemStatus, failures }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
