/**
 * Repository factory — assembles all repositories around a shared BaseRepository.
 * All repos share the same db connection and can participate in the same transaction.
 */

import { BaseRepository, type SqlJsDatabase } from './base.repository';
import { AuthRepository }        from './auth.repository';
import { UserRepository }        from './user.repository';
import { CategoryRepository }    from './category.repository';
import { ProductRepository }     from './product.repository';
import { BatchRepository }       from './batch.repository';
import { TransactionRepository } from './transaction.repository';
import { ShiftRepository }       from './shift.repository';
import { ExpenseRepository }     from './expense.repository';
import { HeldSaleRepository }    from './held-sale.repository';
import { ReportRepository }      from './report.repository';
import { AuditRepository }       from './audit.repository';
import { SettingsRepository }    from './settings.repository';
import { BackupRepository }      from './backup.repository';
import { SupplierRepository }    from './supplier.repository';
import { PurchaseRepository }    from './purchase.repository';

export interface Repositories {
  base:        BaseRepository;
  auth:        AuthRepository;
  user:        UserRepository;
  category:    CategoryRepository;
  product:     ProductRepository;
  batch:       BatchRepository;
  transaction: TransactionRepository;
  shift:       ShiftRepository;
  expense:     ExpenseRepository;
  heldSale:    HeldSaleRepository;
  report:      ReportRepository;
  audit:       AuditRepository;
  settings:    SettingsRepository;
  backup:      BackupRepository;
  supplier:    SupplierRepository;
  purchase:    PurchaseRepository;
}

export function createRepositories(
  db: SqlJsDatabase,
  dataPath: string,
  saveFn: () => void,
  scheduleSaveFn: () => void
): Repositories {
  const base     = new BaseRepository(db, saveFn, scheduleSaveFn);
  const settings = new SettingsRepository(base);
  const audit    = new AuditRepository(base);
  const report   = new ReportRepository(base, (key: string): Promise<string | null> => settings.get(key));

  const backup = new BackupRepository(
    base,
    dataPath,
    () => db,
    (_newDb: SqlJsDatabase) => { /* handled at platform level */ }
  );

  return {
    base,
    auth:        new AuthRepository(base),
    user:        new UserRepository(base),
    category:    new CategoryRepository(base),
    product:     new ProductRepository(base),
    batch:       new BatchRepository(base),
    transaction: new TransactionRepository(base),
    shift:       new ShiftRepository(base),
    expense:     new ExpenseRepository(base),
    heldSale:    new HeldSaleRepository(base),
    report,
    audit,
    settings,
    backup,
    supplier:    new SupplierRepository(base),
    purchase:    new PurchaseRepository(base),
  };
}

// Re-export all repository classes
export {
  BaseRepository,
  AuthRepository,
  UserRepository,
  CategoryRepository,
  ProductRepository,
  BatchRepository,
  TransactionRepository,
  ShiftRepository,
  ExpenseRepository,
  HeldSaleRepository,
  ReportRepository,
  AuditRepository,
  SettingsRepository,
  BackupRepository,
  SupplierRepository,
  PurchaseRepository,
};
