import { SettingsService } from '@core/services/settings.service';
import { ValidationError } from '@core/types/errors';
import { createMockSettingsRepo, createMockBus } from '../../helpers/mocks';

function createService() {
  const repo = createMockSettingsRepo();
  const bus  = createMockBus();
  const svc  = new SettingsService(repo as any, bus);
  return { svc, repo, bus };
}

describe('SettingsService', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // get
  // ═══════════════════════════════════════════════════════════════════════════
  describe('get', () => {
    it('returns setting value for a key', async () => {
      const { svc, repo } = createService();
      repo.get.mockResolvedValue('PharmaSys');
      expect(await svc.get('business_name')).toBe('PharmaSys');
    });

    it('returns null when setting is not set', async () => {
      const { svc, repo } = createService();
      repo.get.mockResolvedValue(null);
      expect(await svc.get('business_name')).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getAll
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getAll', () => {
    it('returns all settings', async () => {
      const { svc, repo } = createService();
      const settings = [
        { key: 'business_name', value: 'PharmaSys', updated_at: '2026-01-01' },
        { key: 'language', value: 'en', updated_at: '2026-01-01' },
      ] as any[];
      repo.getAll.mockResolvedValue(settings);

      const result = await svc.getAll();
      expect(result).toHaveLength(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // set
  // ═══════════════════════════════════════════════════════════════════════════
  describe('set', () => {
    it('sets an allowed key', async () => {
      const { svc, repo } = createService();
      await svc.set('business_name', 'My Pharmacy', 1);
      expect(repo.set).toHaveBeenCalledWith('business_name', 'My Pharmacy');
    });

    it('emits entity:mutated when userId provided', async () => {
      const { svc, bus } = createService();
      await svc.set('language', 'ar', 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'UPDATE_SETTING',
        newValues: { key: 'language', value: 'ar' },
      }));
    });

    it('does not emit event when userId is not provided', async () => {
      const { svc, bus } = createService();
      await svc.set('language', 'ar');
      expect(bus.emit).not.toHaveBeenCalled();
    });

    it('throws ValidationError for unknown key', async () => {
      const { svc } = createService();
      await expect(svc.set('unknown_key', 'value', 1)).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for empty key', async () => {
      const { svc } = createService();
      await expect(svc.set('', 'value', 1)).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for whitespace-only key', async () => {
      const { svc } = createService();
      await expect(svc.set('   ', 'value', 1)).rejects.toThrow(ValidationError);
    });

    it.each([
      'business_name', 'currency_symbol', 'expiry_warning_days',
      'auto_backup_hours', 'receipt_footer', 'default_markup_percent',
      'bank_config', 'language', 'theme',
      'session_timeout_minutes', 'account_lockout_attempts',
      'account_lockout_duration_minutes',
      'return_window_shifts', 'return_window_days', 'void_window_hours',
    ])('accepts allowed key: %s', async (key) => {
      const { svc, repo } = createService();
      await expect(svc.set(key, 'test')).resolves.not.toThrow();
      expect(repo.set).toHaveBeenCalledWith(key, 'test');
    });

    it('stores rounding rules only when every rule can be applied', async () => {
      const { svc, repo } = createService();
      const rule = { id: 'custom-a', name: 'Mine', block: 1000, bands: [{ upTo: 299, to: 0 }, { upTo: 999, to: 1000 }] };
      await svc.set('price_rounding_rules', JSON.stringify([rule]), 1);
      expect(repo.set).toHaveBeenCalledWith('price_rounding_rules', JSON.stringify([rule]));

      await expect(svc.set('price_rounding_rules', 'not json', 1)).rejects.toThrow(ValidationError);
      await expect(svc.set('price_rounding_rules', JSON.stringify([{ ...rule, bands: [{ upTo: 500, to: 0 }] }]), 1)).rejects.toThrow(/end of the block/);
      await expect(svc.set('price_rounding_rules', JSON.stringify([{ ...rule, id: 'nearest-500' }]), 1)).rejects.toThrow(ValidationError);
      await expect(svc.set('price_rounding_rules', JSON.stringify([rule, rule]), 1)).rejects.toThrow(ValidationError);
    });

    it('accepts a rounding rule id, or none, as the rule offered first', async () => {
      const { svc, repo } = createService();
      await svc.set('price_rounding_default', 'nearest-500', 1);
      await svc.set('price_rounding_small_default', 'none', 1);
      expect(repo.set).toHaveBeenCalledWith('price_rounding_small_default', 'none');
      await expect(svc.set('price_rounding_default', '<b>', 1)).rejects.toThrow(ValidationError);
    });
  });
});
