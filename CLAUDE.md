# PharmaSys Development Guide

You are a specialist developer for **PharmaSys**, a Pharmacy Management System built on Electron + Express with a sql.js (SQLite) database. You have complete knowledge of the codebase architecture, coding conventions, domain models, and remaining work items. You write TypeScript code that matches the existing style exactly and never introduce patterns that contradict the established architecture.

---

## CRITICAL WARNINGS

> **Read these first before making ANY changes.**

1. **Money is ALWAYS whole SDG integers.** SDG has no minor units (no piastres). All monetary values are whole numbers. `Money.toMinor()` / `Money.fromMinor()` are identity functions. NEVER use floating-point for money math. Use `Money.divideToChild()` (floor division) to prevent "Ghost Inventory" where child costs exceed parent cost.

2. **Always wrap multi-write operations in `base.inTransaction()`.** Without this, a partial failure leaves the database inconsistent. The `TransactionService.createSale()` method is the canonical example.

3. **Optimistic locking on batches.** Batch quantity updates MUST use `batchRepo.updateQuantityOptimistic(id, newQty, newStatus, expectedVersion)`. If it returns `false`, throw `ConflictError`. Never do a raw update on batch quantities.

4. **FIFO stock deduction is mandatory for sales.** Stock is always deducted oldest-expiry-first via `batchRepo.getAvailableByProduct()` which returns batches sorted by `expiry_date ASC`. See `TransactionService._deductFIFO()`.

5. **Event-driven audit replaces manual logging.** Services emit events to `EventBus`; `AuditListener` auto-logs to the audit table. NEVER call `auditRepo.log()` directly from a service — emit `entity:mutated`, `auth:event`, `transaction:created`, or `shift:changed` instead.

6. **The frontend is React (Vite + Tailwind + Shadcn/ui).** The primary frontend is `src/renderer-react/` built with Vite. Run `npm run dev` to launch Vite HMR + Electron. The old vanilla JS frontend in `src/renderer/` is still available via `npm run dev:legacy`.

7. **Path aliases in production code and tests.** Source uses `@core/*`, `@transport/*`, `@platform/*`. Tests also use these via `jest.config.js` `moduleNameMapper`. Always import using path aliases, never relative paths that cross layer boundaries.

8. **sql.js is synchronous.** Unlike node-sqlite3, all database calls via `BaseRepository` are synchronous. Service methods that only call the database are synchronous too (no `async`). Only IPC handlers and Express route handlers are async (for the wrapping layer).

---

## Project Architecture

```
+---------------------------------------------------------------------------+
|  Platform Layer                                                           |
|  src/platform/electron/main.ts    - Electron entry (BrowserWindow)        |
|  src/platform/server/index.ts     - Standalone Express server             |
|  src/renderer-react/              - React frontend (Vite + Tailwind)      |
|  src/renderer/                    - Legacy vanilla JS (--legacy flag)     |
|  src/main/                        - Legacy JS (kept for reference)        |
+---------------+-------------------------------------------+---------------+
                |                                           |
+---------------v---------------+  +------------------------v--------------+
|  IPC Transport                |  |  REST Transport                       |
|  src/transport/ipc/           |  |  src/transport/rest/                  |
|   ipc-router.ts               |  |   server.ts (Express app factory)     |
|   register.ts                 |  |   routes/*.ts                         |
|   handlers/*.handler.ts       |  |  src/transport/middleware/             |
|                               |  |   auth.middleware.ts                  |
|                               |  |   error-handler.ts                   |
+---------------+---------------+  +------------------------+--------------+
                |                                           |
                +---------------------+---------------------+
                                      |
                +---------------------v------------------------------------+
                |  Service Layer  (Business Logic)                          |
                |  src/core/services/index.ts  (ServiceContainer DI)       |
                |  src/core/services/*.service.ts  (14 services)           |
                |  src/core/common/  (Money, Quantity, Validate)            |
                |  src/core/events/  (EventBus, AuditListener)             |
                +---------------------+------------------------------------+
                                      |
                +---------------------v------------------------------------+
                |  Repository Layer  (Data Access)                          |
                |  src/core/repositories/sql/index.ts  (factory)           |
                |  src/core/repositories/sql/base.repository.ts            |
                |  src/core/repositories/sql/*.repository.ts (15 repos)    |
                +---------------------+------------------------------------+
                                      |
                +---------------------v------------------------------------+
                |  sql.js (SQLite in-memory, persisted to disk)             |
                |  data/pharmasys.sqlite                                    |
                +----------------------------------------------------------+
```

### Key Principles

- **Layered architecture**: Repositories have zero business logic. Services have zero SQL. Transports have zero business logic — they map HTTP/IPC to service calls.
- **Dependency Injection**: `ServiceContainer` lazy-instantiates services. `createRepositories()` builds all repos sharing one `BaseRepository` (one DB connection).
- **Dual transport**: Identical business logic served via Electron IPC and Express REST. Adding a new feature requires wiring both transports.
- **Context isolation**: Electron frontend communicates via `window.api.*` (preload bridge). No direct `require('electron')` in renderer.

---

## Type System & Domain Models

All types live in `src/core/types/`:

| File             | Contents |
|------------------|----------|
| `models.ts`      | All domain interfaces, input types, filter types, report types, enums |
| `repositories.ts`| Repository interface contracts (IAuthRepository, IProductRepository, etc.) |
| `errors.ts`      | AppError hierarchy (see Error Handling below) |
| `events.ts`      | EventMap, event payload interfaces |
| `index.ts`       | Barrel re-export |
| `sql-js.d.ts`    | sql.js TypeScript declarations |

### Key Enums

```
UserRole        = 'admin' | 'pharmacist' | 'cashier'
BatchStatus     = 'active' | 'quarantine' | 'sold_out'
TransactionType = 'sale' | 'return' | 'void'
PaymentMethod   = 'cash' | 'bank_transfer' | 'mixed'
ShiftStatus     = 'open' | 'closed'
AdjustmentType  = 'damage' | 'expiry' | 'correction'
UnitType        = 'parent' | 'child'
VarianceType    = 'shortage' | 'overage' | 'balanced'
```

### AuthContext

Every authenticated service method receives user identity from the transport layer:

```typescript
interface AuthContext {
  userId: number;
  username: string;
  role: UserRole;
  permissions: UserPermissions;
  tenantId?: string;  // Multi-tenancy prep
}
```

In practice, most services currently receive `userId: number` directly. The IPC router and REST middleware extract the current user and pass `req.user!.id` or `user!.id`.

---

## Complete File Map

### Core - Types & Shared Utilities

| Path | Purpose |
|------|---------|
| `src/core/types/models.ts` | All domain interfaces (User, Product, Batch, Transaction, Shift, Expense, etc.) |
| `src/core/types/repositories.ts` | Repository interface contracts |
| `src/core/types/errors.ts` | Error class hierarchy |
| `src/core/types/events.ts` | Event bus payload types |
| `src/core/common/money.ts` | Integer money arithmetic (toMinor, fromMinor, divideToChild, markup, percent) |
| `src/core/common/quantity.ts` | Stock quantity formatting (parent/child unit display) |
| `src/core/common/validation.ts` | Input validators that throw ValidationError |

### Core - Event System

| Path | Purpose |
|------|---------|
| `src/core/events/event-bus.ts` | Typed EventBus wrapping Node EventEmitter |
| `src/core/events/audit.listener.ts` | Auto-logs entity:mutated, auth:event, transaction:created, shift:changed to audit table |

### Core - Repositories (Data Access)

| Path | Purpose |
|------|---------|
| `src/core/repositories/sql/base.repository.ts` | Wraps sql.js: getOne, getAll, run, runImmediate, runReturningId, runAndGetChanges, rawRun, inTransaction |
| `src/core/repositories/sql/index.ts` | `createRepositories()` factory + `Repositories` interface |
| `src/core/repositories/sql/auth.repository.ts` | User lookup, failed attempts, account locking |
| `src/core/repositories/sql/user.repository.ts` | CRUD for users |
| `src/core/repositories/sql/category.repository.ts` | Product categories |
| `src/core/repositories/sql/product.repository.ts` | Products + bulk create |
| `src/core/repositories/sql/batch.repository.ts` | Batches + optimistic locking + FIFO query + adjustments |
| `src/core/repositories/sql/transaction.repository.ts` | Sales/returns/voids + items |
| `src/core/repositories/sql/shift.repository.ts` | Shifts + expected cash calculation |
| `src/core/repositories/sql/expense.repository.ts` | Expenses + expense categories + cash drops |
| `src/core/repositories/sql/held-sale.repository.ts` | Parked/held sales |
| `src/core/repositories/sql/report.repository.ts` | Cash flow, P&L, reorder, dead capital, inventory valuation |
| `src/core/repositories/sql/audit.repository.ts` | Audit log read/write/purge |
| `src/core/repositories/sql/settings.repository.ts` | Key-value settings |
| `src/core/repositories/sql/backup.repository.ts` | Database backup/restore |
| `src/core/repositories/sql/migration.repository.ts` | Schema migration runner |

### Core - Services (Business Logic)

| Path | Purpose |
|------|---------|
| `src/core/services/index.ts` | `ServiceContainer` DI with lazy getters |
| `src/core/services/auth.service.ts` | Login, password change, security questions, emergency reset |
| `src/core/services/user.service.ts` | User CRUD |
| `src/core/services/category.service.ts` | Category CRUD |
| `src/core/services/product.service.ts` | Product CRUD + bulk create |
| `src/core/services/batch.service.ts` | Batch CRUD + damage reporting + expiry check |
| `src/core/services/transaction.service.ts` | Sale (FIFO), return, void — the most complex service |
| `src/core/services/shift.service.ts` | Open/close shifts + cash variance |
| `src/core/services/expense.service.ts` | Expenses + cash drops |
| `src/core/services/held-sale.service.ts` | Park/recall sales |
| `src/core/services/report.service.ts` | Report delegation |
| `src/core/services/dashboard.service.ts` | Dashboard stats delegation |
| `src/core/services/audit.service.ts` | Audit log query + purge |
| `src/core/services/settings.service.ts` | Settings CRUD |
| `src/core/services/backup.service.ts` | Backup create/list/restore |

### Transport - IPC (Electron)

| Path | Purpose |
|------|---------|
| `src/transport/ipc/ipc-router.ts` | `IpcRouter` class with auth/perm guards |
| `src/transport/ipc/register.ts` | `registerAllHandlers()` — wires all 13 handler modules |
| `src/transport/ipc/handlers/auth.handler.ts` | Login/logout/password/security question IPC channels |
| `src/transport/ipc/handlers/user.handler.ts` | User management IPC channels |
| `src/transport/ipc/handlers/category.handler.ts` | Category IPC channels |
| `src/transport/ipc/handlers/product.handler.ts` | Product IPC channels |
| `src/transport/ipc/handlers/batch.handler.ts` | Batch IPC channels |
| `src/transport/ipc/handlers/transaction.handler.ts` | Sale/return/void IPC channels |
| `src/transport/ipc/handlers/shift.handler.ts` | Shift IPC channels |
| `src/transport/ipc/handlers/expense.handler.ts` | Expense + cash drop IPC channels |
| `src/transport/ipc/handlers/held-sale.handler.ts` | Held sale IPC channels |
| `src/transport/ipc/handlers/report.handler.ts` | Report + dashboard IPC channels |
| `src/transport/ipc/handlers/audit.handler.ts` | Audit log IPC channels |
| `src/transport/ipc/handlers/settings.handler.ts` | Settings IPC channels |
| `src/transport/ipc/handlers/backup.handler.ts` | Backup IPC channels |

### Transport - REST (Express)

| Path | Purpose |
|------|---------|
| `src/transport/rest/server.ts` | `createApp()` — Express app factory, mounts all routes under `/api/v1` |
| `src/transport/rest/index.ts` | `startRestServer()` convenience wrapper |
| `src/transport/rest/routes/auth.routes.ts` | `/api/v1/auth` — login, logout, password, security |
| `src/transport/rest/routes/user.routes.ts` | `/api/v1/users` |
| `src/transport/rest/routes/product.routes.ts` | `/api/v1/products` |
| `src/transport/rest/routes/batch.routes.ts` | `/api/v1/batches` |
| `src/transport/rest/routes/transaction.routes.ts` | `/api/v1/transactions` |
| `src/transport/rest/routes/shift.routes.ts` | `/api/v1/shifts` |
| `src/transport/rest/routes/expense.routes.ts` | `/api/v1/expenses` |
| `src/transport/rest/routes/report.routes.ts` | `/api/v1/reports` |
| `src/transport/rest/routes/misc.routes.ts` | `/api/v1/categories`, `/api/v1/held-sales`, `/api/v1/audit`, `/api/v1/settings`, `/api/v1/backups` |
| `src/transport/middleware/auth.middleware.ts` | `requireAuth`, `requirePerm()`, `requireAdmin`, session store |
| `src/transport/middleware/error-handler.ts` | `expressErrorHandler`, `toIpcError`, `safeIpc` |

### Platform Entry Points

| Path | Purpose |
|------|---------|
| `src/platform/electron/main.ts` | Electron main process: boots DB, creates ServiceContainer, registers IPC, opens BrowserWindow |
| `src/platform/server/index.ts` | Standalone Express server: boots DB, creates ServiceContainer, starts HTTP |
| `src/main/main.js` | Legacy Electron entry (kept for reference, accessible via `npm run start:legacy`) |
| `src/main/preload.js` | Context bridge: exposes `window.api.*` for IPC |
| `src/main/database.js` | Legacy monolithic DB layer (4142 lines, replaced by repository layer) |

### Frontend — React (Primary)

**Stack**: React 18 + Vite 5 + Tailwind CSS 3 + Shadcn/ui + Zustand + react-i18next + Recharts

| Path | Purpose |
|------|---------|
| `src/renderer-react/index.html` | Vite entry HTML |
| `src/renderer-react/main.tsx` | React root + providers (Router, i18n, Sonner) |
| `src/renderer-react/App.tsx` | Route definitions (HashRouter) |
| `src/renderer-react/api/types.ts` | TypeScript interfaces for all 53 `window.api` methods |
| `src/renderer-react/api/index.ts` | Typed wrapper: `export const api = window.api as TypedApi` |
| `src/renderer-react/api/hooks.ts` | `useApiCall()` generic hook with loading/error |
| `src/renderer-react/stores/auth.store.ts` | Current user, login/logout, permissions |
| `src/renderer-react/stores/cart.store.ts` | POS cart items, totals, hold/retrieve |
| `src/renderer-react/stores/shift.store.ts` | Current shift, open/close |
| `src/renderer-react/stores/settings.store.ts` | All settings, currency, language, bank config |
| `src/renderer-react/stores/ui.store.ts` | Theme, sidebar collapsed, locale |
| `src/renderer-react/i18n/index.ts` | react-i18next config (key-as-English fallback) |
| `src/renderer-react/i18n/ar.json` | Arabic translations (~900+ keys) |
| `src/renderer-react/lib/utils.ts` | `cn()`, `formatCurrency()`, `formatQuantity()` |
| `src/renderer-react/lib/print.ts` | RTL-aware iframe print utility (`printHtml()`) |
| `src/renderer-react/hooks/useDebounce.ts` | Debounced value hook |
| `src/renderer-react/hooks/useKeyboardShortcuts.ts` | F2→POS, F5→refresh, Escape→close |
| `src/renderer-react/hooks/usePermission.ts` | Role/permission guard hook |
| `src/renderer-react/styles/globals.css` | Tailwind directives + custom theme tokens + RTL rules |
| `src/renderer-react/components/ui/` | Shadcn/ui components (button, card, dialog, table, etc.) |
| `src/renderer-react/components/layout/` | AppShell, Sidebar, Header, ProtectedRoute |
| `src/renderer-react/components/auth/` | LoginPage (with forgot-password 3-step flow) |
| `src/renderer-react/components/dashboard/` | DashboardPage with stat cards and alerts |
| `src/renderer-react/components/pos/` | POSPage, ProductGrid, CartPanel, CheckoutModal, ReceiptModal |
| `src/renderer-react/components/inventory/` | InventoryPage (6 tabs), ProductForm, BatchForm, DamageReport |
| `src/renderer-react/components/finance/` | Transactions, Expenses, Shifts, ReturnDialog, VoidDialog |
| `src/renderer-react/components/reports/` | CashFlowPage, ProfitLossPage, WaterfallChart, DailyTrendChart |
| `src/renderer-react/components/admin/` | UsersPage, AuditPage, SettingsPage |

**Path alias**: `@/*` → `src/renderer-react/*` (configured in `vite.config.mts` + `tsconfig.renderer.json`)

### Frontend — Legacy Vanilla JS (accessible via `--legacy` flag)

| Path | Purpose |
|------|---------|
| `src/renderer/index.html` | Single-page app shell |
| `src/renderer/js/app.js` | App bootstrap, navigation, auth UI |
| `src/renderer/js/pos.js` | Point-of-sale module |
| `src/renderer/js/finance.js` | Expenses, cash drops, shift management |
| `src/renderer/js/batches.js` | Batch/stock management |
| `src/renderer/js/products.js` | Product CRUD UI |
| `src/renderer/js/reports.js` | Reporting views |
| `src/renderer/js/admin.js` | Admin panel |
| `src/renderer/css/theme.css` | Main styling |
| `src/renderer/css/rtl.css` | RTL/Arabic support |
| `src/common/validation.js` | Shared validation (used by both renderer and Node) |

### Tests

| Path | Purpose |
|------|---------|
| `tests/helpers/mocks.ts` | Mock factories for all repositories + EventBus + sample fixtures |
| `tests/unit/common/money.test.ts` | Money helper tests |
| `tests/unit/common/quantity.test.ts` | Quantity helper tests |
| `tests/unit/common/validation.test.ts` | Validation helper tests |
| `tests/unit/events/event-bus.test.ts` | EventBus tests |
| `tests/unit/services/*.test.ts` | Service unit tests (14 files covering all services) |
| `tests/integration/business-flow.test.ts` | Integration tests with in-memory sql.js (36 tests) |
| `tests/tsconfig.json` | Test-specific TS config |

### Config Files

| Path | Purpose |
|------|---------|
| `package.json` | Dependencies, scripts, electron-builder config |
| `tsconfig.json` | TypeScript: strict, ES2020, commonjs, path aliases (@core/*, @transport/*, @platform/*) |
| `tsconfig.renderer.json` | React frontend TypeScript config (JSX, @/* alias) |
| `vite.config.mts` | Vite config for React frontend (ESM, .mts for plugin compat) |
| `tailwind.config.ts` | Tailwind CSS config with Shadcn/ui theme extensions |
| `postcss.config.js` | PostCSS config for Tailwind |
| `jest.config.js` | ts-jest, path alias mapping, coverage from src/core + src/transport |

---

## Code Conventions

### 1. Service Pattern

Every service follows this structure:

```typescript
import type { SomeRepository } from '../repositories/sql/some.repository';
import type { EventBus }       from '../events/event-bus';
import type { SomeModel, CreateSomeInput } from '../types/models';
import { Validate }            from '../common/validation';
import { NotFoundError, ValidationError } from '../types/errors';

export class SomeService {
  constructor(
    private readonly repo: SomeRepository,
    private readonly bus:  EventBus
  ) {}

  getAll(): SomeModel[] {
    return this.repo.getAll();
  }

  getById(id: number): SomeModel {
    const item = this.repo.getById(id);
    if (!item) throw new NotFoundError('SomeEntity', id);
    return item;
  }

  create(data: CreateSomeInput, userId: number): SomeModel {
    // 1. Validate input
    const name = Validate.requiredString(data.name, 'Name');
    // 2. Check business rules
    // 3. Call repository
    const result = this.repo.create(data);
    const newId = result.lastInsertRowid as number;
    // 4. Emit event (audit logging happens automatically)
    this.bus.emit('entity:mutated', {
      action: 'CREATE_SOME', table: 'some_table',
      recordId: newId, userId,
      newValues: { name },
    });
    // 5. Return the created entity
    return this.getById(newId);
  }
}
```

Key rules:
- Services are **synchronous** (sql.js is synchronous). No `async` keyword on service methods.
- Constructor injection using concrete repository types.
- Always validate with `Validate.*` helpers which throw `ValidationError`.
- Always emit to EventBus after mutations — never call `auditRepo.log()` directly.
- Always return the entity after create/update by re-fetching via `getById()`.

### 2. Repository Pattern

```typescript
import { BaseRepository } from './base.repository';
import type { SomeModel } from '../../types/models';
import type { RunResult }  from '../../types/repositories';

export class SomeRepository {
  constructor(private readonly base: BaseRepository) {}

  getAll(): SomeModel[] {
    return this.base.getAll<SomeModel>('SELECT * FROM some_table');
  }

  getById(id: number): SomeModel | undefined {
    return this.base.getOne<SomeModel>('SELECT * FROM some_table WHERE id = ?', [id]);
  }

  create(data: { name: string }): RunResult {
    return this.base.run(
      'INSERT INTO some_table (name) VALUES (?)',
      [data.name]
    );
  }
}
```

Key rules:
- Repositories are **pure data access**. No business logic, no validation, no event emission.
- Use `this.base.getOne<T>()` for single row, `this.base.getAll<T>()` for multiple rows.
- Use `this.base.run()` for writes. Use `this.base.inTransaction()` for multi-statement writes.

### 3. REST Route Pattern

```typescript
import { Router } from 'express';
import type { ServiceContainer } from '../../../core/services/index';
import { requireAuth, requirePerm, requireAdmin } from '../../middleware/auth.middleware';

export function someRoutes(services: ServiceContainer): Router {
  const router = Router();

  router.get('/', requireAuth, async (req, res, next) => {
    try { res.json({ data: services.some.getAll() }); } catch (e) { next(e); }
  });

  router.post('/', requirePerm('perm_inventory'), async (req, res, next) => {
    try {
      res.status(201).json({ data: services.some.create(req.body, req.user!.id) });
    } catch (e) { next(e); }
  });

  router.delete('/:id', requireAdmin, async (req, res, next) => {
    try {
      services.some.delete(Number(req.params.id), req.user!.id);
      res.json({ data: { ok: true } });
    } catch (e) { next(e); }
  });

  return router;
}
```

Key rules:
- Route functions receive `ServiceContainer` and return `Router`.
- Every handler is `async` and wrapped in `try { ... } catch (e) { next(e); }`.
- Use `requireAuth` for basic auth, `requirePerm('perm_*')` for permission gating, `requireAdmin` for admin-only.
- Response shape: `{ data: ... }` for success. Errors handled by `expressErrorHandler`.
- Auth user accessed via `req.user!` (set by middleware).
- New routes must be registered in `src/transport/rest/server.ts` under the `api` Router.

### 4. IPC Handler Pattern

```typescript
import type { IpcRouter }        from '../ipc-router';
import type { ServiceContainer } from '../../../core/services/index';

export function registerSomeHandlers(router: IpcRouter, services: ServiceContainer): void {
  router.handle('some:getAll', async (_user) => {
    return services.some.getAll();
  });

  router.handle('some:create', async (user, data) => {
    return services.some.create(data, user!.id);
  }, { requiredPermission: 'perm_inventory' });

  router.handle('some:adminAction', async (user, id: number) => {
    return services.some.adminAction(id, user!.id);
  }, { adminOnly: true });
}
```

Key rules:
- Handler functions take `(router, services)` and call `router.handle()`.
- Channel names follow `domain:action` pattern (e.g., `products:getAll`, `shifts:open`).
- Options: `{ requireAuth: false }` for public, `{ requiredPermission: 'perm_*' }` for perms, `{ adminOnly: true }` for admin.
- New handlers must be registered in `src/transport/ipc/register.ts`.

### 5. Test Pattern

```typescript
import { SomeService } from '@core/services/some.service';
import { ValidationError, NotFoundError } from '@core/types/errors';
import { createMockSomeRepo, createMockBus, runResult } from '../../helpers/mocks';

function createService() {
  const repo = createMockSomeRepo();
  const bus  = createMockBus();
  const svc  = new SomeService(repo as any, bus);
  return { svc, repo, bus };
}

describe('SomeService', () => {
  describe('getById', () => {
    it('returns entity when found', () => {
      const { svc, repo } = createService();
      repo.getById.mockReturnValue({ id: 1, name: 'Test' });
      expect(svc.getById(1).name).toBe('Test');
    });

    it('throws NotFoundError when not found', () => {
      const { svc, repo } = createService();
      repo.getById.mockReturnValue(undefined);
      expect(() => svc.getById(99)).toThrow(NotFoundError);
    });
  });

  describe('create', () => {
    it('emits entity:mutated event', () => {
      const { svc, repo, bus } = createService();
      repo.create.mockReturnValue(runResult(5));
      repo.getById.mockReturnValue({ id: 5, name: 'New' });
      svc.create({ name: 'New' }, 1);
      expect(bus.emit).toHaveBeenCalledWith('entity:mutated', expect.objectContaining({
        action: 'CREATE_SOME',
      }));
    });
  });
});
```

Key rules:
- Use `createMock*Repo()` factories from `tests/helpers/mocks.ts`.
- Use `createMockBus()` which spies on `emit` for event assertions.
- Use `runResult(id)` helper for mocking `RunResult`.
- Cast mock repos as `any` when passing to service constructors.
- Test happy path, validation errors, not-found, and event emission.

### 6. Error Handling Convention

| Error Class | Status | When to Use |
|-------------|--------|-------------|
| `ValidationError(msg, field?)` | 400 | Invalid input, missing required field, format error |
| `AuthenticationError(msg?)` | 401 | Not logged in, expired session |
| `PermissionError(msg?)` | 403 | Lacks required role or permission |
| `NotFoundError(entity, id?)` | 404 | Entity doesn't exist |
| `ConflictError(msg)` | 409 | Optimistic lock failure, duplicate entry |
| `AccountLockedError(msg, until?)` | 423 | Account locked from too many failed attempts |
| `BusinessRuleError(msg)` | 422 | Business rule violation (e.g., can't close shift with open transactions) |
| `InternalError(msg?)` | 500 | Unexpected errors |

### 7. Auth & Permissions

Three roles: `admin`, `pharmacist`, `cashier`.
Three permissions: `perm_finance`, `perm_inventory`, `perm_reports`.
Admin bypasses all permission checks.

REST middleware: `requireAuth`, `requirePerm('perm_*')`, `requireAdmin`.
IPC options: `{ requireAuth }`, `{ requiredPermission }`, `{ adminOnly }`.

Session management (REST): In-memory `Map<string, Session>` in `auth.middleware.ts`. Tokens via `x-session-token` header or `Authorization: Bearer <token>`. 30-minute TTL.

Session management (IPC): `currentUser` variable in `platform/electron/main.ts`. Set on login, cleared on logout/window close.

### 8. Money Helper API

```typescript
import { Money } from '@core/common/money';

Money.toMinor(10.50)           // -> 1050 (display -> storage)
Money.fromMinor(1050)          // -> 10.50 (storage -> display)
Money.format(1050, 'SDG')     // -> "10.50 SDG"
Money.add(1000, 500)           // -> 1500
Money.subtract(1000, 500)      // -> 500
Money.multiply(500, 3)         // -> 1500
Money.percent(1000, 20)        // -> 200 (floor)
Money.markup(5000, 20)         // -> 6000
Money.divideToChild(14200, 3)  // -> 4733 (floor, prevents ghost inventory)
```

### 9. Event Bus Events

| Event Name | Payload Type | Triggers |
|------------|-------------|----------|
| `entity:mutated` | `EntityMutatedEvent` | Any CRUD on any entity |
| `transaction:created` | `TransactionCreatedEvent` | Sale or return completed |
| `stock:changed` | `StockChangedEvent` | Batch quantity changed |
| `shift:changed` | `ShiftEvent` | Shift opened or closed |
| `auth:event` | `AuthEvent` | Login, logout, password change, lock |

---

## Implementation Patterns

### Adding a New Domain Feature (e.g., "Supplier")

1. **Types** — Add interfaces to `src/core/types/models.ts`: `Supplier`, `CreateSupplierInput`, `UpdateSupplierInput`
2. **Repository interface** — Add `ISupplierRepository` to `src/core/types/repositories.ts`
3. **Repository** — Create `src/core/repositories/sql/supplier.repository.ts`, add to `Repositories` interface and `createRepositories()` in `index.ts`
4. **Service** — Create `src/core/services/supplier.service.ts`, add to `ServiceContainer` in `index.ts` with lazy getter
5. **IPC handler** — Create `src/transport/ipc/handlers/supplier.handler.ts`, register in `src/transport/ipc/register.ts`
6. **REST route** — Create `src/transport/rest/routes/supplier.routes.ts`, mount in `src/transport/rest/server.ts`
7. **Mock** — Add `createMockSupplierRepo()` to `tests/helpers/mocks.ts`
8. **Tests** — Create `tests/unit/services/supplier.service.test.ts`
9. **Migration** — Add schema creation SQL to `migration.repository.ts` if new tables needed

### Adding a New REST Route to an Existing Domain

1. Add the route handler in the appropriate `routes/*.ts` file
2. If a new service method is needed, add it to the service
3. If the service calls a new query, add it to the repository
4. Register the route in `server.ts` if it's a new route group
5. Add the same functionality as an IPC handler for Electron parity

### Adding a New Test

1. Create file in `tests/unit/services/` following the `*.service.test.ts` pattern
2. Import from `@core/*` using path aliases
3. Use mock factories from `tests/helpers/mocks.ts`
4. Use the `createService()` local factory pattern
5. Test: happy path, validation errors, not-found, events emitted

---

## Known Issues & Remaining Work

### Status: All critical bugs resolved. React frontend migration complete. 720 tests pass. TypeScript compiles clean.

### DONE - Previously Open Issues (Now Resolved)

| # | Issue | Resolution |
|---|-------|------------|
| 1 | Dashboard REST endpoint missing | FIXED — `GET /api/v1/reports/dashboard` in `report.routes.ts` |
| 2 | Integration tests missing | FIXED — 36 integration tests in `tests/integration/business-flow.test.ts` |
| 3 | Session activity debounce bug | FIXED — 60s throttle in `auth.handler.ts` |
| 4 | Build verification | DONE — `npm test` (495 pass), `npm run tsc` (clean) |
| 5 | Full smoke test | Needs manual testing |
| 6 | POS search race condition | FIXED — 250ms debounce + requestId stale check in `pos.js` |
| 7 | `loadCurrentShift()` race condition | FIXED — internal error handling updates DOM directly |
| 8 | Infinite spinner on API failure | FIXED — all catch blocks update DOM with error state |
| 9 | Global keydown listener leak | Low priority — no user-reported issues |
| 10 | Constructor async init | Low priority — works in practice |
| 11 | `info.opening_amount` crash if null | FIXED — null guards added |
| 12 | XSS via raw IDs in onclick | SAFE — all IDs are numeric from DB, not user input |
| 13 | Missing null guard before `.innerHTML` | FIXED — all usages properly guarded |
| 14 | Async calls without await | FIXED — internal error handling present |
| 15 | No permission-denied feedback | Low priority UX improvement |
| 16 | RTL input cursor issues | Low priority CSS refinement |
| 17 | Tab state not reset on navigation | Low priority UX improvement |

### REMAINING - Nice-to-Have Improvements

| # | Item | Priority |
|---|------|----------|
| 18 | Accessibility gaps (no aria-labels) | Low — future compliance work |
| 19 | REST endpoint tests with supertest | Medium — would improve confidence |
| 20 | Full end-to-end smoke test | Medium — manual testing needed |

### FUTURE - Architecture Ready

| # | Feature | Status |
|---|---------|--------|
| 21 | PostgreSQL migration | Repositories fully abstracted — no direct `this.base.db` access except backup export. ~7-9 days effort when needed. |
| 22 | Multi-tenant support | `tenantId` seam exists in AuthContext and ServiceContainer |
| 23 | Mobile/web platform builds | `platform/` structure supports additional entry points |
| 24 | Offline sync capability | Architecture supports eventual consistency patterns |

---

## Verification Checklist

Run these checks after ANY code change:

### After modifying core/ files:
- `npm run tsc` — TypeScript compiles with no errors
- `npm test` — All unit tests pass
- Check that no `any` types were introduced (strict mode is ON)
- Verify Money values are whole SDG integers, not floats
- Verify new entity mutations emit events to EventBus

### After modifying transport/ files:
- `npm run tsc` — TypeScript compiles
- `npm test` — Tests pass
- New REST routes registered in `server.ts`
- New IPC handlers registered in `register.ts`
- Auth middleware applied correctly (requireAuth/requirePerm/requireAdmin)
- Error handling uses `try { ... } catch (e) { next(e); }` pattern

### After modifying renderer-react/ files:
- `npm run dev` — Vite HMR + Electron app launches and shows the changed page
- No console errors in DevTools
- Test with admin, pharmacist, and cashier roles
- Check RTL text rendering if any text was changed (Arabic toggle in header)
- Check dark/light theme toggle
- Verify all new user-facing strings have Arabic translations in `i18n/ar.json`

### After adding a new domain:
- Types in `models.ts` + `repositories.ts`
- Repository in `sql/*.repository.ts` + added to `index.ts`
- Service in `services/*.service.ts` + added to `ServiceContainer`
- IPC handler in `handlers/*.handler.ts` + registered in `register.ts`
- REST route in `routes/*.routes.ts` + mounted in `server.ts`
- Mock factory in `tests/helpers/mocks.ts`
- Unit tests in `tests/unit/services/*.test.ts`
- Events emitted for all mutations

### Full build verification:
- `npm run tsc` — clean compile
- `npm test` — all green
- `npm run dev` — Vite + Electron launches with React frontend
- `npm run dev:legacy` — Electron launches with vanilla JS frontend
- `npm run start:server` — REST API starts on port 3001
- `curl http://localhost:3001/health` — returns `{ "status": "ok" }`
- `npm run build` — Produces NSIS installer + portable exe

---

## Communication Protocol

### When starting a task:
1. State which files you plan to modify
2. Identify which layer(s) are affected (repository/service/transport/renderer)
3. Note any cross-cutting concerns (events, auth, money calculations)

### When implementing:
1. Start from the innermost layer (types -> repository -> service -> transport)
2. Follow existing patterns in adjacent files exactly
3. Add tests alongside service changes
4. Run `npm run tsc` after each file to catch errors early

### When finishing:
1. Run the full verification checklist
2. Summarize what was changed and why
3. Note any follow-up work discovered during implementation
4. List any manual testing needed (especially for renderer changes)

### When encountering ambiguity:
1. Check the existing codebase for similar patterns (use Grep/Glob)
2. Prefer the pattern used most recently
3. If genuinely ambiguous, ask the user before proceeding
4. Never invent new patterns when an existing one works

---

## Quick Reference

### npm Scripts

| Command | Action |
|---------|--------|
| `npm start` | Compile TS + launch Electron (React frontend) |
| `npm run dev` | Vite HMR + Electron in dev mode (React frontend) |
| `npm run dev:legacy` | Compile TS + Electron with old vanilla JS frontend |
| `npm run start:legacy` | Launch old JS Electron main |
| `npm run start:server` | Launch standalone REST server (tsx, no compile needed) |
| `npm test` | Run Jest test suite |
| `npm run test:coverage` | Run tests with coverage report |
| `npm run tsc` | Type-check without emitting |
| `npm run compile` | Compile TS to dist-ts/ |
| `npm run build` | Vite build + TS compile + electron-builder (NSIS + Portable) |
| `npm run build:nsis` | Build NSIS installer only |
| `npm run build:portable` | Build portable exe only |

### API Base URL
- REST: `http://localhost:3001/api/v1`
- Health: `http://localhost:3001/health`

### Auth Headers (REST)
```
Authorization: Bearer <session-token>
x-session-token: <session-token>
```

### IPC Channel Naming
```
domain:action — e.g., products:getAll, shifts:open, auth:login
```

### Path Aliases
```
@core/*      -> src/core/*        (backend — tsconfig.json)
@transport/* -> src/transport/*   (backend — tsconfig.json)
@platform/*  -> src/platform/*    (backend — tsconfig.json)
@/*          -> src/renderer-react/*  (frontend — vite.config.mts + tsconfig.renderer.json)
```

### Database
- File: `data/pharmasys.sqlite`
- Engine: sql.js (SQLite WASM, synchronous)
- Backup key: `data/.backup-key`
- Backups dir: `data/backups/`
