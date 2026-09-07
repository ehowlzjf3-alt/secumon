import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDisclosureComparison } from '../infrastructure/disclosure-comparison.js';
import { evaluationCodePin, verifyEvaluationBuild } from '../infrastructure/local-evaluation.js';
import { sha256 } from '../infrastructure/digest.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== 'run' || args[1] !== '--out' || !args[2]) throw new Error('usage: compare:disclosure run --out NEW_DIRECTORY');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'); const output = resolve(args[2]);
  const build = await verifyEvaluationBuild(root); const code = await evaluationCodePin(root);
  if (code.digest !== build.sourceDigest) throw new Error('disclosure_build_changed_before_run');
  const report = await runDisclosureComparison(output);
  const after = await verifyEvaluationBuild(root);
  if (JSON.stringify(after) !== JSON.stringify(build)) throw new Error('disclosure_build_changed_during_run');
  await writeFile(join(output, 'manifest.json'), JSON.stringify({ schemaVersion: 1, code, build, node: process.version, platform: process.platform, architecture: process.arch,
    reportSha256: sha256(await readFile(join(output, 'report.json'))), codeUnchanged: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ executed: report.executed, passed: report.passed, byPlacement: report.byPlacement, report: join(output, 'report.json') }) + '\n');
  if (report.passed !== report.executed) process.exitCode = 1;
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'disclosure_comparison_failed'}\n`); process.exitCode = 1; });
