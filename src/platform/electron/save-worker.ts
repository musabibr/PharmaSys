/**
 * Worker thread for database file I/O.
 * Receives a Uint8Array buffer from the main thread and writes it to disk
 * atomically (tmp file + rename) without blocking the main thread's event loop.
 */
import { parentPort } from 'worker_threads';
import * as fs from 'fs';

parentPort?.on('message', (msg: { data: Uint8Array; dbFile: string }) => {
  const tmp = msg.dbFile + '.tmp';
  let attempts = 0;
  const tryWrite = (): void => {
    try {
      fs.writeFileSync(tmp, msg.data);
      fs.renameSync(tmp, msg.dbFile);
      parentPort?.postMessage({ ok: true });
    } catch (err: any) {
      if (err.code === 'EPERM' && attempts < 3) {
        attempts++;
        setTimeout(tryWrite, 100);
      } else {
        parentPort?.postMessage({ ok: false, error: err.message });
      }
    }
  };
  tryWrite();
});
