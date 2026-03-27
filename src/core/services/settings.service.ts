import type { SettingsRepository } from '../repositories/sql/settings.repository';
import type { EventBus }            from '../events/event-bus';
import type { Setting }             from '../types/models';
import { Validate }                 from '../common/validation';
import { ValidationError }          from '../types/errors';

const ALLOWED_KEYS = new Set([
  'business_name', 'business_address', 'business_phone',
  'currency_symbol', 'currency', 'expiry_warning_days',
  'auto_backup_hours', 'receipt_header', 'receipt_footer',
  'default_markup_percent', 'low_stock_threshold',
  'bank_config', 'language', 'theme',
  // Internal / migration
  'money_migration_manual_needed', 'money_migration_completed',
  'session_timeout_minutes', 'account_lockout_attempts',
  'account_lockout_duration_minutes', 'shifts_enabled',
  'recurring_generation_mode', 'recurring_generation_hour',
]);

export class SettingsService {
  constructor(
    private readonly repo: SettingsRepository,
    private readonly bus:  EventBus
  ) {}

  async get(key: string): Promise<string | null> {
    return await this.repo.get(key);
  }

  async getAll(): Promise<Setting[]> {
    return await this.repo.getAll();
  }

  async set(key: string, value: string, userId?: number): Promise<void> {
    const k = Validate.requiredString(key, 'Setting key', 100);
    if (!ALLOWED_KEYS.has(k)) {
      throw new ValidationError(`Unknown setting key: ${k}`, 'key');
    }
    await this.repo.set(k, value);
    if (userId) {
      this.bus.emit('entity:mutated', {
        action: 'UPDATE_SETTING', table: 'settings',
        recordId: null, userId,
        newValues: { key: k, value },
      });
    }
  }
}
