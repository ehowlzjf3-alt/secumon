import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';

const root = resolve('src');
const failures = [];
let inspected = 0;
function visit(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name);
    if (item.isDirectory()) { visit(path); continue; }
    if (!path.endsWith('.ts')) continue;
    const layer = relative(root, path).split(sep)[0];
    if (!['domain', 'application'].includes(layer)) continue;
    inspected++;
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    function check(node) {
      let target;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) target = node.moduleSpecifier.text;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) target = node.arguments[0].text;
      if (target) {
        const targetLayer = target.startsWith('.') ? relative(root, resolve(dirname(path), target)).split(sep)[0] : null;
        const valid = target.startsWith('.') ? (layer === 'domain' ? targetLayer === 'domain' : ['domain', 'application'].includes(targetLayer)) : layer === 'application' && target === 'zod';
        if (!valid) failures.push({ file: relative(root, path), dependency: target });
      }
      ts.forEachChild(node, check);
    }
    check(source);
  }
}
visit(root);
if (inspected === 0) failures.push({ file: 'src', dependency: 'no_core_files_inspected' });
console.log(JSON.stringify({ inspected, failures }));
if (failures.length) process.exitCode = 1;
