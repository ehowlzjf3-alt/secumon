import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root=resolve('..'),paths=['runtime/README.md','design/README.md','design/03-migration-plan.md','design/VERIFICATION.md','design/IMPLEMENTATION-RESUME.md','design/chapters/C03-document-memory-result.md','design/chapters/C03-document-draft-plan.md','design/chapters/C03-document-memory-cost-notes.md','design/chapters/C03-document-memory-plan.md','design/chapters/C03-postgres-adapter-notes.md','design/chapters/C03-personal-memory-cost-notes.md','design/secumon-review.html','design/implementation-backlog.json','design/chapters/C03-document-draft-result.md','design/chapters/C03-personal-memory-migration-plan.md','design/chapters/C03-personal-memory-migration-review.md','design/chapters/C03-personal-memory-migration-seed-notes.md','design/chapters/C03-personal-memory-migration-backup-notes.md','design/chapters/C04-next-implementation-notes.md'];
const issues=[],documents=[],links=[];let inlineScripts=0,modulePaths=0;
function link(from,to){if(!to||/^(https?:|mailto:|#|javascript:)/.test(to))return;const path=to.split('#')[0].replace(/:\d+$/,'');const absolute=resolve(dirname(resolve(root,from)),decodeURIComponent(path));links.push({from,to});if(!existsSync(absolute))issues.push({from,to,reason:'missing_file'});}
for(const p of paths){const text=readFileSync(resolve(root,p),'utf8');documents.push({path:p,sha256:createHash('sha256').update(text).digest('hex')});
 if(p.endsWith('.md'))for(const match of text.matchAll(/\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))\)/g))link(p,match[1]??match[2]);
 if(p.endsWith('.html')){
  const staticMarkup=text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');for(const match of staticMarkup.matchAll(/href="([^"]+)"/g))link(p,match[1]);
  for(const match of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)){if(match[1].includes('application/json')){const data=JSON.parse(match[2]);for(const m of data.modules)for(const path of [...m.files,...m.docs]){modulePaths++;if(!existsSync(resolve(root,path)))issues.push({module:m.id,path,reason:'missing_module_path'});}}else{new vm.Script(match[2]);inlineScripts++;}}
  const proof=JSON.parse(readFileSync('evidence/C03-drafts-verification.json','utf8'));assert(text.includes('초안'));assert(text.includes('data-nas-run="'+proof.nativeLinux.sessionId+'"'));
 }
}
const b=JSON.parse(readFileSync(resolve(root,'design/implementation-backlog.json'),'utf8'));assert.equal(b.execution_chapters.find(c=>c.id==='C03').status,'in_progress');assert.equal(b.next_execution_chapter,'C03');
const report={browserRender:'not_run_file_url_policy_blocked_not_bypassed',checkedAt:new Date().toISOString(),status:issues.length?'failed':'passed',documents,localLinks:links.length,modulePaths,inlineScripts,issues};writeFileSync('evidence/C03-drafts-doc-review.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,documents:documents.length,localLinks:links.length,modulePaths,inlineScripts,issues}));if(issues.length)process.exitCode=1;
