import type { BaseRepository } from './base.repository';
import type { IUserRepository } from '../../types/repositories';
import type { User, UserPublic, CreateUserInput, UpdateUserInput } from '../../types/models';

export class UserRepository implements IUserRepository {
  constructor(private readonly base: BaseRepository) {}

  async getAll(): Promise<UserPublic[]> {
    return await this.base.getAll<UserPublic>(
      `SELECT id, username, full_name, role, perm_finance, perm_inventory,
              perm_reports, permissions_json, is_active, must_change_password,
              created_at, updated_at
       FROM users ORDER BY full_name`
    );
  }

  async getById(id: number): Promise<UserPublic | undefined> {
    return await this.base.getOne<UserPublic>(
      `SELECT id, username, full_name, role, perm_finance, perm_inventory,
              perm_reports, permissions_json, is_active, must_change_password,
              created_at, updated_at
       FROM users WHERE id = ?`,
      [id]
    );
  }

  async getFullById(id: number): Promise<User | undefined> {
    return await this.base.getOne<User>(
      `SELECT id, username, password_hash, full_name, role,
              perm_finance, perm_inventory, perm_reports, permissions_json,
              is_active, must_change_password,
              failed_login_attempts, locked_until,
              security_question, security_answer_hash,
              security_answer_failed_attempts, security_answer_locked_until,
              created_at, updated_at
       FROM users WHERE id = ?`,
      [id]
    );
  }

  async findByUsername(username: string): Promise<User | undefined> {
    return await this.base.getOne<User>(
      `SELECT id, username, password_hash, full_name, role,
              perm_finance, perm_inventory, perm_reports, permissions_json,
              is_active, must_change_password, created_at
       FROM users WHERE username = ?`,
      [username]
    );
  }

  async create(data: CreateUserInput & { password_hash: string; permissions_json?: string | null }) {
    return await this.base.runImmediate(
      `INSERT INTO users (username, password_hash, full_name, role,
       perm_finance, perm_inventory, perm_reports, permissions_json,
       must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        data.username, data.password_hash, data.full_name, data.role,
        data.perm_finance ? 1 : 0,
        data.perm_inventory ? 1 : 0,
        data.perm_reports ? 1 : 0,
        data.permissions_json ?? null,
      ]
    );
  }

  async update(id: number, data: UpdateUserInput & { password_hash?: string; permissions_json?: string | null }): Promise<void> {
    await this.base.runImmediate(
      `UPDATE users SET full_name = ?, role = ?, perm_finance = ?,
       perm_inventory = ?, perm_reports = ?, permissions_json = ?,
       is_active = ?, updated_at = datetime('now') WHERE id = ?`,
      [
        data.full_name ?? '', data.role ?? 'cashier',
        data.perm_finance ? 1 : 0,
        data.perm_inventory ? 1 : 0,
        data.perm_reports ? 1 : 0,
        data.permissions_json ?? null,
        data.is_active === false || (data.is_active as unknown) === 0 ? 0 : 1,
        id,
      ]
    );

    if (data.password_hash) {
      await this.base.runImmediate(
        `UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?`,
        [data.password_hash, id]
      );
    }
  }

  async resetPassword(userId: number, hash: string): Promise<void> {
    await this.base.runImmediate(
      `UPDATE users SET password_hash = ?, must_change_password = 1,
       updated_at = datetime('now') WHERE id = ?`,
      [hash, userId]
    );
  }

  async unlock(userId: number): Promise<void> {
    await this.base.runImmediate(
      `UPDATE users SET locked_until = NULL, failed_login_attempts = 0,
       updated_at = datetime('now') WHERE id = ?`,
      [userId]
    );
  }
}
