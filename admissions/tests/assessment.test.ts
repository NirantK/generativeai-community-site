import { describe, it, expect } from 'vitest';
import { assessmentRequest, parseAssessment } from '../src/assessment';
const assessment = {student:{status:'not_student',roleEvidence:'Engineer',exceptional:false,exceptionalEvidence:[]},affiliation:null,relevant:true,concrete:true,contribution:true,uncertain:false,reasons:'Concrete implementation',evidence:['I built an AI assistant.']};
const completion = (content: unknown, finish_reason = 'stop') => ({choices:[{finish_reason,message:{content}}]});
describe('model response contract', () => {
 it('reads the actual GLM/OpenAI completion envelope and older Workers AI envelopes', () => {
  expect(parseAssessment(completion(JSON.stringify(assessment)))).toEqual(assessment);
  expect(parseAssessment({response:assessment})).toEqual(assessment);
  expect(parseAssessment({response:JSON.stringify(assessment)})).toEqual(assessment);
 });
 it('fails closed on truncated, refused, empty, and schema-invalid answers', () => {
  for(const output of [completion(JSON.stringify(assessment),'length'),completion(JSON.stringify(assessment),'tool_calls'),completion(null),{choices:[]},{choices:[{finish_reason:'stop',message:{content:JSON.stringify(assessment),refusal:'refused'}}]},completion('{invalid'),completion('{}'),completion(JSON.stringify({...assessment,uncertain:'false'}))]) expect(()=>parseAssessment(output)).toThrow();
 });
 it('uses the named schema contract and omits identity and contact data', () => {
  const request=assessmentRequest({role:'Engineer',project:'AI project',contribution:'Implementation',motivation:'Share work',whatsapp:'+14155552671',linkedinUrl:'https://www.linkedin.com/in/private/'});
  expect(request.response_format.json_schema.name).toBe('admission_assessment');
  expect(request.response_format.json_schema.schema).toHaveProperty('properties.student');
  expect(JSON.stringify(request)).not.toContain('+14155552671');
  expect(JSON.stringify(request)).not.toContain('/in/private/');
 });
});
