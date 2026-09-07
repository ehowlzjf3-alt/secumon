import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const path='evidence/C03-drafts-linux-nas-20260907/verify-linux-drafts-c03.mjs',source=readFileSync(path,'utf8');
const start=source.indexOf('async function run('), end=source.indexOf('\ntry {\n  const expectedAssets',start);assert(start>0&&end>start);
const evidence=mkdtempSync(join(tmpdir(),'secumon-stage-runner-'));
const record={steps:[],executionLimits:{otherStageDeadlineMs:1500,fullStageDeadlineMs:1500,terminationGraceMs:100,postKillObservationMs:100,logFlushDeadlineMs:1000}};
const run=new Function('record','evidence','persist','cwd','spawn','createWriteStream','readFileSync','join',source.slice(start,end)+'; return run;')(record,evidence,()=>{},process.cwd(),spawn,createWriteStream,readFileSync,join);
try {
 await run('normal',process.execPath,['-e','process.stdout.write("probe completed");']);
 assert.equal(record.steps[0].status,'passed');assert.equal(record.steps[0].groupAbsentConfirmed,true);
 record.executionLimits.otherStageDeadlineMs=150;
 await assert.rejects(run('deadline',process.execPath,['-e','setInterval(() => {},1000);']),{message:'step_timeout:deadline'});
 const step=record.steps[1];assert.equal(step.timedOut,true);assert.equal(step.terminationReason,'stage_deadline');assert.equal(step.groupAbsentConfirmed,true);assert.equal(step.signal,'SIGTERM');assert.equal(step.exitCode,null);
 const result={status:'passed',at:new Date().toISOString(),platform:process.platform,node:process.version,runnerSha256:createHash('sha256').update(source).digest('hex'),scope:'local_evidence_runner_success_and_deadline_child_group_only_not_product_tests',steps:record.steps};
 rmSync(evidence,{recursive:true});result.temporaryDirectoryRemoved=true;
 writeFileSync('evidence/C03-drafts-stage-runner-probe.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({status:'passed',cases:2,temporaryDirectoryRemoved:true}));
} catch(error) { console.error(error);process.exitCode=1; }
