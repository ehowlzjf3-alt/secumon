import { readFileSync } from 'node:fs';
import { peerServiceFixture, consultInput } from '../dist/tests/peer-service-fixture.js';
import { PeerAgents } from '../dist/application/peer-agents.js';
import { ToolResultSchema } from '../dist/application/contracts.js';
import { readGeneratedAnswerArtifact } from '../dist/application/generated-answer.js';

// Diagnostic only: fixed C08 build2, one local call, no source compilation or external provider.
const cleanups = [];
const h = await peerServiceFixture({ after(callback) { cleanups.push(callback); } });
const report = { node: process.version, build: JSON.parse(readFileSync(new URL('./C08-ordered-build2-manifest.json', import.meta.url))).sourceDigest };
const inspect = async (name, callback) => {
  try { report[name] = await callback(); } catch (error) { report[name] = { error: String(error), stack: error.stack }; }
};
try {
  h.probe.controls.status = 'waiting';
  const pending = await h.prepare(consultInput), result = await h.invoke(pending);
  const state = await h.state.get('caller-work'), services = h.bundle.services;
  const native = new PeerAgents(services, new Map([['reviewer', h.probe.peer]]), 'caller-agent');
  report.rawResult = result;
  const contract = ToolResultSchema.safeParse(result);
  report.rawContract = contract.success ? { success: true } : { success: false, issues: contract.error.issues };
  report.attempt = state.attempts.find(value => value.id === result.attemptId);
  const raw = await readGeneratedAnswerArtifact(services, state, result.artifacts[0], 'application/json', 131072);
  const record = JSON.parse(raw), receipt = await h.state.receipt(state.id, `peer-response:${result.attemptId}`);
  report.responseReceipt = { digest: receipt.digest, revision: receipt.state.revision,
    expected: h.probe.digest({ type: 'peer_response_observed', data: { artifact: result.artifacts[0], value: record } }) };
  report.responseEvent = (await h.state.events(state.id, 0)).filter(value => value.type === 'peer_response_observed');
  await inspect('descriptor', () => native.descriptor(state, pending.task, result.attemptId));
  await inspect('assertRequest', () => { native.assertRequest(state, record); return true; });
  await inspect('outputMatches', () => h.probe.digest(native.output(record)) === h.probe.digest(result.output));
  await inspect('peerCurrent', () => h.probe.peer.current(record.request, record.reply));
  await inspect('nativeValidation', () => native.tools[0].validateResult(state, result));
  await inspect('registeredValidation', () => h.bundle.contracts.validateResult(state, result));
  await inspect('received', async () => {
    await h.bundle.runtime.receive(state.id, result.attemptId, result);
    const received = await h.state.get(state.id), attempt = received.attempts.find(value => value.id === result.attemptId);
    return { attempt, result: JSON.parse(new TextDecoder().decode(await h.artifacts.get(attempt.resultArtifact, received.policy))) };
  });
  console.log(JSON.stringify(report, null, 2));
} finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
