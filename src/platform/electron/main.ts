/**
 * Electron main process entry point.
 *
 * Responsibilities:
 *  - Boot the database (sql.js)
 *  - Initialise repositories + services (ServiceContainer)
 *  - Register all IPC handlers
 *  - Create and manage the BrowserWindow (React frontend)
 *  - Optionally start the embedded REST server
 */

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path   from 'path';
import * as fs     from 'fs';
import { execFile, execSync } from 'child_process';
import initSqlJs   from 'sql.js';

import { BaseRepository }        from '../../core/repositories/sql/base.repository';
import { MigrationRepository }  from '../../core/repositories/sql/migration.repository';
import { createRepositories }   from '../../core/repositories/sql/index';
import { ServiceContainer }     from '../../core/services/index';
import { EventBus }             from '../../core/events/event-bus';
import { registerAllHandlers }  from '../../transport/ipc/register';
import { startRestServer, getLanIp, getAllLanIps } from '../../transport/rest/index';
import { startDiscoveryResponder, discoverServers } from '../../transport/discovery';
import type { UserPublic }      from '../../core/types/models';
import { validateLicense }      from '../../license/license-validator';
import { loadLicense, saveLicense } from '../../license/license-store';
import { getMachineId } from '../../license/machine-id';

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

if (fs.existsSync(freshMarkerPath)) {
  console.log('[Startup] Fresh install marker detected — clearing previous data');
  try {
    // Clear the data directory (database, device-config, backups, tmp)
    if (fs.existsSync(dataPath)) {
      fs.rmSync(dataPath, { recursive: true, force: true });
      console.log('[Startup] Cleared data directory:', dataPath);
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

    // Delete the marker so we don't clear again on next launch
    fs.unlinkSync(freshMarkerPath);
    console.log('[Startup] Fresh install cleanup complete');
  } catch (err) {
    console.error('[Startup] Fresh install cleanup error:', (err as Error).message);
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
  try {
    const check = execSync(
      `netsh advfirewall firewall show rule name="PharmaSys Server"`,
      { encoding: 'utf8', timeout: 5000 },
    );
    if (check.includes('PharmaSys Server')) return; // already exists
  } catch { /* rule doesn't exist yet — create it */ }
  try {
    execSync(
      `netsh advfirewall firewall add rule name="PharmaSys Server" dir=in action=allow protocol=TCP localport=${tcpPort}`,
      { timeout: 5000 },
    );
    execSync(
      `netsh advfirewall firewall add rule name="PharmaSys Discovery" dir=in action=allow protocol=UDP localport=${udpPort}`,
      { timeout: 5000 },
    );
    console.log(`[Firewall] Inbound rules created for TCP:${tcpPort} UDP:${udpPort}`);
  } catch (err) {
    console.warn('[Firewall] Could not auto-create rules (may need admin):', (err as Error).message);
  }
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

// ─── Database Initialisation ─────────────────────────────────────────────────

async function initDatabase(): Promise<ServiceContainer> {
  fs.mkdirSync(dataPath, { recursive: true });

  const SQL   = await initSqlJs();
  const dbFile = path.join(dataPath, 'pharmasys.db');

  let db: ReturnType<typeof SQL.Database.prototype.constructor>;
  if (fs.existsSync(dbFile)) {
    const data = fs.readFileSync(dbFile);
    db = new SQL.Database(data);
  } else {
    db = new SQL.Database();
  }

  // Enable WAL mode and foreign keys
  db.run('PRAGMA journal_mode=WAL;');
  db.run('PRAGMA foreign_keys=ON;');

  // Save function — atomic rename with Windows EPERM retry
  const saveFn = (): void => {
    const data = db.export();
    const tmp  = dbFile + '.tmp';
    let attempts = 0;
    const tryWrite = (): void => {
      try {
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, dbFile);
      } catch (err: any) {
        if (err.code === 'EPERM' && attempts < 3) {
          attempts++;
          setTimeout(tryWrite, 100);
        } else {
          console.error('[DB] Save failed:', err.message);
        }
      }
    };
    tryWrite();
  };

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSaveFn = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveFn, 2000);
  };

  const repos    = createRepositories(db as any, dataPath, saveFn, scheduleSaveFn);

  // Run schema creation, migrations, seed data — safe to call on every startup
  // Only seed demo data in dev mode; production starts with a clean database
  const migration = new MigrationRepository(repos.base, dataPath);
  await migration.initialise(isDev);

  const bus      = new EventBus();
  const svc      = new ServiceContainer(repos, bus);

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
      sandbox: !isClient,  // REST preload needs process.argv access
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
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    currentUser = null;
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
}

// ─── License Activation Window ────────────────────────────────────────────────

/**
 * Show a minimal "not activated" window when no valid license is present.
 * The user sees their Machine ID and a button to import a .pharmalicense file.
 * On successful activation the window closes and the main app opens.
 */
function showNotActivatedWindow(reason: string): void {
  const win = new BrowserWindow({
    width:     500,
    height:    480,
    resizable: false,
    center:    true,
    title:     'PharmaSys — Activation Required',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox:          true,
      // Minimal preload — only exposes licenseApi
      preload: path.join(__dirname, 'license-preload.js'),
    },
  });

  win.setMenuBarVisibility(false);

  // Pass machine ID and reason as URL query params
  const machineId = getMachineId();
  win.loadFile(
    path.join(__dirname, 'license-screen/not-activated.html'),
    { query: { machineId, reason } },
  );

  // Handle the "Import License File" button click
  ipcMain.handle('license:importFile', async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog(win, {
      title:   'Select License File',
      filters: [{ name: 'PharmaSys License', extensions: ['pharmalicense'] }],
      properties: ['openFile'],
    });

    if (canceled || filePaths.length === 0) {
      return { success: false, reason: 'No file selected.' };
    }

    let licenseJson: string;
    try {
      licenseJson = fs.readFileSync(filePaths[0], 'utf-8');
    } catch {
      return { success: false, reason: 'Could not read the selected file.' };
    }

    const result = validateLicense(licenseJson);
    if (!result.valid) {
      return { success: false, reason: result.reason };
    }

    saveLicense(licenseJson);

    // Remove this handler so it is not double-registered if user re-activates
    ipcMain.removeHandler('license:importFile');

    // Close activation screen and open main app
    win.close();
    if (services) {
      registerAllAppHandlers();
      createWindow();
    }

    return { success: true };
  });

  win.on('closed', () => {
    // If user closes the activation window without activating, quit the app
    if (BrowserWindow.getAllWindows().length === 0) {
      app.quit();
    }
  });
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

// ─── Application Lifecycle ────────────────────────────────────────────────────

app.setAppUserModelId('com.pharmasys.app');

app.whenReady().then(async () => {
  try {
    console.log(`[Startup] Device mode: ${deviceMode}`);

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

    // ── Client mode — no local database ─────────────────────────────────
    if (deviceMode === 'client') {
      console.log(`[Startup] Client mode → connecting to http://${deviceConfig.serverHost}:${deviceConfig.serverPort}`);
      createWindow();
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
      return;
    }

    // ── Standalone / Server mode — local database ───────────────────────
    services = await initDatabase();

    // ── LICENSE GATE ────────────────────────────────────────────────────────
    // Skip the license check in development mode so you can run the app freely.
    // In packaged builds the check is always enforced.
    if (!isDev) {
      const licenseJson = loadLicense();
      const licenseResult = licenseJson ? validateLicense(licenseJson) : null;

      if (!licenseResult?.valid) {
        const reason = licenseResult?.reason ?? 'No license found on this device.';
        showNotActivatedWindow(reason);
        // Do NOT proceed to registerAllHandlers or createWindow — wait for activation
        return;
      }

      console.log(`[License] Valid — Client: ${licenseResult.payload?.clientName}`);
    }
    // ───────────────────────────────────────────────────────────────────────

    registerAllAppHandlers();

    // Backup save-as dialog: copies an existing backup + encryption key to a user-chosen location
    ipcMain.handle('backup:saveAs', async (_event, sourcePath: string) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!win) return { success: false, error: 'No window available' };
      const defaultName = path.basename(sourcePath);
      const { filePath, canceled } = await dialog.showSaveDialog(win, {
        title: 'Save Backup As',
        defaultPath: defaultName,
        filters: [{ name: 'Encrypted Backup', extensions: ['enc'] }],
      });
      if (canceled || !filePath) return { success: false };
      try {
        fs.copyFileSync(sourcePath, filePath);
        // Also copy encryption key alongside (needed for device migration)
        const keyPath = path.join(dataPath, '.backup-key');
        if (fs.existsSync(keyPath)) {
          const keyDest = filePath.replace(/\.enc$/, '.key');
          fs.copyFileSync(keyPath, keyDest);
        }
        return { success: true, savedPath: filePath };
      } catch (err) {
        return { success: false, error: `Failed to save backup: ${(err as Error).message}` };
      }
    });

    // Restore backup from external file (device migration scenario)
    ipcMain.handle('backup:restoreFromFile', async (_event) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!win) return { success: false, error: 'No window available' };

      const { filePaths, canceled } = await dialog.showOpenDialog(win, {
        title: 'Select Backup File',
        filters: [{ name: 'Encrypted Backup', extensions: ['enc'] }],
        properties: ['openFile'],
      });
      if (canceled || filePaths.length === 0) return { success: false };

      const selectedFile = filePaths[0];

      // Check for companion key file (same name but .key extension)
      const companionKey = selectedFile.replace(/\.enc$/, '.key');
      const localKeyPath = path.join(dataPath, '.backup-key');
      if (fs.existsSync(companionKey)) {
        // Import the encryption key from the source device
        fs.copyFileSync(companionKey, localKeyPath);
      }

      // Copy the backup file to the local backup directory
      const backupDir = path.join(dataPath, 'backups');
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
      const filename = path.basename(selectedFile);
      const destPath = path.join(backupDir, filename);
      fs.copyFileSync(selectedFile, destPath);

      // Copy the checksum file if it exists
      const checksumFile = selectedFile + '.sha256';
      if (fs.existsSync(checksumFile)) {
        fs.copyFileSync(checksumFile, destPath + '.sha256');
      }

      try {
        await services!.backup.restore(filename, currentUser?.id ?? 0);
        return { success: true, restartRequired: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    });

    // Start REST server — always in server mode, optionally in dev mode
    if (deviceMode === 'server' || isDev || process.argv.includes('--rest')) {
      const port = Number(process.env.REST_PORT ?? deviceConfig.serverPort);
      const host = deviceMode === 'server' ? '0.0.0.0' : '127.0.0.1';

      // Auto-create Windows Firewall rules in server mode
      if (deviceMode === 'server') {
        ensureFirewallRules(port, 41234);
      }

      startRestServer(services, port, host);

      // Start UDP discovery responder so client devices can find this server
      if (deviceMode === 'server') {
        startDiscoveryResponder(port, 'PharmaSys Server');
        console.log(`[Startup] Server mode — LAN IP: ${getLanIp()}`);
      }
    }

    // ── Auto-backup timer ────────────────────────────────────────────────────
    let autoBackupTimer: ReturnType<typeof setInterval> | null = null;

    async function startAutoBackupTimer() {
      if (autoBackupTimer) clearInterval(autoBackupTimer);
      const hoursStr = await services!.settings.get('auto_backup_hours');
      const hours = parseInt(hoursStr ?? '8', 10) || 8;
      if (hours <= 0) return; // disabled
      const ms = hours * 60 * 60 * 1000;
      console.log(`[AutoBackup] Scheduled every ${hours} hours`);
      autoBackupTimer = setInterval(async () => {
        try {
          const entry = await services!.backup.create(0, 'auto');
          console.log(`[AutoBackup] Created: ${entry.filename}`);
        } catch (err) {
          console.error('[AutoBackup] Failed:', err);
        }
      }, ms);
    }

    startAutoBackupTimer();

    // Listen for setting changes to restart the timer
    ipcMain.on('autoBackupTimerRestart', () => { startAutoBackupTimer(); });

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  } catch (err) {
    console.error('[Startup] Fatal error:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !isReconfiguringWindow) app.quit();
});
