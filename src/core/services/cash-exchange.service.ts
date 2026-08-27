import type { CashExchangeRepository } from '../repositories/sql/cash-exchange.repository';
import type { ShiftRepository } from '../repositories/sql/shift.repository';
import type { SettingsRepository } from '../repositories/sql/settings.repository';
import type { EventBus } from '../events/event-bus';
import type {
  CashExchange,
  CashExchangeFilters,
  CreateCashExchangeInput,
  PaginatedResult,
  CashExchangeValidationSettings,
} from '../types/models';
import { Validate } from '../common/validation';
import { Money } from '../common/money';
import { BusinessRuleError, InternalError, NotFoundError, ValidationError } from '../types/errors';

/**
 * Cash exchanges are their own ledger. They are never edited, voided, or
 * included in sale/return totals; the only ledger effect is bank in / cash out.
 */
export class CashExchangeService {
  constructor(
    private readonly repo: CashExchangeRepository,
    private readonly shiftRepo: ShiftRepository,
    private readonly bus: EventBus,
    private readonly settingsRepo?: SettingsRepository,
  ) {}

  async getAll(filters: CashExchangeFilters): Promise<PaginatedResult<CashExchange>> {
    return await this.repo.getAll(filters);
  }

  async getById(id: number): Promise<CashExchange> {
    Validate.id(id, 'Cash exchange');
    const exchange = await this.repo.getById(id);
    if (!exchange) throw new NotFoundError('Cash exchange', id);
    return exchange;
  }

  async getValidationSettings(): Promise<CashExchangeValidationSettings> {
    const defaultSettings: CashExchangeValidationSettings = {
      enabled: true,
      mode: 'warning',
      min_cash_threshold: 0,
      allow_admin_override: true,
      use_realtime_calculation: true,
      cash_calculation_mode: 'shift_only',
      cash_reserve_amount: 0,
    };

    if (!this.settingsRepo) return defaultSettings;

    try {
      const enabled = (await this.settingsRepo.get('cash_exchange_validation_enabled')) === 'true';
      const mode = (await this.settingsRepo.get('cash_exchange_validation_mode')) as 'warning' | 'strict' || 'warning';
      const minCashThreshold = parseInt((await this.settingsRepo.get('cash_exchange_min_threshold')) || '0', 10);
      const allowAdminOverride = (await this.settingsRepo.get('cash_exchange_allow_admin_override')) !== 'false';
      const useRealtime = (await this.settingsRepo.get('cash_exchange_use_realtime')) !== 'false';
      const cashCalculationMode = (await this.settingsRepo.get('cash_calculation_mode')) as 'shift_only' | 'shift_with_reserve' || 'shift_only';
      const cashReserveAmount = parseInt((await this.settingsRepo.get('cash_reserve_amount')) || '0', 10);

      return {
        enabled,
        mode,
        min_cash_threshold: minCashThreshold,
        allow_admin_override: allowAdminOverride,
        use_realtime_calculation: useRealtime,
        cash_calculation_mode: cashCalculationMode,
        cash_reserve_amount: cashReserveAmount,
      };
    } catch (error) {
      // If settings fail to load, return defaults
      return defaultSettings;
    }
  }

  async updateValidationSettings(settings: Partial<CashExchangeValidationSettings>, userId: number): Promise<CashExchangeValidationSettings> {
    if (!this.settingsRepo) {
      throw new BusinessRuleError('Settings repository is not available');
    }

    if (settings.enabled !== undefined) {
      await this.settingsRepo.set('cash_exchange_validation_enabled', settings.enabled ? 'true' : 'false');
    }
    if (settings.mode !== undefined) {
      await this.settingsRepo.set('cash_exchange_validation_mode', settings.mode);
    }
    if (settings.min_cash_threshold !== undefined) {
      await this.settingsRepo.set('cash_exchange_min_threshold', String(settings.min_cash_threshold));
    }
    if (settings.allow_admin_override !== undefined) {
      await this.settingsRepo.set('cash_exchange_allow_admin_override', settings.allow_admin_override ? 'true' : 'false');
    }
    if (settings.use_realtime_calculation !== undefined) {
      await this.settingsRepo.set('cash_exchange_use_realtime', settings.use_realtime_calculation ? 'true' : 'false');
    }
    if (settings.cash_calculation_mode !== undefined) {
      await this.settingsRepo.set('cash_calculation_mode', settings.cash_calculation_mode);
    }
    if (settings.cash_reserve_amount !== undefined) {
      await this.settingsRepo.set('cash_reserve_amount', String(settings.cash_reserve_amount));
    }

    // Emit audit event
    this.bus.emit('entity:mutated', {
      action: 'UPDATE_SETTING',
      table: 'settings',
      recordId: 0,
      userId,
      oldValues: {},
      newValues: settings,
    });

    return await this.getValidationSettings();
  }

  /** Create an exchange through the standalone Finance gate. */
  async create(data: CreateCashExchangeInput, userId: number, userRole: string = 'cashier'): Promise<CashExchange> {
    const shiftId = await this._resolveStandaloneShift(userId);
    
    // Validate cash availability before creating exchange
    const adminOverride = data.admin_override || false;
    await this.validateCashAvailability(
      data.cash_amount,
      shiftId,
      userRole,
      adminOverride
    );
    
    return await this._create(data, userId, shiftId, null);
  }

  /**
   * Create an exchange atomically with a sale. TransactionService calls this
   * inside its existing DB transaction, so neither record can persist alone.
   */
  async createForSale(
    data: CreateCashExchangeInput,
    userId: number,
    transactionId: number,
    shiftId: number | null,
    userRole: string = 'cashier',
  ): Promise<CashExchange> {
    Validate.id(transactionId, 'Transaction');
    const shiftsEnabled = await this._shiftsEnabled();
    if (shiftsEnabled && !shiftId) {
      throw new BusinessRuleError(
        'Open a shift before giving cash exchange so the drawer remains reconciled.',
      );
    }

    // Validate cash availability before creating exchange
    const adminOverride = data.admin_override || false;
    await this.validateCashAvailability(
      data.cash_amount,
      shiftId,
      userRole,
      adminOverride
    );

    return await this._create(data, userId, shiftId, transactionId);
  }

  private async _create(
    data: CreateCashExchangeInput,
    userId: number,
    shiftId: number | null,
    linkedTransactionId: number | null,
  ): Promise<CashExchange> {
    Validate.id(userId, 'User');
    const bankName = Validate.requiredString(data.bank_name, 'Bank name', 100);
    const referenceNumber = Validate.requiredString(data.reference_number, 'Reference number', 150);
    const bankAmount = Money.round(Validate.positiveNumber(data.bank_amount, 'Bank amount'));
    const cashAmount = Money.round(Validate.positiveNumber(data.cash_amount, 'Cash amount'));

    // This is currency conversion, not a charge. Fees or exchange rates need
    // their own explicit policy before we allow a non-zero difference.
    if (bankAmount !== cashAmount) {
      throw new ValidationError(
        'Bank amount and cash amount must be equal for a cash exchange.',
        'cash_amount',
      );
    }

    const id = await this.repo.create({
      bank_name: bankName,
      reference_number: referenceNumber,
      bank_amount: bankAmount,
      cash_amount: cashAmount,
      customer_name: Validate.optionalString(data.customer_name, 'Customer name', 120),
      customer_phone: Validate.optionalString(data.customer_phone, 'Customer phone', 50),
      notes: Validate.optionalString(data.notes, 'Notes', 500),
      linked_transaction_id: linkedTransactionId,
      shift_id: shiftId,
      user_id: userId,
    });

    this.bus.emit('entity:mutated', {
      action: 'CREATE_CASH_EXCHANGE',
      table: 'cash_exchanges',
      recordId: id,
      userId,
      newValues: {
        bank_name: bankName,
        reference_number: referenceNumber,
        bank_amount: bankAmount,
        cash_amount: cashAmount,
        shift_id: shiftId,
        linked_transaction_id: linkedTransactionId,
      },
    });

    const created = await this.repo.getById(id);
    if (!created) throw new InternalError('Failed to retrieve created cash exchange');
    return created;
  }

  private async _resolveStandaloneShift(userId: number): Promise<number | null> {
    if (!(await this._shiftsEnabled())) return null;
    const shift = await this.shiftRepo.findOpenByUser(userId);
    if (!shift) {
      throw new BusinessRuleError('Open a shift before giving cash exchange.');
    }
    return shift.id;
  }

  private async _shiftsEnabled(): Promise<boolean> {
    if (!this.settingsRepo) return true;
    return (await this.settingsRepo.get('shifts_enabled')) !== 'false';
  }

  /**
   * Validate cash availability for exchange
   * @throws ValidationError if validation fails in strict mode
   * @returns Object with validation result and available cash info
   */
  async validateCashAvailability(
    exchangeAmount: number,
    shiftId: number | null,
    userRole: string,
    adminOverride: boolean = false
  ): Promise<{ 
    valid: boolean; 
    availableCash: number; 
    requiredCash: number;
    warning?: string;
  }> {
    const settings = await this.getValidationSettings();

    // If validation is disabled, always valid
    if (!settings.enabled) {
      return { valid: true, availableCash: 0, requiredCash: exchangeAmount };
    }

    // If no shift, cannot validate - block in strict mode
    if (!shiftId) {
      if (settings.mode === 'strict' && !adminOverride) {
        throw new ValidationError(
          'Open a shift before giving cash exchange so the drawer remains reconciled.',
          'shift_id'
        );
      }
      return { 
        valid: true, 
        availableCash: 0, 
        requiredCash: exchangeAmount,
        warning: 'No shift open - cannot validate cash availability'
      };
    }

    // Get current expected cash from shift
    let availableCash = 0;
    if (settings.use_realtime_calculation) {
      const expected = await this.shiftRepo.getExpectedCash(shiftId);
      availableCash = expected.expected_cash;
    } else {
      // Use opening amount as fallback
      const shift = await this.shiftRepo.getById(shiftId);
      if (shift) {
        availableCash = shift.opening_amount || 0;
      }
    }

    // Add cash reserve if using shift_with_reserve mode
    if (settings.cash_calculation_mode === 'shift_with_reserve') {
      availableCash += settings.cash_reserve_amount;
    }

    // Add cash reserve if using shift_with_reserve mode
    if (settings.cash_calculation_mode === 'shift_with_reserve') {
      availableCash += settings.cash_reserve_amount;
    }

    const requiredCash = exchangeAmount;
    const effectiveThreshold = Math.max(0, settings.min_cash_threshold);
    const hasSufficientCash = availableCash >= (requiredCash + effectiveThreshold);

    // Admin override check
    if (adminOverride && settings.allow_admin_override && userRole === 'admin') {
      return { 
        valid: true, 
        availableCash, 
        requiredCash,
        warning: `Admin override: Insufficient cash (Available: ${availableCash} SDG, Required: ${requiredCash} SDG)`
      };
    }

    // Strict mode: block if insufficient cash
    if (settings.mode === 'strict' && !hasSufficientCash) {
      throw new ValidationError(
        `Insufficient cash in drawer. Available: ${availableCash} SDG, Required: ${requiredCash} SDG (minimum threshold: ${effectiveThreshold} SDG)`,
        'cash_amount'
      );
    }

    // Warning mode: always valid but return warning if insufficient
    if (settings.mode === 'warning' && !hasSufficientCash) {
      return { 
        valid: true, 
        availableCash, 
        requiredCash,
        warning: `Warning: Insufficient cash in drawer. Available: ${availableCash} SDG, Required: ${requiredCash} SDG (minimum threshold: ${effectiveThreshold} SDG)`
      };
    }

    return { valid: true, availableCash, requiredCash };
  }
}
