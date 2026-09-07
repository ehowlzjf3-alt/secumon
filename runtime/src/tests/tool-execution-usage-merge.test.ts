import test from 'node:test';
import assert from 'node:assert/strict';
import type { ToolExecution } from '../domain/model.js';
import { mergeToolExecution, toolExecution } from '../application/tool-execution-usage.js';

test('one attempt unknown measurements are refined without summing repeats or erasing known values', () => {
  const unknown = toolExecution('unreported');
  const partial = toolExecution('invoked', { transportCalls: 1, internalOperations: null, imageBytes: null, waitMs: 0 });
  const rest = toolExecution('invoked', { transportCalls: null, internalOperations: 3, imageBytes: 20, waitMs: null });
  const expected = toolExecution('invoked', { transportCalls: 1, internalOperations: 3, imageBytes: 20, waitMs: 0 });
  assert.deepEqual(mergeToolExecution(undefined, unknown), unknown);
  assert.deepEqual(mergeToolExecution(unknown, partial), partial);
  assert.deepEqual(mergeToolExecution(partial, rest), expected);
  assert.deepEqual(mergeToolExecution(expected, expected), expected);
  assert.deepEqual(mergeToolExecution(expected, unknown), expected);
  const detached = mergeToolExecution(undefined, partial); detached.usage.transportCalls = 2;
  assert.equal(partial.usage.transportCalls, 1); assert.equal(unknown.usage.transportCalls, null);
});

test('conflicting known measurements and incompatible invocation modes are refused instead of combined', () => {
  const invoked = toolExecution('invoked', { transportCalls: 1, internalOperations: 2, imageBytes: 3, waitMs: 4 });
  for (const key of ['transportCalls', 'internalOperations', 'imageBytes', 'waitMs'] as const) {
    const conflicting = structuredClone(invoked); conflicting.usage[key] = invoked.usage[key]! + 1;
    assert.throws(() => mergeToolExecution(invoked, conflicting), /tool_execution_usage_conflict/);
  }
  for (const mode of ['not_invoked', 'reused'] as const) {
    assert.throws(() => mergeToolExecution(toolExecution(mode), invoked), /tool_execution_usage_conflict/);
    assert.throws(() => mergeToolExecution(invoked, toolExecution(mode)), /tool_execution_usage_conflict/);
    assert.deepEqual(mergeToolExecution(toolExecution(mode), toolExecution('unreported')), toolExecution(mode));
  }
  assert.throws(() => mergeToolExecution(toolExecution('reused'), toolExecution('not_invoked')), /tool_execution_usage_conflict/);
});

test('malformed reported and prior measurements never become valid usage through merge', () => {
  for (const invalid of [
    { ...toolExecution('invoked'), implementationCalls: 0 },
    { ...toolExecution('unreported'), usage: { transportCalls: -1, internalOperations: null, imageBytes: null, waitMs: null } },
    { ...toolExecution('not_invoked'), usage: { transportCalls: 1, internalOperations: 0, imageBytes: 0, waitMs: 0 } },
    { ...toolExecution('invoked'), usage: { transportCalls: 1.5, internalOperations: null, imageBytes: null, waitMs: null } },
  ]) {
    assert.throws(() => mergeToolExecution(undefined, invalid as ToolExecution));
    assert.throws(() => mergeToolExecution(invalid as ToolExecution, toolExecution('invoked')));
  }
});
