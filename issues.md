# PharmaSys — Comprehensive Bug & Issue Audit

> Full-system audit performed on **2026-06-20**. Issues sorted by severity.
>
> **Superseded for new work.** A second-generation audit was performed on **2026-08-14** —
> see [SYSTEM-AUDIT-2026-08.md](SYSTEM-AUDIT-2026-08.md) (52 findings, none duplicated from
> this file, with a deep dive on product/transaction history and POS performance).
> This document remains the record of the 2026-06-20 pass and its resolutions; the
> still-open items listed at the bottom (#9, #23, #27, #30, #40b) are carried forward there.

---

## 🔴 CRITICAL — Data Loss / Corruption Risk

### 1. Emergency Reset Uses Hardcoded `process.cwd()` — Wrong Path in Production
**File:** [auth.service.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/auth.service.ts#L240-L241)

```typescript
const dataDir = path.join(process.cwd(), 'data');
const tokenFilePath = path.join(dataDir, '.emergency-reset-token');
```

`process.cwd()` is unreliable in Electron packaged apps — it resolves to the system directory (e.g., `C:\Windows\System32`), NOT the app's data directory. The emergency reset feature **silently fails in production** because the token file is never found.

> [!CAUTION]
> Should use the same `dataPath` resolution as `main.ts` (via `app.getPath('userData')`) injected through the service constructor.

---

### 2. `backup.repository.restore()` Signature Mismatch — Extra Parameters Ignored
**File:** [backup.repository.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/repositories/sql/backup.repository.ts#L193)

The `restore()` method signature is:
```typescript
async restore(filename: string): Promise<void>
```

But [main.ts:628](file:///d:/Noon/wroking%20code/PharmaSys/src/platform/electron/main.ts#L628) calls it with **3 arguments**:
```typescript
await services!.backup.restore(tmpFilename, currentUser?.id ?? 0, finalFilename);
```

The extra `userId` and `finalFilename` arguments are silently dropped. The **backup is restored from `tmpFilename`**, but the `fs.renameSync()` on line 631 then renames the temp file to the final name **after** the DB was already reopened from it — this can corrupt the open DB file handle on Windows (rename of an open file).

---

### 3. `deletePurchaseItem` Doesn't Run Inside a Transaction
**File:** [purchase.service.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/purchase.service.ts#L1401-L1460)

`deletePurchaseItem()` performs multiple related DB writes (delete item, delete/update batch, update totals, insert adjustment) but does **NOT** wrap them in `this.base.inTransaction()`. If any intermediate step fails (e.g., batch update), the purchase total is already modified but items are left in an inconsistent state.

Compare with `deletePurchase()` (line 386) which correctly uses a transaction.

---

### 4. `updatePurchaseItem` Doesn't Run Inside a Transaction
**File:** [purchase.service.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/purchase.service.ts#L1306-L1399)

Same issue as above — `updatePurchaseItem()` modifies purchase_items, batches, and purchase totals across multiple queries without transaction protection.

---

### 5. Product Name Merging Still Silently Merges New Products
**File:** [purchase.service.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/purchase.service.ts#L978-L983)

```typescript
let existingProduct = np.barcode
  ? await this.productRepo.findByBarcode(np.barcode)
  : undefined;
if (!existingProduct) {
  existingProduct = await this.productRepo.findByName(np.name);
}
```

As documented in [issues.txt](file:///d:/Noon/wroking%20code/PharmaSys/issues.txt) (Issue 2D), when a new product name matches an existing product, the batch silently merges. This can attach inventory to the **wrong product** (e.g., "Peprasol 20mg" vs "Peprasol 40mg"). No user confirmation is requested.

---

## 🟠 HIGH — Logic Errors / Incorrect Behavior

### 6. `DeviceSetupWizard` Always Renders for Standalone Mode — Blocks Normal App
**File:** [App.tsx](file:///d:/Noon/wroking%20code/PharmaSys/src/renderer-react/App.tsx#L178-L192)

```typescript
if (deviceMode === 'standalone') {
  return (
    <DirectionProvider dir={dir}>
      <DeviceSetupWizard />
      ...
    </DirectionProvider>
  );
}
```

The default device mode is `'standalone'`. This means **every fresh install** and **every restart** where the config file doesn't exist shows the setup wizard **instead of the login page**. Users on standalone mode can never reach the normal app flow unless the wizard internally handles completion. If the wizard has any bugs, the entire app is inaccessible.

---

### 7. `autoCloseStale` Emits Wrong `actualCash` Value
**File:** [shift.service.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/shift.service.ts#L241-L246)

```typescript
await this.repo.close(shiftId, {
  actual_cash: expected.expected_cash,  // ← closes with expected_cash
  ...
});
this.bus.emit('shift:changed', {
  actualCash: 0,  // ← but emits 0
  expectedCash: expected.expected_cash,
  variance: 0,
});
```

The shift is closed with `actual_cash = expected_cash` but the event emits `actualCash: 0`. Any listener relying on this event (e.g., reporting, audit log) will record the wrong amount.

---

### 8. `enrichItem` Monthly Amount Calculation Wrong for Daily Items
**File:** [recurring-expense.service.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/recurring-expense.service.ts#L11-L15)

```typescript
function enrichItem(item: RecurringExpense): RecurringExpense {
  const daily  = item.amount_type === 'daily'   ? item.amount : null;
  const monthly = item.amount_type === 'monthly' ? item.amount : item.amount * 30;
  return { ...item, daily_amount: daily ?? undefined, monthly_amount: monthly };
}
```

For daily items, `monthly_amount = amount * 30` is a rough approximation. More importantly, the monthly estimate doesn't account for variable month lengths (28–31 days). The dashboard/report may show misleading projected costs.

---

### 9. `_createBatch` Stores `quantity_base = quantity × conversionFactor` — Double-Counted
**File:** [purchase.service.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/purchase.service.ts#L1133)

```typescript
const quantityBase = item.quantity * conversionFactor;
```

If `item.quantity` is already in parent units and the batch stores base (child) units, this is correct. However, `addItemsToPurchase()` (line 428) calculates the additional total as:
```typescript
const additionalTotal = items.reduce(
  (sum, it) => sum + Money.round(it.quantity * it.cost_per_parent), 0
);
```
This uses `quantity × cost_per_parent` directly — consistent. But if the frontend passes `quantity` in child units (strips), the batch quantity and purchase total will be inconsistent.

---

### 10. Missing `last_generated_date` Update in `generateForMissedDays`
**File:** [recurring-expense.service.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/recurring-expense.service.ts#L273-L318)

After generating expense entries for a recurring item, the method **never updates `last_generated_date`** on the recurring_expenses row. It relies solely on the existence check (`getGeneratedDates`). This works for idempotency but means:
- `_getItemSinceDate()` always falls back to checking the DB
- Performance degrades linearly as more dates are generated
- The `last_generated_date` column in the DB is always stale/null

---

### 11. `Validate.id()` Accepts Only `number` Type — Frontend May Send Strings
**File:** [validation.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/common/validation.ts#L52-L57)

```typescript
id(val: unknown, fieldName = 'ID'): number {
  if (typeof val !== 'number' || !Number.isInteger(val) || val <= 0) {
    throw new ValidationError(`Invalid ${fieldName}`, fieldName);
  }
  return val;
}
```

Strict `typeof val !== 'number'` check rejects string IDs like `"42"` which can arrive from URL params, form inputs, or REST query strings. This causes silent failures when the frontend sends numeric strings.

---

### 12. Shift Close — User Can Only Close Their Own Shift, Even Admin
**File:** [shift.service.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/shift.service.ts#L110-L112)

```typescript
if (shift.user_id !== userId) {
  throw new ValidationError('You can only close your own shift', 'shift');
}
```

The `close()` method blocks ALL users, including admins. Admins must use the separate `forceClose()` method. But the `close()` method doesn't check user role — an admin calling the regular close endpoint gets rejected. This can be confusing.

---

## 🟡 MEDIUM — Missing Validations / Edge Cases

### 13. `backup:restoreFromFile` — Path Traversal Vulnerability
**File:** [main.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/platform/electron/main.ts#L608-L639)

The restore handler copies any user-selected file into the backup directory and then passes `tmpFilename` (just a basename) to `services.backup.restore()`. However, `selectedFile` from the OS file picker is trusted, so this is low risk. But the `backup:saveAs` handler (line 583) does validate `resolvedSource` against `backupDir` — the asymmetry is concerning.

---

### 14. `deletePayment` Doesn't Check If Payment Is Paid Before Deleting
**File:** [purchase.service.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/purchase.service.ts#L1249-L1268)

```typescript
async deletePayment(paymentId: number, userId: number): Promise<void> {
  const payment = await this.purchaseRepo.getPaymentById(paymentId);
  if (!payment) throw new NotFoundError('Payment', paymentId);
  await this.purchaseRepo.deletePayment(paymentId);
  ...
}
```

A paid payment (with `is_paid = 1`) can be deleted without warning. This silently removes the record of an actual money transfer, corrupting the purchase payment status and financial records.

---

### 15. `BatchService.reportDamage` Uses `repo.inTransaction` — Wrong Base
**File:** [batch.service.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/batch.service.ts#L227)

```typescript
return await this.repo.inTransaction(async () => { ... });
```

`this.repo` is `BatchRepository` which likely delegates to its own `BaseRepository`. But the `TransactionService` and `PurchaseService` use `this.base.inTransaction()`. If the `BatchRepository` wraps a different `BaseRepository` instance (not the shared one), this transaction won't queue properly with other transactions.

> [!NOTE]
> Need to verify that `BatchRepository.inTransaction()` delegates to the same shared `BaseRepository._txQueue`.

---

### 16. `IpcRouter` Serializes All Arguments for Size Check — Performance Issue
**File:** [ipc-router.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/transport/ipc/ipc-router.ts#L58-L62)

```typescript
const payloadSize = JSON.stringify(args).length;
if (payloadSize > 1_048_576) { ... }
```

`JSON.stringify(args)` is called on **every single IPC call** before the handler runs. For large payloads (e.g., PDF buffers, inventory lists), this creates a full copy of the data in memory just for a size check. The PDF handler passes `ArrayBuffer` which may not even serialize properly with `JSON.stringify`.

---

### 17. Missing Barcode Uniqueness Validation
**File:** [purchase.service.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/purchase.service.ts#L938-L943)

When updating an existing product's barcode:
```typescript
if (item.barcode && !product.barcode) {
  await this.base.run('UPDATE products SET barcode = ? WHERE id = ?', [item.barcode, item.product_id]);
}
```

No check is performed to ensure the barcode isn't already assigned to another product. This can create duplicate barcodes in the database, causing the wrong product to be matched in future barcode lookups.

---

### 18. `updatePayment` Allows Editing Paid Payments Without Restriction
**File:** [purchase.service.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/purchase.service.ts#L1210-L1247)

The `updatePayment()` method doesn't check `payment.is_paid` before modifying the amount. Editing the `amount` of an already-paid payment changes the scheduled amount but NOT the actual `paid_amount`, creating a discrepancy in the financial records.

---

### 19. No Input Sanitization for SQL Injection via `batch_number`
**File:** [purchase.service.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/purchase.service.ts#L1153)

While parameterized queries are used (safe from injection), the `batch_number` field has no length/character validation. An arbitrarily long or special-character batch number could cause display issues.

---

## 🔵 LOW — Code Quality / Architectural Concerns

### 20. Dead Code: `_getOrCreateSupplierPaymentCategory`
**File:** [purchase.service.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/purchase.service.ts#L1585-L1593)

This method is defined but **never called** anywhere in the codebase. The comment trail says "Supplier payments are NOT recorded as expenses" — this method is a leftover from before that architectural change.

---

### 21. Unused Import: `AuditRepository` Direct Instantiation in Transaction Service
**File:** [transaction.service.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/transaction.service.ts#L6)

```typescript
import { AuditRepository } from '../repositories/sql/audit.repository';
```

Then on [line 253](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/transaction.service.ts#L253):
```typescript
const auditRepo = new AuditRepository(this.base);
```

This creates a **new instance** of `AuditRepository` inside a method instead of receiving it via dependency injection. This bypasses the DI container and makes testing/mocking harder. The `ServiceContainer` already wires `AuditRepository` for the `AuditService`.

---

### 22. `UserService` Has Unused `scryptAsync` Import
**File:** [user.service.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/user.service.ts#L1-L2)

```typescript
import * as crypto from 'crypto';
import * as util   from 'util';
...
const scryptAsync = util.promisify(crypto.scrypt);
```

`scryptAsync` is defined at module level but **never used**. Only the sync `crypto.scryptSync` is used in `hashPassword()`.

---

### 23. `better-sqlite3` Is Both a Dependency AND dev-Dependency Type
**File:** [package.json](file:///d:/Noon/wroking%20code/PharmaSys/package.json#L48)

`@types/better-sqlite3` is in `devDependencies`, but `better-sqlite3` itself is in `dependencies`. This is correct, but `sql.js` is ALSO in dependencies — two SQLite implementations are included. Only `better-sqlite3` appears to be used now (based on `base.repository.ts`). `sql.js` is dead weight adding to bundle size.

---

### 24. React UI Dependencies in `devDependencies` Instead of `dependencies`
**File:** [package.json](file:///d:/Noon/wroking%20code/PharmaSys/package.json#L36-L86)

`react`, `react-dom`, `react-router-dom`, `zustand`, `i18next`, `lucide-react`, `recharts`, and all Radix UI packages are in `devDependencies`. For an Electron app where the renderer is bundled by Vite, this technically works (Vite resolves them at build time). However, it's misleading — these are runtime dependencies of the renderer. If anyone runs `npm install --production`, none of the UI framework is installed.

---

### 25. `cycle-count.service.ts` Casts `status` with `as any`
**File:** [cycle-count.service.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/cycle-count.service.ts#L39)

```typescript
const activeBatches = await this.batchRepo.getAll({ status: 'active' as any });
```

The `as any` cast bypasses type checking on the `BatchFilters` type. This suggests the filter type doesn't support a `status` field, meaning either the filter is silently ignored (returns all batches) or the type definition is incomplete.

---

### 26. `conversion_factor` Accessed via `as any` Cast
**File:** [batch.service.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/batch.service.ts#L153)

```typescript
const cf = (existing as any).conversion_factor ?? 1;
```

The `Batch` type apparently doesn't include `conversion_factor`, so it's accessed via `as any`. This is fragile — if the column name changes or the JOIN is removed, this silently returns `undefined` and falls back to `1`, potentially miscalculating child prices.

---

### 27. Firewall Rules Created Without Cleanup
**File:** [main.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/platform/electron/main.ts#L157-L180)

`ensureFirewallRules()` creates Windows Firewall inbound rules named "PharmaSys Server" and "PharmaSys Discovery", but:
- No cleanup on uninstall
- No cleanup when switching away from server mode
- Rules accumulate if the port changes
- Rules are created with `execFile` which may silently fail without admin rights

---

### 28. `app.on('activate')` Registered Twice
**File:** [main.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/platform/electron/main.ts#L550-L553) and [main.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/platform/electron/main.ts#L727-L729)

Both the client branch and the standalone/server branch register an `activate` handler. If `bootMainApp` is called after switching modes, duplicate handlers may accumulate.

---

### 29. `Money.add` and `Money.subtract` Use `Math.trunc` but `Money.round` Uses `Math.round`
**File:** [money.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/common/money.ts#L28-L35)

```typescript
add(a: number, b: number): number {
  return (Math.trunc(Number(a)) || 0) + (Math.trunc(Number(b)) || 0);
},
subtract(a: number, b: number): number {
  return (Math.trunc(Number(a)) || 0) - (Math.trunc(Number(b)) || 0);
},
```

`Math.trunc` drops the fractional part (always toward zero), while `Math.round` rounds to nearest. If a value like `999.7` is passed to `add()`, it becomes `999` (loses 0.7 SDG). But `Money.round(999.7)` returns `1000`. This inconsistency can cause 1-unit discrepancies between differently calculated totals.

---

### 30. No Rate Limiting on Login in IPC Mode
**File:** [auth.service.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/auth.service.ts#L54-L101)

While the service has account lockout after 5 failed attempts, there's no rate limiting at the IPC transport level. An attacker with access to the machine could rapidly brute-force passwords before the lockout triggers (lockout is per-account, not per-IP/session, which is appropriate for a desktop app — but the timing of the fake scrypt on line 61 may not perfectly match a real password check).

---

### 31. `Toaster` Component Rendered Twice When Authenticated in Standalone
**File:** [App.tsx](file:///d:/Noon/wroking%20code/PharmaSys/src/renderer-react/App.tsx#L183-L189) and [App.tsx](file:///d:/Noon/wroking%20code/PharmaSys/src/renderer-react/App.tsx#L287-L296)

Due to the early return for `deviceMode === 'standalone'` (line 179), the `<Toaster>` on line 183 is always shown for standalone mode. If the `DeviceSetupWizard` transitions without changing `deviceMode`, the authenticated app at line 287 also renders a second `<Toaster>`.

---

## 🆕 ADDITIONAL ISSUES — Second-Pass Audit (2026-06-20)

> Found in a follow-up audit and **verified against the actual source**. Note: the codebase has
> evolved past `CLAUDE.md` — services/repositories are now **async** (better-sqlite3, not synchronous
> sql.js) and auth uses a **granular micro-permission system** (`inventory.batches.view`,
> `purchases.manage`, …), not the 3-permission model the docs describe.

### 32. Cycle-Count REST Routes Have ZERO Auth — Crash on Write + Data Leak 🔴 Critical
**File:** [cycle-count.routes.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/transport/rest/routes/cycle-count.routes.ts)

All 6 handlers lack `requireAuth`/`requireMicroPerm`, and [server.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/transport/rest/server.ts#L108) applies **no** global auth middleware. Consequences:
- `POST /`, `POST /:id/start`, `POST /items/:itemId/record`, `POST /:id/complete` call `req.user!.id`
  with `req.user` **undefined** → `TypeError` → 500. The feature is simply broken over REST/LAN.
- `GET /` and `GET /:id` leak cycle-count data to unauthenticated callers.

The IPC equivalents in `cycle-count.handler.ts` correctly gate with `inventory.batches.view/manage`.
Fix: add per-route `requireMicroPerm(...)` and switch to the shared `handle()` wrapper.

---

### 33. Batch REST/IPC Parity Gap — 4 Operations Missing Over REST 🟠 High
**File:** [batch.routes.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/transport/rest/routes/batch.routes.ts)

Routes present in [batch.handler.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/transport/ipc/handlers/batch.handler.ts) but missing from REST:
`getActiveBatchesForPriceUpdate`, `updatePricesByProduct`, `bulkDelete`, `getDeleteInfo`. LAN/client mode
loses price-by-product updates and batch bulk-delete entirely.

---

### 34. Purchase REST/IPC Parity Gap — ~10 Operations Missing Over REST 🟠 High
**File:** [purchase.routes.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/transport/rest/routes/purchase.routes.ts)

REST implements suppliers, purchase CRUD, schedule, and `markPaymentPaid` only. Missing vs IPC/preload:
payment `update`/`delete`/`unpay`, item `update`/`delete`, all `pending-items` operations
(get/getAll/complete/update/delete), and `merge`. Major feature gap for multi-device deployments.

---

### 35. `updatePaymentSchedule` HTTP Method Mismatch Risk 🟠 High
**File:** [purchase.routes.ts:121](file:///d:/Noon/wroking%20code/PharmaSys/src/transport/rest/routes/purchase.routes.ts#L121)

`updatePaymentSchedule` is exposed as `PATCH /:id/schedule` while `replaceUnpaidSchedule` is
`PUT /:id/schedule`. Verify `preload-rest.js` uses the correct verb for each; a mismatch means the
schedule update silently 404s / mis-routes in LAN mode.

---

### 36. Recurring-Expense `toggleActive` Is a Non-Atomic Read-Modify-Write 🟡 Medium
**File:** [recurring-expense.service.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/recurring-expense.service.ts)

Reads `is_active`, flips it in JS, writes back — without a transaction or version check. Concurrent
toggles can lose an update. Prefer a single SQL `UPDATE ... SET is_active = NOT is_active`.

---

### 37. `updatePaymentSchedule` Validation Is TOCTOU 🟡 Medium
**File:** [purchase.service.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/purchase.service.ts)

Validates "sum of scheduled payments == purchase total" then writes in a loop. The application-level
check runs before the writes, so a concurrent payment insert breaks the invariant even inside the SQL
transaction. Re-validate inside the transaction after re-reading the purchase.

---

### 38. `held-sale.service.ts` Uses `Math.round` Instead of `Money.round` 🔵 Low
**File:** [held-sale.service.ts:28](file:///d:/Noon/wroking%20code/PharmaSys/src/core/services/held-sale.service.ts#L28)

Functionally fine for integer inputs but violates the project-wide Money rule. Normalize for consistency.

---

### 39. `cart.store.ts` Gross-Rounding Inconsistency (Cosmetic) 🔵 Low
**File:** [cart.store.ts](file:///d:/Noon/wroking%20code/PharmaSys/src/renderer-react/stores/cart.store.ts)

`getTotal` uses unrounded `unit_price * quantity` while `getSubtotal`/`getDiscountTotal` use
`Math.round(...)`. Identical in practice (whole-integer money + integer-enforced quantities), but extract
a shared `lineGross()` helper so the three numbers can never diverge if inputs ever become fractional.

### 40. Integration/REST Test Harness Is Broken (ABI + stale signature) 🟠 High
**File:** [test-db.ts](file:///d:/Noon/wroking%20code/PharmaSys/tests/helpers/test-db.ts)

The harness still boots **sql.js** and calls `createRepositories(db, '/tmp/test-data', noop, noop)` with 4
args, but the current `createRepositories(dbPath, dataPath)` takes 2 and `BaseRepository` is hardcoded to
**better-sqlite3**. So all 29 integration/REST suites fail to run (only the 136 mock-based unit tests
execute). Even after fixing the signature to `createRepositories(':memory:', dataPath)`, the suites fail
at runtime because `postinstall` (`electron-builder install-app-deps`) builds better-sqlite3 against
**Electron's ABI (NODE_MODULE_VERSION 119)** while Jest runs under Node (ABI 137). Re-running
`npm rebuild better-sqlite3` would unblock Jest but **break the Electron app**. Proper fix needs an
architectural/tooling decision: a pluggable DB backend (sql.js for tests), running tests under Electron,
or maintaining a Node-ABI build for CI. Tracked here for a decision; not fixed in the bug-fix pass.

---

## ✅ CORRECTIONS — Items re-classified after code verification (2026-06-20)

- **#2 (backup `restore()` 3-arg mismatch) — NOT A BUG.** The IPC handler calls
  `BackupService.restore(filename, userId, displayFilename?)`, which *does* accept 3 args; the audit
  looked at the repository signature. `main.ts:631` renames the **archived copy** in `backups/` (already
  fully read into memory and closed), not the live DB — the repo swaps the DB via its own internal temp
  + `replaceDb()`. Working code left untouched.
- **#5 (silent product merge to wrong product) — DOWNGRADED, not corruption.** `productRepo.findByName`
  is an **exact normalized match** on active products (`LOWER(TRIM(name)) = LOWER(TRIM(?))`), so the
  "Peprasol 20mg vs 40mg" example cannot occur (different names). An exact-name collision is exactly what
  the partial UNIQUE index forbids, so merging is the only valid outcome, and the import UI already has an
  explicit existing-vs-new Match step. Fixed the real residual gap (silence) by recording a `name_merged`
  flag in the audit event instead of forcing a flow-breaking error.
- **#10 (recurring `last_generated_date` never updated) — NOT A BUG.** `last_generated_date` is **not a
  stored column**; it is a computed subquery `(SELECT MAX(expense_date) FROM expenses WHERE
  recurring_expense_id = re.id AND is_recurring = 1)`. It is therefore always live-accurate, and the
  daily-backfill `since` date works correctly. No fix needed (there is no column to update).
- **Service unit tests are pre-existing broken (test/code drift), extends #40.** Beyond the ABI issue,
  `tests/unit/services/*.test.ts` fail to compile because they call evolved service signatures with the
  old arity (e.g. `held-sale.service.test.ts` calls `getAll(1)` but `getAll(userId, role)` now takes 2).
  Only the `common/` + `events/` suites run (137 tests). These need updating alongside the harness fix.
- **#15 (`reportDamage` may use a different tx queue) — NOT A BUG.** `BatchRepository.inTransaction(work)`
  delegates to `this.base.inTransaction(work)`, and every repo shares the one `BaseRepository` built by
  `createRepositories`. So `reportDamage` uses the same serial `_txQueue` as everything else.
- **#37 (`updatePaymentSchedule` TOCTOU) — ALREADY HANDLED.** Fetch, validation (paid + new-unpaid ==
  total), and the writes are all inside a single `this.base.inTransaction(...)` which is serialized by the
  tx queue, so no concurrent insert can interleave between check and write. No change needed.

---

> **Downgraded / speculative (verify before acting):** CartPanel rounding (same non-issue as #39),
> LoginPage forgot-password "no await" claim, ProductGrid/`useApiCall` unmount handling (code already
> uses ref-based cancellation), CheckoutModal NaN bank-amount validation, CloseShiftDialog stale state,
> ReceiptModal `displayQty` fallback. These need re-reading before they are treated as real bugs.

---

## 🧾 STOCK-INTEGRITY AUDIT (root-cause of "system qty ≠ actual qty")

Full review of every code path that writes `batches.quantity_base`.

**Sound paths (no change needed):**
- **Sale FIFO** (`transaction.service._deductFIFO` + `createSale`): atomic via
  `base.inTransaction` (BEGIN→COMMIT, ROLLBACK on error — verified), oldest-expiry-first,
  every deduction uses `updateQuantityOptimistic` (version check) and retries on conflict.
  Can't under- or double-deduct.
- **Return / Void restore**: enforce return limits and subtract already-returned qty before
  restoring; optimistic-locked. No double-restore.
- **reportDamage / reverseAdjustment**: optimistic-locked; reversal guarded against
  double-reverse. **POS checkout**: submit disabled on `loading` (double-click guard).

**Bugs found & FIXED (these caused the variance):**
- 🔴 **`updatePurchaseItem` reset batch stock.** Editing a purchase item's received quantity
  did `quantity_base = qty * cf` — overwriting current stock with the full received amount and
  **wiping every unit already sold/adjusted from that batch** (system shows more than actual →
  "didn't deduct"). FIXED: apply the **delta** in base units
  (`quantity_base = max(0, current + (newReceived − oldReceived) × cf)`) and re-derive status.
- 🔴 **Cycle-count used a stale variance.** `complete()` recorded the adjustment as
  `-item.variance` where variance was snapshotted at count **start**. Any sale between starting
  and completing the count desynced the reconciliation ledger from actual stock. FIXED: derive
  the adjustment from the batch's **current** quantity at apply time
  (`adjustment = current − counted`), set the batch to the counted value, skip when already
  equal. Regression tests added (`cycle-count.service.test.ts`).

**Edge note (not fixed — rare):** changing a product's `conversion_factor` rescales batch
quantities with floor division (`qty × newCf / oldCf`); intentional (prevents ghost inventory)
but can shift reconciliation by a unit on non-divisible factors. Avoid changing CF after stock exists.

---

## 📋 Summary Table

| # | Severity | Category | Component | Issue |
|---|----------|----------|-----------|-------|
| 1 | 🔴 Critical | Wrong Path | `auth.service` | Emergency reset uses `process.cwd()` — fails in production |
| 2 | 🔴 Critical | API Mismatch | `backup.repository` | `restore()` called with 3 args, accepts 1 — rename-on-open-file |
| 3 | 🔴 Critical | No Transaction | `purchase.service` | `deletePurchaseItem` — multi-write without transaction |
| 4 | 🔴 Critical | No Transaction | `purchase.service` | `updatePurchaseItem` — multi-write without transaction |
| 5 | 🔴 Critical | Silent Merge | `purchase.service` | Name-match merges batches to wrong product |
| 6 | 🟠 High | Logic Error | `App.tsx` | Standalone mode always shows setup wizard |
| 7 | 🟠 High | Wrong Value | `shift.service` | `autoCloseStale` emits `actualCash: 0` instead of expected |
| 8 | 🟠 High | Approximation | `recurring-expense.service` | Monthly estimate `×30` inaccurate for daily items |
| 9 | 🟠 High | Ambiguity | `purchase.service` | `_createBatch` quantity conversion potentially double-counted |
| 10 | 🟠 High | Missing Update | `recurring-expense.service` | `last_generated_date` never updated after generation |
| 11 | 🟠 High | Type Strictness | `validation.ts` | `Validate.id()` rejects string IDs from REST/frontend |
| 12 | 🟠 High | Auth | `shift.service` | Admin can't use regular `close()` — must know about `forceClose()` |
| 13 | 🟡 Medium | Security | `main.ts` | `restoreFromFile` has no path traversal guard |
| 14 | 🟡 Medium | Missing Guard | `purchase.service` | `deletePayment` allows deleting paid payments |
| 15 | 🟡 Medium | DI | `batch.service` | `reportDamage` may use different transaction queue |
| 16 | 🟡 Medium | Performance | `ipc-router.ts` | `JSON.stringify` on every IPC call for size check |
| 17 | 🟡 Medium | Missing Validation | `purchase.service` | No barcode uniqueness check when updating product |
| 18 | 🟡 Medium | Missing Guard | `purchase.service` | `updatePayment` can edit paid payment amounts |
| 19 | 🟡 Medium | Validation | `purchase.service` | No length/char validation on `batch_number` |
| 20 | 🔵 Low | Dead Code | `purchase.service` | `_getOrCreateSupplierPaymentCategory` never called |
| 21 | 🔵 Low | DI | `transaction.service` | Direct `AuditRepository` instantiation bypasses DI |
| 22 | 🔵 Low | Dead Code | `user.service` | Unused `scryptAsync` import |
| 23 | 🔵 Low | Dependencies | `package.json` | `sql.js` included but unused (only `better-sqlite3` used) |
| 24 | 🔵 Low | Dependencies | `package.json` | React/UI libs in devDependencies instead of dependencies |
| 25 | 🔵 Low | Type Safety | `cycle-count.service` | `as any` cast on batch filter |
| 26 | 🔵 Low | Type Safety | `batch.service` | `as any` cast for `conversion_factor` |
| 27 | 🔵 Low | Cleanup | `main.ts` | Firewall rules created but never cleaned up |
| 28 | 🔵 Low | Duplicate | `main.ts` | `app.on('activate')` registered twice |
| 29 | 🔵 Low | Inconsistency | `money.ts` | `trunc` vs `round` inconsistency in money math |
| 30 | 🔵 Low | Security | `auth.service` | No IPC-level rate limiting on login |
| 31 | 🔵 Low | UI | `App.tsx` | Duplicate `<Toaster>` components |
| 32 | 🔴 Critical | Security/Crash | `cycle-count.routes` | REST routes have no auth — 500 on write + data leak |
| 33 | 🟠 High | REST Parity | `batch.routes` | 4 batch ops missing over REST (bulkDelete, price updates, delete-info) |
| 34 | 🟠 High | REST Parity | `purchase.routes` | ~10 purchase ops missing over REST (payments, items, pending-items, merge) |
| 35 | 🟠 High | Method Mismatch | `purchase.routes` | `updatePaymentSchedule` PATCH vs `replaceUnpaidSchedule` PUT — verify preload |
| 36 | 🟡 Medium | Race | `recurring-expense.service` | `toggleActive` non-atomic read-modify-write |
| 37 | 🟡 Medium | TOCTOU | `purchase.service` | `updatePaymentSchedule` validates before writes — invariant can break |
| 38 | 🔵 Low | Inconsistency | `held-sale.service` | Uses `Math.round` instead of `Money.round` |
| 39 | 🔵 Low | Inconsistency | `cart.store` | `getTotal` vs `getSubtotal` gross-rounding mismatch (cosmetic) |
| 40 | 🟠 High | Test Infra | `test-db.ts` | Integration/REST harness broken (sql.js+stale sig; better-sqlite3 ABI conflict) |

---

## 🛠️ RESOLUTION LOG

**Phase 1 (data integrity & security)** — `npm run tsc` clean, 137 unit tests pass:
- **#1** FIXED — real data dir threaded `ServiceContainer → AuthService` (Electron `userData` / server `DB_DIR`), replacing `process.cwd()`.
- **#2** NOT A BUG (see corrections) — left untouched.
- **#3 / #4** FIXED — `deletePurchaseItem` / `updatePurchaseItem` writes wrapped in `base.inTransaction()`.
- **#5** DOWNGRADED + FIXED — name-merge now records a `name_merged` audit flag (see corrections).
- **#32** FIXED — cycle-count REST routes gated with `requireMicroPerm` + `handle()`; `recordCount` path aligned to client.

**Phase 2 (parity gaps & logic errors)** — `npm run tsc` clean, 137 unit tests pass:
- **#7** FIXED — `autoCloseStale` emits `actualCash = expected_cash` (matches what is persisted).
- **#8** FIXED — daily→monthly projection uses 365.25/12 average, not flat ×30.
- **#10** NOT A BUG (computed column, see corrections).
- **#11** FIXED — `Validate.id` coerces numeric strings; test updated.
- **#12** FIXED — `close()` accepts role; admins may close any shift (transports pass `user.role`).
- **#33** FIXED — added `active/:productId`, `update-prices`, `bulk-delete`, `:id/delete-info` batch routes.
- **#34** FIXED — added payment update/unpay/delete, item update/delete, all pending-items, and merge purchase routes.
- **#35** FIXED — `updatePaymentSchedule` → `PUT /:id/schedule`, `replaceUnpaidSchedule` → `PUT /:id/schedule/replace` (matches preload). Also wired `?force=` on DELETE.
- **#36** FIXED — atomic `toggleActive` (single `CASE` UPDATE in repo).

**Phase 3 (medium guards & robustness)** — `npm run tsc` clean, 137 unit tests pass:
- **#13** FIXED — `restoreFromFile` now whitelists the extension and asserts the promoted path stays inside `backups/` (symmetry with `saveAs`).
- **#14** FIXED — `deletePayment` rejects paid payments (must `unmarkPaymentPaid` first).
- **#15** NOT A BUG (shared tx queue, see corrections).
- **#16** FIXED — IPC size guard measures per-arg, counts ArrayBuffer/TypedArray by `byteLength`, and short-circuits.
- **#17** FIXED — barcode only assigned during import if no other product already owns it.
- **#18** FIXED — `updatePayment` rejects amount/due_date changes on a paid payment.
- **#19** FIXED — `batch_number` bounded via `Validate.optionalString(..., 60)` in `_createBatch` and `BatchService.create`.
- **#37** ALREADY HANDLED (single transaction, see corrections).

**Phase 4 (code quality & consistency)** — `npm run tsc` clean, 137 unit tests pass:
- **#20** FIXED — removed dead `_getOrCreateSupplierPaymentCategory` and the now-unused `expenseRepo`/`shiftRepo` injected deps + imports (rewired DI).
- **#21** FIXED — `AuditRepository` injected into `TransactionService` via constructor (wired in `ServiceContainer`); inline `new AuditRepository` kept only as fallback.
- **#22** FIXED — removed unused `scryptAsync` and the `util` import.
- **#25** FIXED — removed spurious `as any`; `BatchFilters.status` already exists and `getAll` handles it.
- **#26** FIXED — removed `as any`; `Batch.conversion_factor` is already declared.
- **#29** FIXED — `Money.add`/`subtract` now use `Math.round` (consistent with `round`); identical for whole-integer inputs.
- **#38** FIXED — `held-sale.service` uses `Money.round`.
- **#39** FIXED — `cart.store` uses shared `lineGross()`/`lineDiscount()` so subtotal/discount/total can't diverge.
- **#28** FIXED — `app.on('activate')` registered once in the lifecycle section instead of per device-mode branch.
- **#6** NOT A BUG — the setup wizard only offers Main(server)/Connect(client); `standalone` is the *unconfigured* fresh-install state, and the wizard is the intended gate. After a choice is saved the app reloads to server/client and skips it.
- **#31** NOT A BUG — the `standalone` branch `return`s its own `<Toaster>` before the authenticated app's `<Toaster>` is reached; the two are mutually exclusive, never both mounted.
- **#24** NOT A BUG (intentional) — React/UI libs belong in `devDependencies` for a Vite-bundled renderer: Vite inlines them into static assets at build time. Moving them to `dependencies` would make electron-builder bundle them into the packaged app unnecessarily (larger installer).
- **#23** DEFERRED — `sql.js` is still imported by the (broken) test harness; removal is tied to the #40 decision.
- **#27** DEFERRED — firewall-rule cleanup needs NSIS uninstaller scripting (outside the TS codebase); rules are idempotent (fixed names) so they don't multiply in normal use.

**Phase 6 (docs) + #40 (test recovery)** — `npm run tsc` clean:
- **CLAUDE.md** refreshed: async/`better-sqlite3` data layer (not synchronous sql.js), the micro-permission
  system (+ `permissions.ts` and the legacy-derivation note), `data/pharmasys.db`, and a note on the ABI
  blocker.
- **#40a (service unit tests) — LARGELY FIXED.** Root cause was the shared `tests/helpers/mocks.ts`
  (a `TransactionItem` fixture missing `checkout_discount_allocation` broke 13/15 suites; the batch mock
  lacked `inTransaction`/`propagateSellingPrices`). Fixed those + updated drifted call sites
  (`held-sale.getAll(userId, role)`, `PurchaseService` 6-arg constructor). Test suite went from **137 →
  512 passing**; 13/15 service suites now green and all Phase 1–4 service changes are now covered.
- **Remaining 10 failures (batch.service, product.service)** are pre-existing test/code drift, NOT caused
  by this pass. Some are safe additive drift (bulkCreate event now carries `errors`/`failedCount`;
  `bulkUpdateSellingPrices` gained a 5th arg). Two are **genuine behavioral questions left for the owner**
  rather than masked by editing tests to match code:
    1. `reportDamage` on a partially-damaged batch keeps status `active` (only `sold_out` at qty 0); the
       test expects `quarantine`. Decide: should partial damage quarantine the whole batch?
    2. `bulkCreate` now emits a `BULK_CREATE_PRODUCTS` audit event even when every item fails; the test
       expects no event. Decide: audit the failed attempt or stay silent?
- **#40b (rest/integration suites) — STILL BLOCKED** by the better-sqlite3 Electron-ABI issue (Jest runs
  under Node). Needs a tooling decision (pluggable sql.js test backend, run-under-Electron, or a Node-ABI
  build for CI). `sql.js` stays in deps until this is decided (#23).

**Remaining:** #9 (frontend, verify), #30 (IPC login rate-limit — design choice), #40b (ABI tooling),
and the two behavioral decisions above.
