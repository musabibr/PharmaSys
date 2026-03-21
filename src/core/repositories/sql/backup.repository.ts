import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { BaseRepository, SqlJsDatabase } from './base.repository';
import type { IBackupRepository, BackupEntry } from '../../types/repositories';

const MAX_BACKUPS = 50;

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

  private _getEncryptionKey(): Buffer {
    const envKey = process.env.PHARMASYS_BACKUP_KEY;
    if (envKey) {
      const keyBuf = Buffer.from(envKey, 'hex');
      if (keyBuf.length === 32) return keyBuf;
      console.warn('[BackupRepo] PHARMASYS_BACKUP_KEY is not a valid 256-bit hex key. Falling back to file.');
    }
    const keyPath = path.join(this.dataPath, '.backup-key');
    if (fs.existsSync(keyPath)) return fs.readFileSync(keyPath);
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    console.log('[BackupRepo] Generated new AES-256 encryption key. Hex:', key.toString('hex'));
    return key;
  }

  private _encrypt(buffer: Buffer): Buffer {
    const key = this._getEncryptionKey();
    const iv  = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const authTag   = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]);
  }

  private _decrypt(buf: Buffer): Buffer {
    const key     = this._getEncryptionKey();
    const iv      = buf.slice(0, 16);
    const authTag = buf.slice(16, 32);
    const data    = buf.slice(32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }

  private _rotate(): void {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('pharmasys-backup-') && (f.endsWith('.enc') || f.endsWith('.sqlite')))
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

  async create(label?: string): Promise<BackupEntry> {
    this._ensureBackupDir();
    this.base.save(); // flush in-memory state first

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const suffix = label ? `-${label.replace(/[^a-zA-Z0-9]/g, '_')}` : '';
    const filename  = `pharmasys-backup-${ts}${suffix}.enc`;
    const filePath  = path.join(this.backupDir, filename);

    const raw       = this.base.db.export();
    const encrypted = this._encrypt(Buffer.from(raw));

    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, encrypted);
    fs.renameSync(tmp, filePath);

    const checksum = crypto.createHash('sha256').update(encrypted).digest('hex');
    fs.writeFileSync(filePath + '.sha256', `${checksum}  ${filename}\n`);

    this._rotate();

    return {
      filename,
      path: filePath,
      size: encrypted.length,
      created_at: new Date().toISOString(),
    };
  }

  async list(): Promise<BackupEntry[]> {
    this._ensureBackupDir();
    return fs.readdirSync(this.backupDir)
      .filter(f => f.startsWith('pharmasys-backup-') && (f.endsWith('.enc') || f.endsWith('.sqlite')))
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

  async restore(filename: string): Promise<void> {
    const filePath = path.join(this.backupDir, filename);
    if (!fs.existsSync(filePath)) throw new Error('Backup file not found');

    const fileBuffer = fs.readFileSync(filePath);

    // Verify checksum
    const csFile = filePath + '.sha256';
    if (fs.existsSync(csFile)) {
      const expected = fs.readFileSync(csFile, 'utf-8').split(' ')[0].trim();
      const actual   = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      if (expected !== actual) throw new Error('Backup integrity check failed — file may be corrupted');
    }

    // Safety backup before restore
    await this.create('pre-restore');

    let dbBuffer: Buffer;
    if (filename.endsWith('.enc')) {
      try { dbBuffer = this._decrypt(fileBuffer); }
      catch (err) { throw new Error(`Failed to decrypt backup: ${(err as Error).message}`); }
    } else {
      dbBuffer = fileBuffer; // legacy unencrypted
    }

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
}
