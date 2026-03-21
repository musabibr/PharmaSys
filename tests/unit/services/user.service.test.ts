import { UserService } from '@core/services/user.service';
import { ValidationError, NotFoundError } from '@core/types/errors';
import {
  createMockUserRepo, createMockBus, adminUserPublic, runResult,
} from '../../helpers/mocks';

function createService() {
  const userRepo = createMockUserRepo();
  const bus      = createMockBus();
  const svc      = new UserService(userRepo as any, bus);
  return { svc, userRepo, bus };
}

describe('UserService', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // getAll
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getAll', () => {
    it('returns all users', async () => {
      const { svc, userRepo } = createService();
      userRepo.getAll.mockResolvedValue([adminUserPublic]);
      const result = await svc.getAll();
      expect(result).toHaveLength(1);
      expect(result[0].username).toBe('admin');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getById
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getById', () => {
    it('returns user when found', async () => {
      const { svc, userRepo } = createService();
      userRepo.getById.mockResolvedValue(adminUserPublic);
      expect((await svc.getById(1)).username).toBe('admin');
    });

    it('throws NotFoundError when user does not exist', async () => {
      const { svc, userRepo } = createService();
      userRepo.getById.mockResolvedValue(undefined);
      await expect(svc.getById(99)).rejects.toThrow(NotFoundError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // create
  // ═══════════════════════════════════════════════════════════════════════════
  describe('create', () => {
    const validInput = {
      username: 'newuser',
      full_name: 'New User',
      role: 'cashier' as const,
      password: 'password123',
    };

    it('creates user and returns public profile', async () => {
      const { svc, userRepo } = createService();
      userRepo.findByUsername.mockResolvedValue(undefined);
      userRepo.create.mockResolvedValue(runResult(5));
      userRepo.getById.mockResolvedValue({ ...adminUserPublic, id: 5, username: 'newuser' });

      const result = await svc.create(validInput, 1);
      expect(result.username).toBe('newuser');
      expect(userRepo.create).toHaveBeenCalled();
    });

    it('throws ValidationError for empty username', async () => {
      const { svc } = createService();
      await expect(svc.create({ ...validInput, username: '' }, 1)).rejects.toThrow(ValidationError);
      await expect(svc.create({ ...validInput, username: '  ' }, 1)).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for empty full_name', async () => {
      const { svc } = createService();
      await expect(svc.create({ ...validInput, full_name: '' }, 1)).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for invalid role', async () => {
      const { svc } = createService();
      await expect(svc.create({ ...validInput, role: 'superuser' as any }, 1)).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when password is too short', async () => {
      const { svc } = createService();
      await expect(svc.create({ ...validInput, password: 'short' }, 1)).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when password is missing', async () => {
      const { svc } = createService();
      await expect(svc.create({ ...validInput, password: '' }, 1)).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when username already exists', async () => {
      const { svc, userRepo } = createService();
      userRepo.findByUsername.mockResolvedValue(adminUserPublic);
      await expect(svc.create(validInput, 1)).rejects.toThrow(ValidationError);
    });

    it('emits entity:mutated on create', async () => {
      const { svc, userRepo, bus } = createService();
      userRepo.findByUsername.mockResolvedValue(undefined);
      userRepo.create.mockResolvedValue(runResult(5));
      userRepo.getById.mockResolvedValue({ ...adminUserPublic, id: 5 });

      await svc.create(validInput, 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'CREATE_USER',
      }));
    });

    it('hashes password before storing', async () => {
      const { svc, userRepo } = createService();
      userRepo.findByUsername.mockResolvedValue(undefined);
      userRepo.create.mockResolvedValue(runResult(5));
      userRepo.getById.mockResolvedValue({ ...adminUserPublic, id: 5 });

      await svc.create(validInput, 1);
      const createCall = userRepo.create.mock.calls[0][0];
      expect(createCall.password_hash).toMatch(/^[a-f0-9]+:[a-f0-9]+$/);
      expect(createCall.password_hash).not.toBe(validInput.password);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // update
  // ═══════════════════════════════════════════════════════════════════════════
  describe('update', () => {
    it('updates user and returns updated profile', async () => {
      const { svc, userRepo } = createService();
      userRepo.getById
        .mockResolvedValueOnce(adminUserPublic)
        .mockResolvedValue({ ...adminUserPublic, full_name: 'Updated Name' });

      const result = await svc.update(1, { full_name: 'Updated Name' }, 1);
      expect(userRepo.update).toHaveBeenCalled();
      expect(result.full_name).toBe('Updated Name');
    });

    it('throws NotFoundError when user does not exist', async () => {
      const { svc, userRepo } = createService();
      userRepo.getById.mockResolvedValue(undefined);
      await expect(svc.update(99, { full_name: 'X' }, 1)).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError for invalid userId', async () => {
      const { svc } = createService();
      await expect(svc.update(0, {}, 1)).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for invalid role', async () => {
      const { svc, userRepo } = createService();
      userRepo.getById.mockResolvedValue(adminUserPublic);
      await expect(svc.update(1, { role: 'superuser' as any }, 1)).rejects.toThrow(ValidationError);
    });

    it('updates password when provided and valid', async () => {
      const { svc, userRepo } = createService();
      userRepo.getById.mockResolvedValue(adminUserPublic);

      await svc.update(1, { password: 'newpassword123' }, 1);
      const updateCall = userRepo.update.mock.calls[0][1];
      expect(updateCall.password_hash).toMatch(/^[a-f0-9]+:[a-f0-9]+$/);
    });

    it('does not update password when shorter than 8 chars', async () => {
      const { svc, userRepo } = createService();
      userRepo.getById.mockResolvedValue(adminUserPublic);

      await svc.update(1, { password: 'short' }, 1);
      const updateCall = userRepo.update.mock.calls[0][1];
      expect(updateCall.password_hash).toBeUndefined();
    });

    it('emits entity:mutated on update', async () => {
      const { svc, userRepo, bus } = createService();
      userRepo.getById.mockResolvedValue(adminUserPublic);

      await svc.update(1, { full_name: 'New Name' }, 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'UPDATE_USER',
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // resetPassword
  // ═══════════════════════════════════════════════════════════════════════════
  describe('resetPassword', () => {
    it('resets password successfully', async () => {
      const { svc, userRepo } = createService();
      userRepo.getById.mockResolvedValue(adminUserPublic);

      await svc.resetPassword(1, 'newpassword123', 1);
      expect(userRepo.resetPassword).toHaveBeenCalledWith(1, expect.stringMatching(/^[a-f0-9]+:[a-f0-9]+$/));
    });

    it('throws ValidationError for invalid userId', async () => {
      const { svc } = createService();
      await expect(svc.resetPassword(0, 'newpassword123', 1)).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when new password is too short', async () => {
      const { svc } = createService();
      await expect(svc.resetPassword(1, 'short', 1)).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when new password is empty', async () => {
      const { svc } = createService();
      await expect(svc.resetPassword(1, '', 1)).rejects.toThrow(ValidationError);
    });

    it('throws NotFoundError when user does not exist', async () => {
      const { svc, userRepo } = createService();
      userRepo.getById.mockResolvedValue(undefined);
      await expect(svc.resetPassword(99, 'newpassword123', 1)).rejects.toThrow(NotFoundError);
    });

    it('emits entity:mutated on reset', async () => {
      const { svc, userRepo, bus } = createService();
      userRepo.getById.mockResolvedValue(adminUserPublic);

      await svc.resetPassword(1, 'newpassword123', 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'RESET_PASSWORD',
      }));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // unlock
  // ═══════════════════════════════════════════════════════════════════════════
  describe('unlock', () => {
    it('unlocks user account', async () => {
      const { svc, userRepo } = createService();
      userRepo.getFullById.mockResolvedValue({ ...adminUserPublic, locked_until: new Date().toISOString() });

      await svc.unlock(1, 1);
      expect(userRepo.unlock).toHaveBeenCalledWith(1);
    });

    it('throws NotFoundError when user does not exist', async () => {
      const { svc, userRepo } = createService();
      userRepo.getFullById.mockResolvedValue(undefined);
      await expect(svc.unlock(99, 1)).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError for invalid userId', async () => {
      const { svc } = createService();
      await expect(svc.unlock(0, 1)).rejects.toThrow(ValidationError);
    });

    it('emits entity:mutated on unlock', async () => {
      const { svc, userRepo, bus } = createService();
      userRepo.getFullById.mockResolvedValue({ ...adminUserPublic, username: 'admin' });

      await svc.unlock(1, 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'UNLOCK_ACCOUNT',
        newValues: { username: 'admin' },
      }));
    });
  });
});
