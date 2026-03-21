/**
 * UDP auto-discovery for LAN server/client setup.
 *
 * Server side: listens for broadcast discovery requests and responds with server info.
 * Client side: sends broadcast and collects responses from servers on the network.
 *
 * Uses Node.js built-in `dgram` — zero external dependencies.
 */

import * as dgram from 'dgram';
import { getLanIp, getAllLanIps } from './rest/index';

const DISCOVERY_PORT = 41234;
const DISCOVERY_MAGIC = 'PHARMASYS_DISCOVER';

export interface ServerInfo {
  app: 'pharmasys';
  ip: string;
  port: number;
  name: string;
  version: string;
}

// ─── Server Side ──────────────────────────────────────────────────────────────

/**
 * Start a UDP responder that replies to discovery broadcasts.
 * Call this on the server device after starting the REST server.
 * Returns the socket so it can be closed on shutdown.
 */
export function startDiscoveryResponder(
  serverPort: number,
  serverName: string,
  version: string = '1.0.0',
): dgram.Socket {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('message', (msg, rinfo) => {
    const text = msg.toString('utf-8').trim();
    if (text !== DISCOVERY_MAGIC) return;

    const response: ServerInfo = {
      app: 'pharmasys',
      ip: getLanIp(),
      port: serverPort,
      name: serverName,
      version,
    };

    const buf = Buffer.from(JSON.stringify(response), 'utf-8');
    socket.send(buf, 0, buf.length, rinfo.port, rinfo.address, (err) => {
      if (err) console.warn('[Discovery] Failed to respond:', err.message);
    });
  });

  socket.on('error', (err) => {
    console.warn('[Discovery] Responder error:', err.message);
    try { socket.close(); } catch { /* ignore */ }
  });

  socket.bind(DISCOVERY_PORT, '0.0.0.0', () => {
    console.log(`[Discovery] Listening for broadcasts on port ${DISCOVERY_PORT}`);
  });

  return socket;
}

// ─── Client Side ──────────────────────────────────────────────────────────────

/**
 * Broadcast a discovery request and collect server responses.
 * Returns an array of discovered servers (may be empty if none found).
 */
export function discoverServers(timeoutMs: number = 3000): Promise<ServerInfo[]> {
  return new Promise((resolve) => {
    const found: ServerInfo[] = [];
    const seen = new Set<string>(); // deduplicate by ip:port

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const cleanup = () => {
      try { socket.close(); } catch { /* ignore */ }
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(found);
    }, timeoutMs);

    socket.on('message', (msg, rinfo) => {
      try {
        const info: ServerInfo = JSON.parse(msg.toString('utf-8'));
        if (info.app !== 'pharmasys') return;
        // Use the actual source IP of the UDP packet instead of the
        // payload's ip field — the OS picks the correct outgoing interface,
        // so rinfo.address is always the reachable server IP.
        info.ip = rinfo.address;
        const key = `${info.ip}:${info.port}`;
        if (seen.has(key)) return;
        seen.add(key);
        found.push(info);
      } catch { /* ignore malformed responses */ }
    });

    socket.on('error', (err) => {
      console.warn('[Discovery] Scanner error:', err.message);
      clearTimeout(timer);
      cleanup();
      resolve(found);
    });

    socket.bind(0, () => {
      socket.setBroadcast(true);

      const msg = Buffer.from(DISCOVERY_MAGIC, 'utf-8');

      // Send to global broadcast address
      socket.send(msg, 0, msg.length, DISCOVERY_PORT, '255.255.255.255', (err) => {
        if (err) {
          console.warn('[Discovery] Broadcast send error:', err.message);
          clearTimeout(timer);
          cleanup();
          resolve(found);
          return;
        }

        // Also send to subnet-specific broadcast addresses (more reliable on
        // some routers/adapters that drop global 255.255.255.255 broadcasts).
        // Assumes /24 subnets — covers the vast majority of home/office networks.
        const localIps = getAllLanIps();
        for (const { address } of localIps) {
          const parts = address.split('.');
          parts[3] = '255';
          const subnetBroadcast = parts.join('.');
          socket.send(msg, 0, msg.length, DISCOVERY_PORT, subnetBroadcast, () => {});
        }
      });
    });
  });
}
