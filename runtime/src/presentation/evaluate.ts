import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asJson } from '../application/plan-validator.js';
import { Sha256Digester } from '../infrastructure/digest.js';
import { evaluationConfiguration, loadEvaluationCases } from '../infrastructure/evaluation-cases.js';
import { evaluationCodePin, evaluationPins, replayLocalEvaluation, runEvaluationSuite, verifyEvaluationBuild } from '../infrastructure/local-evaluation.js';

async function main() {
  const args = process.argv.slice(2); const command = args.shift();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  if (command === 'run') {
    let output: string | null = null; let variant: string | null = null;
    while (args.length) {
      const flag = args.shift(); const value = args.shift();
      if (!value || !['--out', '--variant'].includes(flag ?? '')) throw new Error('usage: evaluate run --out NEW_DIRECTORY [--variant VARIANT]');
      if (flag === '--out') output = resolve(value); else variant = value;
    }
    if (!output) throw new Error('usage: evaluate run --out NEW_DIRECTORY [--variant VARIANT]');
    const report = await runEvaluationSuite(root, output, variant ? input => input.specification.variant === variant : undefined,
      (id, passed) => process.stdout.write(`${passed ? 'PASS' : 'FAIL'} ${id}\n`));
    process.stdout.write(JSON.stringify({ passed: report.passed, output: join(output, 'report.json'), overall: report.summary.overall }) + '\n');
    if (!report.passed) process.exitCode = 1;
  } else if (command === 'replay' && args.length === 1) {
    const build = await verifyEvaluationBuild(root);
    const directory = resolve(args[0]!); const recorded = JSON.parse(await readFile(join(directory, 'evaluation.json'), 'utf8'));
    const cases = await loadEvaluationCases(root); const input = cases.find(value => value.specification.id === recorded?.sample?.case?.id);
    if (!input) throw new Error('evaluation_case_unavailable');
    const suite = new Sha256Digester().digest(asJson({ configuration: evaluationConfiguration, cases }));
    const code = await evaluationCodePin(root);
    if (code.digest !== build.sourceDigest) throw new Error('evaluation_build_changed_before_replay');
    const pins = evaluationPins(input, suite, code.digest);
    const result = await replayLocalEvaluation(directory, pins); process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.available) process.exitCode = 1;
  } else throw new Error('usage: evaluate run --out NEW_DIRECTORY [--variant VARIANT] | evaluate replay CASE_DIRECTORY');
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'evaluation_failed'}\n`); process.exitCode = 1; });
