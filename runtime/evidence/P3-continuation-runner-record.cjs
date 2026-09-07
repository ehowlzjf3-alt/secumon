const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const root = '/Users/seunghanee/Documents/secumon';
const recordPath = 'runtime/evidence/P3-continuation-runner-local-verification.json';
const priorPath = 'runtime/evidence/P3-continuation-boundary-local-verification.json';
const priorSha256 = '0de1804dda9981fb5bef334ea67a5eb7f8094f69423afa8fc598cc29a2a8c286';
const logPath = 'runtime/evidence/P3-continuation-runner-verify.log';
const targetedPath = 'runtime/evidence/P3-continuation-runner-targeted-final.log';
const planPath = 'design/chapters/P3-computer-continuation-runner-plan.md';
const expectedPriorTests = 1853; const existingTargetedTests = 66; const expectedInnerFiles = 98;
const read = p => fs.readFileSync(path.resolve(root, p));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = p => JSON.parse(read(p));
const evidence = p => { const bytes = read(p); return { path: p, sha256: hash(bytes), bytes: bytes.length }; };
function walk(relative) {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const p = path.join(relative, entry.name);
    if (entry.isDirectory()) return walk(p);
    if (!entry.isFile()) throw new Error('unsupported_verification_file_type:' + p);
    return [p];
  });
}
function metric(text, name) {
  const matches = [...text.matchAll(new RegExp('^(?:ℹ |# )' + name + ' ([0-9]+(?:\\.[0-9]+)?)\\s*$', 'gm'))];
  return matches.length === 1 ? Number(matches[0][1]) : null;
}
const log = read(logPath).toString(); const targeted = read(targetedPath).toString(); const prior = json(priorPath);
const fixture = json('runtime/evidence/fixture-baseline.json'); const manifest = json('design/extraction-manifest.json');
const originals = [manifest.original, ...manifest.parts, manifest.joined, ...manifest.extraction.files];
const originalMismatches = originals.filter(file => hash(read(file.path)) !== file.sha256 || file.bytes !== undefined && read(file.path).length !== file.bytes).map(file => file.path);
const links = new Set(); const unclosedCodeBlocks = []; const brokenLinks = [];
for (const p of [...walk('design').filter(p => p.endsWith('.md')), 'runtime/README.md']) {
  const text = read(p).toString();
  for (const match of text.matchAll(/\[[^\]]*\]\((?:<(\/[^>\n]+)>|(\/[^)\n]+))\)/g)) links.add(match[1] ?? match[2]);
  let fence = false; for (const line of text.split('\n')) if (/^\s*\x60{3,}/.test(line)) fence = !fence;
  if (fence) unclosedCodeBlocks.push(p);
}
for (const link of links) {
  const match = /^(.*?)(?::(\d+))?$/.exec(link.split('#')[0]); const p = match[1]; const line = match[2];
  if (!fs.existsSync(p)) { if (p !== path.join(root, recordPath)) brokenLinks.push(link); }
  else if (line && Number(line) > fs.readFileSync(p, 'utf8').split('\n').length) brokenLinks.push(link);
}
const jsonFiles = [...walk('design'), ...walk('runtime/evidence'), ...walk('runtime/fixtures'), ...walk('runtime/guidance')].filter(p => p.endsWith('.json'));
const invalidJson = []; for (const p of jsonFiles) try { json(p); } catch { invalidJson.push(p); }
const guidanceMismatches = json('runtime/guidance/catalog.json').entries.filter(entry => {
  const bytes = read(path.join('runtime/guidance', entry.bodyFile)); return hash(bytes) !== entry.sha256 || bytes.length !== entry.byteLength;
}).map(entry => entry.id);
const backlog = json('design/implementation-backlog.json'); const tasks = new Map(backlog.work_items.map(item => [item.id, item]));
const invalidDependencies = backlog.work_items.flatMap(item => item.depends_on.filter(id => !tasks.has(id) || item.status === 'verified' && tasks.get(id).status !== 'verified').map(id => item.id + ':' + id));
if (tasks.size !== backlog.work_items.length) invalidDependencies.push('duplicate_work_item_id');
const workItem = tasks.get('P3-04'); const verifiedWorkItems = backlog.work_items.filter(item => item.status === 'verified').length;
const groupCounts = workItem?.verification?.new_test_groups;
if (!groupCounts || typeof groupCounts !== 'object' || Array.isArray(groupCounts) || !Object.keys(groupCounts).length ||
  Object.values(groupCounts).some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error('invalid_backlog_new_test_groups');
const expectedTestsPassed = workItem.verification.tests_passed; const expectedAdditionalTests = workItem.verification.additional_tests;
if (!Number.isSafeInteger(expectedTestsPassed) || !Number.isSafeInteger(expectedAdditionalTests) || expectedAdditionalTests <= 0)
  throw new Error('invalid_backlog_test_totals');
const sourceFiles = [...walk('runtime/src'), ...walk('runtime/scripts'), ...walk('runtime/fixtures'), ...walk('runtime/guidance'),
  ...['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.core.json', '.nvmrc'].map(p => 'runtime/' + p)].sort();
const sources = sourceFiles.map(p => ({ path: p, sha256: hash(read(p)) }));
const priorSources = new Map(prior.sources.map(file => [file.path, file.sha256]));
const sourceChanges = sources.filter(file => priorSources.get(file.path) !== file.sha256).map(file => ({ path: file.path, kind: priorSources.has(file.path) ? 'modified' : 'added' }));
const removedSources = prior.sources.filter(file => !sourceFiles.includes(file.path)).map(file => file.path);
const dependencyLockUnchanged = hash(read('runtime/package-lock.json')) === priorSources.get('runtime/package-lock.json');
const historicalArtifactMismatches = []; const historicalRefs = new Map(); const unpinnedHistoricalPaths = new Set();
function historicalArtifacts(record) {
  const excluded = new Set(['sources', 'sourceChanges', 'build', 'buildFiles', 'buildManifest', 'priorVerification', 'priorChain']);
  const visit = (value, section) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.path === 'string') {
      const relative = path.relative(root, path.resolve(root, value.path));
      if (relative.startsWith('runtime/src/') || relative.startsWith('runtime/dist/')) return;
      if (typeof value.sha256 === 'string') {
        try { const actual = evidence(value.path);
          if (actual.sha256 !== value.sha256 || value.bytes !== undefined && actual.bytes !== value.bytes) historicalArtifactMismatches.push(value.path);
          historicalRefs.set(relative, actual);
        } catch { historicalArtifactMismatches.push(value.path); }
      } else if (section === 'intermediate' || /\.log$/.test(value.path)) {
        unpinnedHistoricalPaths.add(relative); if (!fs.existsSync(path.resolve(root, value.path))) historicalArtifactMismatches.push(value.path);
      }
    }
    for (const child of Object.values(value)) visit(child, section);
  };
  for (const [section, value] of Object.entries(record)) if (!excluded.has(section)) visit(value, section);
}
const priorChain = []; const seen = new Set(); let chainPath = priorPath; let chainRecord = prior;
while (chainRecord) {
  if (seen.has(chainPath)) throw new Error('verification_parent_cycle'); seen.add(chainPath);
  const node = { ...evidence(chainPath), testsPassed: chainRecord.testsPassed ?? null, logUnchanged: true, parentUnchanged: true };
  historicalArtifacts(chainRecord);
  if (chainRecord.log?.path && chainRecord.log?.sha256) { const actual = evidence(chainRecord.log.path);
    node.logUnchanged = actual.sha256 === chainRecord.log.sha256 && (chainRecord.log.bytes === undefined || actual.bytes === chainRecord.log.bytes);
  }
  const parent = chainRecord.priorVerification;
  if (parent?.path && parent?.sha256) { const actual = evidence(parent.path);
    const parentRecord = json(parent.path);
    node.parentUnchanged = actual.sha256 === parent.sha256 && (parent.bytes === undefined || actual.bytes === parent.bytes) &&
      parentRecord.testsPassed === parent.testsPassed && chainRecord.previousTotal === parentRecord.testsPassed;
  }
  priorChain.push(node); if (!parent?.path || !parent?.sha256) break;
  chainPath = parent.path; chainRecord = json(chainPath);
}
const historicalChainMismatches = priorChain.filter(item => !item.logUnchanged || !item.parentUnchanged).map(item => item.path);
if (hash(read(priorPath)) !== priorSha256) historicalChainMismatches.push(priorPath);
if (JSON.stringify((prior.priorChain ?? []).map(item => item.path)) !== JSON.stringify(priorChain.slice(1).map(item => item.path)))
  historicalChainMismatches.push('prior_chain_order');
for (const ref of prior.priorChain ?? []) { const actual = evidence(ref.path);
  if (actual.sha256 !== ref.sha256 || ref.bytes !== undefined && actual.bytes !== ref.bytes) historicalChainMismatches.push(ref.path);
}
for (const p of historicalRefs.keys()) unpinnedHistoricalPaths.delete(p);
const intermediate = walk('runtime/evidence').filter(p => /^runtime\/evidence\/P3-continuation-runner-(?:typecheck|build|targeted|verify)-[^/]+\.log$/.test(p)).map(p => ({
  ...evidence(p), tests: metric(read(p).toString(), 'tests'), passed: metric(read(p).toString(), 'pass'), failed: metric(read(p).toString(), 'fail'), cancelled: metric(read(p).toString(), 'cancelled'),
  scope: 'Intermediate or targeted observation; the final verify log is the whole-runtime acceptance run.',
}));
const failures = { originalMismatches, brokenLinks, unclosedCodeBlocks, invalidJson, guidanceMismatches, invalidDependencies,
  removedSources, historicalArtifactMismatches, historicalChainMismatches };
(async () => {
  const evaluation = await import(pathToFileURL(path.join(root, 'runtime/dist/infrastructure/local-evaluation.js')).href);
  const code = await evaluation.evaluationCodePin(path.join(root, 'runtime'));
  const build = await evaluation.verifyEvaluationBuild(path.join(root, 'runtime'));
  const buildFiles = await evaluation.evaluationBuildFiles(path.join(root, 'runtime'));
  const additionalTests = Object.values(groupCounts).reduce((sum, value) => sum + value, 0);
  const testsPassed = metric(log, 'pass'); const testsFailed = metric(log, 'fail'); const durationMs = metric(log, 'duration_ms');
  const rows = log.split('\n').filter(line => line.startsWith('{"inspected":')); const architecture = rows.length === 1 ? JSON.parse(rows[0]) : {};
  const workItemScopeValid = workItem?.status === 'in_progress' && workItem.verification?.local_contracts === 'partially_verified' &&
    workItem.verification?.record === recordPath && workItem.verification?.actual_driver === 'not_run' && workItem.verification?.actual_model === 'not_run' &&
    workItem.plan === planPath && fs.existsSync(path.join(root, planPath)) && backlog.revision === 'v0.37' && verifiedWorkItems === 9;
  const targetedTests = existingTargetedTests + additionalTests;
  if (process.version !== 'v24.20.0' || metric(log, 'tests') !== expectedTestsPassed || testsPassed !== expectedTestsPassed || testsFailed !== 0 || !(durationMs > 0) ||
    prior.backlogRevision !== 'v0.36' || prior.testsPassed !== expectedPriorTests || additionalTests !== expectedAdditionalTests ||
    prior.testsPassed + additionalTests !== testsPassed || metric(targeted, 'tests') !== targetedTests || metric(targeted, 'pass') !== targetedTests || metric(targeted, 'fail') !== 0 ||
    architecture.inspected !== expectedInnerFiles || !Array.isArray(architecture.failures) || architecture.failures.length || !fixture.passed || fixture.scenarios !== 4 ||
    fixture.checkpoints !== 22 || !/"scenarios":\s*4/.test(log) || !/"checkpoints":\s*22/.test(log) || !/"passed":\s*true/.test(log) ||
    !log.includes('> tsc -p tsconfig.core.json') || !log.includes('> tsc -p tsconfig.json && node scripts/record-build.mjs') || originals.length !== 1973 ||
    !dependencyLockUnchanged || !workItemScopeValid || Object.values(failures).some(values => values.length))
    throw new Error('verification_incomplete:' + JSON.stringify({ failures, workItemScopeValid, testsPassed, testsFailed, durationMs, architecture,
      originalCount: originals.length, verifiedWorkItems, backlogRevision: backlog.revision, expectedTestsPassed, expectedAdditionalTests,
      newTestGroups: groupCounts, targetedTests, targetedObserved: { tests: metric(targeted, 'tests'), pass: metric(targeted, 'pass'), fail: metric(targeted, 'fail') } }));
  for (const p of ['.git', 'runtime/.git']) {
    try { fs.lstatSync(path.join(root, p)); throw new Error('unexpected_git_repository:' + p); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (sources.some(file => hash(read(file.path)) !== file.sha256)) throw new Error('source_changed_during_verification');
  const record = { createdAt: new Date().toISOString(), workItems: ['P3-04'], status: 'verified_local_computer_continuation_v2_execution_and_recovery',
    workItemStatus: workItem.status, localContracts: workItem.verification.local_contracts, backlogRevision: backlog.revision,
    plan: planPath,
    scope: 'Actual synthetic continue and zero-input verify, immutable single-successor reservation, v2 durable counters and root deadline, fresh frontier observations, context references, effect-proof lifetime and process-kill recovery. No real model, GUI or internal service was invoked.',
    command: 'npm run verify', exitCode: 0, node: process.version.slice(1), executable: process.execPath, platform: process.platform, architectureHost: process.arch,
    testsPassed, testsFailed, durationMs, previousTotal: prior.testsPassed, additionalTests, newTestGroups: groupCounts,
    log: evidence(logPath), priorVerification: { ...evidence(priorPath), testsPassed: prior.testsPassed, logUnchanged: priorChain[0].logUnchanged,
      parentUnchanged: priorChain[0].parentUnchanged }, priorChain,
    architecture: { innerFiles: architecture.inspected, violations: architecture.failures.length, coreTypecheck: 'passed' }, dependencyLockUnchanged,
    fixtureScenarios: fixture.scenarios, fixtureCheckpoints: fixture.checkpoints, fixturePassed: fixture.passed,
    acceptanceEvidence: ['computer-checkpoint-v2-contracts.test.ts', 'computer-continuations.test.ts', 'computer-continuation-runner.test.ts',
      'computer-continuation-authority.test.ts', 'computer-continuation-recovery.test.ts', 'computer-continuation-context.test.ts',
      'computer-reconciliation-progress.test.ts', 'computer-use.test.ts'].map(p => 'runtime/src/tests/' + p),
    artifacts: [targetedPath, 'runtime/evidence/P3-continuation-runner-profile-before.json', 'runtime/evidence/P3-continuation-runner-profile-after.json', 'runtime/evidence/P3-continuation-runner-profile.mjs', 'runtime/evidence/P3-continuation-runner-preservation-audit.json'].map(evidence), intermediate, targeted: { ...evidence(targetedPath), existingTests: existingTargetedTests, newTests: additionalTests, testsPassed: targetedTests, testsFailed: 0 },
    actualDriver: 'not_run', actualModel: 'not_run', actualExternalModelCalls: 0, actualServiceCalls: 0, actualGuiInvoked: false,
    continuationExecution: { continueTool: 'locally_verified', verifyTool: 'locally_verified_zero_input', runnerV2: 'locally_verified', processKillContinuation: 'six_local_cases_passed',
      preservation: 'Root deadline, cumulative limits, source artifacts and claimed parent retained across local execution, compaction and process restart.' },
    performanceMeasuredThisSlice: 'intermediate_single_local_profile_only', historicalCost: { ...evidence(prior.historicalCost.path), currentDriverComparison: false }, remaining: workItem.remaining,
    knownLimits: [
      'The actual execution uses a local synthetic driver; real browser/OS/internal GUI, model quality and production ownership remain unvalidated.',
      'Legacy v1 checkpoints remain readable and reconcilable, but do not carry trustworthy cumulative counters and cannot authorize continuation.',
      'SIGKILL during a child observation before any input intent retains spent counters and conservatively blocks as unknown. Automatic no-input effect settlement is not implemented.',
      'Actual continuation recovery is exercised through depth two. The contract limit of eight successors is not a measured depth-eight performance guarantee.',
      'Parent proof validation still repeats source reads. Head merging reduces publications but introduces no cross-boundary artifact or authority cache.',
      'The profile is one intermediate local synthetic observation before and after head merging, not a stable latency or service-level guarantee; the saved script reconstructs the earlier inline command.',
      'New protocol fixtures use a 60-second execution watchdog or 20-second recovery lease to separate host disk contention from synthetic logical action deadlines; original input deadlines and cumulative caps are unchanged.',
      'No-input read verification receives a new bounded read lease, which does not renew the root write deadline.',
      'General retained-knowledge source-owner reauthentication and query-wide custody budgets retain the previously recorded limitations.',
      'Historical intermediate logs without a saved hash are checked for existence only.'],
    codeDigest: code.digest, build, buildManifest: evidence('runtime/dist/build-manifest.json'),
    buildFiles: buildFiles.map(file => ({ path: 'runtime/' + file.path, sha256: file.sha256 })),
    originals: { checked: originals.length, unchanged: true }, static: { links: links.size,
      json: jsonFiles.length + (jsonFiles.includes(recordPath) ? 0 : 1), jsonBeforeRecord: jsonFiles.length, jsonCountIncludesGeneratedRecord: true,
      failures, guidanceValid: true, verifiedWorkItems,
      historicalEvidence: { hashedFiles: historicalRefs.size, unchanged: true, unpinnedIntermediateExistenceOnly: [...unpinnedHistoricalPaths].sort() } },
    generator: { path: __filename, sha256: hash(fs.readFileSync(__filename)) }, gitInitialized: false, sourceChanges, sources,
  };
  fs.writeFileSync(path.join(root, recordPath), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ recordPath, testsPassed, sourceFiles: sources.length, buildFiles: build.fileCount, sourceChanges,
    originals: originals.length, links: links.size, json: record.static.json, codeDigest: code.digest, build,
    localContracts: record.localContracts, workItemStatus: record.workItemStatus, failures }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
