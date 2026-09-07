const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const root = '/Users/seunghanee/Documents/secumon';
const recordPath = 'runtime/evidence/P3-runtime-reconciliation-local-verification.json';
const priorPath = 'runtime/evidence/P3-computer-receipts-local-verification.json';
const logPath = 'runtime/evidence/P3-runtime-reconciliation-verify.log';
const targetedPath = 'runtime/evidence/P3-runtime-reconciliation-targeted-4.log';
const groupCounts = { contracts: 11, runtime: 16, context: 16, effectBoundaries: 16, processRecovery: 8, authority: 6, workView: 6, outbox: 18, provenance: 10, edgeRecovery: 8 };
const read = p => fs.readFileSync(path.join(root, p));
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
const sourceFiles = [...walk('runtime/src'), ...walk('runtime/scripts'), ...walk('runtime/fixtures'), ...walk('runtime/guidance'),
  ...['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.core.json', '.nvmrc'].map(p => 'runtime/' + p)].sort();
const sources = sourceFiles.map(p => ({ path: p, sha256: hash(read(p)) }));
const priorSources = new Map(prior.sources.map(file => [file.path, file.sha256]));
const sourceChanges = sources.filter(file => priorSources.get(file.path) !== file.sha256).map(file => ({ path: file.path, kind: priorSources.has(file.path) ? 'modified' : 'added' }));
const removedSources = prior.sources.filter(file => !sourceFiles.includes(file.path)).map(file => file.path);
const dependencyLockUnchanged = hash(read('runtime/package-lock.json')) === priorSources.get('runtime/package-lock.json');
const historicalArtifactMismatches = (prior.artifacts ?? []).filter(ref => hash(read(ref.path)) !== ref.sha256).map(ref => ref.path);
const priorChain = []; const seen = new Set(); let chainPath = priorPath; let chainRecord = prior;
while (chainRecord) {
  if (seen.has(chainPath)) throw new Error('verification_parent_cycle'); seen.add(chainPath);
  const node = { ...evidence(chainPath), testsPassed: chainRecord.testsPassed ?? null, logUnchanged: true, parentUnchanged: true };
  if (chainRecord.log?.path && chainRecord.log?.sha256) node.logUnchanged = hash(read(chainRecord.log.path)) === chainRecord.log.sha256;
  const parent = chainRecord.priorVerification;
  if (parent?.path && parent?.sha256) node.parentUnchanged = hash(read(parent.path)) === parent.sha256;
  priorChain.push(node); if (!parent?.path || !parent?.sha256) break;
  chainPath = parent.path; chainRecord = json(chainPath);
}
const historicalChainMismatches = priorChain.filter(item => !item.logUnchanged || !item.parentUnchanged).map(item => item.path);
const intermediate = walk('runtime/evidence').filter(p => /^runtime\/evidence\/P3-runtime-reconciliation-(?:typecheck|build|targeted)-\d+\.log$/.test(p)).map(p => ({
  ...evidence(p), tests: metric(read(p).toString(), 'tests'), passed: metric(read(p).toString(), 'pass'), failed: metric(read(p).toString(), 'fail'),
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
    backlog.revision === 'v0.35' && verifiedWorkItems === 9;
  if (process.version !== 'v24.20.0' || metric(log, 'tests') !== 1771 || testsPassed !== 1771 || testsFailed !== 0 || !(durationMs > 0) ||
    prior.testsPassed !== 1656 || prior.testsPassed + additionalTests !== testsPassed || metric(targeted, 'pass') !== 115 || metric(targeted, 'fail') !== 0 ||
    architecture.inspected !== 96 || !Array.isArray(architecture.failures) || architecture.failures.length || !fixture.passed || fixture.scenarios !== 4 ||
    fixture.checkpoints !== 22 || !/"scenarios":\s*4/.test(log) || !/"checkpoints":\s*22/.test(log) || !/"passed":\s*true/.test(log) ||
    !log.includes('> tsc -p tsconfig.core.json') || !log.includes('> tsc -p tsconfig.json && node scripts/record-build.mjs') || originals.length !== 1973 ||
    !dependencyLockUnchanged || !workItemScopeValid || Object.values(failures).some(values => values.length))
    throw new Error('verification_incomplete:' + JSON.stringify({ failures, workItemScopeValid, testsPassed, testsFailed, durationMs, architecture,
      originalCount: originals.length, verifiedWorkItems, backlogRevision: backlog.revision }));
  if (fs.existsSync(path.join(root, '.git'))) throw new Error('unexpected_git_repository');
  const record = { createdAt: new Date().toISOString(), workItems: ['P3-04'], status: 'verified_local_explicit_computer_reconciliation',
    workItemStatus: workItem.status, localContracts: workItem.verification.local_contracts, backlogRevision: backlog.revision,
    scope: 'Explicit budgeted runtime receipt lookup with immutable original input, durable intent/response/proof and command-receipt provenance. Late input returns, cancellation, SIGKILL recovery, compaction, models, completion, delivery and current screen reads preserve effect uncertainty. Remaining-step continuation and real GUI driver remain future work.',
    command: 'npm run verify', exitCode: 0, node: process.version.slice(1), executable: process.execPath, platform: process.platform, architectureHost: process.arch,
    testsPassed, testsFailed, durationMs, previousTotal: prior.testsPassed, additionalTests, newTestGroups: groupCounts,
    log: evidence(logPath), priorVerification: { ...evidence(priorPath), testsPassed: prior.testsPassed, logUnchanged: priorChain[0].logUnchanged,
      parentUnchanged: priorChain[0].parentUnchanged }, priorChain,
    architecture: { innerFiles: architecture.inspected, violations: architecture.failures.length, coreTypecheck: 'passed' }, dependencyLockUnchanged,
    fixtureScenarios: fixture.scenarios, fixtureCheckpoints: fixture.checkpoints, fixturePassed: fixture.passed,
    acceptanceEvidence: ['computer-reconciliation-contracts.test.ts', 'computer-reconciliation.test.ts', 'computer-reconciliation-context.test.ts',
      'effect-proofs.test.ts', 'computer-reconciliation-recovery.test.ts', 'computer-reconciliation-authority.test.ts', 'computer-reconciliation-work-view.test.ts',
      'computer-reconciliation-outbox.test.ts', 'computer-reconciliation-provenance.test.ts', 'computer-reconciliation-edges.test.ts'].map(p => 'runtime/src/tests/' + p),
    artifacts: [targetedPath].map(evidence), intermediate, actualExternalModelCalls: 0, actualServiceCalls: 0, actualGuiInvoked: false,
    performanceMeasuredThisSlice: false, historicalCost: { ...evidence(prior.historicalCost.path), currentDriverComparison: false }, remaining: workItem.remaining,
    knownLimits: ['The synthetic app and receipts share a single atomic file; this does not establish exactly-once operation for real GUI drivers.',
      'One host owns the file; sequential epoch checks are not a cross-process lock or compare-and-swap transaction.',
      'Receipts are capped at 256; completed operation slots are not silently reclaimed. Retention and safe archival are later operational work.',
      'Absent receipts remain unknown. Applied receipts alone establish neither current postconditions nor goal completion.',
      'Remaining-step continuation is not implemented. Reconciliation records are capped at 1000 and never silently discarded.',
      'Explicit lookup is a host service, not a general model tool or an unknown-effect bypass. Callers require current read authority and remaining work/grant budget.',
      'If an original source artifact already pinned by generic commits is physically gone, even invalidation persistence may fail; callers remain blocked by errors.',
      'Effects and repository receipts are trusted host evidence rather than cryptographic attestations from a real UI. Cross-store atomicity and power-loss guarantees are unchanged.',
      'Power-loss, real model quality, real GUI latency, billing savings and selected deployment environments are not validated.'],
    codeDigest: code.digest, build, buildManifest: evidence('runtime/dist/build-manifest.json'),
    buildFiles: buildFiles.map(file => ({ path: 'runtime/' + file.path, sha256: file.sha256 })),
    originals: { checked: originals.length, unchanged: true }, static: { links: links.size,
      json: jsonFiles.length + (jsonFiles.includes(recordPath) ? 0 : 1), jsonBeforeRecord: jsonFiles.length, jsonCountIncludesGeneratedRecord: true,
      failures, guidanceValid: true, verifiedWorkItems },
    generator: { path: __filename, sha256: hash(fs.readFileSync(__filename)) }, gitInitialized: false, sourceChanges, sources,
  };
  fs.writeFileSync(path.join(root, recordPath), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ recordPath, testsPassed, sourceFiles: sources.length, buildFiles: build.fileCount, sourceChanges,
    originals: originals.length, links: links.size, json: record.static.json, codeDigest: code.digest, build,
    localContracts: record.localContracts, workItemStatus: record.workItemStatus, failures }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
