// Live inference only; never writes applications or sends email.
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
const model = process.argv[2] || '@cf/zai-org/glm-4.7-flash';
const repeats = Number(process.env.EVAL_REPEATS || 2);
const bundle = await build({stdin:{contents:'export {assessmentRequest,parseAssessment} from "./admissions/src/assessment"; export {qualifies,rejectStudent} from "./admissions/src/domain";',resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'node'});
const {assessmentRequest,parseAssessment,qualifies,rejectStudent} = await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const cases = JSON.parse(await readFile('admissions/evals/model-cases.json','utf8'));
const credential = JSON.parse(execFileSync('npx',['wrangler','auth','token','--json'],{encoding:'utf8'})).token;
const proxy = { env: { AI: { async run(model, input) {
 const response = await fetch('https://api.cloudflare.com/client/v4/accounts/076c525b59739562570401e48fc0651c/ai/run/'+model, {method:'POST',headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(45000)});
 const body=await response.json();
 if(!response.ok || !body.success) throw new Error(JSON.stringify(body.errors));
 return body.result;
} } } };
let failures=0;
try {
 for(let repeat=1;repeat<=repeats;repeat++) for(const fixture of cases) {
  const start=Date.now(); let timer;
  try {
   const raw=await Promise.race([proxy.env.AI.run(model,assessmentRequest(fixture.application,'2026-09-17')),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('inference_timeout')),45000);})]);
   const assessment=parseAssessment(raw);
   const actual=qualifies(assessment,fixture.application,Date.parse('2026-09-17T00:00:00Z'))?'approved':rejectStudent(assessment,fixture.application)?'declined':'review';
   const pass=actual===fixture.expected;if(!pass)failures++;
   console.log(JSON.stringify({model,case:fixture.name,repeat,pass,expected:fixture.expected,actual,ms:Date.now()-start,usage:raw.usage}));
  }catch(error){failures++;console.log(JSON.stringify({model,case:fixture.name,repeat,pass:false,error:String(error),ms:Date.now()-start}));}
  finally {clearTimeout(timer);}
 }
}finally {}
console.log(JSON.stringify({model,total:cases.length*repeats,failures}));
process.exit(failures?1:0);
