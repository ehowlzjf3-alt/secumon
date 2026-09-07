await (async function probe(root){
 const fs=await import('node:fs'),{spawn}=await import('node:child_process');
 const inside=p=>p===root||p.startsWith(root+'/'),link=p=>{try{return fs.readlinkSync(p)}catch{return ''}};
 function audit(){return fs.readdirSync('/proc').flatMap(id=>{if(!/^\d+$/.test(id)||Number(id)===process.pid)return[];const b='/proc/'+id,exe=link(b+'/exe'),cwd=link(b+'/cwd');if(!inside(exe)&&!inside(cwd))return[];let comm='';try{comm=fs.readFileSync(b+'/comm','utf8').trim()}catch{};return[{pid:Number(id),comm,exe,cwd}];});}
 const before=audit();if(before.length)throw Error('existing_owned_process_before_audit_probe');
 const child=spawn(process.execPath,['-e','process.stdout.write("ready");setInterval(()=>{},1000)'],{cwd:root,stdio:['ignore','pipe','pipe']});
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));let timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},5000);let during=[],exit;
 try {await Promise.race([new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject)}),exited.then(()=>{throw Error('child_exited_before_ready')})]);during=audit();if(during.length!==1||during[0].pid!==child.pid)throw Error('owned_process_detection_failed');}
 finally {child.kill('SIGTERM');exit=await exited;clearTimeout(timer);}
 const after=audit();const result={at:new Date().toISOString(),source:'positive_and_negative_control_for_process_audit',before,during,after,exit,timedOut,pass:!timedOut&&during.length===1&&after.length===0,rule:'all comm names, proc executable or cwd inside dedicated root, exclude audit itself'};console.log(JSON.stringify(result,null,2));if(!result.pass)process.exitCode=1;
})("/home/shaneee/secumon-linux-test.pCJ0bd");
