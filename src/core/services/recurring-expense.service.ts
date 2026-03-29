import type { RecurringExpenseRepository } from '../repositories/sql/recurring-expense.repository';
import type { ExpenseRepository }          from '../repositories/sql/expense.repository';
import type { SettingsRepository }         from '../repositories/sql/settings.repository';
import type { EventBus }                   from '../events/event-bus';
import type {
  RecurringExpense, CreateRecurringExpenseInput, GenerationPreviewItem,
} from '../types/models';
import { Validate }               from '../common/validation';
import { NotFoundError, BusinessRuleError, ValidationError } from '../types/errors';

function enrichItem(item: RecurringExpense): RecurringExpense {
  const daily  = item.amount_type === 'daily'   ? item.amount : null;
  const monthly = item.amount_type === 'monthly' ? item.amount : item.amount * 30;
  return { ...item, daily_amount: daily ?? undefined, monthly_amount: monthly };
}

/**
 * Get all dates of the form YYYY-MM-{day} that fall strictly after afterDate
 * and on or before upToDate. If the month has fewer days than `day`,
 * clamps to the last day of that month.
 */
function monthDaysBetween(afterDate: string, upToDate: string, day: number): string[] {
  const results: string[] = [];
  const after = new Date(afterDate + 'T00:00:00');
  const end   = new Date(upToDate  + 'T00:00:00');

  let y = after.getFullYear();
  let m = after.getMonth(); // 0-based

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const lastDayOfMonth = new Date(y, m + 1, 0).getDate();
    const actualDay = Math.min(day, lastDayOfMonth);
    const candidate = new Date(y, m, actualDay);
    if (candidate > end) break;
    if (candidate > after) {
      results.push(candidate.toISOString().slice(0, 10));
    }
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return results;
}

/** Max days of daily backfill to prevent runaway generation */
const MAX_DAILY_BACKFILL_DAYS = 90;

export class RecurringExpenseService {
  constructor(
    private readonly repo:         RecurringExpenseRepository,
    private readonly expenseRepo:  ExpenseRepository,
    private readonly _settingsRepo: SettingsRepository, // kept for DI compatibility
    private readonly bus:          EventBus
  ) {}

  async getAll(): Promise<RecurringExpense[]> {
    const items = await this.repo.getAll();
    return items.map(enrichItem);
  }

  async getById(id: number): Promise<RecurringExpense> {
    Validate.id(id);
    const item = await this.repo.getById(id);
    if (!item) throw new NotFoundError('RecurringExpense', id);
    return enrichItem(item);
  }

  async create(data: CreateRecurringExpenseInput, userId: number): Promise<RecurringExpense> {
    const name = Validate.requiredString(data.name, 'Name', 200);
    Validate.positiveInteger(data.amount, 'Amount');
    Validate.id(data.category_id, 'Category');
    Validate.enum(data.amount_type, ['monthly', 'daily'] as const, 'Amount type');
    if (data.payment_method) {
      Validate.enum(data.payment_method, ['cash', 'bank_transfer'] as const, 'Payment method');
    }
    if (data.amount_type === 'monthly' && data.day_of_month !== undefined) {
      if (!Number.isInteger(data.day_of_month) || data.day_of_month < 1 || data.day_of_month > 28) {
        throw new ValidationError('Day of month must be between 1 and 28', 'day_of_month');
      }
    }

    const result = await this.repo.create({ ...data, name }, userId);
    const newId = result.lastInsertRowid as number;

    this.bus.emit('entity:mutated', {
      action: 'CREATE_RECURRING_EXPENSE', table: 'recurring_expenses',
      recordId: newId, userId,
      newValues: { name, amount: data.amount, amount_type: data.amount_type, payment_method: data.payment_method ?? 'cash' },
    });

    return await this.getById(newId);
  }

  async update(id: number, data: CreateRecurringExpenseInput, userId: number): Promise<RecurringExpense> {
    Validate.id(id);
    const existing = await this.repo.getById(id);
    if (!existing) throw new NotFoundError('RecurringExpense', id);

    const name = Validate.requiredString(data.name, 'Name', 200);
    Validate.positiveInteger(data.amount, 'Amount');
    Validate.id(data.category_id, 'Category');
    Validate.enum(data.amount_type, ['monthly', 'daily'] as const, 'Amount type');
    if (data.payment_method) {
      Validate.enum(data.payment_method, ['cash', 'bank_transfer'] as const, 'Payment method');
    }
    if (data.amount_type === 'monthly' && data.day_of_month !== undefined) {
      if (!Number.isInteger(data.day_of_month) || data.day_of_month < 1 || data.day_of_month > 28) {
        throw new ValidationError('Day of month must be between 1 and 28', 'day_of_month');
      }
    }

    await this.repo.update(id, { ...data, name });

    this.bus.emit('entity:mutated', {
      action: 'UPDATE_RECURRING_EXPENSE', table: 'recurring_expenses',
      recordId: id, userId,
      oldValues: { name: existing.name, amount: existing.amount },
      newValues: { name, amount: data.amount, amount_type: data.amount_type, payment_method: data.payment_method ?? 'cash' },
    });

    return await this.getById(id);
  }

  async delete(id: number, userId: number): Promise<void> {
    Validate.id(id);
    const existing = await this.repo.getById(id);
    if (!existing) throw new NotFoundError('RecurringExpense', id);

    const hasExpenses = await this.repo.hasGeneratedExpenses(id);
    if (hasExpenses) {
      throw new BusinessRuleError(
        'Cannot delete a recurring expense that has generated entries. Deactivate it instead.'
      );
    }

    await this.repo.delete(id);
    this.bus.emit('entity:mutated', {
      action: 'DELETE_RECURRING_EXPENSE', table: 'recurring_expenses',
      recordId: id, userId,
    });
  }

  async toggleActive(id: number, userId: number): Promise<RecurringExpense> {
    Validate.id(id);
    const existing = await this.repo.getById(id);
    if (!existing) throw new NotFoundError('RecurringExpense', id);

    const newActive = existing.is_active === 1 ? false : true;
    await this.repo.setActive(id, newActive);

    this.bus.emit('entity:mutated', {
      action: 'TOGGLE_RECURRING_EXPENSE', table: 'recurring_expenses',
      recordId: id, userId,
      oldValues: { is_active: existing.is_active },
      newValues: { is_active: newActive ? 1 : 0 },
    });

    return await this.getById(id);
  }

  // ─── Date range helpers (shared between preview and generate) ──────────

  /**
   * Get the "since" date for a specific item.
   * Uses the item's actual last_generated_date from the DB (per-item, not global).
   * Falls back to yesterday if the item has never been generated.
   */
  private _getItemSinceDate(item: RecurringExpense): string {
    if (item.last_generated_date) {
      return item.last_generated_date;
    }
    // Never generated → start from yesterday so today is included
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Get daily dates in the range (sinceDate, today] — i.e., sinceDate is
   * exclusive, today is inclusive. This ensures already-generated dates
   * are not re-included in the candidate list.
   */
  private _getDailyDates(sinceDate: string, today: string): string[] {
    const dates: string[] = [];
    const cursor = new Date(sinceDate + 'T00:00:00');
    cursor.setDate(cursor.getDate() + 1); // start day after sinceDate
    const end = new Date(today + 'T00:00:00');

    // Safety cap
    let dayCount = 0;
    while (cursor <= end && dayCount < MAX_DAILY_BACKFILL_DAYS) {
      dates.push(cursor.toISOString().slice(0, 10));
      cursor.setDate(cursor.getDate() + 1);
      dayCount++;
    }
    return dates;
  }

  // ─── Preview ───────────────────────────────────────────────────────────

  /**
   * Preview what would be generated without creating anything.
   * Returns items with their pending dates and already-generated dates.
   */
  async previewGeneration(): Promise<{ items: GenerationPreviewItem[]; capped: boolean }> {
    const today = new Date().toISOString().slice(0, 10);
    const activeItems = await this.repo.getActive();
    if (activeItems.length === 0) return { items: [], capped: false };

    let capped = false;
    const items: GenerationPreviewItem[] = [];

    for (const item of activeItems) {
      const sinceDate = this._getItemSinceDate(item);
      const targetDates = item.amount_type === 'daily'
        ? this._getDailyDates(sinceDate, today)
        : monthDaysBetween(sinceDate, today, item.day_of_month ?? 1);

      // Check if this item's daily dates were capped
      if (item.amount_type === 'daily' && !capped) {
        const uncapped = new Date(sinceDate + 'T00:00:00');
        uncapped.setDate(uncapped.getDate() + 1);
        const end = new Date(today + 'T00:00:00');
        let totalDays = 0;
        while (uncapped <= end) { totalDays++; uncapped.setDate(uncapped.getDate() + 1); }
        if (totalDays > MAX_DAILY_BACKFILL_DAYS) capped = true;
      }

      if (targetDates.length === 0) {
        items.push({
          itemId: item.id,
          itemName: item.name,
          categoryName: item.category_name ?? '',
          amount: item.amount,
          paymentMethod: item.payment_method ?? 'cash',
          dates: [],
          alreadyGenerated: [],
          type: item.amount_type,
        });
        continue;
      }

      const existingDates = new Set(
        await this.repo.getGeneratedDates(item.id, targetDates[0], targetDates[targetDates.length - 1])
      );

      const pendingDates = targetDates.filter(d => !existingDates.has(d));
      const alreadyGenerated = targetDates.filter(d => existingDates.has(d));

      items.push({
        itemId: item.id,
        itemName: item.name,
        categoryName: item.category_name ?? '',
        amount: item.amount,
        paymentMethod: item.payment_method ?? 'cash',
        dates: pendingDates,
        alreadyGenerated,
        type: item.amount_type,
      });
    }

    return { items, capped };
  }

  // ─── Generate ──────────────────────────────────────────────────────────

  /**
   * Generate expense entries for active recurring items.
   * - Daily items: one entry per day (capped at 90 days backfill).
   * - Monthly items: one entry per month-end that has passed.
   * @param itemIds — optional filter: only generate for these recurring item IDs
   */
  async generateForMissedDays(userId: number, itemIds?: number[]): Promise<number> {
    const today = new Date().toISOString().slice(0, 10);

    let activeItems = await this.repo.getActive();
    if (itemIds && itemIds.length > 0) {
      const idSet = new Set(itemIds);
      activeItems = activeItems.filter(i => idSet.has(i.id));
    }

    if (activeItems.length === 0) return 0;

    let count = 0;

    for (const item of activeItems) {
      const sinceDate = this._getItemSinceDate(item);
      const dates = item.amount_type === 'daily'
        ? this._getDailyDates(sinceDate, today)
        : monthDaysBetween(sinceDate, today, item.day_of_month ?? 1);

      if (dates.length === 0) continue;

      const existingDates = new Set(
        await this.repo.getGeneratedDates(item.id, dates[0], dates[dates.length - 1])
      );

      for (const date of dates) {
        if (existingDates.has(date)) continue;
        await this.expenseRepo.create(
          {
            category_id: item.category_id,
            amount: item.amount,
            description: `[Auto] ${item.name}`,
            expense_date: date,
            payment_method: item.payment_method ?? 'cash',
            is_recurring: 1,
            recurring_expense_id: item.id,
          },
          userId,
          null,
        );
        count++;
      }
    }

    return count;
  }
}
