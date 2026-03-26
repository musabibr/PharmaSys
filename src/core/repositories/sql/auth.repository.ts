import type { BaseRepository } from './base.repository';
import type { IAuthRepository } from '../../types/repositories';
import type { User } from '../../types/models';

export class AuthRepository implements IAuthRepository {
  constructor(private readonly base: BaseRepository) {}

  async findByUsername(username: string): Promise<User | undefined> {
    return await this.base.getOne<User>(
      `SELECT id, username, password_hash, full_name, role,
              perm_finance, perm_inventory, perm_reports, permissions_json,
              is_active, must_change_password,
              failed_login_attempts, locked_until,
              security_question, security_answer_hash,
              security_answer_failed_attempts, security_answer_locked_until,
              created_at, updated_at
       FROM users WHERE username = ? AND is_active = 1`,
      [username]
    );
  }

  async incrementFailedAttempts(userId: number, newCount: number): Promise<void> {
    await this.base.rawRun(
      'UPDATE users SET failed_login_attempts = ? WHERE id = ?',
      [newCount, userId]
    );
    this.base.save();
  }

  async lockAccount(userId: number, lockedUntil: string, attempts: number): Promise<void> {
    await this.base.rawRun(
      `UPDATE users SET locked_until = ?, failed_login_attempts = ? WHERE id = ?`,
      [lockedUntil, attempts, userId]
    );
    this.base.save();
  }

  async resetFailedAttempts(userId: number): Promise<void> {
    await this.base.rawRun(
      `UPDATE users SET failed_login_attempts = 0, locked_until = NULL,
       updated_at = datetime('now', 'localtime') WHERE id = ?`,
      [userId]
    );
    this.base.save();
  }

  async updatePassword(userId: number, hash: string, mustChange = false): Promise<void> {
    await this.base.runImmediate(
      `UPDATE users SET password_hash = ?, must_change_password = ?,
       updated_at = datetime('now', 'localtime') WHERE id = ?`,
      [hash, mustChange ? 1 : 0, userId]
    );
    this.base.save();
  }

  async isFirstLaunch(): Promise<boolean> {
    const admin = await this.base.getOne<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE username = 'admin' AND role = 'admin'`
    );
    if (!admin) return true;
    // isFirstLaunch = the admin password is still the default 'admin123'
    // The actual check (hash comparison) is done in AuthService using crypto
    return false; // placeholder — AuthService does the real check
  }

  async getSecurityQuestion(username: string): Promise<{ question: string | null }> {
    if (!username || typeof username !== 'string') return { question: null };
    const user = await this.base.getOne<{ security_question: string | null }>(
      'SELECT security_question FROM users WHERE username = ? AND is_active = 1',
      [username.trim()]
    );
    return { question: user?.security_question ?? null };
  }

  async findForSecurityReset(username: string): Promise<User | undefined> {
    return await this.base.getOne<User>(
      `SELECT id, role, security_question, security_answer_hash,
              security_answer_failed_attempts, security_answer_locked_until
       FROM users WHERE username = ? AND is_active = 1`,
      [username.trim()]
    );
  }

  async updateSecurityAnswerAttempts(userId: number, attempts: number, lockedUntil: string | null = null): Promise<void> {
    await this.base.rawRun(
      `UPDATE users SET security_answer_failed_attempts = ?,
       security_answer_locked_until = ? WHERE id = ?`,
      [attempts, lockedUntil, userId]
    );
    this.base.save();
  }

  async setSecurityQuestion(userId: number, question: string, answerHash: string): Promise<void> {
    await this.base.runImmediate(
      `UPDATE users SET security_question = ?, security_answer_hash = ?,
       security_answer_failed_attempts = 0, security_answer_locked_until = NULL,
       updated_at = datetime('now', 'localtime') WHERE id = ?`,
      [question, answerHash, userId]
    );
    this.base.save();
  }

  async clearSecurityAnswerLock(userId: number): Promise<void> {
    await this.base.rawRun(
      `UPDATE users SET security_answer_locked_until = NULL,
       security_answer_failed_attempts = 0 WHERE id = ?`,
      [userId]
    );
    this.base.save();
  }

  async unlockAccount(userId: number): Promise<void> {
    await this.base.runImmediate(
      `UPDATE users SET locked_until = NULL, failed_login_attempts = 0,
       updated_at = datetime('now', 'localtime') WHERE id = ?`,
      [userId]
    );
    this.base.save();
  }
}
