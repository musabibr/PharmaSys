import * as crypto from 'crypto';
import * as fs     from 'fs';
import * as path   from 'path';
import type { AuthRepository } from '../repositories/sql/auth.repository';
import type { UserRepository } from '../repositories/sql/user.repository';
import type { EventBus }       from '../events/event-bus';
import type { UserPublic } from '../types/models';
import { Validate }             from '../common/validation';
import { ValidationError, NotFoundError, AuthenticationError, PermissionError } from '../types/errors';

const MAX_LOGIN_ATTEMPTS      = 5;
const LOGIN_LOCKOUT_MINUTES   = 15;
const MAX_SECURITY_ATTEMPTS   = 3;
const SECURITY_LOCKOUT_MINUTES = 15;

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  try {
    const attempt = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(attempt, 'hex'));
  } catch {
    return false;
  }
}

function isLocked(lockedUntil: string | null): boolean {
  if (!lockedUntil) return false;
  return new Date(lockedUntil) > new Date();
}

function lockoutUntil(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

export interface LoginResult {
  user: UserPublic;
  mustChangePassword: boolean;
}

export class AuthService {
  constructor(
    private readonly repo:     AuthRepository,
    private readonly userRepo: UserRepository,
    private readonly bus:      EventBus
  ) {}

  async login(username: string, password: string): Promise<LoginResult> {
    const uname = Validate.requiredString(username, 'Username', 50);

    const user = await this.repo.findByUsername(uname);

    if (!user) {
      // Consistent timing: still hash to prevent timing-based username enumeration
      crypto.scryptSync('__fake__', 'aabbccddeeff00112233445566778899', 64);
      throw new AuthenticationError('Invalid username or password');
    }

    if (isLocked(user.locked_until)) {
      const remaining = Math.ceil((new Date(user.locked_until!).getTime() - Date.now()) / 60000);
      throw new ValidationError(
        `Account is locked. Try again in ${remaining} minute(s).`,
        'locked'
      );
    }

    const valid = verifyPassword(password, user.password_hash);

    if (!valid) {
      const attempts = (user.failed_login_attempts ?? 0) + 1;

      if (attempts >= MAX_LOGIN_ATTEMPTS) {
        await this.repo.lockAccount(user.id, lockoutUntil(LOGIN_LOCKOUT_MINUTES), attempts);
        this.bus.emit('auth:event', {
          action: 'account_locked', userId: user.id, username: user.username,
        });
        throw new ValidationError(
          `Too many failed attempts. Account locked for ${LOGIN_LOCKOUT_MINUTES} minutes.`,
          'locked'
        );
      }

      await this.repo.incrementFailedAttempts(user.id, attempts);
      throw new AuthenticationError('Invalid username or password');
    }

    // Successful login — reset failed attempts
    await this.repo.resetFailedAttempts(user.id);

    this.bus.emit('auth:event', {
      action: 'login', userId: user.id, username: user.username,
    });

    const pub = await this.userRepo.getById(user.id);
    return { user: pub!, mustChangePassword: user.must_change_password === 1 };
  }

  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string
  ): Promise<void> {
    Validate.id(userId);
    Validate.passwordString(newPassword, 'New password');

    const userPublic = await this.userRepo.getById(userId);
    const user = await this.repo.findByUsername(userPublic?.username ?? '');
    if (!user) throw new NotFoundError('User', userId);

    if (!verifyPassword(currentPassword, user.password_hash)) {
      throw new AuthenticationError('Current password is incorrect');
    }

    const hash = hashPassword(newPassword);
    await this.repo.updatePassword(userId, hash, false);

    this.bus.emit('auth:event', {
      action: 'password_changed', userId, username: user.username,
    });
  }

  async adminResetPassword(
    targetUserId: number,
    newPassword: string,
    requestedBy: number,
    mustChange = true
  ): Promise<void> {
    Validate.id(targetUserId);
    Validate.passwordString(newPassword, 'password');
    if (!await this.userRepo.getById(targetUserId)) throw new NotFoundError('User', targetUserId);

    const hash = hashPassword(newPassword);
    await this.repo.updatePassword(targetUserId, hash, mustChange);

    this.bus.emit('auth:event', {
      action: 'password_reset', userId: requestedBy,
      username: '',
      extra: { targetUserId },
    });
  }

  async getSecurityQuestion(username: string): Promise<{ question: string | null }> {
    const uname = Validate.requiredString(username, 'Username', 50);
    return await this.repo.getSecurityQuestion(uname);
  }

  async resetPasswordWithSecurityAnswer(
    username: string,
    answer: string,
    newPassword: string
  ): Promise<void> {
    const uname = Validate.requiredString(username, 'Username', 50);
    Validate.passwordString(newPassword, 'New password');

    const user = await this.repo.findForSecurityReset(uname);
    if (!user || !user.security_question || !user.security_answer_hash) {
      throw new ValidationError('No security question set for this account', 'username');
    }

    if (isLocked(user.security_answer_locked_until)) {
      const remaining = Math.ceil(
        (new Date(user.security_answer_locked_until!).getTime() - Date.now()) / 60000
      );
      throw new ValidationError(
        `Too many wrong answers. Try again in ${remaining} minute(s).`,
        'locked'
      );
    }

    const normalised = answer.trim().toLowerCase();
    const valid = verifyPassword(normalised, user.security_answer_hash);

    if (!valid) {
      const attempts = (user.security_answer_failed_attempts ?? 0) + 1;
      if (attempts >= MAX_SECURITY_ATTEMPTS) {
        await this.repo.updateSecurityAnswerAttempts(
          user.id, attempts, lockoutUntil(SECURITY_LOCKOUT_MINUTES)
        );
        throw new ValidationError(
          `Too many wrong answers. Account locked for ${SECURITY_LOCKOUT_MINUTES} minutes.`,
          'locked'
        );
      }
      await this.repo.updateSecurityAnswerAttempts(user.id, attempts, null);
      throw new ValidationError('Incorrect answer', 'answer');
    }

    // Correct — reset lockout and set new password
    await this.repo.clearSecurityAnswerLock(user.id);
    const hash = hashPassword(newPassword);
    await this.repo.updatePassword(user.id, hash, false);

    this.bus.emit('auth:event', {
      action: 'password_reset', userId: user.id, username: uname,
    });
  }

  async setSecurityQuestion(
    userId: number,
    question: string,
    answer: string
  ): Promise<void> {
    Validate.id(userId);
    const q = Validate.requiredString(question, 'Question', 200);
    const a = Validate.requiredString(answer, 'Answer', 200);

    if (!await this.userRepo.getById(userId)) throw new NotFoundError('User', userId);

    const normalised = a.trim().toLowerCase();
    const hash = hashPassword(normalised);
    await this.repo.setSecurityQuestion(userId, q, hash);

    this.bus.emit('auth:event', {
      action: 'security_question_set', userId, username: '',
    });
  }

  async unlockAccount(userId: number, unlockedBy: number): Promise<void> {
    Validate.id(userId);
    if (!await this.userRepo.getById(userId)) throw new NotFoundError('User', userId);

    await this.repo.unlockAccount(userId);

    this.bus.emit('auth:event', {
      action: 'account_unlocked', userId: unlockedBy,
      username: '', extra: { targetUserId: userId },
    });
  }

  async emergencyResetAdmin(token: string): Promise<void> {
    Validate.requiredString(token, 'Emergency reset token');

    // The token file must exist in the data/ directory
    const dataDir = path.join(process.cwd(), 'data');
    const tokenFilePath = path.join(dataDir, '.emergency-reset-token');

    if (!fs.existsSync(tokenFilePath)) {
      throw new PermissionError(
        'Emergency reset not available. No reset token file found.'
      );
    }

    const storedToken = fs.readFileSync(tokenFilePath, 'utf-8').trim();
    if (!storedToken || storedToken !== token.trim()) {
      throw new PermissionError('Invalid emergency reset token.');
    }

    const admin = await this.repo.findByUsername('admin');
    if (!admin) throw new ValidationError('Admin account not found', 'admin');
    const hash = hashPassword('admin123');
    await this.repo.updatePassword(admin.id, hash, true);
    await this.repo.unlockAccount(admin.id);

    // Delete the token file after successful use (one-time use)
    try { fs.unlinkSync(tokenFilePath); } catch { /* ignore cleanup errors */ }

    this.bus.emit('auth:event', {
      action: 'emergency_reset', userId: admin.id, username: 'admin',
    });
  }

  async isFirstLaunch(): Promise<boolean> {
    // Check if admin password is still the default 'admin123'
    const admin = await this.repo.findByUsername('admin');
    if (!admin) return true;
    return verifyPassword('admin123', admin.password_hash);
  }
}
