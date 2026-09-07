import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const base='evidence/C03-drafts-linux-nas-20260907',root='/home/shaneee/secumon-linux-test.pCJ0bd';
const control=readFileSync(base+'/control-directory.txt','utf8').trim()+'/control';
const metadata=JSON.parse(readFileSync(base+'/run-metadata.json','utf8'));
async function inspect(root){
 const fs=await import('node:fs'),{createHash}=await import('node:crypto');
 const directory=root+'/evidence-drafts-c03/mcp-trace';
 const result=JSON.parse(fs.readFileSync(root+'/evidence-drafts-c03/result.json','utf8'));
 if(!result.finishedAt||!['passed','failed'].includes(result.status))throw new Error('native_not_finished');
 if(result.mcpTrace?.directory!==directory)throw new Error('trace_not_registered');
 if(fs.realpathSync(directory)!==directory||(fs.statSync(directory).mode&0o777)!==0o700)throw new Error('trace_directory_unsafe');
 const names=fs.readdirSync(directory);if(names.length!==1||names.some(x=>!/^\d+\.jsonl$/.test(x)))throw new Error('trace_file_set_unexpected');
 const files=names.map(file=>{const p=directory+'/'+file,s=fs.lstatSync(p);if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||s.size>16*1024*1024)throw new Error('trace_file_unsafe');const bytes=fs.readFileSync(p);return{file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};});
 console.log(JSON.stringify({status:result.status,finishedAt:result.finishedAt,sourceAndBuild:result.buildPin,trace:result.mcpTrace,files}));
}
const raw=execFileSync('ssh',['-S',control,'nas','/usr/bin/env -i PATH=/usr/bin:/bin '+root+'/node-v24.20.0-linux-x64/bin/node --input-type=module'],{input:'await ('+inspect.toString()+')('+JSON.stringify(root)+');',encoding:'utf8'});
const result=JSON.parse(raw),dest=base+'/attempt-'+metadata.attempt+'-mcp-trace';mkdirSync(dest,{mode:0o700});
for(const file of result.files){const bytes=execFileSync('ssh',['-S',control,'nas','/bin/cat '+root+'/evidence-drafts-c03/mcp-trace/'+file.file],{maxBuffer:16*1024*1024});assert.equal(bytes.length,file.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);writeFileSync(dest+'/'+file.file,bytes,{flag:'wx',mode:0o600});}
const collection={...result,collectedAt:new Date().toISOString(),attempt:metadata.attempt,sessionId:metadata.sessionId,directory:'runtime/'+dest};writeFileSync(dest+'-collection.json',JSON.stringify(collection,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:'collected',attempt:metadata.attempt,files:result.files.length,directory:dest}));
