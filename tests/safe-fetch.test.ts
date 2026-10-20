import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSafeUrl, fetchPublic, isPublicAddress, UnsafeTargetError } from '../pipeline/safe-fetch';

afterEach(() => vi.unstubAllGlobals());

describe('untrusted source URL boundary', () => {
  it('allows GitHub Blog public hosting without allowing special 192.0 subnets', () => {
    expect(isPublicAddress('192.0.66.2')).toBe(true);
    for (const ip of ['192.0.0.1', '192.0.0.170', '192.0.2.1', '192.168.1.1']) {
      expect(isPublicAddress(ip)).toBe(false);
    }
  });
  it('rejects local and reserved targets before making a request', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    for (const url of ['http://127.0.0.1/private', 'http://169.254.169.254/metadata', 'http://[::1]/', 'http://localhost/', 'file:///etc/passwd']) {
      await expect(fetchPublic(url)).rejects.toBeInstanceOf(UnsafeTargetError);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('validates every redirect target before following it', async () => {
    const request = vi.fn().mockResolvedValue(new Response('', { status: 302, headers: { Location: 'http://10.0.0.5/internal' } }));
    vi.stubGlobal('fetch', request);
    await expect(fetchPublic('https://example.com/free')).rejects.toBeInstanceOf(UnsafeTargetError);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('classifies both IP families and rejects embedded credentials', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('192.168.1.1')).toBe(false);
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false);
    expect(() => assertSafeUrl('https://user:secret@example.com/')).toThrow(UnsafeTargetError);
  });
});
