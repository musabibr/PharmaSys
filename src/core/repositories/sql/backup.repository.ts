import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { BaseRepository, SqlJsDatabase } from './base.repository';
import type { IBackupRepository, BackupEntry } from '../../types/repositories';

const MAX_BACKUPS = 50;

// Magic bytes for format detection
const PORTABLE_MAGIC   = 'PSBK';
const PORTABLE_VERSION = 1;
const SQLITE_MAGIC     = 'SQLite format 3';

export class BackupRepository implements IBackupRepository {
  constructor(
    private readonly base: BaseRepository,
    private readonly dataPath: string,
    private readonly getSQLDatabase: () => SqlJsDatabase,
    private readonly onRestored: (db: SqlJsDatabase) => void
  ) {}

  private get backupDir(): string {
    return path.join(this.dataPath, 'backups');
  }

  private _ensureBackupDir(): void {
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  // ── Legacy encryption helpers (kept for restoring old encrypted backups) ────

  private _getEncryptionKey(): Buffer | null {
    const envKey = process.env.PHARMASYS_BACKUP_KEY;
    if (envKey) {
      const keyBuf = Buffer.from(envKey, 'hex');
      if (keyBuf.length === 32) return keyBuf;
    }
    const keyPath = path.join(this.dataPath, '.backup-key');
    if (fs.existsSync(keyPath)) {
      const key = fs.readFileSync(keyPath);
      if (key.length === 32) return key;
    }
    return null;
  }

  private _decrypt(buf: Buffer, key: Buffer): Buffer {
    const iv      = buf.slice(0, 16);
    const authTag = buf.slice(16, 32);
    const data    = buf.slice(32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }

  // ── Rotation ───────────────────────────────────────────────────────────────

  private _isBackupFile(f: string): boolean {
    return f.startsWith('pharmasys-backup-') &&
      (f.endsWith('.bak') || f.endsWith('.enc') || f.endsWith('.sqlite'));
  }

  private _rotate(): void {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(f => this._isBackupFile(f))
        .sort().reverse();
      files.slice(MAX_BACKUPS).forEach(f => {
        try {
          fs.unlinkSync(path.join(this.backupDir, f));
          const cs = path.join(this.backupDir, f + '.sha256');
          if (fs.existsSync(cs)) fs.unlinkSync(cs);
        } catch { /* best effort */ }
      });
    } catch { /* best effort */ }
  }

  // ── Migration: convert old encrypted backups to raw SQLite ──────────────

  /**
   * One-time migration: converts all .enc backups to .bak (raw SQLite).
   * Called on startup. After conversion, deletes .backup-key since it's no longer needed.
   */
  migrateEncryptedBackups(): void {
    this._ensureBackupDir();
    const encFiles = fs.readdirSync(this.backupDir)
      .filter(f => f.startsWith('pharmasys-backup-') && f.endsWith('.enc'));

    if (encFiles.length === 0) return;

    console.log(`[BackupRepo] Migrating ${encFiles.length} encrypted backup(s) to raw SQLite...`);
    let converted = 0;

    for (const encFile of encFiles) {
      const encPath = path.join(this.backupDir, encFile);
      try {
        const buf = fs.readFileSync(encPath);
        const sqliteData = this._extractSqlite(buf);

        // Write as .bak
        const bakFile = encFile.replace(/\.enc$/, '.bak');
        const bakPath = path.join(this.backupDir, bakFile);
        fs.writeFileSync(bakPath, sqliteData);

        // Update checksum
        const checksum = crypto.createHash('sha256').update(sqliteData).digest('hex');
        fs.writeFileSync(bakPath + '.sha256', `${checksum}  ${bakFile}\n`);

        // Remove old .enc and its checksum
        fs.unlinkSync(encPath);
        const oldCs = encPath + '.sha256';
        if (fs.existsSync(oldCs)) fs.unlinkSync(oldCs);

        converted++;
        console.log(`[BackupRepo] Converted: ${encFile} → ${bakFile}`);
      } catch (err) {
        // Rename to .unrecoverable so it no longer appears in the backup list
        const lostPath = encPath + '.unrecoverable';
        try { fs.renameSync(encPath, lostPath); } catch { /* best effort */ }
        console.warn(`[BackupRepo] Cannot convert ${encFile} — renamed to .unrecoverable`);
      }
    }

    console.log(`[BackupRepo] Migration complete: ${converted}/${encFiles.length} converted`);

    // Delete .backup-key if all encrypted backups are gone
    const remainingEnc = fs.readdirSync(this.backupDir)
      .filter(f => f.startsWith('pharmasys-backup-') && f.endsWith('.enc'));
    if (remainingEnc.length === 0) {
      const keyPath = path.join(this.dataPath, '.backup-key');
      if (fs.existsSync(keyPath)) {
        fs.unlinkSync(keyPath);
        console.log('[BackupRepo] Deleted .backup-key — no longer needed');
      }
    }
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  async create(label?: string): Promise<BackupEntry> {
    this._ensureBackupDir();
    this.base.save(); // flush in-memory state first

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const suffix = label ? `-${label.replace(/[^a-zA-Z0-9]/g, '_')}` : '';
    const filename  = `pharmasys-backup-${ts}${suffix}.bak`;
    const filePath  = path.join(this.backupDir, filename);

    // Write raw SQLite bytes — no encryption, always restorable
    const raw = Buffer.from(this.base.db.export());

    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, raw);
    fs.renameSync(tmp, filePath);

    const checksum = crypto.createHash('sha256').update(raw).digest('hex');
    fs.writeFileSync(filePath + '.sha256', `${checksum}  ${filename}\n`);

    this._rotate();

    return {
      filename,
      path: filePath,
      size: raw.length,
      created_at: new Date().toISOString(),
    };
  }

  // ── List ───────────────────────────────────────────────────────────────────

  async list(): Promise<BackupEntry[]> {
    this._ensureBackupDir();
    return fs.readdirSync(this.backupDir)
      .filter(f => this._isBackupFile(f))
      .sort().reverse()
      .map(f => {
        const filePath = path.join(this.backupDir, f);
        const stat     = fs.statSync(filePath);
        return {
          filename:   f,
          path:       filePath,
          size:       stat.size,
          created_at: stat.birthtime.toISOString(),
        };
      });
  }

  // ── Restore (handles all formats) ──────────────────────────────────────────

  async restore(filename: string): Promise<void> {
    const filePath = path.join(this.backupDir, filename);
    if (!fs.existsSync(filePath)) throw new Error('Backup file not found');

    const fileBuffer = fs.readFileSync(filePath);

    // Verify checksum if available
    const csFile = filePath + '.sha256';
    if (fs.existsSync(csFile)) {
      const expected = fs.readFileSync(csFile, 'utf-8').split(' ')[0].trim();
      const actual   = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      if (expected !== actual) throw new Error('Backup integrity check failed — file may be corrupted');
    }

    // Safety backup before restore
    await this.create('pre-restore');

    // Detect format and extract raw SQLite bytes
    const dbBuffer = this._extractSqlite(fileBuffer);

    // Create new sql.js Database from restored buffer
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    const newDb = new SQL.Database(new Uint8Array(dbBuffer));

    // Set pragmas on new DB (match initDatabase settings)
    newDb.run('PRAGMA journal_mode=WAL;');
    newDb.run('PRAGMA foreign_keys=ON;');

    // Persist restored database to disk FIRST (before swapping in-memory)
    const dbPath = path.join(this.dataPath, 'pharmasys.db');
    const tmp    = dbPath + '.restore.tmp';
    fs.writeFileSync(tmp, Buffer.from(dbBuffer));
    fs.renameSync(tmp, dbPath);

    // Verify the file was written correctly
    const written = fs.readFileSync(dbPath);
    if (written.length !== dbBuffer.length) {
      throw new Error(`Restore verification failed: wrote ${dbBuffer.length} bytes but file is ${written.length} bytes`);
    }
    console.log(`[BackupRepo] Restored DB written to disk: ${written.length} bytes`);

    // Swap in-memory database — all repos now query restored data
    this.onRestored(newDb);

    // Save again to ensure the in-memory DB matches disk
    this.base.save();

    console.log('[BackupRepo] Restore complete — database swapped in-memory and persisted to disk.');
  }

  /**
   * Detect backup format and return raw SQLite bytes.
   *
   * Supported formats:
   *  1. Raw SQLite (starts with "SQLite format 3") — .bak or .sqlite
   *  2. Portable encrypted (starts with "PSBK") — .enc with embedded key
   *  3. Legacy encrypted (anything else) — .enc, needs local .backup-key
   */
  private _extractSqlite(buf: Buffer): Buffer {
    const header = buf.slice(0, 16).toString('ascii');

    // ── Format 1: Raw SQLite ──────────────────────────────────────────────
    if (header.startsWith(SQLITE_MAGIC)) {
      console.log('[BackupRepo] Detected raw SQLite backup');
      return buf;
    }

    // ── Format 2: Portable encrypted (PSBK header + embedded key) ─────────
    if (buf.length > 37 && buf.slice(0, 4).toString() === PORTABLE_MAGIC) {
      const version = buf.readUInt8(4);
      if (version !== PORTABLE_VERSION) {
        throw new Error(`Unsupported portable backup version: ${version}`);
      }
      const embeddedKey = buf.slice(5, 37);
      const encData     = buf.slice(37);
      console.log('[BackupRepo] Detected portable encrypted backup — using embedded key');

      // Install the key so future legacy restores can also use it
      const keyPath = path.join(this.dataPath, '.backup-key');
      fs.writeFileSync(keyPath, embeddedKey, { mode: 0o600 });

      try {
        return this._decrypt(encData, embeddedKey);
      } catch (err) {
        throw new Error(`Failed to decrypt portable backup: ${(err as Error).message}`);
      }
    }

    // ── Format 3: Legacy encrypted (no header, needs local key) ───────────
    console.log('[BackupRepo] Detected legacy encrypted backup — looking for .backup-key');
    const key = this._getEncryptionKey();
    if (!key) {
      throw new Error(
        'Cannot restore this backup — the encryption key (.backup-key) is missing. ' +
        'This backup was created with an older version and the key was lost during reinstall. ' +
        'If you have the original .backup-key file, place it in the data directory and try again.'
      );
    }

    try {
      return this._decrypt(buf, key);
    } catch (err) {
      throw new Error(
        `Failed to decrypt backup — the encryption key may not match this backup. ${(err as Error).message}`
      );
    }
  }
}
