import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { evaluateScenario, validateScenario } from '../application/fixtures.js';

const directory = new URL('../../fixtures/', import.meta.url);
const started = performance.now();
const results = [];
for (const file of (await readdir(directory)).filter(f => f.endsWith('.json')).sort()) {
  const scenario = validateScenario(JSON.parse(await readFile(new URL(file, directory), 'utf8')));
  results.push({ id: scenario.id, family: scenario.family, complexity: scenario.complexity, checks: evaluateScenario(scenario) });
}
const report = { createdAt: new Date().toISOString(), node: process.version, evaluation: 'deterministic_contract_baseline',
  passed: results.length >= 4 && results.every(r => r.checks.every(c => c.passed)), scenarios: results.length,
  checkpoints: results.reduce((n, r) => n + r.checks.length, 0), elapsedMs: performance.now() - started,
  actualModelCalls: 0, actualToolCalls: 0, actualTokenUsage: null, results };
await mkdir(new URL('../../evidence/', import.meta.url), { recursive: true });
await writeFile(new URL('../../evidence/fixture-baseline.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, results: results.map(r => ({ id: r.id, checks: r.checks.length, passed: r.checks.every(c => c.passed) })) }, null, 2));
if (!report.passed) process.exitCode = 1;
