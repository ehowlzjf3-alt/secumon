import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComputerLease, ComputerView } from '../domain/computer-use.js';
import type { ComputerOperationReceipt } from '../domain/computer-operation.js';
import type { ComputerDriver } from '../application/computer-use-ports.js';
import { ComputerOperationIdentitySchema, ComputerOperationLookupResultSchema, ComputerOperationReceiptSchema,
  computerOperationIdentity } from '../application/computer-operation-contracts.js';

const usage = { transportCalls: 1, internalOperations: 1, imageBytes: 0, waitMs: 0 };
function lease(): ComputerLease {
  return { sessionId: 'local-session', epoch: 3, surfaceId: 'window', fence: 7, workId: 'work', attemptId: 'original-attempt', expiresAt: 10000 };
}
function request(): Parameters<ComputerDriver['act']>[1] {
  const basis: ComputerView = { sessionId: 'local-session', epoch: 3, surfaceId: 'window', revision: 8, focusRevision: 2, observedAt: 10,
    elements: [{ ref: 'note-ref', role: 'textbox', name: 'Note', value: 'ORIGINAL_SCREEN_BODY', visible: true, enabled: true }],
    facts: { displayed: 'ORIGINAL_FACT_BODY' }, partial: false, omittedCount: 0 };
  return { operationId: 'operation', basis, targetRef: 'note-ref', action: { kind: 'fill', target: { role: 'textbox', name: 'Note' }, value: 'reviewed' }, deadlineAt: 9000 };
}
function receipt(): ComputerOperationReceipt {
  return { schemaVersion: 1, kind: 'computer_operation_receipt', driver: { id: 'synthetic', version: '1' },
    identity: computerOperationIdentity(lease(), request()), outcome: 'applied', decidedAt: 20, effectSequence: 1 };
}

test('computer operation contract: identity binds the requested input without copying the observed screen or mutable lease', () => {
  const grant = lease(); const action = request(); const identity = computerOperationIdentity(grant, action);
  assert.deepEqual(identity, { workId: 'work', attemptId: 'original-attempt', sessionId: 'local-session', epoch: 3, surfaceId: 'window',
    operationId: 'operation', viewRevision: 8, focusRevision: 2, targetRef: 'note-ref', action: action.action });
  grant.attemptId = 'later-reader'; grant.epoch = 4; action.action.target.name = 'another-target';
  assert.equal(identity.attemptId, 'original-attempt'); assert.equal(identity.epoch, 3); assert.equal(identity.action.target.name, 'Note');
  const encoded = JSON.stringify(identity);
  assert.equal(encoded.includes('ORIGINAL_SCREEN_BODY'), false); assert.equal(encoded.includes('ORIGINAL_FACT_BODY'), false);
  assert.equal(Object.hasOwn(identity, 'fence'), false); assert.equal(Object.hasOwn(identity, 'deadlineAt'), false);
});

test('computer operation contract: every routing and action component distinguishes an otherwise reused operation id', () => {
  const original = computerOperationIdentity(lease(), request());
  for (const change of [{ workId: 'other-work' }, { attemptId: 'other-attempt' }, { sessionId: 'other-session' }, { epoch: 4 }, { surfaceId: 'other-window' }]) {
    assert.notDeepEqual(computerOperationIdentity({ ...lease(), ...change }, request()), original);
  }
  assert.notDeepEqual(computerOperationIdentity(lease(), { ...request(), targetRef: 'replaced-ref' }), original);
  assert.notDeepEqual(computerOperationIdentity(lease(), { ...request(), basis: { ...request().basis, revision: 9 } }), original);
  assert.notDeepEqual(computerOperationIdentity(lease(), { ...request(), basis: { ...request().basis, focusRevision: 3 } }), original);
  assert.notDeepEqual(computerOperationIdentity(lease(), { ...request(), action: { ...request().action, kind: 'fill', value: 'other-value' } }), original);
});

test('computer operation contract: strict identity retains the bounded typed-action boundary', () => {
  const identity = computerOperationIdentity(lease(), request());
  for (const value of [
    { ...identity, driverAddress: 'unregistered' }, { ...identity, epoch: 0 }, { ...identity, epoch: Number.MAX_SAFE_INTEGER + 1 },
    { ...identity, viewRevision: -1 }, { ...identity, focusRevision: 0.5 }, { ...identity, targetRef: 'x'.repeat(257) },
    { ...identity, action: { ...identity.action, script: 'unregistered action' } },
    { ...identity, action: { kind: 'fill', target: { role: 'textbox', name: 'Note' }, value: 'x'.repeat(8193) } },
  ]) assert.equal(ComputerOperationIdentitySchema.safeParse(value).success, false);
  assert.equal(ComputerOperationIdentitySchema.safeParse({ ...identity, viewRevision: 0, focusRevision: 0 }).success, true);
});

test('computer operation contract: receipts record a decision and never treat an unknown response as a negative effect', () => {
  for (const outcome of ['applied', 'not_applied'] as const) {
    const record = { ...receipt(), outcome, decidedAt: 0, effectSequence: 0 };
    assert.deepEqual(ComputerOperationReceiptSchema.parse(record), record);
  }
  for (const value of [
    { ...receipt(), outcome: 'unknown' }, { ...receipt(), decidedAt: -1 }, { ...receipt(), effectSequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...receipt(), driver: { id: 'synthetic', version: '1', address: 'other' } }, { ...receipt(), instruction: 'skip validation' },
  ]) assert.equal(ComputerOperationReceiptSchema.safeParse(value).success, false);
});

test('computer operation contract: lookup cannot claim found without a receipt or turn an absent proof into not_applied', () => {
  const found = { status: 'found', receipt: receipt(), reason: null, usage };
  const unknown = { status: 'unknown', receipt: null, reason: 'receipt_unavailable', usage };
  assert.deepEqual(ComputerOperationLookupResultSchema.parse(found), found);
  assert.deepEqual(ComputerOperationLookupResultSchema.parse(unknown), unknown);
  for (const value of [
    { ...found, receipt: null }, { ...found, reason: 'receipt_unavailable' }, { ...unknown, reason: null }, { ...unknown, reason: '' },
    { ...unknown, receipt: receipt() }, { ...unknown, outcome: 'not_applied' }, { ...unknown, status: 'not_found' },
    { ...unknown, usage: { ...usage, transportCalls: -1 } },
  ]) assert.equal(ComputerOperationLookupResultSchema.safeParse(value).success, false);
  const parsed = ComputerOperationLookupResultSchema.parse(found);
  assert.equal(parsed.status, 'found');
  if (parsed.status === 'found') parsed.receipt.identity.action.target.name = 'mutated copy';
  assert.equal(found.receipt.identity.action.target.name, 'Note');
});
