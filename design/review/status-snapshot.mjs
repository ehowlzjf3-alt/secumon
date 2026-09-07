import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const read=async p=>JSON.parse(await readFile(resolve(root,p),'utf8'));
const backlog=await read('design/implementation-backlog.json');
const exit=await read('runtime/evidence/P4-board-funding-verify1-exit.json');
const log=await readFile(resolve(root,'runtime',exit.log),'utf8');
const counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo','duration_ms'].map(k=>[k,Number(log.match(new RegExp(`ℹ ${k} ([0-9.]+)`))?.[1])]));
if(exit.exitCode!==0||counts.tests!==2460||counts.pass!==2460||counts.fail!==0)throw Error('latest_native_result_unverified');
const {verifyEvaluationBuild}=await import('../../runtime/dist/infrastructure/local-evaluation.js');
const build=await verifyEvaluationBuild(resolve(root,'runtime'));
if(build.sourceDigest!=='ac8fec235326770e8e93ef6e536ab54da3d402bf828360f7dfadbbe9c1af46f2')throw Error('review_snapshot_requires_new_verified_baseline');
const fixture=await read('runtime/evidence/fixture-baseline.json');
const arch=JSON.parse(log.split('\n').find(l=>l.startsWith('{"inspected":')));
const snapshot={createdAt:new Date().toISOString(),asOf:exit.finishedAt,scope:'read_only_project_review',backlogRevision:backlog.revision,
counts:backlog.work_items.reduce((a,w)=>(a[w.status]=(a[w.status]||0)+1,a),{}),phases:backlog.phases.map(p=>({...p,derivedStatus:backlog.work_items.filter(w=>w.phase===p.id).every(w=>w.status==='verified')?'verified':backlog.work_items.some(w=>w.phase===p.id&&w.status==='in_progress')?'in_progress':'not_started'})),
items:backlog.work_items.map(w=>({id:w.id,phase:w.phase,title:w.title,status:w.status,outcome:w.outcome,acceptance:w.acceptance,local:w.verification?.local_contracts||null,record:w.verification?.record||null,document:w.result||w.verification?.document||w.verification?.chapter||w.plan||null})),
verification:{...exit,counts,build,architecture:arch,fixtures:{passed:fixture.passed,scenarios:fixture.scenarios,checkpoints:fixture.checkpoints},latestRecord:'runtime/evidence/P4-board-funding-verify1-exit.json',targeted:'runtime/evidence/P4-board-funding-new1-exit.json'},
limitations:['Latest native result is newer than backlog v0.50; this review does not promote project status or run the old finalizer.','Phase P4 stored status is stale; overview derives phase progress from work items.','P4 funding exists and has passed local tests despite the old backlog field not_implemented.','Real model test cancelled; internal MCP, Knox and production not tested.'],next:'design_alignment_only'};
await writeFile(resolve(root,'design/review/status-snapshot.json'),JSON.stringify(snapshot,null,2)+'\n');
console.log(JSON.stringify({items:snapshot.items.length,counts:snapshot.counts,latest:counts,build}));
