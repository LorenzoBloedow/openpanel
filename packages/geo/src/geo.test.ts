import { describe, expect, it } from 'vitest';
import { getAsnInfo, getGeoLocation } from './geo';

const cf = {
  country: 'SE',
  city: 'Stockholm',
  region: 'Stockholm County',
  latitude: '59.32930',
  longitude: '18.06860',
  asn: 16509,
  asOrganization: 'Amazon.com',
};

describe('getGeoLocation', () => {
  it('uses request.cf when the event ip is the connecting ip', async () => {
    await expect(
      getGeoLocation('203.0.113.7', { cf, connectingIp: '203.0.113.7' }),
    ).resolves.toEqual({
      country: 'SE',
      city: 'Stockholm',
      region: 'Stockholm County',
      latitude: 59.3293,
      longitude: 18.0686,
    });
  });

  it('matches IPv6 addresses case-insensitively', async () => {
    const geo = await getGeoLocation('2001:DB8::1', {
      cf,
      connectingIp: '2001:db8::1',
    });
    expect(geo.country).toBe('SE');
  });

  it('returns empty geo for forwarded ips', async () => {
    await expect(
      getGeoLocation('198.51.100.1', { cf, connectingIp: '203.0.113.7' }),
    ).resolves.toEqual({
      country: undefined,
      city: undefined,
      region: undefined,
      latitude: undefined,
      longitude: undefined,
    });
  });

  it('drops cloudflare pseudo countries', async () => {
    const geo = await getGeoLocation('203.0.113.7', {
      cf: { ...cf, country: 'T1' },
      connectingIp: '203.0.113.7',
    });
    expect(geo.country).toBeUndefined();
  });

  it('ignores loopback and missing ips', async () => {
    expect((await getGeoLocation('127.0.0.1', { cf, connectingIp: '127.0.0.1' })).country).toBeUndefined();
    expect((await getGeoLocation(undefined, { cf })).country).toBeUndefined();
  });
});

describe('getAsnInfo', () => {
  it('flags datacenter networks', async () => {
    await expect(
      getAsnInfo('203.0.113.7', { cf, connectingIp: '203.0.113.7' }),
    ).resolves.toEqual({ asn: 16509, org: 'Amazon.com', isHosting: true });
  });

  it('does not flag residential networks', async () => {
    const info = await getAsnInfo('203.0.113.7', {
      cf: { ...cf, asn: 7922, asOrganization: 'Comcast' },
      connectingIp: '203.0.113.7',
    });
    expect(info.isHosting).toBe(false);
  });
});
