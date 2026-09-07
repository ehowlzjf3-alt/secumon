import {mkdtempSync,realpathSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openAgentLocalProfile} from '../dist/presentation/local-profile.js';
import {LocalWorkbench} from '../dist/presentation/local-workbench.js';
import {startWebServer} from '../dist/presentation/web-server.js';
import {verifyEvaluationBuild} from '../dist/infrastructure/local-evaluation.js';
const base=realpathSync(mkdtempSync(join(tmpdir(),'secumon-personal-browser-'))),directory=join(base,'agent');
const sourceAndBuild=await verifyEvaluationBuild(process.cwd());
const profile=await openAgentLocalProfile(directory),workbench=new LocalWorkbench(profile);
await workbench.initializeSession();
const work=await workbench.accept({requestId:'browser-personal-original',scenarioId:'documents-simple',mode:'auto',rawText:'브라우저 기억 시험: 답변은 한국어로 작성하고 먼저 세 문장으로 요약해 주세요.'});
const web=await startWebServer(workbench);
const record={base,directory,workId:work.workId,sessionId:work.sessionId,origin:web.origin,sourceAndBuild,startedAt:new Date().toISOString(),synthetic:true,modelCalls:false,closed:false};
const persist=()=>writeFileSync('evidence/C03-personal-browser-state.json',JSON.stringify(record,null,2)+'\n',{mode:0o600});persist();
let closing=false;async function close(){if(closing)return;closing=true;await web.close();await profile.close();rmSync(base,{recursive:true,force:true});Object.assign(record,{closed:true,temporaryProfileRemoved:true,finishedAt:new Date().toISOString()});persist();process.exit(0);}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
console.log(JSON.stringify({connectUrl:web.connectUrl,workId:work.workId,pid:process.pid}));
