/**
 * PostgreSQL repository factory — assembles all domain repositories
 * around a shared PgBaseRepository.
 *
 * Domain repos are identical to the sql.js versions — only the
 * BaseRepository implementation changes.
 */

import type { Pool } from 'pg';
import { PgBaseRepository }      from './base.repository';
import { PgBackupRepository }    from './backup.repository';
import { AuthRepository }        from '../sql/auth.repository';
import { UserRepository }        from '../sql/user.repository';
import { CategoryRepository }    from '../sql/category.repository';
import { ProductRepository }     from '../sql/product.repository';
import { BatchRepository }       from '../sql/batch.repository';
import { TransactionRepository } from '../sql/transaction.repository';
import { ShiftRepository }       from '../sql/shift.repository';
import { ExpenseRepository }     from '../sql/expense.repository';
import { HeldSaleRepository }    from '../sql/held-sale.repository';
import { ReportRepository }      from '../sql/report.repository';
import { AuditRepository }       from '../sql/audit.repository';
import { SettingsRepository }    from '../sql/settings.repository';

/**
 * Repositories interface — matches the sql.js `Repositories` shape
 * so ServiceContainer works unchanged.
 */
export interface PgRepositories {
  base:        PgBaseRepository;
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
  backup:      PgBackupRepository;
}

/**
 * Create all repositories backed by a PostgreSQL connection pool.
 *
 * Domain repos are constructed with `PgBaseRepository as any` because
 * they type their constructor param as the sql.js `BaseRepository`.
 * Structurally compatible (same method signatures) — safe at runtime.
 */
export function createPgRepositories(
  pool: Pool,
  connectionString: string,
  dataPath: string
): PgRepositories {
  const base     = new PgBaseRepository(pool);
  const settings = new SettingsRepository(base as any);
  const audit    = new AuditRepository(base as any);
  const report   = new ReportRepository(
    base as any,
    (key: string): Promise<string | null> => settings.get(key),
  );
  const backup   = new PgBackupRepository(connectionString, dataPath);

  return {
    base,
    auth:        new AuthRepository(base as any),
    user:        new UserRepository(base as any),
    category:    new CategoryRepository(base as any),
    product:     new ProductRepository(base as any),
    batch:       new BatchRepository(base as any),
    transaction: new TransactionRepository(base as any),
    shift:       new ShiftRepository(base as any),
    expense:     new ExpenseRepository(base as any),
    heldSale:    new HeldSaleRepository(base as any),
    report,
    audit,
    settings,
    backup,
  };
}

export { PgBaseRepository, PgBackupRepository };
