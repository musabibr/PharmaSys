import * as crypto from 'crypto';
import * as util   from 'util';
import type { UserRepository } from '../repositories/sql/user.repository';
import type { EventBus }       from '../events/event-bus';
import type { UserPublic, CreateUserInput, UpdateUserInput } from '../types/models';
import { Validate }            from '../common/validation';
import { NotFoundError, ValidationError } from '../types/errors';
import { ALL_PERMISSION_KEYS, deriveLegacyPermissions } from '../common/permissions';
import type { PermissionKey } from '../common/permissions';

const scryptAsync = util.promisify(crypto.scrypt);

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export class UserService {
  constructor(
    private readonly repo: UserRepository,
    private readonly bus:  EventBus
  ) {}

  async getAll(): Promise<UserPublic[]> {
    return await this.repo.getAll();
  }

  async getById(id: number): Promise<UserPublic> {
    const user = await this.repo.getById(id);
    if (!user) throw new NotFoundError('User', id);
    return user;
  }

  async create(data: CreateUserInput, createdBy: number): Promise<UserPublic> {
    const username = Validate.requiredString(data.username, 'Username', 50);
    const fullName = Validate.requiredString(data.full_name, 'Full name', 100);
    const role     = Validate.enum(data.role, ['admin', 'pharmacist', 'cashier'] as const, 'Role');

    if (!data.password || data.password.length < 8) {
      throw new ValidationError('Password must be at least 8 characters', 'password');
    }

    const existing = await this.repo.findByUsername(username);
    if (existing) throw new ValidationError('Username already exists', 'username');

    // Resolve permissions: if micro-permissions provided, use them; otherwise use legacy booleans
    const { permissionsJson, legacyPerms } = this._resolveInputPermissions(data);

    const hash = hashPassword(data.password);
    const result = await this.repo.create({
      ...data, username, full_name: fullName, role, password_hash: hash,
      perm_finance: legacyPerms.perm_finance === 1,
      perm_inventory: legacyPerms.perm_inventory === 1,
      perm_reports: legacyPerms.perm_reports === 1,
      permissions_json: permissionsJson,
    });

    this.bus.emit('entity:mutated', {
      action: 'CREATE_USER', table: 'users',
      recordId: result.lastInsertRowid, userId: createdBy,
      newValues: { username, role },
    });

    return await this.getById(result.lastInsertRowid);
  }

  async update(id: number, data: UpdateUserInput & { password?: string }, updatedBy: number): Promise<UserPublic> {
    Validate.id(id);
    const existing = await this.repo.getById(id);
    if (!existing) throw new NotFoundError('User', id);

    const fullName = data.full_name
      ? Validate.requiredString(data.full_name, 'Full name', 100)
      : existing.full_name;
    const role = data.role
      ? Validate.enum(data.role, ['admin', 'pharmacist', 'cashier'] as const, 'Role')
      : existing.role;

    const passwordHash = (data.password && data.password.length >= 8)
      ? hashPassword(data.password) : undefined;

    // Resolve permissions: if micro-permissions provided, use them; otherwise use legacy booleans
    const { permissionsJson, legacyPerms } = this._resolveInputPermissions(data);

    await this.repo.update(id, {
      full_name: fullName, role, password_hash: passwordHash,
      perm_finance:   legacyPerms.perm_finance === 1,
      perm_inventory: legacyPerms.perm_inventory === 1,
      perm_reports:   legacyPerms.perm_reports === 1,
      permissions_json: permissionsJson,
      is_active:      data.is_active,
    });

    this.bus.emit('entity:mutated', {
      action: 'UPDATE_USER', table: 'users',
      recordId: id, userId: updatedBy,
      oldValues: { role: existing.role }, newValues: { role },
    });

    return await this.getById(id);
  }

  async resetPassword(userId: number, newPassword: string, resetBy: number): Promise<void> {
    Validate.id(userId);
    if (!newPassword || newPassword.length < 8) {
      throw new ValidationError('Password must be at least 8 characters', 'password');
    }
    if (!await this.repo.getById(userId)) throw new NotFoundError('User', userId);

    const hash = hashPassword(newPassword);
    await this.repo.resetPassword(userId, hash);

    this.bus.emit('entity:mutated', {
      action: 'RESET_PASSWORD', table: 'users',
      recordId: userId, userId: resetBy,
    });
  }

  async unlock(userId: number, unlockedBy: number): Promise<void> {
    Validate.id(userId);
    const user = await this.repo.getFullById(userId);
    if (!user) throw new NotFoundError('User', userId);

    await this.repo.unlock(userId);

    this.bus.emit('entity:mutated', {
      action: 'UNLOCK_ACCOUNT', table: 'users',
      recordId: userId, userId: unlockedBy,
      newValues: { username: user.username },
    });
  }

  /**
   * Resolve input permissions into permissions_json and legacy column values.
   * If `permissions` array is provided, it takes precedence and legacy columns are derived.
   * Otherwise, legacy booleans are used as-is and permissions_json stays null.
   */
  private _resolveInputPermissions(data: { permissions?: PermissionKey[]; perm_finance?: boolean; perm_inventory?: boolean; perm_reports?: boolean }): {
    permissionsJson: string | null;
    legacyPerms: { perm_finance: number; perm_inventory: number; perm_reports: number };
  } {
    if (data.permissions) {
      // Validate all keys are known
      const validKeys = new Set<string>(ALL_PERMISSION_KEYS);
      const filtered = data.permissions.filter(k => validKeys.has(k));
      const legacy = deriveLegacyPermissions(filtered);
      return {
        permissionsJson: JSON.stringify(filtered),
        legacyPerms: legacy,
      };
    }

    // No micro-permissions provided — use legacy booleans
    return {
      permissionsJson: null,
      legacyPerms: {
        perm_finance:   data.perm_finance ? 1 : 0,
        perm_inventory: data.perm_inventory ? 1 : 0,
        perm_reports:   data.perm_reports ? 1 : 0,
      },
    };
  }
}
