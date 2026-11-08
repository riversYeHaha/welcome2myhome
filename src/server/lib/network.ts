import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

/** Virtual/VPN interfaces that are usually not the home Wi-Fi/LAN. */
const VIRTUAL_INTERFACE = /^(utun|tun|tap|docker|bridge|vmnet|veth|llw|awdl|gif|stf|anpi)/i;

function isPrivateIpv4(address: string): boolean {
  return (
    /^192\.168\./.test(address) ||
    /^10\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  );
}

/**
 * Pick the LAN IPv4 a phone should use. Prefers 192.168.x, then 10.x, then
 * 172.16/12, and prefers a physical `en*` interface over virtual adapters.
 * Returns null when the machine has no private IPv4 (e.g. offline).
 */
export function pickLanIp(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): string | null {
  const candidates: Array<{ address: string; rank: number }> = [];

  for (const [name, infos] of Object.entries(interfaces)) {
    if (!infos || VIRTUAL_INTERFACE.test(name)) continue;

    for (const info of infos) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (!isPrivateIpv4(info.address)) continue;

      let rank = 2;
      if (/^192\.168\./.test(info.address)) rank = 0;
      else if (/^10\./.test(info.address)) rank = 1;

      if (/^en\d+/.test(name)) rank -= 0.5;

      candidates.push({ address: info.address, rank });
    }
  }

  candidates.sort((a, b) => a.rank - b.rank);
  return candidates[0]?.address ?? null;
}

export function detectLanIp(): string | null {
  return pickLanIp(networkInterfaces());
}

/**
 * Host used in printed QR codes: explicit room LAN IP first, then detected
 * interface, and only then the request hostname (localhost fallback).
 */
export function publicHost(
  room: { lan_ip: string },
  fallbackHost: string,
  detected: string | null = detectLanIp(),
): string {
  return room.lan_ip || detected || fallbackHost;
}
