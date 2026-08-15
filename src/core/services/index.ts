/**
 * ServiceContainer — wires all services together using dependency injection.
 * All services are lazy-instantiated on first access to avoid circular deps.
 */

import type { Repositories } from '../repositories/sql/index';
import type { EventBus }     from '../events/event-bus';
import { AuditListener }     from '../events/audit.listener';

import { AuthService }        from './auth.service';
import { UserService }        from './user.service';
import { CategoryService }    from './category.service';
import { ProductService }     from './product.service';
import { BatchService }       from './batch.service';
import { TransactionService } from './transaction.service';
import { ShiftService }       from './shift.service';
import { ExpenseService }     from './expense.service';
import { HeldSaleService }    from './held-sale.service';
import { ReportService }      from './report.service';
import { DashboardService }   from './dashboard.service';
import { AuditService }       from './audit.service';
import { SettingsService }    from './settings.service';
import { BackupService }      from './backup.service';
import { PurchaseService }          from './purchase.service';
import { RecurringExpenseService }  from './recurring-expense.service';
import { CycleCountService }        from './cycle-count.service';

export class ServiceContainer {
  private _auth?:        AuthService;
  private _user?:        UserService;
  private _category?:   CategoryService;
  private _product?:    ProductService;
  private _batch?:      BatchService;
  private _transaction?: TransactionService;
  private _shift?:      ShiftService;
  private _expense?:    ExpenseService;
  private _heldSale?:   HeldSaleService;
  private _report?:     ReportService;
  private _dashboard?:  DashboardService;
  private _audit?:      AuditService;
  private _settings?:   SettingsService;
  private _backup?:     BackupService;
  private _purchase?:          PurchaseService;
  private _recurringExpense?:  RecurringExpenseService;
  private _cycleCount?:        CycleCountService;

  constructor(
    private readonly repos: Repositories,
    private readonly bus:   EventBus,
    private readonly dataPath?: string
  ) {
    // Wire the audit listener — it subscribes to EventBus and writes audit logs.
    // repos.base is passed so audit writes emitted mid-transaction are
    // deferred until COMMIT instead of racing the transaction's own
    // remaining writes for it (audit finding F3).
    new AuditListener(bus, repos.audit, repos.base);
  }

  get auth(): AuthService {
    return (this._auth ??= new AuthService(
      this.repos.auth,
      this.repos.user,
      this.bus,
      this.dataPath
    ));
  }

  get user(): UserService {
    return (this._user ??= new UserService(
      this.repos.user,
      this.bus
    ));
  }

  get category(): CategoryService {
    return (this._category ??= new CategoryService(
      this.repos.category,
      this.repos.audit,
      this.bus
    ));
  }

  get product(): ProductService {
    return (this._product ??= new ProductService(
      this.repos.product,
      this.repos.category,
      this.repos.batch,
      this.bus,
      this.repos.settings
    ));
  }

  get batch(): BatchService {
    return (this._batch ??= new BatchService(
      this.repos.batch,
      this.repos.product,
      this.bus
    ));
  }

  get transaction(): TransactionService {
    return (this._transaction ??= new TransactionService(
      this.repos.transaction,
      this.repos.batch,
      this.repos.shift,
      this.repos.product,
      this.repos.base,
      this.bus,
      this.repos.settings,
      this.repos.audit
    ));
  }

  get shift(): ShiftService {
    return (this._shift ??= new ShiftService(
      this.repos.shift,
      this.bus
    ));
  }

  get expense(): ExpenseService {
    return (this._expense ??= new ExpenseService(
      this.repos.expense,
      this.repos.shift,
      this.bus,
      this.repos.settings
    ));
  }

  get heldSale(): HeldSaleService {
    return (this._heldSale ??= new HeldSaleService(
      this.repos.heldSale,
      this.bus
    ));
  }

  get report(): ReportService {
    return (this._report ??= new ReportService(
      this.repos.report
    ));
  }

  get dashboard(): DashboardService {
    return (this._dashboard ??= new DashboardService(
      this.repos.report
    ));
  }

  get audit(): AuditService {
    return (this._audit ??= new AuditService(
      this.repos.audit
    ));
  }

  get settings(): SettingsService {
    return (this._settings ??= new SettingsService(
      this.repos.settings,
      this.bus
    ));
  }

  get backup(): BackupService {
    return (this._backup ??= new BackupService(
      this.repos.backup,
      this.repos.audit,
      this.bus
    ));
  }

  get recurringExpense(): RecurringExpenseService {
    return (this._recurringExpense ??= new RecurringExpenseService(
      this.repos.recurringExpense,
      this.repos.expense,
      this.repos.settings,
      this.bus
    ));
  }

  get purchase(): PurchaseService {
    return (this._purchase ??= new PurchaseService(
      this.repos.purchase,
      this.repos.supplier,
      this.repos.base,
      this.bus,
      this.repos.product,
      this.repos.category,
    ));
  }

  get cycleCount(): CycleCountService {
    return (this._cycleCount ??= new CycleCountService(
      this.repos.cycleCount,
      this.repos.batch,
      this.bus
    ));
  }
}

// Re-export all services for convenience
export {
  AuthService,
  UserService,
  CategoryService,
  ProductService,
  BatchService,
  TransactionService,
  ShiftService,
  ExpenseService,
  HeldSaleService,
  ReportService,
  DashboardService,
  AuditService,
  SettingsService,
  BackupService,
  PurchaseService,
  RecurringExpenseService,
  CycleCountService,
};
