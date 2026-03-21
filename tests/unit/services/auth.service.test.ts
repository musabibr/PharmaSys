import { AuthService, LoginResult } from '@core/services/auth.service';
import { ValidationError, NotFoundError, AuthenticationError } from '@core/types/errors';
import {
  createMockAuthRepo,
  createMockUserRepo,
  createMockBus,
  adminUser,
  lockedUser,
  securityUser,
  adminUserPublic,
  admin123Hash,
  newPass123Hash,
} from '../../helpers/mocks';
import type { EventBus } from '@core/events/event-bus';
import type { User } from '@core/types/models';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type MockAuthRepo = ReturnType<typeof createMockAuthRepo>;
type MockUserRepo = ReturnType<typeof createMockUserRepo>;

function makeService() {
  const authRepo = createMockAuthRepo();
  const userRepo = createMockUserRepo();
  const bus = createMockBus();
  const service = new AuthService(authRepo as any, userRepo as any, bus);
  return { service, authRepo, userRepo, bus };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('AuthService', () => {

  // ═══════════════════════════════════════════════════════════════════════════
  // login
  // ═══════════════════════════════════════════════════════════════════════════
  describe('login', () => {
    let service: AuthService;
    let authRepo: MockAuthRepo;
    let userRepo: MockUserRepo;
    let bus: EventBus;

    beforeEach(() => {
      ({ service, authRepo, userRepo, bus } = makeService());
    });

    it('returns user and mustChangePassword=false on successful login', async () => {
      authRepo.findByUsername.mockResolvedValue({ ...adminUser });
      userRepo.getById.mockResolvedValue(adminUserPublic);

      const result = await service.login('admin', 'admin123');

      expect(result.user).toEqual(adminUserPublic);
      expect(result.mustChangePassword).toBe(false);
      expect(authRepo.resetFailedAttempts).toHaveBeenCalledWith(adminUser.id);
    });

    it('returns mustChangePassword=true when user flag is set', async () => {
      authRepo.findByUsername.mockResolvedValue({
        ...adminUser,
        must_change_password: 1,
      });
      userRepo.getById.mockResolvedValue({ ...adminUserPublic, must_change_password: 1 });

      const result = await service.login('admin', 'admin123');

      expect(result.mustChangePassword).toBe(true);
    });

    it('emits login event on successful login', async () => {
      authRepo.findByUsername.mockResolvedValue({ ...adminUser });
      userRepo.getById.mockResolvedValue(adminUserPublic);

      await service.login('admin', 'admin123');

      expect(bus.emit).toHaveBeenCalledWith('auth:event', {
        action: 'login',
        userId: adminUser.id,
        username: adminUser.username,
      });
    });

    it('resets failed attempts on successful login', async () => {
      authRepo.findByUsername.mockResolvedValue({
        ...adminUser,
        failed_login_attempts: 3,
      });
      userRepo.getById.mockResolvedValue(adminUserPublic);

      await service.login('admin', 'admin123');

      expect(authRepo.resetFailedAttempts).toHaveBeenCalledWith(adminUser.id);
    });

    it('throws AuthenticationError on wrong password', async () => {
      authRepo.findByUsername.mockResolvedValue({ ...adminUser });

      await expect(service.login('admin', 'wrongPass'))
        .rejects.toThrow(AuthenticationError);
      await expect(service.login('admin', 'wrongPass'))
        .rejects.toThrow('Invalid username or password');
    });

    it('increments failed_login_attempts on wrong password', async () => {
      authRepo.findByUsername.mockResolvedValue({
        ...adminUser,
        failed_login_attempts: 0,
      });

      await expect(service.login('admin', 'wrongpassword')).rejects.toThrow();

      expect(authRepo.incrementFailedAttempts).toHaveBeenCalledWith(adminUser.id, 1);
    });

    it('increments attempts from current count', async () => {
      authRepo.findByUsername.mockResolvedValue({
        ...adminUser,
        failed_login_attempts: 3,
      });

      await expect(service.login('admin', 'wrongpassword')).rejects.toThrow();

      expect(authRepo.incrementFailedAttempts).toHaveBeenCalledWith(adminUser.id, 4);
    });

    it('throws AuthenticationError for user not found (timing-safe)', async () => {
      authRepo.findByUsername.mockResolvedValue(null);

      await expect(service.login('unknown_user', 'password'))
        .rejects.toThrow(AuthenticationError);
      await expect(service.login('unknown_user', 'password'))
        .rejects.toThrow('Invalid username or password');
    });

    it('does not reveal whether username exists via error message', async () => {
      // User not found
      authRepo.findByUsername.mockResolvedValue(null);
      let notFoundMsg = '';
      try { await service.login('nonexistent', 'pass'); } catch (e: any) { notFoundMsg = e.message; }

      // Wrong password
      authRepo.findByUsername.mockResolvedValue({ ...adminUser });
      let wrongPassMsg = '';
      try { await service.login('admin', 'wrongpass'); } catch (e: any) { wrongPassMsg = e.message; }

      expect(notFoundMsg).toBe(wrongPassMsg);
    });

    it('throws ValidationError with "locked" field when account is locked', async () => {
      authRepo.findByUsername.mockResolvedValue({ ...lockedUser });

      try {
        await service.login('locked_user', 'admin123');
        fail('Expected ValidationError');
      } catch (e: any) {
        expect(e).toBeInstanceOf(ValidationError);
        expect(e.field).toBe('locked');
        expect(e.message).toMatch(/Account is locked/);
        expect(e.message).toMatch(/minute\(s\)/);
      }
    });

    it('shows remaining minutes in lock message', async () => {
      const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      authRepo.findByUsername.mockResolvedValue({
        ...adminUser,
        id: 2,
        username: 'locked_user',
        locked_until: fiveMinutesFromNow,
        failed_login_attempts: 5,
      });

      try {
        await service.login('locked_user', 'admin123');
        fail('Expected ValidationError');
      } catch (e: any) {
        expect(e).toBeInstanceOf(ValidationError);
        // Should show approximately 5 minutes (could be 4 or 5 due to timing)
        expect(e.message).toMatch(/\d+ minute\(s\)/);
      }
    });

    it('locks account on 5th failed attempt', async () => {
      authRepo.findByUsername.mockResolvedValue({
        ...adminUser,
        failed_login_attempts: 4, // next failure = 5th
      });

      try {
        await service.login('admin', 'wrongpassword');
        fail('Expected ValidationError');
      } catch (e: any) {
        expect(e).toBeInstanceOf(ValidationError);
        expect(e.field).toBe('locked');
        expect(e.message).toMatch(/Too many failed attempts/);
        expect(e.message).toMatch(/15 minutes/);
      }

      expect(authRepo.lockAccount).toHaveBeenCalledWith(
        adminUser.id,
        expect.any(String), // lockout ISO string
        5,
      );
    });

    it('emits account_locked event on 5th failed attempt', async () => {
      authRepo.findByUsername.mockResolvedValue({
        ...adminUser,
        failed_login_attempts: 4,
      });

      try { await service.login('admin', 'wrongpassword'); } catch { /* expected */ }

      expect(bus.emit).toHaveBeenCalledWith('auth:event', {
        action: 'account_locked',
        userId: adminUser.id,
        username: adminUser.username,
      });
    });

    it('does not lock on 4th failed attempt', async () => {
      authRepo.findByUsername.mockResolvedValue({
        ...adminUser,
        failed_login_attempts: 3, // next failure = 4th
      });

      try { await service.login('admin', 'wrongpassword'); } catch { /* expected */ }

      expect(authRepo.lockAccount).not.toHaveBeenCalled();
      expect(authRepo.incrementFailedAttempts).toHaveBeenCalledWith(adminUser.id, 4);
    });

    it('throws ValidationError for empty username', async () => {
      await expect(service.login('', 'password')).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for whitespace-only username', async () => {
      await expect(service.login('   ', 'password')).rejects.toThrow(ValidationError);
    });

    it('trims username before lookup', async () => {
      authRepo.findByUsername.mockResolvedValue({ ...adminUser });
      userRepo.getById.mockResolvedValue(adminUserPublic);

      await service.login('  admin  ', 'admin123');

      expect(authRepo.findByUsername).toHaveBeenCalledWith('admin');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // changePassword
  // ═══════════════════════════════════════════════════════════════════════════
  describe('changePassword', () => {
    let service: AuthService;
    let authRepo: MockAuthRepo;
    let userRepo: MockUserRepo;
    let bus: EventBus;

    beforeEach(() => {
      ({ service, authRepo, userRepo, bus } = makeService());
    });

    it('successfully changes password with correct current password', async () => {
      userRepo.getById.mockResolvedValue(adminUserPublic);
      authRepo.findByUsername.mockResolvedValue({ ...adminUser });

      await service.changePassword(1, 'admin123', 'newSecurePass1');

      expect(authRepo.updatePassword).toHaveBeenCalledWith(
        1,
        expect.any(String), // new hash
        false, // must_change_password = false
      );
    });

    it('emits password_changed event on success', async () => {
      userRepo.getById.mockResolvedValue(adminUserPublic);
      authRepo.findByUsername.mockResolvedValue({ ...adminUser });

      await service.changePassword(1, 'admin123', 'newSecurePass1');

      expect(bus.emit).toHaveBeenCalledWith('auth:event', {
        action: 'password_changed',
        userId: 1,
        username: 'admin',
      });
    });

    it('throws AuthenticationError when current password is wrong', async () => {
      userRepo.getById.mockResolvedValue(adminUserPublic);
      authRepo.findByUsername.mockResolvedValue({ ...adminUser });

      await expect(service.changePassword(1, 'wrongCurrent', 'newSecurePass1'))
        .rejects.toThrow(AuthenticationError);
      await expect(service.changePassword(1, 'wrongCurrent', 'newSecurePass1'))
        .rejects.toThrow('Current password is incorrect');
    });

    it('throws ValidationError when new password is too short', async () => {
      try {
        await service.changePassword(1, 'admin123', 'short');
        fail('Expected ValidationError');
      } catch (e: any) {
        expect(e).toBeInstanceOf(ValidationError);
        expect(e.message).toMatch(/at least 8 characters/);
      }
    });

    it('throws ValidationError when new password is empty', async () => {
      await expect(service.changePassword(1, 'admin123', ''))
        .rejects.toThrow(ValidationError);
    });

    it('throws NotFoundError when user does not exist', async () => {
      userRepo.getById.mockResolvedValue(null);
      authRepo.findByUsername.mockResolvedValue(null);

      await expect(service.changePassword(999, 'admin123', 'newSecurePass1'))
        .rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError for invalid userId', async () => {
      await expect(service.changePassword(0, 'admin123', 'newSecurePass1'))
        .rejects.toThrow(ValidationError);
      await expect(service.changePassword(-1, 'admin123', 'newSecurePass1'))
        .rejects.toThrow(ValidationError);
    });

    it('does not call updatePassword when current password is wrong', async () => {
      userRepo.getById.mockResolvedValue(adminUserPublic);
      authRepo.findByUsername.mockResolvedValue({ ...adminUser });

      try { await service.changePassword(1, 'wrongCurrent', 'newSecurePass1'); } catch { /* expected */ }

      expect(authRepo.updatePassword).not.toHaveBeenCalled();
    });

    it('stores a properly formatted hash (salt:hash)', async () => {
      userRepo.getById.mockResolvedValue(adminUserPublic);
      authRepo.findByUsername.mockResolvedValue({ ...adminUser });

      await service.changePassword(1, 'admin123', 'newSecurePass1');

      const storedHash = authRepo.updatePassword.mock.calls[0][1] as string;
      const parts = storedHash.split(':');
      expect(parts).toHaveLength(2);
      expect(parts[0]).toHaveLength(32); // 16 bytes hex = 32 chars
      expect(parts[1]).toHaveLength(128); // 64 bytes hex = 128 chars
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // adminResetPassword
  // ═══════════════════════════════════════════════════════════════════════════
  describe('adminResetPassword', () => {
    let service: AuthService;
    let authRepo: MockAuthRepo;
    let userRepo: MockUserRepo;
    let bus: EventBus;

    beforeEach(() => {
      ({ service, authRepo, userRepo, bus } = makeService());
    });

    it('successfully resets password with mustChange=true by default', async () => {
      userRepo.getById.mockResolvedValue(adminUserPublic);

      await service.adminResetPassword(1, 'newSecure123', 99);

      expect(authRepo.updatePassword).toHaveBeenCalledWith(
        1,
        expect.any(String),
        true,
      );
    });

    it('respects mustChange=false when explicitly set', async () => {
      userRepo.getById.mockResolvedValue(adminUserPublic);

      await service.adminResetPassword(1, 'newSecure123', 99, false);

      expect(authRepo.updatePassword).toHaveBeenCalledWith(
        1,
        expect.any(String),
        false,
      );
    });

    it('emits password_reset event with requestedBy userId', async () => {
      userRepo.getById.mockResolvedValue(adminUserPublic);

      await service.adminResetPassword(1, 'newSecure123', 99);

      expect(bus.emit).toHaveBeenCalledWith('auth:event', {
        action: 'password_reset',
        userId: 99,
        username: '',
        extra: { targetUserId: 1 },
      });
    });

    it('throws ValidationError when new password is too short', async () => {
      userRepo.getById.mockResolvedValue(adminUserPublic);

      try {
        await service.adminResetPassword(1, 'short', 99);
        fail('Expected ValidationError');
      } catch (e: any) {
        expect(e).toBeInstanceOf(ValidationError);
        expect(e.message).toMatch(/at least 8 characters/);
        expect(e.field).toBe('password');
      }
    });

    it('throws ValidationError when new password is empty', async () => {
      await expect(service.adminResetPassword(1, '', 99))
        .rejects.toThrow(ValidationError);
    });

    it('throws NotFoundError when target user does not exist', async () => {
      userRepo.getById.mockResolvedValue(null);

      await expect(service.adminResetPassword(999, 'newSecure123', 99))
        .rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError for invalid target userId', async () => {
      await expect(service.adminResetPassword(0, 'newSecure123', 99))
        .rejects.toThrow(ValidationError);
    });

    it('does not call updatePassword when target user is not found', async () => {
      userRepo.getById.mockResolvedValue(null);

      try { await service.adminResetPassword(999, 'newSecure123', 99); } catch { /* expected */ }

      expect(authRepo.updatePassword).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getSecurityQuestion
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getSecurityQuestion', () => {
    let service: AuthService;
    let authRepo: MockAuthRepo;
    let userRepo: MockUserRepo;
    let bus: EventBus;

    beforeEach(() => {
      ({ service, authRepo, userRepo, bus } = makeService());
    });

    it('returns question when user has one set', async () => {
      authRepo.getSecurityQuestion.mockResolvedValue({ question: "What is your pet's name?" });

      const result = await service.getSecurityQuestion('sec_user');

      expect(result).toEqual({ question: "What is your pet's name?" });
      expect(authRepo.getSecurityQuestion).toHaveBeenCalledWith('sec_user');
    });

    it('returns null question when user has no security question', async () => {
      authRepo.getSecurityQuestion.mockResolvedValue({ question: null });

      const result = await service.getSecurityQuestion('admin');

      expect(result).toEqual({ question: null });
    });

    it('returns null question for unknown user', async () => {
      authRepo.getSecurityQuestion.mockResolvedValue({ question: null });

      const result = await service.getSecurityQuestion('nonexistent');

      expect(result).toEqual({ question: null });
    });

    it('throws ValidationError for empty username', async () => {
      await expect(service.getSecurityQuestion('')).rejects.toThrow(ValidationError);
    });

    it('trims username before lookup', async () => {
      authRepo.getSecurityQuestion.mockResolvedValue({ question: null });

      await service.getSecurityQuestion('  admin  ');

      expect(authRepo.getSecurityQuestion).toHaveBeenCalledWith('admin');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // resetPasswordWithSecurityAnswer
  // ═══════════════════════════════════════════════════════════════════════════
  describe('resetPasswordWithSecurityAnswer', () => {
    let service: AuthService;
    let authRepo: MockAuthRepo;
    let userRepo: MockUserRepo;
    let bus: EventBus;

    beforeEach(() => {
      ({ service, authRepo, userRepo, bus } = makeService());
    });

    it('resets password on correct answer', async () => {
      authRepo.findForSecurityReset.mockResolvedValue({ ...securityUser });

      await service.resetPasswordWithSecurityAnswer('sec_user', 'fluffy', 'newSecure123');

      expect(authRepo.clearSecurityAnswerLock).toHaveBeenCalledWith(securityUser.id);
      expect(authRepo.updatePassword).toHaveBeenCalledWith(
        securityUser.id,
        expect.any(String),
        false,
      );
    });

    it('normalizes answer to lowercase before verification', async () => {
      authRepo.findForSecurityReset.mockResolvedValue({ ...securityUser });

      // Answer stored as hash of 'fluffy' (lowercase). Passing mixed case should still work.
      await service.resetPasswordWithSecurityAnswer('sec_user', 'FLUFFY', 'newSecure123');

      expect(authRepo.clearSecurityAnswerLock).toHaveBeenCalledWith(securityUser.id);
      expect(authRepo.updatePassword).toHaveBeenCalled();
    });

    it('trims answer before verification', async () => {
      authRepo.findForSecurityReset.mockResolvedValue({ ...securityUser });

      await service.resetPasswordWithSecurityAnswer('sec_user', '  fluffy  ', 'newSecure123');

      expect(authRepo.clearSecurityAnswerLock).toHaveBeenCalledWith(securityUser.id);
      expect(authRepo.updatePassword).toHaveBeenCalled();
    });

    it('emits password_reset event on success', async () => {
      authRepo.findForSecurityReset.mockResolvedValue({ ...securityUser });

      await service.resetPasswordWithSecurityAnswer('sec_user', 'fluffy', 'newSecure123');

      expect(bus.emit).toHaveBeenCalledWith('auth:event', {
        action: 'password_reset',
        userId: securityUser.id,
        username: 'sec_user',
      });
    });

    it('throws ValidationError on wrong answer and increments attempts', async () => {
      authRepo.findForSecurityReset.mockResolvedValue({
        ...securityUser,
        security_answer_failed_attempts: 0,
      });

      try {
        await service.resetPasswordWithSecurityAnswer('sec_user', 'wrong_answer', 'newSecure123');
        fail('Expected ValidationError');
      } catch (e: any) {
        expect(e).toBeInstanceOf(ValidationError);
        expect(e.message).toBe('Incorrect answer');
        expect(e.field).toBe('answer');
      }

      expect(authRepo.updateSecurityAnswerAttempts).toHaveBeenCalledWith(
        securityUser.id,
        1,
        null, // no lockout yet
      );
    });

    it('increments attempts from current count', async () => {
      authRepo.findForSecurityReset.mockResolvedValue({
        ...securityUser,
        security_answer_failed_attempts: 1,
      });

      try { await service.resetPasswordWithSecurityAnswer('sec_user', 'wrong', 'newSecure123'); } catch { /* expected */ }

      expect(authRepo.updateSecurityAnswerAttempts).toHaveBeenCalledWith(
        securityUser.id,
        2,
        null,
      );
    });

    it('locks after 3rd wrong answer', async () => {
      authRepo.findForSecurityReset.mockResolvedValue({
        ...securityUser,
        security_answer_failed_attempts: 2, // next will be 3rd
      });

      try {
        await service.resetPasswordWithSecurityAnswer('sec_user', 'wrong', 'newSecure123');
        fail('Expected ValidationError');
      } catch (e: any) {
        expect(e).toBeInstanceOf(ValidationError);
        expect(e.field).toBe('locked');
        expect(e.message).toMatch(/Too many wrong answers/);
        expect(e.message).toMatch(/15 minutes/);
      }

      expect(authRepo.updateSecurityAnswerAttempts).toHaveBeenCalledWith(
        securityUser.id,
        3,
        expect.any(String), // lockout ISO timestamp
      );
    });

    it('throws ValidationError when security answer lockout is active', async () => {
      const tenMinutesFromNow = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      authRepo.findForSecurityReset.mockResolvedValue({
        ...securityUser,
        security_answer_locked_until: tenMinutesFromNow,
        security_answer_failed_attempts: 3,
      });

      try {
        await service.resetPasswordWithSecurityAnswer('sec_user', 'fluffy', 'newSecure123');
        fail('Expected ValidationError');
      } catch (e: any) {
        expect(e).toBeInstanceOf(ValidationError);
        expect(e.field).toBe('locked');
        expect(e.message).toMatch(/Too many wrong answers/);
        expect(e.message).toMatch(/minute\(s\)/);
      }
    });

    it('shows remaining minutes in security lockout message', async () => {
      const threeMinutesFromNow = new Date(Date.now() + 3 * 60 * 1000).toISOString();
      authRepo.findForSecurityReset.mockResolvedValue({
        ...securityUser,
        security_answer_locked_until: threeMinutesFromNow,
        security_answer_failed_attempts: 3,
      });

      try {
        await service.resetPasswordWithSecurityAnswer('sec_user', 'fluffy', 'newSecure123');
        fail('Expected ValidationError');
      } catch (e: any) {
        expect(e.message).toMatch(/\d+ minute\(s\)/);
      }
    });

    it('throws ValidationError when no security question is set', async () => {
      authRepo.findForSecurityReset.mockResolvedValue({
        ...adminUser, // no security question
        security_question: null,
        security_answer_hash: null,
      });

      try {
        await service.resetPasswordWithSecurityAnswer('admin', 'answer', 'newSecure123');
        fail('Expected ValidationError');
      } catch (e: any) {
        expect(e).toBeInstanceOf(ValidationError);
        expect(e.message).toMatch(/No security question set/);
        expect(e.field).toBe('username');
      }
    });

    it('throws ValidationError when user not found', async () => {
      authRepo.findForSecurityReset.mockResolvedValue(null);

      try {
        await service.resetPasswordWithSecurityAnswer('nonexistent', 'answer', 'newSecure123');
        fail('Expected ValidationError');
      } catch (e: any) {
        expect(e).toBeInstanceOf(ValidationError);
        expect(e.message).toMatch(/No security question set/);
      }
    });

    it('throws ValidationError when new password is too short', async () => {
      try {
        await service.resetPasswordWithSecurityAnswer('sec_user', 'fluffy', 'short');
        fail('Expected ValidationError');
      } catch (e: any) {
        expect(e).toBeInstanceOf(ValidationError);
        expect(e.message).toMatch(/at least 8 characters/);
      }
    });

    it('throws ValidationError when new password is empty', async () => {
      await expect(service.resetPasswordWithSecurityAnswer('sec_user', 'fluffy', ''))
        .rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for empty username', async () => {
      await expect(service.resetPasswordWithSecurityAnswer('', 'fluffy', 'newSecure123'))
        .rejects.toThrow(ValidationError);
    });

    it('does not update password on wrong answer', async () => {
      authRepo.findForSecurityReset.mockResolvedValue({
        ...securityUser,
        security_answer_failed_attempts: 0,
      });

      try { await service.resetPasswordWithSecurityAnswer('sec_user', 'wrong', 'newSecure123'); } catch { /* expected */ }

      expect(authRepo.updatePassword).not.toHaveBeenCalled();
      expect(authRepo.clearSecurityAnswerLock).not.toHaveBeenCalled();
    });

    it('does not update password when locked', async () => {
      const tenMinutesFromNow = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      authRepo.findForSecurityReset.mockResolvedValue({
        ...securityUser,
        security_answer_locked_until: tenMinutesFromNow,
      });

      try { await service.resetPasswordWithSecurityAnswer('sec_user', 'fluffy', 'newSecure123'); } catch { /* expected */ }

      expect(authRepo.updatePassword).not.toHaveBeenCalled();
    });

    it('allows login after expired security lockout', async () => {
      // Lockout in the past = expired
      const pastLockout = new Date(Date.now() - 1000).toISOString();
      authRepo.findForSecurityReset.mockResolvedValue({
        ...securityUser,
        security_answer_locked_until: pastLockout,
        security_answer_failed_attempts: 3,
      });

      // Correct answer should succeed since lockout expired
      await service.resetPasswordWithSecurityAnswer('sec_user', 'fluffy', 'newSecure123');

      expect(authRepo.updatePassword).toHaveBeenCalled();
      expect(authRepo.clearSecurityAnswerLock).toHaveBeenCalledWith(securityUser.id);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // setSecurityQuestion
  // ═══════════════════════════════════════════════════════════════════════════
  describe('setSecurityQuestion', () => {
    let service: AuthService;
    let authRepo: MockAuthRepo;
    let userRepo: MockUserRepo;
    let bus: EventBus;

    beforeEach(() => {
      ({ service, authRepo, userRepo, bus } = makeService());
    });

    it('sets security question and hashed answer', async () => {
      userRepo.getById.mockResolvedValue(adminUserPublic);

      await service.setSecurityQuestion(1, "What is your pet's name?", 'Fluffy');

      expect(authRepo.setSecurityQuestion).toHaveBeenCalledWith(
        1,
        "What is your pet's name?",
        expect.any(String), // hashed answer
      );
    });

    it('normalizes answer to lowercase+trim before hashing', async () => {
      userRepo.getById.mockResolvedValue(adminUserPublic);

      await service.setSecurityQuestion(1, 'Question?', '  FLUFFY  ');

      // The hash should be for 'fluffy' (lowercased + trimmed)
      const storedHash = authRepo.setSecurityQuestion.mock.calls[0][2] as string;
      expect(storedHash).toMatch(/^[a-f0-9]{32}:[a-f0-9]{128}$/);
    });

    it('emits security_question_set event', async () => {
      userRepo.getById.mockResolvedValue(adminUserPublic);

      await service.setSecurityQuestion(1, 'Question?', 'Answer');

      expect(bus.emit).toHaveBeenCalledWith('auth:event', {
        action: 'security_question_set',
        userId: 1,
        username: '',
      });
    });

    it('throws NotFoundError when user does not exist', async () => {
      userRepo.getById.mockResolvedValue(null);

      await expect(service.setSecurityQuestion(999, 'Question?', 'Answer'))
        .rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError for empty question', async () => {
      await expect(service.setSecurityQuestion(1, '', 'Answer'))
        .rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for empty answer', async () => {
      await expect(service.setSecurityQuestion(1, 'Question?', ''))
        .rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for whitespace-only question', async () => {
      await expect(service.setSecurityQuestion(1, '   ', 'Answer'))
        .rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for whitespace-only answer', async () => {
      await expect(service.setSecurityQuestion(1, 'Question?', '   '))
        .rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for invalid userId', async () => {
      await expect(service.setSecurityQuestion(0, 'Question?', 'Answer'))
        .rejects.toThrow(ValidationError);
    });

    it('does not call repo when user not found', async () => {
      userRepo.getById.mockResolvedValue(null);

      try { await service.setSecurityQuestion(999, 'Q?', 'A'); } catch { /* expected */ }

      expect(authRepo.setSecurityQuestion).not.toHaveBeenCalled();
    });

    it('trims question before storing', async () => {
      userRepo.getById.mockResolvedValue(adminUserPublic);

      await service.setSecurityQuestion(1, '  What is your pet?  ', 'Fluffy');

      expect(authRepo.setSecurityQuestion).toHaveBeenCalledWith(
        1,
        'What is your pet?',
        expect.any(String),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // unlockAccount
  // ═══════════════════════════════════════════════════════════════════════════
  describe('unlockAccount', () => {
    let service: AuthService;
    let authRepo: MockAuthRepo;
    let userRepo: MockUserRepo;
    let bus: EventBus;

    beforeEach(() => {
      ({ service, authRepo, userRepo, bus } = makeService());
    });

    it('unlocks account and emits event', async () => {
      userRepo.getById.mockResolvedValue(adminUserPublic);

      await service.unlockAccount(2, 1);

      expect(authRepo.unlockAccount).toHaveBeenCalledWith(2);
      expect(bus.emit).toHaveBeenCalledWith('auth:event', {
        action: 'account_unlocked',
        userId: 1,
        username: '',
        extra: { targetUserId: 2 },
      });
    });

    it('throws NotFoundError when user does not exist', async () => {
      userRepo.getById.mockResolvedValue(null);

      await expect(service.unlockAccount(999, 1)).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError for invalid userId', async () => {
      await expect(service.unlockAccount(0, 1)).rejects.toThrow(ValidationError);
    });

    it('does not call unlockAccount repo method when user not found', async () => {
      userRepo.getById.mockResolvedValue(null);

      try { await service.unlockAccount(999, 1); } catch { /* expected */ }

      expect(authRepo.unlockAccount).not.toHaveBeenCalled();
    });

    it('emits event with unlockedBy as userId', async () => {
      userRepo.getById.mockResolvedValue(adminUserPublic);

      await service.unlockAccount(5, 42);

      expect(bus.emit).toHaveBeenCalledWith('auth:event',
        expect.objectContaining({
          action: 'account_unlocked',
          userId: 42,
          extra: { targetUserId: 5 },
        }),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // isFirstLaunch
  // ═══════════════════════════════════════════════════════════════════════════
  describe('isFirstLaunch', () => {
    let service: AuthService;
    let authRepo: MockAuthRepo;
    let userRepo: MockUserRepo;
    let bus: EventBus;

    beforeEach(() => {
      ({ service, authRepo, userRepo, bus } = makeService());
    });

    it('returns true when admin has default password (admin123)', async () => {
      authRepo.findByUsername.mockResolvedValue({
        ...adminUser,
        password_hash: admin123Hash,
      });

      expect(await service.isFirstLaunch()).toBe(true);
    });

    it('returns false after admin has changed password', async () => {
      authRepo.findByUsername.mockResolvedValue({
        ...adminUser,
        password_hash: newPass123Hash, // hash of 'newPass123', not 'admin123'
      });

      expect(await service.isFirstLaunch()).toBe(false);
    });

    it('returns true when no admin user exists', async () => {
      authRepo.findByUsername.mockResolvedValue(null);

      expect(await service.isFirstLaunch()).toBe(true);
    });

    it('looks up the "admin" username specifically', async () => {
      authRepo.findByUsername.mockResolvedValue(null);

      await service.isFirstLaunch();

      expect(authRepo.findByUsername).toHaveBeenCalledWith('admin');
    });
  });
});
