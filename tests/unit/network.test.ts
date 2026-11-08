import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { pickLanIp, publicHost } from '../../src/server/lib/network';

function iface(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  };
}

describe('LAN IP detection', () => {
  it('prefers 192.168.x on a physical interface over VPN/10.x', () => {
    const interfaces = {
      lo0: [iface('127.0.0.1', true)],
      utun3: [iface('10.8.0.1')],
      en1: [iface('10.0.0.7')],
      en0: [iface('192.168.3.20')],
    };

    expect(pickLanIp(interfaces)).toBe('192.168.3.20');
  });

  it('ignores virtual interfaces and non-private IPv4', () => {
    const interfaces = {
      utun3: [iface('10.8.0.1')],
      bridge0: [iface('192.168.64.1')],
      en0: [iface('203.0.113.9')],
    };

    expect(pickLanIp(interfaces)).toBeNull();
  });

  it('resolves the public host with the right precedence', () => {
    expect(publicHost({ lan_ip: '192.168.1.50' }, '127.0.0.1', '10.0.0.9')).toBe(
      '192.168.1.50',
    );
    expect(publicHost({ lan_ip: '' }, '127.0.0.1', '192.168.3.20')).toBe('192.168.3.20');
    expect(publicHost({ lan_ip: '' }, '127.0.0.1', null)).toBe('127.0.0.1');
  });
});
