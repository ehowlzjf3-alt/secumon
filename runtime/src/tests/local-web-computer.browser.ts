import test, { after, before, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startLocalWebComputerFixture } from '../infrastructure/local-web-computer-fixture.js';
import { InstrumentedWebComputerDriver, createPlaywrightWebComputerTransport } from '../infrastructure/instrumented-web-computer-driver.js';
import { SyntheticComputerClock, SyntheticComputerDriver } from '../infrastructure/synthetic-computer-driver.js';
import { computerOperationIdentity } from '../application/computer-operation-contracts.js';
import { evaluationCodePin } from '../infrastructure/local-evaluation.js';
import type { ComputerDriver } from '../application/computer-use-ports.js';
import type { ComputerStep, ComputerView } from '../domain/computer-use.js';
import type { TaskSpec } from '../domain/model.js';
import { computerActor, computerActInput, computerHarness, computerResult, observeComputer, saveNoteSteps, submitComputerTask,
  type ComputerBackend, type ComputerHarness } from './computer-use-helpers.js';

// Explicit browser gate, excluded from *.test.js. Missing host-supplied Playwright fails this gate; no downloads or silent skip.
interface Page {
  url(): string;
  goto(url: string): Promise<unknown>;
  reload(): Promise<unknown>;
  bringToFront(): Promise<void>;
  close(): Promise<void>;
  evaluate<T, A>(fn: (argument: A) => T | Promise<T>, argument: A): Promise<T>;
  getByRole(role: string, options: { name: string; exact?: boolean }): { pressSequentially(text: string): Promise<void>; click(): Promise<void> };
  route(pattern: string, handler: (route: { continue(): Promise<void> }) => Promise<void>): Promise<void>;
  waitForFunction<T, A>(fn: (argument: A) => T, argument: A, options?: { timeout?: number }): Promise<unknown>;
}
interface Browser { newPage(): Promise<Page>; close(): Promise<void>; version(): string }
interface Playwright { chromium: { launch(options: { headless: boolean; channel?: string }): Promise<Browser> } }
class WallComputerClock extends SyntheticComputerClock { override now(): number { return Date.now(); } }
let browser: Browser;
let codeDigest: string;
const comparisons: Record<string, unknown>[] = [];
const evidenceDirectory = process.env['SECUMON_WEB_EVIDENCE_DIR'];
let opened = 0; let closed = 0;
before(async () => {
  codeDigest = (await evaluationCodePin(resolve('.'))).digest;
  const modulePath = process.env['SECUMON_PLAYWRIGHT_MODULE'];
  if (!modulePath) throw new Error('Set SECUMON_PLAYWRIGHT_MODULE to an installed Playwright entry file; browser gate never installs dependencies');
  const playwright = await import(pathToFileURL(resolve(modulePath)).href) as Playwright;
  const channel = process.env['SECUMON_BROWSER_CHANNEL'];
  browser = await playwright.chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
});
after(async () => {
  const version = browser?.version(); await browser?.close();
  if (evidenceDirectory) {
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(join(evidenceDirectory, 'P3-local-web-driver-comparison.json'), JSON.stringify({ schemaVersion: 1, codeDigest, browserVersion: version,
      nativeInput: false, modelCalls: 0, sameGoal: 'Save note=reviewed once and verify fresh savedNote', cells: comparisons,
      allEightCellsPassed: comparisons.length === 8 && comparisons.every(cell => cell['complete'] === true && cell['saveCount'] === 1 && cell['inputCount'] === 2),
      denominator: 'One invocation per cell; paired batch/individual semantic outcome. Timing is observational, not a benchmark.' }, null, 2) + '\n');
    await writeFile(join(evidenceDirectory, 'P3-local-web-driver-shutdown.json'), JSON.stringify({ browserClosed: !!browser, fixtureServersOpened: opened,
      fixtureServersClosed: closed, allOwnedFixturesClosed: opened === closed }, null, 2) + '\n');
  }
});

async function setup(t: TestContext, options: Parameters<typeof startLocalWebComputerFixture>[0] = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'local-web-computer-'));
  const fixture = await startLocalWebComputerFixture({ stateFile: join(directory, 'app.json'), ...options }); opened++;
  const page = await browser.newPage();
  t.after(async () => { try { await page.close(); } finally { await fixture.close(); closed++; await rm(directory, { recursive: true, force: true }); } });
  await page.goto(fixture.url); await page.bringToFront();
  const driver = new InstrumentedWebComputerDriver(createPlaywrightWebComputerTransport(page, fixture.url));
  return { directory, fixture, page, driver };
}
async function grant(driver: ComputerDriver, attemptId = 'browser-attempt') {
  const signal = new AbortController().signal;
  const lease = await driver.acquire({ sessionId: 'synthetic-document', workId: 'browser-work', attemptId, deadlineAt: Date.now() + 30000 }, signal);
  const observed = await driver.observe(lease, { maxElements: 40, maxBytes: 32768 }, signal);
  return { lease, view: observed.view, signal };
}
async function renderer(page: Page) {
  return page.evaluate(() => (window as unknown as { secumonComputer: { snapshot(): { domInputsDispatched: number; domEventsHandled: number; bridgeCalls: number; httpCalls: number; requestBytes: number; responseBytes: number } } }).secumonComputer.snapshot(), undefined);
}
function input(view: ComputerView, operationId: string, step: ComputerStep = saveNoteSteps[0]!) {
  return { operationId, basis: view, targetRef: view.elements.find(value => value.role === step.action.target.role && value.name === step.action.target.name)!.ref,
    action: step.action, deadlineAt: Date.now() + 30000 };
}
async function run(h: ComputerHarness, steps: ComputerStep[], observationId?: string) {
  const basis = observationId ?? (await observeComputer(h)).observationId;
  const attempt = await submitComputerTask(h, 'act', computerActInput(basis, steps, 30000));
  await h.runtime.execute(h.workId, attempt.id); await h.runtime.settlePending(attempt.id); await h.runtime.adopt(h.workId, attempt.id);
  return { attemptId: attempt.id, result: await computerResult(h, attempt.id) };
}
for (const backend of ['sqlite', 'file-journal'] as ComputerBackend[]) {
  for (const kind of ['synthetic', 'web'] as const) for (const sequence of ['individual', 'batch'] as const) {
    test(`same goal ${backend}/${kind}/${sequence}: save once through the real runtime`, { timeout: 120000 }, async t => {
      const web = kind === 'web' ? await setup(t) : null;
      const clock = web ? new WallComputerClock() : new SyntheticComputerClock(Date.now());
      const driver = web?.driver ?? new SyntheticComputerDriver({ clock });
      const h = await computerHarness(backend, { clock, driver, leaseMs: 60000, limits: { maxDurationMs: 30000 } });
      t.after(() => h.close()); const started = performance.now();
      if (sequence === 'batch') assert.equal((await run(h, saveNoteSteps)).result.status, 'success');
      else {
        const first = await run(h, [saveNoteSteps[0]!]); assert.equal(first.result.status, 'success');
        assert.ok(first.result.output && typeof first.result.output === 'object' && !Array.isArray(first.result.output));
        const observationId = first.result.output['observationId']; assert.equal(typeof observationId, 'string');
        assert.equal((await run(h, [saveNoteSteps[1]!], observationId as string)).result.status, 'success');
      }
      assert.equal((await h.runtime.step(h.workId)).kind, 'complete');
      const state = (await h.state.get(h.workId))!;
      assert.equal(state.modelCalls.length, 0);
      const snapshot = web ? web.fixture.snapshot() : (driver as SyntheticComputerDriver).snapshot();
      const app = snapshot;
      assert.equal(app.savedNote, 'reviewed'); assert.equal(app.saveCount, 1); assert.equal(app.inputCount, 2);
      const rendererMetrics = web ? await renderer(web.page) : null;
      if (rendererMetrics) { assert.equal(rendererMetrics.domInputsDispatched, 2); assert.equal(rendererMetrics.domEventsHandled, 2); }
      let transportCalls = 0; let internalOperations = 0;
      for (const attempt of state.attempts) if (attempt.resultArtifact) {
        const result = await computerResult(h, attempt.id); transportCalls += result.usage?.transportCalls ?? 0; internalOperations += result.usage?.internalOperations ?? 0;
      }
      comparisons.push({ backend, driver: kind, sequence, complete: true, saveCount: app.saveCount, inputCount: app.inputCount,
        highLevelToolCalls: state.attempts.length, transportCalls, internalOperations, durationMs: performance.now() - started,
        ...(web ? { fixtureMetrics: snapshot, rendererMetrics } : {}) });
    });
  }
}

test('actual Web DOM: stale refs, lost focus, duplicate/disabled targets and partial views never send an input', { timeout: 60000 }, async t => {
  for (const mutation of [{ kind: 'rerender' }, { kind: 'focus', focused: false }, { kind: 'target', name: 'Note', disabled: true },
    { kind: 'target', name: 'Note', duplicate: true }, { kind: 'target', name: 'Note', hidden: true }] as const) {
    const web = await setup(t); const { lease, view, signal } = await grant(web.driver);
    await web.fixture.control(mutation);
    const result = await web.driver.act(lease, input(view, `blocked-${mutation.kind}`), signal, async () => {});
    assert.equal(result.status, 'not_applied'); assert.equal(web.fixture.snapshot().app.inputCount, 0);
    assert.equal((await renderer(web.page)).domInputsDispatched, 0);
  }
  const web = await setup(t); const { lease, signal } = await grant(web.driver);
  const partial = (await web.driver.observe(lease, { maxElements: 3, maxBytes: 32768 }, signal)).view;
  assert.equal(partial.partial, true);
  const result = await web.driver.act(lease, input(partial, 'partial'), signal, async () => {});
  assert.equal(result.status, 'not_applied'); assert.equal(web.fixture.snapshot().app.inputCount, 0);
  assert.equal((await renderer(web.page)).domInputsDispatched, 0);
});
test('actual Web DOM: renderer rechecks mutations made inside current authority callback', async t => {
  const web = await setup(t); const { lease, view, signal } = await grant(web.driver);
  const result = await web.driver.act(lease, input(view, 'late-rerender'), signal, async () => { await web.fixture.control({ kind: 'rerender' }); });
  assert.equal(result.status, 'not_applied'); assert.equal(web.fixture.snapshot().app.inputCount, 0);
  assert.equal((await renderer(web.page)).domInputsDispatched, 0);
});
test('actual Web DOM: reload invalidates old lease; a current read finds the exact old receipt without input', async t => {
  const web = await setup(t); const { lease, view, signal } = await grant(web.driver);
  const request = input(view, 'before-reload'); assert.equal((await web.driver.act(lease, request, signal, async () => {})).status, 'applied');
  await web.page.reload(); await web.page.bringToFront();
  await assert.rejects(web.driver.observe(lease, { maxElements: 40, maxBytes: 32768 }, signal));
  const reopened = new InstrumentedWebComputerDriver(createPlaywrightWebComputerTransport(web.page, web.fixture.url));
  assert.equal((await reopened.act(lease, request, signal, async () => {})).status, 'unknown');
  const fresh = await grant(web.driver, 'new-reader'); assert.notEqual(fresh.lease.epoch, lease.epoch);
  const found = await web.driver.lookup(fresh.lease, { identity: computerOperationIdentity(lease, request) }, signal, async () => {});
  assert.equal(found.status, 'found'); assert.equal(web.fixture.snapshot().app.inputCount, 1);
  const missing = await web.driver.lookup(fresh.lease, { identity: { ...computerOperationIdentity(lease, request), operationId: 'absent' } }, signal, async () => {});
  assert.equal(missing.status, 'unknown'); assert.equal(web.fixture.snapshot().app.inputCount, 1);
});
test('actual Web DOM: Search uses an observed change while waiting', async t => {
  const web = await setup(t, { searchDelayMs: 150 }); const { lease, view, signal } = await grant(web.driver);
  const step: ComputerStep = { action: { kind: 'click', target: { role: 'button', name: 'Search' } }, condition: { kind: 'fact_equals', key: 'resultsReady', value: true } };
  assert.equal((await web.driver.act(lease, input(view, 'search', step), signal, async () => {})).status, 'applied');
  const before = await web.driver.observe(lease, { maxElements: 40, maxBytes: 32768 }, signal);
  if (!before.view.facts['resultsReady']) {
    assert.equal((await web.driver.wait(lease, { afterRevision: before.view.revision, maxWaitMs: 1000, deadlineAt: Date.now() + 2000 }, signal)).status, 'changed');
  }
  const after = await web.driver.observe(lease, { maxElements: 40, maxBytes: 32768 }, signal);
  assert.equal(after.view.facts['resultsReady'], true); assert.equal(web.fixture.snapshot().app.inputCount, 1);
});
test('actual Web human editing: a delayed first save cannot overwrite later typed characters', { timeout: 30000 }, async t => {
  const web = await setup(t); await grant(web.driver);
  let release!: () => void; const held = new Promise<void>(done => { release = done; }); let first = true;
  await web.page.route('**/api/human', async route => { if (first) { first = false; await held; } await route.continue(); });
  await web.page.getByRole('textbox', { name: 'Note', exact: true }).pressSequentially('reviewed');
  release();
  await web.page.getByRole('button', { name: 'Save', exact: true }).click();
  await web.page.waitForFunction(() => document.getElementById('saved-note')?.textContent === 'reviewed', undefined, { timeout: 10000 });
  assert.equal(await web.page.evaluate(() => (document.getElementById('note') as HTMLTextAreaElement).value, undefined), 'reviewed');
  assert.equal(web.fixture.snapshot().app.note, 'reviewed'); assert.equal(web.fixture.snapshot().app.savedNote, 'reviewed'); assert.equal(web.fixture.snapshot().app.saveCount, 1);
});
test('actual Web form: non-pending DOM input is persisted as human editing and never receives an agent receipt', async t => {
  const web = await setup(t); const { lease, signal } = await grant(web.driver);
  await web.page.evaluate(() => {
    const note = document.getElementById('note') as HTMLTextAreaElement;
    note.value = 'reviewed'; note.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('[aria-label="Save"]') as HTMLButtonElement).click();
  }, undefined);
  await web.page.waitForFunction(() => document.getElementById('saved-note')?.textContent === 'reviewed', undefined, { timeout: 10000 });
  assert.equal(web.fixture.snapshot().app.savedNote, 'reviewed'); assert.equal(web.fixture.snapshot().app.inputCount, 2);
  assert.deepEqual(web.fixture.snapshot().receipts, []);
  await assert.rejects(web.driver.observe(lease, { maxElements: 40, maxBytes: 32768 }, signal), /computer_human_owned/);
});
test('actual Web app: closing and reopening the fixture preserves app+receipt and changes the epoch', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'web-reopen-')); const stateFile = join(directory, 'app.json');
  let fixture = await startLocalWebComputerFixture({ stateFile }); opened++; let page = await browser.newPage();
  t.after(async () => { try { await page.close(); } finally { await fixture.close(); closed++; await rm(directory, { recursive: true, force: true }); } });
  await page.goto(fixture.url); await page.bringToFront();
  const original = new InstrumentedWebComputerDriver(createPlaywrightWebComputerTransport(page, fixture.url)); const before = await grant(original);
  assert.equal((await original.act(before.lease, input(before.view, 'fill'), before.signal, async () => {})).status, 'applied');
  const filled = await original.observe(before.lease, { maxElements: 40, maxBytes: 32768 }, before.signal);
  const saving = input(filled.view, 'save', saveNoteSteps[1]!);
  assert.equal((await original.act(before.lease, saving, before.signal, async () => {})).status, 'applied');
  await page.close(); await fixture.close(); closed++;
  fixture = await startLocalWebComputerFixture({ stateFile }); opened++; page = await browser.newPage(); await page.goto(fixture.url); await page.bringToFront();
  const reopened = new InstrumentedWebComputerDriver(createPlaywrightWebComputerTransport(page, fixture.url)); const fresh = await grant(reopened, 'reopened-reader');
  assert.notEqual(fresh.lease.epoch, before.lease.epoch); assert.equal(fresh.view.facts['savedNote'], 'reviewed');
  assert.equal((await reopened.lookup(fresh.lease, { identity: computerOperationIdentity(before.lease, saving) }, fresh.signal, async () => {})).status, 'found');
  assert.equal(fixture.snapshot().app.inputCount, 2); assert.equal(fixture.snapshot().app.saveCount, 1); assert.equal((await renderer(page)).domInputsDispatched, 0);
});
for (const backend of ['sqlite', 'file-journal'] as ComputerBackend[]) {
  test(`${backend}: actual Web Save response loss is reconciled and verified without saving twice`, { timeout: 180000 }, async t => {
    const web = await setup(t); const clock = new WallComputerClock();
    const h = await computerHarness(backend, { clock, driver: web.driver, continuations: true, leaseMs: 60000, limits: { maxDurationMs: 30000 } }); t.after(() => h.close());
    web.fixture.injectNextAction({ loseResponseAfterSave: true });
    const source = await run(h, saveNoteSteps); assert.equal(source.result.effectState, 'unknown');
    assert.equal(web.fixture.snapshot().app.saveCount, 1);
    const state = (await h.state.get(h.workId))!; const parent = state.attempts.find(value => value.id === source.attemptId)!;
    assert.ok(parent.computerUse);
    const record = await h.computerReconciliations.reconcile(h.workId, `reconcile-${source.attemptId}`, computerActor,
      { attemptId: source.attemptId, checkpointId: parent.computerUse.head.id });
    assert.equal(record.status, 'settled'); assert.ok(record.proofArtifact);
    const current = (await h.state.get(h.workId))!;
    const task: TaskSpec = { id: `verify-${current.revision}`, toolId: 'synthetic.ui.verify', toolVersion: '1', description: 'Confirm current saved value from the actual browser',
      input: {}, computerResume: { attemptId: parent.id, checkpointId: parent.computerUse.head.id, reconciliation: { id: record.id, proofId: record.proofArtifact.id } },
      dependsOn: [], effect: 'read', maxAttempts: 1, satisfies: ['saved'] };
    await h.runtime.submitPlan(h.workId, `verify-plan-${current.revision}`, { baseStateRevision: current.revision, baseGoalRevision: current.goal.revision,
      basePlanRevision: current.plan?.revision ?? 0, reason: 'Applied Save confirmed by receipt; fresh DOM observation checks completion', tasks: [task], hypotheses: [] });
    const child = await h.runtime.reserve(h.workId, task.id); await h.runtime.execute(h.workId, child.id); await h.runtime.adopt(h.workId, child.id);
    assert.equal((await computerResult(h, child.id)).status, 'success');
    assert.equal((await h.runtime.step(h.workId)).kind, 'complete');
    assert.equal(web.fixture.snapshot().app.inputCount, 2); assert.equal(web.fixture.snapshot().app.saveCount, 1);
  });
}
