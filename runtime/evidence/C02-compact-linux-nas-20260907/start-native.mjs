import {spawn} from 'node:child_process';import {readFileSync,writeFileSync} from 'node:fs';
const directory='evidence/C02-compact-linux-nas-20260907',root='/home/shaneee/secumon-linux-test.pCJ0bd',control=readFileSync(directory+'/control-directory.txt','utf8').trim()+'/control';
const record={status:'running',attempt:2,root,control,sourceAndBuild:JSON.parse(readFileSync('evidence/C02-compact-build-pin.json','utf8')),startedAt:new Date().toISOString(),externalModelCalls:false,internalServiceIntegration:false,duplicateRunStarted:false};
writeFileSync(directory+'/run-metadata.json',JSON.stringify(record,null,2)+'\n');
const command='/usr/bin/env -i PATH='+root+'/node-v24.20.0-linux-x64/bin:/usr/bin:/bin TMPDIR='+root+'/tmp NODE_COMPILE_CACHE='+root+'/tmp/node-compile-cache npm_config_cache='+root+'/npm-cache /usr/bin/nice -n 10 '+root+'/node-v24.20.0-linux-x64/bin/node '+root+'/verify-linux-compact-c02.mjs '+root;
const child=spawn('ssh',['-S',control,'nas',command],{stdio:['ignore','inherit','inherit']});
child.on('error',e=>{record.observerError=String(e)});
child.on('close',(code,signal)=>{const latest=JSON.parse(readFileSync(directory+'/run-metadata.json','utf8'));Object.assign(latest,{observerExitCode:code,observerSignal:signal,observerFinishedAt:new Date().toISOString()});writeFileSync(directory+'/run-metadata.json',JSON.stringify(latest,null,2)+'\n');process.exitCode=code??1;});
