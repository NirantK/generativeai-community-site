import { expect, it } from 'vitest';
import { withinReplyWindow, REPLY_MAX_AGE_MS } from '../src/chat-routing-policy';
it('uses original post age and includes exactly twelve hours, rejecting stale or invalid dates', () => {
 const now=Date.parse('2026-10-12T12:00:00Z');
 expect(withinReplyWindow(now-REPLY_MAX_AGE_MS,now)).toBe(true);
 expect(withinReplyWindow(now-REPLY_MAX_AGE_MS-1,now)).toBe(false);
 expect(withinReplyWindow(now-2*3600000,now)).toBe(true);
 for(const value of [NaN,Infinity,0,now+1])expect(withinReplyWindow(value,now)).toBe(false);
});
