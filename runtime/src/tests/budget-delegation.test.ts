import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetExcess, delegatedExposure, grantExposure, ownExposure, totalExposure, type BudgetExposureWork, type BudgetGrant,
  type BudgetParent, type BudgetVector } from '../domain/budget-delegation.js';
import { BudgetGrantSchema, BudgetGrantsSchema, BudgetMandateSchema, BudgetParentSchema, BudgetVectorSchema } from '../application/budget-delegation-contracts.js';

const vector = (values: Partial<BudgetVector> = {}): BudgetVector => ({ toolCalls: 0, modelCalls: 0, tokens: 0, replans: 0, ...values });
function grant(values: Partial<BudgetGrant> = {}): BudgetGrant {
  return { id: 'grant-1', childWorkId: 'child-1', parentGoalRevision: 1, childScope: 'synthetic', childPolicyDigest: 'a'.repeat(64),
    allocated: vector({ toolCalls: 5, modelCalls: 2, tokens: 100, replans: 3 }), deadlineAt: 10000, status: 'active',
    accounted: vector(), reserved: vector(), unmeasuredModelCalls: 0, childStateRevision: null, ...values };
}
function work(grants?: BudgetGrant[]): BudgetExposureWork {
  return { budget: { limits: { toolCalls: 20, modelCalls: 10, tokens: 1000, replans: 10, wallTimeMs: 10000 },
    used: { ...vector(), unmeasuredModelCalls: 0 }, reservedToolCalls: 0, reservedModelCalls: 0, reservedTokens: 0 }, ...(grants ? { budgetGrants: grants } : {}) };
}
const maximum = Number.MAX_SAFE_INTEGER;

test('budget exposure: own usage and reservations add each dimension without charging elapsed time or unknown counts as tokens', () => {
  const value = work(); value.budget.used = { toolCalls: 2, modelCalls: 3, tokens: 40, replans: 1, unmeasuredModelCalls: 2 };
  value.budget.reservedToolCalls = 1; value.budget.reservedModelCalls = 1; value.budget.reservedTokens = 80;
  assert.deepEqual(ownExposure(value), vector({ toolCalls: 3, modelCalls: 4, tokens: 120, replans: 1 }));
  assert.deepEqual(totalExposure(value), ownExposure(value)); assert.deepEqual(totalExposure(work()), vector());
});

test('budget exposure: active and draining escrow count once even when the same child usage has already been observed', () => {
  const value = grant({ accounted: vector({ toolCalls: 3, modelCalls: 1, tokens: 20, replans: 2 }), childStateRevision: 7 });
  for (const status of ['active', 'draining'] as const) {
    value.status = status; assert.deepEqual(grantExposure(value), value.allocated);
    assert.deepEqual(delegatedExposure([value]), value.allocated);
  }
  const parent = work([value]); parent.budget.used.toolCalls = 2;
  assert.equal(totalExposure(parent).toolCalls, 7); assert.deepEqual(totalExposure(parent), totalExposure(parent));
});

test('budget exposure: usage above allocation and outstanding reservations remain visible in independent dimensions', () => {
  const value = grant({ accounted: vector({ toolCalls: 7, modelCalls: 1, tokens: 150, replans: 2 }),
    reserved: vector({ modelCalls: 3, tokens: 80 }), childStateRevision: 8 });
  assert.deepEqual(grantExposure(value), vector({ toolCalls: 7, modelCalls: 4, tokens: 230, replans: 3 }));
  value.status = 'draining'; assert.deepEqual(grantExposure(value), vector({ toolCalls: 7, modelCalls: 4, tokens: 230, replans: 3 }));
});

test('budget exposure: settling replaces escrow with accounted plus reserved amounts and repeated reads cannot refund twice', () => {
  const value = grant({ accounted: vector({ toolCalls: 3, modelCalls: 1, tokens: 50, replans: 1 }), childStateRevision: 9 });
  const parent = work([value]); parent.budget.used.toolCalls = 2;
  assert.equal(totalExposure(parent).toolCalls, 7); value.status = 'settled';
  for (let repeat = 0; repeat < 5; repeat++) assert.deepEqual(totalExposure(parent), vector({ toolCalls: 5, modelCalls: 1, tokens: 50, replans: 1 }));
  assert.equal(parent.budget.used.toolCalls, 2); assert.equal(value.accounted.toolCalls, 3);
});

test('budget exposure: unknown and partially reported model usage keeps reserved tokens even on a settled summary', () => {
  const value = grant({ allocated: vector({ modelCalls: 1, tokens: 100 }), accounted: vector({ modelCalls: 1, tokens: 25 }),
    reserved: vector({ tokens: 100 }), unmeasuredModelCalls: 1, childStateRevision: 10 });
  for (const status of ['active', 'draining', 'settled'] as const) {
    value.status = status; assert.equal(grantExposure(value).tokens, 125); assert.equal(BudgetGrantSchema.safeParse(value).success, true);
  }
  assert.equal(value.unmeasuredModelCalls, 1); assert.equal(value.reserved.tokens, 100);
  value.accounted.tokens = 180; value.reserved.tokens = 0; value.unmeasuredModelCalls = 0;
  assert.equal(grantExposure(value).tokens, 180);
});

test('budget exposure: a lower parent limit preserves actual costs and reports each excess without negative remaining values', () => {
  const value = work([grant()]); value.budget.used = { toolCalls: 2, modelCalls: 1, tokens: 50, replans: 1, unmeasuredModelCalls: 0 };
  const before = structuredClone(value);
  assert.deepEqual(budgetExcess(value, { ...vector({ toolCalls: 6, modelCalls: 3, tokens: 100, replans: 1 }), wallTimeMs: 1 } as typeof value.budget.limits),
    vector({ toolCalls: 1, tokens: 50, replans: 3 }));
  assert.deepEqual(budgetExcess(value, value.budget.limits), vector()); assert.deepEqual(value, before);
});

test('budget exposure: separate grants sum but duplicate IDs and duplicate child funding records are rejected', () => {
  const first = grant(); const second = grant({ id: 'grant-2', childWorkId: 'child-2' });
  assert.deepEqual(delegatedExposure([first, second]), vector({ toolCalls: 10, modelCalls: 4, tokens: 200, replans: 6 }));
  for (const duplicate of [structuredClone(first), { ...second, id: first.id }, { ...second, childWorkId: first.childWorkId }]) {
    assert.throws(() => delegatedExposure([first, duplicate]), /budget_delegation_invalid/);
    assert.equal(BudgetGrantsSchema.safeParse([first, duplicate]).success, false);
  }
});

test('budget exposure: zero-funded grants remain explicit and cannot hide a later reported expense', () => {
  const value = grant({ allocated: vector() }); assert.deepEqual(grantExposure(value), vector());
  value.accounted.tokens = 1; value.childStateRevision = 2;
  assert.equal(grantExposure(value).tokens, 1); assert.deepEqual(budgetExcess(work([value]), vector()), vector({ tokens: 1 }));
});

test('budget exposure: max-safe totals are exact and overflow in local, grant, aggregate or combined arithmetic fails closed', () => {
  const local = work(); local.budget.used.tokens = maximum;
  assert.equal(ownExposure(local).tokens, maximum); local.budget.reservedTokens = 1;
  assert.throws(() => ownExposure(local), /budget_exposure_overflow/);
  const observed = grant({ accounted: vector({ tokens: maximum }), reserved: vector({ tokens: 1 }), childStateRevision: 2 });
  assert.throws(() => grantExposure(observed), /budget_exposure_overflow/); assert.equal(BudgetGrantSchema.safeParse(observed).success, false);
  const huge = grant({ allocated: vector({ tokens: maximum }) });
  const small = grant({ id: 'grant-2', childWorkId: 'child-2', allocated: vector({ tokens: 1 }) });
  assert.throws(() => delegatedExposure([huge, small]), /budget_exposure_overflow/);
  assert.equal(BudgetGrantsSchema.safeParse([huge, small]).success, false);
  const combined = work([huge]); combined.budget.used.tokens = 1;
  assert.throws(() => totalExposure(combined), /budget_exposure_overflow/);
  assert.throws(() => budgetExcess(combined, vector()), /budget_exposure_overflow/);
});

test('budget exposure: fractional, negative, nonfinite, unsafe and missing values never become zero', () => {
  for (const bad of [-1, 0.5, NaN, Infinity, -Infinity, maximum + 1, undefined, null, '1']) {
    const amount = { ...vector(), tokens: bad } as BudgetVector;
    assert.equal(BudgetVectorSchema.safeParse(amount).success, false);
    assert.throws(() => budgetExcess(work(), amount), /budget_delegation_invalid/);
    const value = work(); value.budget.used.tokens = bad as number;
    assert.throws(() => ownExposure(value), /budget_delegation_invalid/);
    assert.throws(() => grantExposure(grant({ allocated: amount })), /budget_delegation_invalid/);
  }
  const value = work(); value.budget.reservedToolCalls = -1; assert.throws(() => ownExposure(value), /budget_delegation_invalid/);
  value.budget.reservedToolCalls = 0; value.budget.used.unmeasuredModelCalls = NaN; assert.throws(() => ownExposure(value), /budget_delegation_invalid/);
});

test('budget exposure: grant schema keeps authority identity strict and requires a state revision for observed or settled accounting', () => {
  const original = grant(); assert.equal(BudgetGrantSchema.safeParse(original).success, true);
  for (const invalid of [{ ...original, extra: true }, { ...original, childPolicyDigest: 'not-a-digest' }, { ...original, parentGoalRevision: 0 },
    { ...original, childScope: ' ' }, { ...original, deadlineAt: -1 }, { ...original, status: 'pending' }, { ...original, childStateRevision: 0 },
    { ...original, status: 'settled' }, { ...original, accounted: vector({ tokens: 1 }) }, { ...original, reserved: vector({ toolCalls: 1 }) },
    { ...original, unmeasuredModelCalls: 1 }, { ...original, allocated: { ...original.allocated, wallTimeMs: 10 } }])
    assert.equal(BudgetGrantSchema.safeParse(invalid).success, false);
  assert.equal(BudgetGrantSchema.safeParse(grant({ status: 'settled', childStateRevision: 1 })).success, true);
});

test('budget exposure: parent links preserve pending, active and draining as different stored phases without conferring allocation authority', () => {
  for (const phase of ['pending', 'active', 'draining'] as const) {
    const parent: BudgetParent = { parentWorkId: 'parent', grantId: 'grant', phase };
    assert.deepEqual(BudgetParentSchema.parse(parent), parent);
  }
  for (const invalid of [{ parentWorkId: 'parent', grantId: 'grant', phase: 'settled' }, { parentWorkId: '', grantId: 'grant', phase: 'pending' },
    { parentWorkId: 'parent', grantId: ' ', phase: 'pending' }, { parentWorkId: 'parent', grantId: 'grant', phase: 'active', allocated: vector() }])
    assert.equal(BudgetParentSchema.safeParse(invalid).success, false);
});

test('budget exposure: empty and absent grant lists are equivalent while malformed and over-cap lists are rejected', () => {
  assert.deepEqual(delegatedExposure([]), vector()); assert.deepEqual(totalExposure(work()), totalExposure(work([])));
  for (const invalid of [null, {}, new Array(10001).fill(grant())]) {
    assert.throws(() => delegatedExposure(invalid as BudgetGrant[]), /budget_delegation_invalid/);
    assert.equal(BudgetGrantsSchema.safeParse(invalid).success, false);
  }
  assert.throws(() => totalExposure({ ...work(), budgetGrants: null } as unknown as BudgetExposureWork), /budget_delegation_invalid/);
});

test('budget exposure: projections and strict schema copies share no mutable vectors with the ledger', () => {
  const value = work([grant({ childStateRevision: 1 })]); const before = structuredClone(value);
  const own = ownExposure(value); const delegated = delegatedExposure(value.budgetGrants!); const total = totalExposure(value);
  own.tokens = 1; delegated.tokens = 2; total.tokens = 3;
  const parsed = BudgetGrantSchema.parse(value.budgetGrants![0]); parsed.allocated.tokens = 999; parsed.accounted.tokens = 999;
  assert.deepEqual(value, before);
});

test('budget authority: strict mandate identity retains issuer, reference, rule and child goal revision', () => {
  const mandate = { provider: 'host-policy', referenceId: 'request-1', revision: 1, childGoalRevision: 1 };
  assert.deepEqual(BudgetMandateSchema.parse(mandate), mandate);
  assert.equal(BudgetGrantSchema.safeParse(grant({ mandate })).success, true);
  for (const invalid of [{ ...mandate, extra: true }, { ...mandate, provider: ' ' }, { ...mandate, referenceId: '' },
    { ...mandate, revision: 0 }, { ...mandate, childGoalRevision: 0 }, { ...mandate, revision: 1.5 }]) {
    assert.equal(BudgetMandateSchema.safeParse(invalid).success, false);
    assert.equal(BudgetGrantSchema.safeParse(grant({ mandate: invalid })).success, false);
  }
});

test('budget authority: a second grant for one mandate remains duplicate even after its issuer revision changes', () => {
  const mandate = { provider: 'host-policy', referenceId: 'request-1', revision: 1, childGoalRevision: 1 };
  const first = grant({ mandate }); const second = grant({ id: 'second', childWorkId: 'second-child', mandate: { ...mandate, revision: 2 } });
  assert.throws(() => delegatedExposure([first, second]), /budget_delegation_invalid/);
  assert.equal(BudgetGrantsSchema.safeParse([first, second]).success, false);
  second.mandate!.referenceId = 'request-2'; assert.equal(BudgetGrantsSchema.safeParse([first, second]).success, true);
});
