import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { evaluateScenario, validateScenario } from '../application/fixtures.js';
import { evaluateCompletion } from '../domain/completion.js';

const directory = new URL('../../fixtures/', import.meta.url);
const scenarios = readdirSync(directory).filter(f => f.endsWith('.json')).map(f => validateScenario(JSON.parse(readFileSync(new URL(f, directory), 'utf8'))));
for (const scenario of scenarios) {
  test(`baseline ${scenario.id}`, () => {
    const results = evaluateScenario(scenario);
    for (const result of results) assert.equal(result.passed, true, JSON.stringify(result));
  });
}
test('both domains use the same schema and include simple/complex baselines', () => {
  assert.deepEqual(scenarios.map(s => `${s.family}:${s.complexity}`).sort(), ['document_comparison:complex', 'document_comparison:simple', 'observation_review:complex', 'observation_review:simple']);
  assert.ok(scenarios.reduce((n, s) => n + s.checkpoints.length, 0) >= 20);
});
test('fixture oracle rejects missing references and duplicated evidence IDs', () => {
  const scenario = structuredClone(scenarios[0]!);
  scenario.checkpoints[0]!.evidenceIds = ['absent'];
  assert.throws(() => validateScenario(scenario), /missing_fixture_evidence/);
  scenario.checkpoints[0]!.evidenceIds = [];
  scenario.evidence.push(scenario.evidence[0]!);
  assert.throws(() => validateScenario(scenario), /duplicate_fixture_evidence/);
});
test('repetition and permutation cannot create independent sources', () => {
  const s = scenarios.find(s => s.id === 'documents-complex')!;
  const original = s.evidence.find(e => e.id === 'doc-b')!;
  const copies = Array.from({ length: 30 }, (_, i) => ({ ...original, id: `copy-${i}`, derivedFrom: [original.id] }));
  for (const evidence of [[original, ...copies], [...copies].reverse().concat(original)]) {
    assert.equal(evaluateCompletion(s.goal, evidence, [], s.policy).complete, false);
  }
});
test('completed facts do not discharge an unrelated pending obligation', () => {
  const s = scenarios.find(s => s.id === 'documents-simple')!;
  const evidence = [s.evidence.find(e => e.id === 'doc-current')!];
  assert.equal(evaluateCompletion(s.goal, evidence, [], s.policy).complete, true);
  const check = evaluateCompletion(s.goal, evidence, [{ id: 'receipt', kind: 'effect_reconciliation', status: 'pending', reason: 'unknown effect', wakeKey: null, dueAt: null }], s.policy);
  assert.equal(check.complete, false);
  assert.deepEqual(check.blockers, ['pending_obligation:receipt']);
});
