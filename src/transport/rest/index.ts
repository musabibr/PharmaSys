/**
 * Standalone REST server entry point.
 * Used when running without Electron (e.g., web/cloud deployment).
 * See platform/server/index.ts for the full standalone entry.
 */

import * as os from 'os';
import { createApp } from './server';
import type { ServiceContainer } from '../../core/services/index';

/** Returns all non-internal IPv4 addresses with adapter names. */
export function getAllLanIps(): Array<{ name: string; address: string }> {
  const results: Array<{ name: string; address: string }> = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const iface of addrs ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        results.push({ name, address: iface.address });
      }
    }
  }
  return results;
}

/** Returns the most likely LAN IP (prefers Wi-Fi, then 192.168.x.x, then 10.x.x.x). */
export function getLanIp(): string {
  const ips = getAllLanIps();
  if (ips.length === 0) return '127.0.0.1';
  // Prefer Wi-Fi adapter by name
  const wifi = ips.find(i => /wi-fi|wifi|wlan/i.test(i.name));
  if (wifi) return wifi.address;
  // Then 192.168.x.x (common router range)
  const lan192 = ips.find(i => i.address.startsWith('192.168.'));
  if (lan192) return lan192.address;
  // Then 10.x.x.x
  const lan10 = ips.find(i => i.address.startsWith('10.'));
  if (lan10) return lan10.address;
  return ips[0].address;
}

export function startRestServer(
  services: ServiceContainer,
  port: number = 3001,
  host: string = '127.0.0.1'
): void {
  const app = createApp(services);

  app.listen(port, host, () => {
    const lanIp = getLanIp();
    console.log(`[REST] PharmaSys API running on http://${host}:${port}/api/v1`);
    if (host === '0.0.0.0') {
      console.log(`[REST] LAN clients can connect to http://${lanIp}:${port}/api/v1`);
    }
  });
}
