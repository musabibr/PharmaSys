/**
 * Electron main process entry point.
 *
 * Responsibilities:
 *  - Boot the database (better-sqlite3)
 *  - Initialise repositories + services (ServiceContainer)
 *  - Register all IPC handlers
 *  - Create and manage the BrowserWindow (React frontend)
 *  - Optionally start the embedded REST server
 */

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path   from 'path';
import * as fs     from 'fs';
import { execFile } from 'child_process';
import Database     from 'better-sqlite3';

import type { BaseRepository }   from '../../core/repositories/sql/base.repository';
import { MigrationRepository }  from '../../core/repositories/sql/migration.repository';
import { createRepositories }   from '../../core/repositories/sql/index';
import { ServiceContainer }     from '../../core/services/index';
import { EventBus }             from '../../core/events/event-bus';
import { registerAllHandlers }  from '../../transport/ipc/register';
import { startRestServer, getLanIp, getAllLanIps } from '../../transport/rest/index';
import { startDiscoveryResponder, discoverServers } from '../../transport/discovery';
import type { UserPublic }      from '../../core/types/models';

// License system
import { decodeKey }                                        from '../../license/activation-key';
import { setLicensePath, loadLicense, validateLicense,
         createAndSaveLicense, deleteLicense }              from '../../license/local-license';
import { setMachineIdCachePath, getMachineId, getDisplayMachineId } from '../../license/machine-id';

// ─── Device Mode Types ───────────────────────────────────────────────────────

type DeviceMode = 'standalone' | 'server' | 'client';

interface DeviceConfig {
  mode: DeviceMode;
  serverHost: string;
  serverPort: number;
}

// ─── App State ────────────────────────────────────────────────────────────────

const isDev      = process.argv.includes('--dev') || !app.isPackaged;
const useLegacy  = process.argv.includes('--legacy');

// Resolves to project root whether running via tsx (src/platform/electron)
// or compiled (dist-ts/platform/electron) — both are 3 levels deep.
const projectRoot = path.join(__dirname, '../../..');

// app.getPath('userData') already resolves to %APPDATA%/PharmaSys (from productName)
// so we only append 'data', not 'PharmaSys/data'.
const dataPath = isDev
  ? path.join(projectRoot, 'data')
  : path.join(app.getPath('userData'), 'data');

// ─── Fresh Install Detection ─────────────────────────────────────────────────
// The NSIS installer writes a `fresh_install` marker to $INSTDIR.
// On first launch after install, detect it and clear user data ourselves.
// We cannot rely on NSIS to clear data because $APPDATA in an elevated
// installer resolves to the ADMIN profile, not the actual user's AppData.

const freshMarkerPath = isDev
  ? path.join(projectRoot, 'fresh_install')
  : path.join(path.dirname(process.execPath), 'fresh_install');

// Guard: a user-writable marker that records we already processed the fresh install.
// The INSTDIR marker may be undeletable (C:\Program Files requires admin rights),
// so without this guard the data directory would be wiped on EVERY launch.
const freshProcessedPath = path.join(dataPath, '.fresh_install_processed');

if (fs.existsSync(freshMarkerPath) && !fs.existsSync(freshProcessedPath)) {
  console.log('[Startup] Fresh install marker detected — clearing previous data');
  try {
    // Clear the data directory SELECTIVELY — preserve backups/ and .backup-key
    // so old backups remain restorable after reinstall
    if (fs.existsSync(dataPath)) {
      const preserveSet = new Set(['backups', '.backup-key']);
      for (const entry of fs.readdirSync(dataPath)) {
        if (!preserveSet.has(entry)) {
          try {
            fs.rmSync(path.join(dataPath, entry), { recursive: true, force: true });
          } catch { /* locked file — best effort */ }
        }
      }
      console.log('[Startup] Cleared data directory (preserved backups/):', dataPath);
    }

    // Clear Electron caches and session storage in userData
    if (!isDev) {
      const userData = app.getPath('userData');
      const cacheDirs = [
        'Cache', 'Code Cache', 'DawnCache', 'GPUCache',
        'Local Storage', 'Network', 'Session Storage',
        'Shared Dictionary', 'SharedStorage', 'blob_storage',
      ];
      for (const dir of cacheDirs) {
        const p = path.join(userData, dir);
        if (fs.existsSync(p)) {
          try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* locked by Electron */ }
        }
      }
      // Delete single files
      for (const f of ['Preferences', 'Local State']) {
        const p = path.join(userData, f);
        if (fs.existsSync(p)) {
          try { fs.unlinkSync(p); } catch { /* ignore */ }
        }
      }
    }

    // Mark as processed in user-writable dataPath (survives even if INSTDIR marker can't be deleted)
    fs.mkdirSync(dataPath, { recursive: true });
    fs.writeFileSync(freshProcessedPath, new Date().toISOString());

    // Try to delete the INSTDIR marker (may fail if no admin rights — that's OK now)
    try { fs.unlinkSync(freshMarkerPath); } catch { /* OK — freshProcessedPath guards us */ }
    console.log('[Startup] Fresh install cleanup complete');
  } catch (err) {
    console.error('[Startup] Fresh install cleanup error:', (err as Error).message);
  }
} else {
  if (fs.existsSync(freshMarkerPath)) {
    console.log('[Startup] Fresh install marker exists but already processed — skipping data wipe');
  } else {
    console.log('[Startup] No fresh install marker at:', freshMarkerPath);
  }
}

// ─── Device Config ───────────────────────────────────────────────────────────

function loadDeviceConfig(): DeviceConfig {
  const configPath = path.join(dataPath, 'device-config.json');
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch { /* fall through to default */ }
  return { mode: 'standalone', serverHost: '', serverPort: 3001 };
}

function saveDeviceConfig(config: DeviceConfig): void {
  fs.mkdirSync(dataPath, { recursive: true });
  const configPath = path.join(dataPath, 'device-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`[DeviceConfig] Saved to ${configPath}: ${JSON.stringify(config)}`);
  // Verify the write succeeded
  if (!fs.existsSync(configPath)) {
    console.error(`[DeviceConfig] CRITICAL: File not found after write! dataPath=${dataPath}`);
  }
}

// ─── Firewall Auto-Rule (Windows) ───────────────────────────────────────────

function ensureFirewallRules(tcpPort: number, udpPort: number): void {
  // Run firewall checks asynchronously to avoid blocking the main thread
  execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=PharmaSys Server'],
    { timeout: 5000 }, (err, stdout) => {
      if (!err && stdout.includes('PharmaSys Server')) return; // already exists
      // Create rules
      execFile('netsh', ['advfirewall', 'firewall', 'add', 'rule',
        'name=PharmaSys Server', 'dir=in', 'action=allow', 'protocol=TCP', `localport=${tcpPort}`],
        { timeout: 5000 }, (addErr) => {
          if (addErr) {
            console.warn('[Firewall] Could not create TCP rule (may need admin):', addErr.message);
          }
        });
      execFile('netsh', ['advfirewall', 'firewall', 'add', 'rule',
        'name=PharmaSys Discovery', 'dir=in', 'action=allow', 'protocol=UDP', `localport=${udpPort}`],
        { timeout: 5000 }, (addErr) => {
          if (addErr) {
            console.warn('[Firewall] Could not create UDP rule (may need admin):', addErr.message);
          } else {
            console.log(`[Firewall] Inbound rules created for TCP:${tcpPort} UDP:${udpPort}`);
          }
        });
    });
}

const deviceConfig = loadDeviceConfig();

// CLI flags override config file
let deviceMode: DeviceMode =
  process.argv.includes('--server') ? 'server'
  : process.argv.includes('--client') ? 'client'
  : deviceConfig.mode;

let mainWindow:    BrowserWindow | null = null;
let services:      ServiceContainer | null = null;
let currentUser:   UserPublic | null = null;
let isReconfiguringWindow = false; // Guard: prevent app.quit() during window recreation

const getCurrentUser = (): UserPublic | null => currentUser;
const setCurrentUser = (u: UserPublic | null): void => { currentUser = u; };

let baseRepo: BaseRepository | null = null;
let pendingCorruptionAlert: string | null = null;

// ─── Database Initialisation ─────────────────────────────────────────────────

async function initDatabase(): Promise<ServiceContainer> {
  fs.mkdirSync(dataPath, { recursive: true });

  const dbFile = path.join(dataPath, 'pharmasys.db');

  // ── Corruption recovery ────────────────────────────────────────────────
  // Try to open the database file. If it's corrupted, attempt auto-restore
  // from the most recent backup.
  if (fs.existsSync(dbFile)) {
    try {
      // Quick open + sanity check
      const testDb = new Database(dbFile, { readonly: true });
      try {
        // better-sqlite3 opens lazily, so a corrupt / all-zero / non-SQLite file
        // does NOT fail on `new Database(...)`. Force a real header + schema read
        // here so corruption is detected. This MUST be outside the users-table
        // check below — otherwise SQLITE_NOTADB gets swallowed as "table missing".
        testDb.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
        try {
          const row = testDb.prepare('SELECT COUNT(*) as cnt FROM users').get() as any;
          console.log(`[DB] Database loaded — ${row?.cnt ?? 0} user(s) found`);
        } catch { /* table may not exist yet — that's OK */ }
      } finally {
        testDb.close();
      }
    } catch (loadErr) {
      // Database file is corrupted — preserve it and attempt recovery
      const corruptPath = `${dbFile}.corrupted.${Date.now()}`;
      try { fs.renameSync(dbFile, corruptPath); } catch { /* best effort */ }
      console.error(`[DB] Corrupted database file — renamed to ${path.basename(corruptPath)}`);
      console.error(`[DB] Load error: ${(loadErr as Error).message}`);

      let restored = false;
      const backupDir = path.join(dataPath, 'backups');
      if (fs.existsSync(backupDir)) {
        const baks = fs.readdirSync(backupDir)
          .filter(f => f.startsWith('pharmasys-backup-') && f.endsWith('.bak'))
          .sort().reverse();
        for (const bak of baks) {
          try {
            const bakPath = path.join(backupDir, bak);
            // Validate backup is a valid SQLite file
            const bakDb = new Database(bakPath, { readonly: true });
            bakDb.close();
            // Copy backup to db path
            fs.copyFileSync(bakPath, dbFile);
            console.log(`[DB] Restored from backup: ${bak}`);
            const tsMatch = bak.match(/pharmasys-backup-([\dT:.\-]+Z?)/);
            let ageDescription = '';
            if (tsMatch) {
              const isoLike = tsMatch[1].replace(/-(\d{2})-(\d{2})-(\d{3}Z?)$/, ':$1:$2.$3');
              const bakDate = new Date(isoLike);
              if (!isNaN(bakDate.getTime())) {
                const ageMs = Date.now() - bakDate.getTime();
                const hours = Math.floor(ageMs / 3_600_000);
                const minutes = Math.floor((ageMs % 3_600_000) / 60_000);
                ageDescription = hours > 0
                  ? `Backup is ${hours}h ${minutes}m old (taken ${bakDate.toLocaleString()}). `
                  : `Backup is ${minutes}m old (taken ${bakDate.toLocaleString()}). `;
              }
            }
            pendingCorruptionAlert =
              `Restored from: ${bak}\n` +
              `${ageDescription}\n` +
              `The corrupted file has been preserved at:\n${path.basename(corruptPath)}`;
            restored = true;
            break;
          } catch { /* backup unreadable — try next */ }
        }
      }

      if (!restored) {
        console.log('[DB] No usable backup found — starting with fresh empty database');
        pendingCorruptionAlert =
          'Database was corrupted and no backup was available to restore from.\n\n' +
          'A fresh empty database has been created. Previous data has been lost.\n\n' +
          `The corrupted file has been preserved at:\n${corruptPath}`;
      }
    }
  } else {
    console.log(`[DB] No database file found at ${dbFile} — creating new database`);
  }

  // ── Open database (better-sqlite3 creates the file if it doesn't exist) ──
  // WAL mode + foreign keys are set inside BaseRepository constructor.
  const repos = createRepositories(dbFile, dataPath);
  baseRepo = repos.base;

  // Run schema creation, migrations, seed data — safe to call on every startup
  const migration = new MigrationRepository(repos.base, dataPath);
  await migration.initialise(isDev);

  // Convert any old encrypted backups (.enc) to raw SQLite (.bak) while key exists
  try { repos.backup.migrateEncryptedBackups(); } catch (err) {
    console.warn('[Startup] Backup migration warning:', (err as Error).message);
  }

  const bus = new EventBus();
  const svc = new ServiceContainer(repos, bus, dataPath);

  return svc;
}

// ─── Window Management ────────────────────────────────────────────────────────

function createWindow(): void {
  const iconPath = path.join(projectRoot, 'build/icon.ico');
  const isClient = deviceMode === 'client';

  // Client mode uses REST-based preload; standalone/server use IPC preload
  const preloadPath = isClient
    ? path.join(projectRoot, 'src/main/preload-rest.js')
    : path.join(projectRoot, 'src/main/preload.js');

  const additionalArguments = isClient
    ? [`--server-url=http://${deviceConfig.serverHost}:${deviceConfig.serverPort}`]
    : [];

  const opts: Electron.BrowserWindowConstructorOptions = {
    width: 1400, height: 900,
    minWidth: 1200, minHeight: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath,
      sandbox: true,
      additionalArguments,
      devTools: isDev,
    },
    title: isClient ? 'PharmaSys (Client)' : deviceMode === 'server' ? 'PharmaSys (Server)' : 'PharmaSys',
    backgroundColor: '#0a0f0d',
    show: false,
  };

  if (fs.existsSync(iconPath)) opts.icon = iconPath;

  mainWindow = new BrowserWindow(opts);

  // Choose renderer: React (default) or legacy vanilla JS (--legacy flag)
  const reactDist = path.join(projectRoot, 'dist-renderer/index.html');
  const legacyHtml = path.join(projectRoot, 'src/renderer/index.html');

  if (useLegacy) {
    mainWindow.loadFile(legacyHtml);
  } else if (isDev) {
    // In dev mode, wait for Vite dev server then load it
    const viteUrl = 'http://localhost:5173';
    const tryLoadVite = (retries: number): void => {
      mainWindow!.loadURL(viteUrl).catch(() => {
        if (retries > 0) {
          setTimeout(() => tryLoadVite(retries - 1), 1000);
        } else {
          console.warn('[Window] Vite dev server not available, using built files');
          if (fs.existsSync(reactDist)) {
            mainWindow!.loadFile(reactDist);
          } else {
            mainWindow!.loadFile(legacyHtml);
          }
        }
      });
    };
    tryLoadVite(10); // retry for up to ~10 seconds
  } else {
    if (fs.existsSync(reactDist)) {
      mainWindow.loadFile(reactDist);
    } else {
      // Fallback to legacy if React build not found
      mainWindow.loadFile(legacyHtml);
    }
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow!.show();
    // DevTools: use Ctrl+Shift+I manually if needed
    if (!isDev) mainWindow!.maximize();
    // Explicitly focus the web contents after showing. On Electron/Windows the freshly
    // shown window sometimes does not route keyboard input to inputs (the "frozen login
    // field, fixed by minimize/maximize" bug) until webContents is focused.
    mainWindow!.focus();
    mainWindow!.webContents.focus();
  });
  // Re-assert web-contents focus when the window regains focus or is restored — otherwise
  // input fields can stay unresponsive after alt-tab / minimize-restore on Windows.
  mainWindow.on('focus', () => mainWindow?.webContents.focus());
  mainWindow.on('restore', () => mainWindow?.webContents.focus());
  mainWindow.on('closed', () => {
    mainWindow = null;
    currentUser = null;
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
}

// ─── PDF Python Parser IPC ────────────────────────────────────────────────────

function registerPdfParseHandler(): void {
  ipcMain.handle('pdf:parsePython', async (_event, buffer: ArrayBuffer) => {
    // Write buffer to a temp file
    const tmpDir = path.join(dataPath, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `pdf-${Date.now()}.pdf`);

    try {
      fs.writeFileSync(tmpFile, Buffer.from(buffer));

      // Resolve executable / script
      let cmd: string;
      let args: string[];

      if (isDev) {
        cmd = 'python';
        args = [path.join(projectRoot, 'scripts/pdf_invoice_parser.py'), tmpFile];
      } else {
        const exePath = path.join(process.resourcesPath!, 'pdf_invoice_parser.exe');
        if (!fs.existsSync(exePath)) {
          throw new Error('PDF parser not found. Please reinstall the application.');
        }
        cmd = exePath;
        args = [tmpFile];
      }

      // Spawn and collect output
      const result = await new Promise<string>((resolve, reject) => {
        execFile(cmd, args, {
          timeout: 60_000,
          maxBuffer: 10 * 1024 * 1024, // 10 MB
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        }, (error, stdout, stderr) => {
          // If we got valid JSON, resolve it even if there was an error (graceful degradation)
          if (stdout && stdout.trim().startsWith('[')) {
            try {
              JSON.parse(stdout); // verify it's valid JSON
              if (error) {
                console.warn('[PDFParser] Process exited with error, but partial data was recovered:', error.message);
                if (stderr) console.warn('[PDFParser] Stderr:', stderr);
              }
              return resolve(stdout);
            } catch {
              // Not valid JSON, fall through to error handling
            }
          }

          if (error) {
            if ((error as any).code === 'ENOENT') {
              reject(new Error('Python is not installed or not in PATH.'));
            } else if ((error as any).killed) {
              reject(new Error('PDF parsing timed out (60s).'));
            } else {
              reject(new Error(stderr?.trim() || error.message));
            }
            return;
          }
          resolve(stdout);
        });
      });

      // Parse JSON
      try {
        return JSON.parse(result);
      } catch {
        throw new Error('PDF parser returned invalid data.');
      }
    } finally {
      // Clean up temp file
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  });
}

// ─── Register All Handlers (called after license validation) ─────────────────

function registerAllAppHandlers(): void {
  if (!services) return;
  registerAllHandlers(ipcMain, services, getCurrentUser, setCurrentUser);
  registerPdfParseHandler();
}

// ─── License Gate ────────────────────────────────────────────────────────────

function checkLicense(): { valid: boolean; reason?: string; daysRemaining?: number } {
  const license = loadLicense();
  if (!license) return { valid: false, reason: 'No license found. Please activate.' };
  const currentMachineId = getMachineId();
  const status = validateLicense(license, currentMachineId);
  if (!status.valid) {
    deleteLicense(); // Remove tampered/expired/wrong-device file
    return { valid: false, reason: status.reason };
  }
  return { valid: true, daysRemaining: status.daysRemaining };
}

function showActivationScreen(reason?: string): void {
  const iconPath = path.join(projectRoot, 'build/icon.ico');
  const licensePreload = path.join(projectRoot, 'src/main/license-preload.js');
  const htmlPath = path.join(__dirname, 'license-screen/not-activated.html');
  const displayId = getDisplayMachineId();

  const win = new BrowserWindow({
    width: 520, height: 580,
    resizable: false,
    maximizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: licensePreload,
      sandbox: true,
      devTools: isDev,
    },
    title: 'PharmaSys — Activation',
    backgroundColor: '#1e1e2e',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
  });

  const params = new URLSearchParams();
  if (reason) params.set('reason', reason);
  params.set('machineId', displayId);
  win.loadFile(htmlPath, { search: params.toString() });

  // IPC: activate with key (device-independent), then bind to this machine
  const fullMachineId = getMachineId();
  ipcMain.handle('license:activate', async (_event, keyString: string) => {
    const result = decodeKey(keyString);
    if (!result.valid) {
      return { success: false, error: result.reason || 'Invalid key' };
    }

    // Create local license bound to this machine
    createAndSaveLicense(keyString, result.payload!.licenseDurationDays, fullMachineId);
    console.log(`[License] Activated — duration: ${result.payload!.licenseDurationDays === 0 ? 'forever' : result.payload!.licenseDurationDays + ' days'}`);

    // Boot main app, then close activation window
    // Guard: prevent app.quit() while transitioning windows
    isReconfiguringWindow = true;
    setTimeout(async () => {
      try {
        ipcMain.removeHandler('license:activate');
        ipcMain.removeHandler('license:getStatus');
        await bootMainApp();
        win.close();
      } catch (err) {
        console.error('[License] Failed to boot after activation:', err);
        win.close();
      } finally {
        isReconfiguringWindow = false;
      }
    }, 1500);

    return { success: true };
  });

  ipcMain.handle('license:getStatus', () => {
    return checkLicense();
  });

  win.on('closed', () => {
    ipcMain.removeHandler('license:activate');
    ipcMain.removeHandler('license:getStatus');
  });
}

async function bootMainApp(): Promise<void> {
  // ── Client mode — no local database ─────────────────────────────────
  if (deviceMode === 'client') {
    console.log(`[Startup] Client mode → connecting to http://${deviceConfig.serverHost}:${deviceConfig.serverPort}`);
    createWindow();
    return;
  }

  // ── Standalone / Server mode — local database ───────────────────────
  services = await initDatabase();

  // ── Auto-generate recurring expenses ───────────────────────────────
  let startupGeneratedCount = 0;
  const generationMode = await services.settings.get('recurring_generation_mode') ?? 'startup';
  if (generationMode !== 'manual') {
    try {
      startupGeneratedCount = await services.recurringExpense.generateForMissedDays(1);
      if (startupGeneratedCount > 0) console.log(`[Startup] Auto-generated ${startupGeneratedCount} recurring expense(s)`);
    } catch (err) {
      console.warn('[Startup] Failed to auto-generate recurring expenses:', (err as Error).message);
    }
  }

  if (startupGeneratedCount > 0) {
    ipcMain.once('app:ready', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('startup:recurringGenerated', { count: startupGeneratedCount });
      }
    });
  }

  // ── Register IPC/REST handlers ─────────────────────────────────────
  registerAllAppHandlers();

  // Backup save-as dialog
  ipcMain.handle('backup:saveAs', async (_event, sourcePath: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) return { success: false, error: 'No window available' };
    const backupDir = path.resolve(path.join(dataPath, 'backups'));
    const resolvedSource = path.resolve(sourcePath);
    if (!resolvedSource.startsWith(backupDir + path.sep) && resolvedSource !== backupDir) {
      return { success: false, error: 'Invalid backup source path' };
    }
    const defaultName = path.basename(sourcePath);
    const ext = path.extname(defaultName).replace('.', '') || 'bak';
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: 'Save Backup As',
      defaultPath: defaultName,
      filters: [{ name: 'PharmaSys Backup', extensions: [ext] }],
    });
    win.webContents.focus(); // native dialog can leave inputs unresponsive until refocus
    if (canceled || !filePath) return { success: false };
    try {
      fs.copyFileSync(sourcePath, filePath);
      return { success: true, savedPath: filePath };
    } catch (err) {
      return { success: false, error: `Failed to save backup: ${(err as Error).message}` };
    }
  });

  // Restore backup from external file
  ipcMain.handle('backup:restoreFromFile', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) return { success: false, error: 'No window available' };
    const { filePaths, canceled } = await dialog.showOpenDialog(win, {
      title: 'Select Backup File',
      filters: [{ name: 'PharmaSys Backup', extensions: ['bak', 'enc', 'sqlite'] }],
      properties: ['openFile'],
    });
    win.webContents.focus(); // native dialog can leave inputs unresponsive until refocus
    if (canceled || filePaths.length === 0) return { success: false };
    const selectedFile = filePaths[0];
    const backupDir = path.join(dataPath, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    // Temp-then-promote: copy to a temporary file first
    const tmpFilename = `restore-${Date.now()}.tmp`;
    const tmpPath = path.join(backupDir, tmpFilename);
    fs.copyFileSync(selectedFile, tmpPath);
    
    try {
      // Whitelist the extension (dialog already restricts these) and verify the promoted
      // path stays inside the backup directory — symmetry with backup:saveAs (defense-in-depth).
      const rawExt = path.extname(selectedFile).toLowerCase();
      const ext = ['.bak', '.enc', '.sqlite'].includes(rawExt) ? rawExt : '.bak';
      const finalFilename = `pharmasys-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-imported${ext}`;
      const resolvedBackupDir = path.resolve(backupDir);
      const finalPath = path.resolve(resolvedBackupDir, finalFilename);
      if (!finalPath.startsWith(resolvedBackupDir + path.sep)) {
        throw new Error('Invalid backup destination path');
      }
      await services!.backup.restore(tmpFilename, currentUser?.id ?? 0, finalFilename);

      // If successful, promote the temp file to a permanent backup file
      fs.renameSync(tmpPath, finalPath);

      return { success: true, restartRequired: true };
    } catch (err) {
      // If it fails, remove the temp file so we don't pollute the directory
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      return { success: false, error: (err as Error).message };
    }
  });

  // ── REST server ────────────────────────────────────────────────────
  if (deviceMode === 'server' || isDev || process.argv.includes('--rest')) {
    const port = Number(process.env.REST_PORT ?? deviceConfig.serverPort);
    const host = deviceMode === 'server' ? '0.0.0.0' : '127.0.0.1';
    if (deviceMode === 'server') ensureFirewallRules(port, 41234);
    startRestServer(services, port, host);
    if (deviceMode === 'server') {
      startDiscoveryResponder(port, 'PharmaSys Server');
      console.log(`[Startup] Server mode — LAN IP: ${getLanIp()}`);
    }
  }

  // ── Auto-backup timer ──────────────────────────────────────────────
  let autoBackupTimer: ReturnType<typeof setInterval> | null = null;
  async function startAutoBackupTimer() {
    if (autoBackupTimer) clearInterval(autoBackupTimer);
    // Default 1 hour (halved from 2h) so the maximum data-loss window after an
    // auto-restore is shorter. User can override via the auto_backup_hours setting.
    const hours = parseInt(await services!.settings.get('auto_backup_hours') ?? '1', 10) || 1;
    if (hours <= 0) return;
    console.log(`[AutoBackup] Scheduled every ${hours} hours`);
    autoBackupTimer = setInterval(async () => {
      try {
        const entry = await services!.backup.create(0, 'auto');
        console.log(`[AutoBackup] Created: ${entry.filename}`);
      } catch (err) { console.error('[AutoBackup] Failed:', err); }
    }, hours * 3_600_000);
  }
  startAutoBackupTimer();
  ipcMain.on('autoBackupTimerRestart', () => { startAutoBackupTimer(); });

  // ── Recurring expense timer ────────────────────────────────────────
  let recurringExpenseTimer: ReturnType<typeof setTimeout> | null = null;
  async function startRecurringExpenseTimer() {
    if (recurringExpenseTimer) { clearTimeout(recurringExpenseTimer); recurringExpenseTimer = null; }
    const mode = await services!.settings.get('recurring_generation_mode') ?? 'startup';
    if (mode !== 'scheduled') return;
    const hour = parseInt(await services!.settings.get('recurring_generation_hour') ?? '0', 10);
    const now = new Date();
    const target = new Date(now);
    target.setHours(hour, 0, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    recurringExpenseTimer = setTimeout(async () => {
      try {
        const count = await services!.recurringExpense.generateForMissedDays(1);
        if (count > 0 && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('startup:recurringGenerated', { count });
        }
      } catch (err) { console.error('[RecurringExpenses] Timer failed:', err); }
      startRecurringExpenseTimer();
    }, target.getTime() - now.getTime());
    console.log(`[RecurringExpenses] Next generation at ${target.toLocaleString()}`);
  }
  startRecurringExpenseTimer();
  ipcMain.on('recurringExpenseTimerRestart', () => { startRecurringExpenseTimer(); });

  createWindow();

  // Show deferred corruption alert (if database was corrupted on startup).
  // Use the SYNC variant — the user must acknowledge that data may be missing
  // before they start working. A non-blocking toast was previously dismissed by
  // accident and the user only realized days later that recent data was gone.
  if (pendingCorruptionAlert) {
    const msg = pendingCorruptionAlert;
    pendingCorruptionAlert = null;
    setTimeout(() => {
      try {
        dialog.showMessageBoxSync(mainWindow!, {
          type: 'warning',
          title: 'Database Recovered — Data Loss Possible',
          message: 'Database was recovered from a backup. Some recent data may be missing.',
          detail: msg,
          buttons: ['I understand'],
          defaultId: 0,
          noLink: true,
        });
      } catch {
        /* mainWindow may have been destroyed during a reconfigure — best effort */
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.focus();
        mainWindow.webContents.focus();
      }
    }, 1500); // brief delay so the main window has time to render first
  }
}

// ─── Application Lifecycle ────────────────────────────────────────────────────

app.setAppUserModelId('com.pharmasys.app');

// ── Single-instance lock ─────────────────────────────────────────────────────
// Without this, a second launch (desktop shortcut + start menu, or portable +
// installer) opens a SECOND process that loads the same SQLite file into its
// own memory. Both processes write back independently — last writer wins —
// silently destroying the other process's transactions, sales, and inventory
// changes. This is the most likely root cause of "everything gone by end of
// day" and "shift suddenly closed with all sales lost".
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  console.log('[Startup] Another PharmaSys instance is already running — exiting');
  app.exit(0);
}

app.on('second-instance', () => {
  // User clicked the icon while we're already running — focus the existing
  // window instead of letting Windows think nothing happened.
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// Re-create a window when the app is activated with none open (macOS dock / taskbar).
// Registered once here — not per device-mode branch — so handlers can't accumulate.
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.whenReady().then(async () => {
  try {
    console.log(`[Startup] Device mode: ${deviceMode}`);

    // Set license + machine ID paths before any license operations
    setLicensePath(dataPath);
    setMachineIdCachePath(dataPath);

    // ── IPC handler for device config (available in all modes) ───────────
    ipcMain.handle('device:getConfig', () => ({
      mode: deviceMode,
      serverHost: deviceConfig.serverHost,
      serverPort: deviceConfig.serverPort,
      lanIp: getLanIp(),
      allLanIps: getAllLanIps(),
    }));

    ipcMain.handle('device:saveConfig', async (_event, config: DeviceConfig) => {
      saveDeviceConfig(config);
      const oldMode = deviceMode;
      deviceMode = config.mode;
      // Update the live config so createWindow() uses the new values
      deviceConfig.mode = config.mode;
      deviceConfig.serverHost = config.serverHost;
      deviceConfig.serverPort = config.serverPort;

      // Standalone → server: start REST + discovery in-place
      if (oldMode === 'standalone' && config.mode === 'server' && services) {
        try {
          const port = 3001;
          ensureFirewallRules(port, 41234);
          startRestServer(services, port, '0.0.0.0');
          startDiscoveryResponder(port, 'PharmaSys Server');
          console.log(`[Device] Switched to server mode — LAN IP: ${getLanIp()}`);
        } catch (err) {
          console.warn('[Device] Failed to start server services:', (err as Error).message);
        }
      }

      // Close the current window and open a new one with the correct preload.
      // Client mode needs preload-rest.js; server mode needs preload.js.
      // Reloading alone isn't enough because the preload is set at window creation.
      // Guard: prevent window-all-closed from calling app.quit() between destroy and create.
      isReconfiguringWindow = true;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy();
        mainWindow = null;
      }
      createWindow();
      isReconfiguringWindow = false;

      return { success: true };
    });

    // ── Discovery + restart IPC (available in all modes, no auth) ─────────
    ipcMain.handle('discovery:scan', async () => {
      return discoverServers(3000);
    });

    ipcMain.handle('app:restart', () => {
      // Close database connection cleanly before exiting.
      // With better-sqlite3, all data is already on disk — no flush needed.
      try {
        if (baseRepo) {
          baseRepo.close();
          console.log('[Restart] Database connection closed before exit');
        }
      } catch (err) {
        console.error('[Restart] Failed to close DB:', (err as Error).message);
      }

      // electron-builder portable sets PORTABLE_EXECUTABLE_FILE to the outer
      // wrapper exe. app.relaunch() only relaunches the inner electron.exe
      // which doesn't work for portable apps. Spawn the correct executable.
      const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
      if (portableExe) {
        require('child_process').spawn(portableExe, [], {
          detached: true,
          stdio: 'ignore',
        }).unref();
      } else {
        app.relaunch();
      }
      app.exit(0);
    });

    // ── License Gate ─────────────────────────────────────────────────────
    const skipLicense = process.argv.includes('--dev');
    const licenseCheck = skipLicense ? { valid: true } : checkLicense();

    if (licenseCheck.valid) {
      console.log(`[License] Valid${licenseCheck.daysRemaining === -1 ? ' (forever)' : ` (${licenseCheck.daysRemaining} days remaining)`}`);
      await bootMainApp();
    } else {
      console.log(`[License] ${licenseCheck.reason}`);
      showActivationScreen(licenseCheck.reason);
    }
  } catch (err) {
    console.error('[Startup] Fatal error:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !isReconfiguringWindow) app.quit();
});

// Close the database connection cleanly before the process exits.
// With better-sqlite3, all committed data is already on disk (WAL mode).
// This just ensures the WAL is checkpointed and the connection is released.
app.on('will-quit', () => {
  if (baseRepo) {
    try { baseRepo.close(); } catch (err) {
      console.error('[Quit] DB close error:', (err as Error).message);
    }
  }
});
