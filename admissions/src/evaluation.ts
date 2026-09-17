import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { assessmentRequest, parseAssessment } from './assessment';
import { qualifies, rejectStudent, type Application } from './domain';
import cases from '../evals/model-cases.json';

// Bound only in staging. Runs real inference without creating members or sending email.
export class AssessmentEvaluationWorkflow extends WorkflowEntrypoint<Env, { repeats?: number }> {
 async run(event: WorkflowEvent<{ repeats?: number }>, step: WorkflowStep) {
  if(this.env.SITE_URL !== 'https://staging.genaicommunity.ai') throw new Error('Evaluation is staging-only');
  const repeats=Math.min(3,Math.max(1,event.payload.repeats || 2));
  const results=[];
  for(let round=1;round<=repeats;round++) for(const fixture of cases) {
   const result=await step.do(`${round}-${fixture.name}`,{retries:{limit:0,delay:'1 second'},timeout:'90 seconds'},async()=>{
    const start=Date.now();
    try {
     const application={...fixture.application,whatsapp:'+14155552671',linkedinUrl:'https://www.linkedin.com/in/synthetic-evaluation/'} as Application;
     const output=await this.env.AI.run(this.env.AI_MODEL as Parameters<Ai['run']>[0],assessmentRequest(application,'2026-09-17'));
     const assessment=parseAssessment(output);
     const actual=qualifies(assessment,application,Date.parse('2026-09-17T00:00:00Z'))?'approved':rejectStudent(assessment,application)?'declined':'review';
     return {case:fixture.name,round,expected:fixture.expected,actual,pass:actual===fixture.expected,ms:Date.now()-start};
    }catch {return {case:fixture.name,round,expected:fixture.expected,actual:'model_error',pass:false,ms:Date.now()-start};}
   });
   results.push(result);
  }
  return {model:this.env.AI_MODEL,total:results.length,failures:results.filter(r=>!r.pass).length,results};
 }
}
