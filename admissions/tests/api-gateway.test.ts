import { describe, expect, it, vi } from 'vitest';
import gateway from '../../api-gateway/index';

describe('direct API ingress', () => {
  it('forwards the original submission unchanged to existing auth and idempotency handling', async () => {
    const request = new Request('https://genaicommunity.ai/api/v1/application', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Idempotency-Key': 'same-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Existing application draft' }),
    });
    const expected = new Response('{"error":{"code":"invalid_token"}}', { status: 401 });
    const fetch = vi.fn(async (forwarded: Request) => {
      expect(forwarded).toBe(request);
      expect(forwarded.headers.get('Authorization')).toBe('Bearer test-token');
      expect(forwarded.headers.get('Idempotency-Key')).toBe('same-key');
      expect(await forwarded.json()).toEqual({ project: 'Existing application draft' });
      return expected;
    });
    const result = await gateway.fetch(request, { SITE_URL: 'https://genaicommunity.ai', ADMISSIONS: { fetch } } as never);
    expect(result).toBe(expected);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    'https://genaicommunity.ai/api/application-token',
    'https://genaicommunity.ai/api/admin/access',
    'https://genaicommunity.ai/auth/linkedin',
    'https://genaicommunity.ai/api/v1-malformed/application',
    'https://other.example/api/v1/application',
    'http://genaicommunity.ai/api/v1/application',
  ])('never exposes non-API or wrong-origin handlers: %s', async (url) => {
    const fetch = vi.fn();
    const result = await gateway.fetch(new Request(url), { SITE_URL: 'https://genaicommunity.ai', ADMISSIONS: { fetch } } as never);
    expect(result.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves cookie authentication and origin checks for the browser form', async () => {
    const request = new Request('https://genaicommunity.ai/api/v1/application', {
      headers: { Cookie: '__Host-ga-session=test', Origin: 'https://genaicommunity.ai' },
    });
    const fetch = vi.fn(async (forwarded: Request) => {
      expect(forwarded).toBe(request);
      return new Response('rate limited', { status: 429, headers: { 'Retry-After': '60' } });
    });
    const result = await gateway.fetch(request, { SITE_URL: 'https://genaicommunity.ai', ADMISSIONS: { fetch } } as never);
    expect(result.status).toBe(429);
    expect(result.headers.get('Retry-After')).toBe('60');
  });
});
