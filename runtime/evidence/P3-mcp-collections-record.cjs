// Produces only the local MCP evidence record from already completed, explicitly supplied local runs.
// It does not build, run tests, start a server/browser, or contact an external service.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const recordPath = 'runtime/evidence/P3-mcp-collections-local-verification.json';
const planPath = 'design/chapters/P3-mcp-collections-plan.md';
const priorPath = 'runtime/evidence/P3-mcp-adapter-local-verification.json';
const priorSha256 = 'd3ba4b2d35f26b7a630e208e44d7c38c74c17861255e5821d3f5e4c2bc45677f';
const priorBytes = 227451;
const priorTests = 1992;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fail(reason, details) { throw new Error(reason + (details === undefined ? '' : ':' + JSON.stringify(details))); }
function localPath(value) {
  if (typeof value !== 'string' || !value) fail('invalid_evidence_path');
  const resolved = path.resolve(root, value); const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith('../')) fail('evidence_outside_workspace', value);
  return resolved;
}
function read(file) {
  const full = localPath(file); const stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('unsupported_evidence_file_type', file);
  return fs.readFileSync(full);
}
const json = file => JSON.parse(read(file).toString('utf8'));
function evidence(file) {
  const bytes = read(file);
  return { path: path.relative(root, localPath(file)), sha256: hash(bytes), bytes: bytes.length };
}
function walk(directory) {
  return fs.readdirSync(localPath(directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(file);
    if (!entry.isFile()) fail('unsupported_verification_file_type', file);
    return [file];
  });
}
function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail('invalid_integer', label); return value;
}
function metric(text, name) {
  const values = [...text.matchAll(new RegExp('^(?:ℹ |# )' + name + ' ([0-9]+(?:\\.[0-9]+)?)\\s*$', 'gm'))];
  return values.length === 1 ? Number(values[0][1]) : null;
}
function testLog(run, name) {
  if (!run || run.exitCode !== 0 || typeof run.command !== 'string' || !run.command.trim()) fail('run_not_successful', name);
  const text = read(run.log).toString('utf8'); const passed = metric(text, 'pass'); const skipped = metric(text, 'skipped');
  const total = metric(text, 'tests'); const failed = metric(text, 'fail'); const cancelled = metric(text, 'cancelled');
  const durationMs = metric(text, 'duration_ms');
  integer(run.testsPassed, name + '.testsPassed', 1); integer(run.testsSkipped ?? 0, name + '.testsSkipped');
  if (passed !== run.testsPassed || skipped !== (run.testsSkipped ?? 0) || failed !== 0 || cancelled !== 0 ||
    total !== passed + skipped || !(durationMs > 0) || skipped > 0 && !run.skipReason) fail('run_log_mismatch', name);
  return { ...evidence(run.log), command: run.command, exitCode: run.exitCode, tests: total, testsPassed: passed,
    testsFailed: failed, testsCancelled: cancelled, testsSkipped: skipped, skipReason: run.skipReason ?? null, durationMs, text };
}
function atPointer(value, pointer) {
  if (pointer === '') return value;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) fail('invalid_json_pointer', pointer);
  for (const token of pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, token)) fail('missing_summary_field', pointer);
    value = value[token];
  }
  return value;
}
function section(input, name, sourceDigest) {
  if (!input || input.status !== 'passed' || !Array.isArray(input.checks) || input.checks.length < 1 ||
    !Array.isArray(input.logs) || !input.logs.length) fail('observation_section_incomplete', name);
  const summary = json(input.summary); const checks = input.checks.map(check => {
    if (!check || !Object.hasOwn(check, 'equals')) fail('invalid_summary_check', name);
    const actual = atPointer(summary, check.pointer);
    if (JSON.stringify(actual) !== JSON.stringify(check.equals)) fail('summary_check_failed', { name, pointer: check.pointer });
    return { pointer: check.pointer, equals: check.equals };
  });
  if (name !== 'shutdown' && atPointer(summary, input.sourceDigestPointer) !== sourceDigest) fail('observation_source_stale', name);
  if (!input.observation || typeof input.observation !== 'object' || Array.isArray(input.observation)) fail('observation_description_missing', name);
  const artifacts = (input.artifacts ?? []).map(evidence);
  return { status: 'passed', summary: evidence(input.summary), logs: input.logs.map(evidence), artifacts, checkedFields: checks,
    sourceDigestPointer: input.sourceDigestPointer ?? null, observationDeclaredByRecorder: input.observation };
}
function preserveHistory(prior) {
  const artifacts = new Map(); const unpinned = new Set(); const failures = []; const chain = []; const seen = new Set();
  function check(ref) {
    try { const actual = evidence(ref.path);
      if (actual.sha256 !== ref.sha256 || ref.bytes !== undefined && actual.bytes !== ref.bytes) failures.push(ref.path);
      return actual;
    } catch { failures.push(ref.path); return null; }
  }
  // Historical sources/build manifests describe the old build. Their nested file pins are not current-file requirements.
  function fixedArtifacts(record) {
    const excluded = new Set(['sources', 'sourceChanges', 'build', 'buildFiles', 'buildManifest', 'priorVerification', 'priorChain']);
    const visit = (value, sectionName) => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.path === 'string') {
        const relative = path.relative(root, localPath(value.path));
        if (relative.startsWith('runtime/evidence/')) {
          if (typeof value.sha256 === 'string') { const result = check(value); if (result) artifacts.set(relative, result); }
          else if (sectionName === 'intermediate' || value.path.endsWith('.log')) {
            unpinned.add(relative); if (!fs.existsSync(localPath(relative))) failures.push(relative);
          }
        }
      }
      for (const child of Object.values(value)) visit(child, sectionName);
    };
    for (const [sectionName, value] of Object.entries(record)) if (!excluded.has(sectionName)) visit(value, sectionName);
  }
  let file = priorPath; let record = prior;
  for (;;) {
    if (seen.has(file) || seen.size >= 64) fail('verification_parent_cycle_or_limit'); seen.add(file);
    fixedArtifacts(record); const own = evidence(file); const log = record.log?.sha256 ? check(record.log) : null;
    const parent = record.priorVerification;
    let parentUnchanged = true;
    if (parent?.path && parent?.sha256) {
      const parentActual = check(parent); const parentRecord = json(parent.path);
      parentUnchanged = !!parentActual && parentActual.sha256 === parent.sha256 && parentRecord.testsPassed === parent.testsPassed &&
        record.previousTotal === parentRecord.testsPassed;
      if (!parentUnchanged) failures.push(file + ':parent');
    }
    chain.push({ ...own, testsPassed: record.testsPassed ?? null, logUnchanged: !!log && log.sha256 === record.log.sha256, parentUnchanged });
    if (!parent?.path || !parent?.sha256) break;
    file = parent.path; record = json(file);
  }
  if (JSON.stringify((prior.priorChain ?? []).map(ref => ref.path)) !== JSON.stringify(chain.slice(1).map(ref => ref.path))) failures.push('prior_chain_order');
  for (const ref of prior.priorChain ?? []) check(ref);
  for (const file of artifacts.keys()) unpinned.delete(file);
  return { chain, pinnedArtifacts: [...artifacts.values()], unpinnedIntermediateExistenceOnly: [...unpinned].sort(), failures };
}
function staticChecks() {
  const links = new Map(); const brokenLinks = []; const unclosedCodeBlocks = [];
  for (const file of [...walk('design').filter(value => value.endsWith('.md')), 'runtime/README.md']) {
    const text = read(file).toString('utf8'); let fenced = false;
    for (const line of text.split('\n')) if (/^\s*`{3,}/.test(line)) fenced = !fenced;
    if (fenced) unclosedCodeBlocks.push(file);
    for (const match of text.matchAll(/\[[^\]]*\]\((?:<([^>\n]+)>|([^\s)]+))\)/g)) {
      const target = match[1] ?? match[2];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
      const withoutAnchor = target.split('#')[0]; const location = /^(.*?)(?::(\d+))?$/.exec(withoutAnchor);
      const full = path.resolve(path.dirname(localPath(file)), location[1]);
      const key = full + (location[2] ? ':' + location[2] : ''); links.set(key, { full, line: location[2] });
    }
  }
  for (const [key, link] of links) {
    if (!fs.existsSync(link.full)) { if (link.full !== localPath(recordPath)) brokenLinks.push(key); }
    else if (link.line && Number(link.line) > fs.readFileSync(link.full, 'utf8').split('\n').length) brokenLinks.push(key);
  }
  const jsonFiles = [...walk('design'), ...walk('runtime/evidence'), ...walk('runtime/fixtures'), ...walk('runtime/guidance')].filter(file => file.endsWith('.json'));
  const invalidJson = []; for (const file of jsonFiles) try { json(file); } catch { invalidJson.push(file); }
  const guidanceMismatches = json('runtime/guidance/catalog.json').entries.filter(entry => {
    const bytes = read(path.join('runtime/guidance', entry.bodyFile)); return hash(bytes) !== entry.sha256 || bytes.length !== entry.byteLength;
  }).map(entry => entry.id);
  return { links: links.size, json: jsonFiles.length + (jsonFiles.includes(recordPath) ? 0 : 1), jsonBeforeRecord: jsonFiles.length,
    jsonCountIncludesGeneratedRecord: true, failures: { brokenLinks, unclosedCodeBlocks, invalidJson, guidanceMismatches } };
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
const same = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));
function dependencies(_input, prior) {
  const oldSources = new Map(prior.sources.map(ref => [ref.path, ref.sha256]));
  const currentPackage = evidence('runtime/package.json'); const currentLock = evidence('runtime/package-lock.json');
  if ([currentPackage, currentLock].some(ref => oldSources.get(ref.path) !== ref.sha256)) fail('dependency_changed');
  return { intentional: false, unchanged: true, before: currentLock, currentPackage, currentLock,
    installRuns: [], sdk: [], directChanges: [], lockDelta: {added: [], modified: [], removed: []} };
}
async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--input') fail('usage', 'node runtime/evidence/P3-mcp-collections-record.cjs --input <finalized-input.json>');
  const inputPath = path.relative(root, localPath(process.argv[3])); const inputRef = evidence(inputPath); const input = json(inputPath);
  if (input.schemaVersion !== 1 || input.ready !== true || process.version !== 'v24.20.0') fail('verification_input_not_final');
  if (typeof input.backlogRevision !== 'string' || input.backlogRevision === 'v0.39') fail('new_backlog_revision_required');
  const prior = json(priorPath); const previous = evidence(priorPath);
  if (previous.sha256 !== priorSha256 || previous.bytes !== priorBytes || prior.backlogRevision !== 'v0.39' || prior.testsPassed !== priorTests) fail('prior_record_changed');
  const dependencyChange = dependencies(input.dependencyChange, prior);
  const verify = testLog(input.verify, 'verify'); const targeted = testLog(input.targeted, 'targeted');
  if (input.verify.command !== 'npm run verify') fail('not_whole_runtime_verification');
  const backlog = json('design/implementation-backlog.json'); const tasks = new Map(backlog.work_items.map(item => [item.id, item]));
  const work = tasks.get('P3-01'); const verifiedWorkItems = backlog.work_items.filter(item => item.status === 'verified').length;
  const groups = work?.verification?.new_test_groups;
  if (!groups || typeof groups !== 'object' || Array.isArray(groups) || !Object.keys(groups).length) fail('missing_new_test_groups');
  Object.values(groups).forEach(value => integer(value, 'new_test_groups', 1));
  const additionalTests = Object.values(groups).reduce((sum, value) => sum + value, 0);
  const invalidDependencies = backlog.work_items.flatMap(item => item.depends_on.filter(id => !tasks.has(id) || item.status === 'verified' && tasks.get(id).status !== 'verified').map(id => item.id + ':' + id));
  if (tasks.size !== backlog.work_items.length) invalidDependencies.push('duplicate_work_item_id');
  if (backlog.revision !== input.backlogRevision || work?.status !== 'in_progress' || work.plan !== planPath ||
    work.verification?.local_contracts !== 'partially_verified' || work.verification?.record !== recordPath ||
    work.verification?.actual_model !== 'not_run' || work.verification?.actual_mcp !== 'local_stdio_verified' || verifiedWorkItems !== 9 ||
    work.verification.tests_passed !== verify.testsPassed || work.verification.additional_tests !== additionalTests ||
    priorTests + additionalTests !== verify.testsPassed || !Array.isArray(work.remaining) || !work.remaining.length) fail('work_scope_or_totals_mismatch');
  const manifestRef = evidence('design/extraction-manifest.json'); const manifest = json(manifestRef.path);
  const originals = [manifest.original, ...manifest.parts, manifest.joined, ...manifest.extraction.files];
  const originalMismatches = []; for (const ref of originals) {
    try { const actual = evidence(ref.path); if (actual.sha256 !== ref.sha256 || actual.bytes !== ref.bytes) originalMismatches.push(ref.path); }
    catch { originalMismatches.push(ref.path); }
  }
  const sourceFiles = [...walk('runtime/src'), ...walk('runtime/scripts'), ...walk('runtime/fixtures'), ...walk('runtime/guidance'),
    ...['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.core.json', '.nvmrc'].map(file => 'runtime/' + file)].sort();
  const sources = sourceFiles.map(file => ({ path: file, sha256: hash(read(file)) })); const oldSources = new Map(prior.sources.map(ref => [ref.path, ref.sha256]));
  const sourceChanges = sources.filter(ref => oldSources.get(ref.path) !== ref.sha256).map(ref => ({ path: ref.path, kind: oldSources.has(ref.path) ? 'modified' : 'added' }));
  const removedSources = prior.sources.filter(ref => !sourceFiles.includes(ref.path)).map(ref => ref.path);
  const historical = preserveHistory(prior); const staticResult = staticChecks();
  const failures = { originalMismatches, invalidDependencies, removedSources, historicalEvidenceMismatches: historical.failures, ...staticResult.failures };
  const git = ['.git', 'runtime/.git'].map(file => { try { fs.lstatSync(localPath(file)); return { path: file, absent: false }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return { path: file, absent: true }; } });
  const evaluation = await import(pathToFileURL(localPath('runtime/dist/infrastructure/local-evaluation.js')).href);
  const code = await evaluation.evaluationCodePin(localPath('runtime')); const build = await evaluation.verifyEvaluationBuild(localPath('runtime'));
  const buildFiles = await evaluation.evaluationBuildFiles(localPath('runtime'));
  if (code.digest !== build.sourceDigest) fail('source_build_digest_mismatch');
  const observations = Object.fromEntries(['protocol', 'recovery', 'shutdown'].map(name => [name, section(input[name], name, code.digest)]));
  const protocol = input.protocol.observation; const recovery = input.recovery.observation;
  if (protocol.transport !== 'stdio' || protocol.effects !== 'read-only' || protocol.actualLocalSdkServer !== true ||
    typeof protocol.negotiatedProtocolVersion !== 'string' || !protocol.negotiatedProtocolVersion ||
    !Array.isArray(protocol.backends) || !same([...protocol.backends].sort(), ['file-journal', 'sqlite']) ||
    protocol.actualModelCalls !== 0 || protocol.externalServiceCalls !== 0 || protocol.httpOrOAuthVerified !== false ||
    protocol.readCollectionResumeVerified !== true || protocol.writeEffectsVerified !== false || !protocol.costDenominators)
    fail('protocol_scope_incomplete');
  if (recovery.cancellationIsNotRemoteCompletion !== true || recovery.hiddenCallRetries !== 0 ||
    recovery.storedResultDoesNotRecallServer !== true || input.shutdown.observation.ownedProcessesStopped !== true ||
    input.shutdown.observation.temporaryFilesCleaned !== true) fail('recovery_or_shutdown_incomplete');
  const rows = verify.text.split('\n').filter(line => line.startsWith('{"inspected":'));
  const architecture = rows.length === 1 ? JSON.parse(rows[0]) : {};
  integer(input.expectedInnerFiles, 'expectedInnerFiles', 1);
  const fixture = json('runtime/evidence/fixture-baseline.json');
  if (architecture.inspected !== input.expectedInnerFiles || !Array.isArray(architecture.failures) || architecture.failures.length ||
    !fixture.passed || fixture.scenarios !== 4 || fixture.checkpoints !== 22 || !/"scenarios":\s*4/.test(verify.text) ||
    !/"checkpoints":\s*22/.test(verify.text) || !/"passed":\s*true/.test(verify.text) || !verify.text.includes('> tsc -p tsconfig.core.json') ||
    !verify.text.includes('> tsc -p tsconfig.json && node scripts/record-build.mjs') || originals.length !== 1973 ||
    git.some(item => !item.absent) || Object.values(failures).some(values => values.length)) fail('verification_incomplete', failures);
  if (!Array.isArray(input.acceptanceEvidence) || !input.acceptanceEvidence.length) fail('acceptance_evidence_missing');
  const acceptanceEvidence = input.acceptanceEvidence.map(evidence);
  const artifacts = [...(input.additionalArtifacts ?? []).map(evidence), ...Object.values(observations).flatMap(value => [value.summary, ...value.logs, ...value.artifacts])];
  const finalPins = [previous, inputRef, manifestRef, verify, targeted, ...historical.chain, ...artifacts, ...acceptanceEvidence,
    ...historical.pinnedArtifacts, dependencyChange.before, dependencyChange.currentPackage, dependencyChange.currentLock,
    ...dependencyChange.installRuns.map(run => run.log), ...dependencyChange.sdk.map(value => value.installedManifest)];
  if (finalPins.some(ref => hash(read(ref.path)) !== ref.sha256) || sources.some(ref => hash(read(ref.path)) !== ref.sha256)) fail('input_changed_during_verification');
  const { text: verifyText, ...verification } = verify; const { text: targetedText, ...targetedRecord } = targeted;
  void verifyText; void targetedText;
  const record = { createdAt: new Date().toISOString(), workItems: ['P3-01'], status: 'verified_local_mcp_collection_resume_slice',
    workItemStatus: 'in_progress', localContracts: 'partially_verified', backlogRevision: input.backlogRevision, plan: planPath,
    scope: 'Pinned TypeScript MCP SDK client/server communicate with an owned synthetic stdio fixture. Host-approved collection sources use the existing collection ledger, per-response raw proofs and explicit resume, with real owned-worker SIGKILL recovery. This is not internal MCP integration, HTTP/OAuth, write-effect recovery or whole-plan completion.',
    command: verification.command, exitCode: verification.exitCode, node: process.version.slice(1), executable: process.execPath,
    platform: process.platform, architectureHost: process.arch, testsPassed: verification.testsPassed, testsFailed: verification.testsFailed,
    testsTotal: verification.tests, testsSkipped: verification.testsSkipped, durationMs: verification.durationMs,
    previousTotal: priorTests, additionalTests, newTestGroups: groups, log: evidence(input.verify.log), verification, targeted: targetedRecord,
    priorVerification: { ...previous, testsPassed: priorTests, logUnchanged: historical.chain[0].logUnchanged, parentUnchanged: historical.chain[0].parentUnchanged },
    priorChain: historical.chain, architecture: { innerFiles: architecture.inspected, violations: 0, coreTypecheck: 'passed' },
    dependencyLockUnchanged: true, dependencyChange, fixtureScenarios: 4, fixtureCheckpoints: 22, fixturePassed: true,
    acceptanceEvidence: acceptanceEvidence.map(ref => ref.path), observations, artifacts,
    actualMcp: 'local_stdio_verified', actualModel: 'not_run', actualExternalModelCalls: 0, actualServiceCalls: 0,
    actualInternalMcpInvoked: false, actualGuiInvoked: false, actualWriteEffectsVerified: false, readCollectionResumeVerified: true,
    performanceMeasuredThisSlice: 'bounded_local_protocol_counters_only', remaining: work.remaining,
    knownLimits: ['The host-approved read-only stdio fixture does not establish HTTP/OAuth, internal-service scope or production deployment.',
      'MCP annotations and remote text do not authorize tools or automatically become Evidence.',
      'SDK-decoded JSON preservation is distinct from original wire bytes.',
      'Cancellation notification, rejected waiting promise and process termination are not proof of remote execution cancellation.',
      'The first source snapshot is opaque; later pages must preserve it. Accepted durable successes survive resume; unaccepted responses may require explicit rereading.',
      'Protocol/usage claims are retained with their source summaries and explicit leaf checks; this helper does not rerun the experiment.',
      'Historical source/build pins remain in immutable earlier records. The new source/build stamp and unchanged dependency lock are checked separately.',
      'Older intermediate logs without a saved hash are checked for existence only.', ...(input.knownLimits ?? [])],
    codeDigest: code.digest, build, buildManifest: evidence('runtime/dist/build-manifest.json'),
    buildFiles: buildFiles.map(ref => ({ path: 'runtime/' + ref.path, sha256: ref.sha256 })),
    originals: { checked: originals.length, unchanged: true, manifest: manifestRef }, git, gitInitialized: false,
    static: { ...staticResult, failures, guidanceValid: true, verifiedWorkItems,
      historicalEvidence: { hashedFiles: historical.pinnedArtifacts.length, unchanged: true, unpinnedIntermediateExistenceOnly: historical.unpinnedIntermediateExistenceOnly } },
    input: inputRef, generator: evidence(path.relative(root, __filename)), sourceChanges, sources };
  fs.writeFileSync(localPath(recordPath), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ recordPath, testsPassed: record.testsPassed, testsSkipped: record.testsSkipped, sourceFiles: sources.length,
    buildFiles: build.fileCount, originals: originals.length, links: staticResult.links, json: staticResult.json, codeDigest: code.digest,
    dependencyChange: { direct: dependencyChange.directChanges, added: dependencyChange.lockDelta.added.length,
      modified: dependencyChange.lockDelta.modified.length, removed: dependencyChange.lockDelta.removed.length },
    localContracts: record.localContracts, workItemStatus: record.workItemStatus, failures }));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
