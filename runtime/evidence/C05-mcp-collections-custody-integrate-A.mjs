import { readFile, writeFile, mkdir, access, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = resolve(runtime, '..');
const evidence = 'evidence/C05-mcp-collections-custody-';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFile(resolve(runtime, path));
const json = async path => JSON.parse(await read(path));
const manifests = ['core', 'adapter', 'tests'].map(name => `${evidence}staging/${name}/manifest.json`);
const loaded = await Promise.all(manifests.map(json));
const files = [
  ...loaded[0].files.map(f => ({path: f.source, staged: resolve(runtime, f.destination), before: f.beforeSha256, after: f.afterSha256})),
  ...loaded[1].files.map(f => ({path: f.path, staged: resolve(project, f.stagedPath), before: f.sourceSha256, after: f.stagedSha256})),
  ...loaded[2].files.map(f => ({path: f.path, staged: resolve(runtime, `${evidence}staging/tests/${f.path}`), before: null, after: f.sha256}))
];
const output = `${evidence}A-integration1.json`;
try { await access(resolve(runtime, output)); throw new Error('integration_already_recorded'); } catch(e) { if(e.code !== 'ENOENT') throw e; }
for(const f of files) {
  if(sha(await readFile(f.staged)) !== f.after) throw new Error(`staged_changed:${f.path}`);
  let before = null; try { before = sha(await read(f.path)); } catch(e) { if(e.code !== 'ENOENT') throw e; }
  if(before !== f.before) throw new Error(`product_changed:${f.path}`);
}
for(const f of loaded[2].dependencies) {
  if(sha(await readFile(resolve(project,f.path))) !== f.sha256) throw new Error(`test_dependency_changed:${f.path}`);
}
const backup = `${evidence}A-originals1`;
await mkdir(resolve(runtime,backup));
for(const f of files.filter(f=>f.before !== null)) {
  const dest=resolve(runtime,backup,f.path); await mkdir(dirname(dest),{recursive:true});
  await copyFile(resolve(runtime,f.path),dest);
}
await writeFile(resolve(runtime,backup,'intent.json'), JSON.stringify({at:new Date().toISOString(),files},null,2)+'\n',{flag:'wx'});
for(const f of files) {
  await writeFile(resolve(runtime,f.path), await readFile(f.staged), {flag:f.before === null?'wx':'w'});
  if(sha(await read(f.path)) !== f.after) throw new Error(`copy_changed:${f.path}`);
}
const record = {schemaVersion:1, status:'A_integrated_not_built_or_tested',at:new Date().toISOString(),
  chapterComplete:false,goalComplete:false,files,backup,
  manifests:await Promise.all(manifests.map(async path=>({path,sha256:sha(await read(path))}))),
  scope:'Five product files and two new A test files. B accounting and C crash/general entry remain unimplemented.',
  previousVerifiedSource:'33c45f6df85a16f8d43e0b90e9032ff332183ebc91674f63b7993146cb10fdfe'};
await writeFile(resolve(runtime,output),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:record.status, files:files.length,record:output}));
