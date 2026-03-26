import type { BaseRepository } from './base.repository';
import type { ISettingsRepository } from '../../types/repositories';
import type { Setting } from '../../types/models';

export class SettingsRepository implements ISettingsRepository {
  constructor(private readonly base: BaseRepository) {}

  async get(key: string): Promise<string | null> {
    const row = await this.base.getOne<{ value: string | null }>(
      `SELECT value FROM settings WHERE key = ?`,
      [key]
    );
    return row?.value ?? null;
  }

  async getAll(): Promise<Setting[]> {
    return await this.base.getAll<Setting>(
      `SELECT key, value, updated_at FROM settings ORDER BY key`
    );
  }

  async set(key: string, value: string): Promise<void> {
    await this.base.runImmediate(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now', 'localtime'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', 'localtime')`,
      [key, value]
    );
  }
}
