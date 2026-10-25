import { expect, it } from 'vitest';
import { withinReplyWindow, REPLY_MAX_AGE_MS } from '../src/chat-routing-policy';
it('uses original post age and includes exactly twelve hours, rejecting stale or invalid dates', () => {
 const now=Date.parse('2026-10-12T12:00:00Z');
 expect(withinReplyWindow(now-REPLY_MAX_AGE_MS,now)).toBe(true);
 expect(withinReplyWindow(now-REPLY_MAX_AGE_MS-1,now)).toBe(false);
 expect(withinReplyWindow(now-2*3600000,now)).toBe(true);
 for(const value of [NaN,Infinity,0,now+1])expect(withinReplyWindow(value,now)).toBe(false);
});

import { routingTrialPassed, reviewRequirementWaived, moveReply } from '../src/chat-routing-policy';
it('waives only the review gate with an attributed waiver and preserves truthful counts',()=>{
 const now=Date.parse('2026-10-25T12:00:00Z');const settings={trial_started_at:now-8*86400000};
 expect(routingTrialPassed(settings,1,1,now)).toBe(false);
 expect(routingTrialPassed(settings,30,29,now)).toBe(true);
 expect(routingTrialPassed(settings,30,28,now)).toBe(false);
 for(const waiver of [{review_waived_at:now},{review_waived_by:'admin'},{review_waived_at:now,review_waived_by:' '}])expect(reviewRequirementWaived({...settings,...waiver})).toBe(false);
 const waived={...settings,review_waived_at:now,review_waived_by:'admin'};
 expect(routingTrialPassed(waived,1,1,now)).toBe(true);
 expect(routingTrialPassed({...waived,trial_started_at:now},1,1,now)).toBe(false);
 for(const destination of ['general','jobs','demos_events'] as const)expect(moveReply(destination).endsWith('\n\n- Sent by my agent')).toBe(true);
});
