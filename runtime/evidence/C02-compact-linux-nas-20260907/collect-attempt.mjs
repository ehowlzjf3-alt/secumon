import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
const directory='evidence/C02-compact-linux-nas-20260907',root='/home/shaneee/secumon-linux-test.pCJ0bd';
const label=process.argv[2];if(!/^(attempt-[1-9][0-9]*|final)$/.test(label??''))throw new Error('collection_label_required');
const control=readFileSync(directory+'/control-directory.txt','utf8').trim()+'/control';
const get=name=>execFileSync('ssh',['-S',control,'nas','/bin/cat '+root+'/evidence-compact-c02/'+name]);
const bytes=get('result.json'),result=JSON.parse(bytes);if(!result.finishedAt||result.status==='running')throw new Error('native_run_not_finished');
mkdirSync(directory+'/'+label,{mode:0o700});writeFileSync(directory+'/'+label+'/result.json',bytes);
const names=['result.json'];for(const step of result.steps){const name=step.name+'.log';writeFileSync(directory+'/'+label+'/'+name,get(name));names.push(name);}
const hashes=names.map(file=>({file,sha256:createHash('sha256').update(readFileSync(directory+'/'+label+'/'+file)).digest('hex')}));
writeFileSync(directory+'/'+label+'-collection.json',JSON.stringify({collectedAt:new Date().toISOString(),status:result.status,finishedAt:result.finishedAt,sourceAndBuild:result.buildPin,files:hashes},null,2)+'\n');
console.log(JSON.stringify({status:result.status,finishedAt:result.finishedAt,collectedFiles:names.length,sourceAndBuild:result.buildPin}));
