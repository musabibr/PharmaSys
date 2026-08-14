# PharmaSys — Deep Feature-by-Feature Audit

**Date:** 2026-08-14
**Scope:** Full system, verified against source (not speculative).
**Depth focus:** section **I** (product & transaction history / audit traceability) and section **G** (POS performance) were reviewed line-by-line at the owner's request; the rest is a systematic feature-by-feature pass.
**Reviewer note:** This is a *second-generation* audit. The earlier `issues.md` (2026-06-20, items #1–#40) is mostly resolved and is **not repeated here**. Everything below is newly found or newly re-classified.

**Purpose of this file:** hand-off document for another AI model / developer. Each finding has: exact file+line evidence, a reproduction, the concrete impact, and a proposed fix. Findings are independent unless a dependency is stated.

---

## 0. Orientation (for a model reading this cold)

```
src/core/common/        Money (integer SDG), Quantity, Validate, permissions
src/core/repositories/  better-sqlite3, all repos share ONE BaseRepository connection
src/core/services/      business logic; async; emit to EventBus (AuditListener auto-logs)
src/transport/ipc/      Electron IPC handlers  (preload.js unwraps { success:false } → throws)
src/transport/rest/     Express routes         (LAN/client mode, preload-rest.js)
src/renderer-react/     React 18 + Vite + Tailwind + Shadcn + Zustand
```

**Invariants the code relies on:**

| Concept | Meaning |
|---|---|
| `batches.quantity_base` | stock in **child (small) units** |
| `conversion_factor` (cf) | child units per parent unit |
| `transaction_items.quantity_base` | sold amount in **child units** |
| `transaction_items.unit_price` | price **per display unit** (parent price if `unit_type='parent'`) |
| Money | whole SDG integers; `Money.divideToChild` = floor (anti–ghost-inventory) |
| Optimistic lock | `batches.version`, via `updateQuantityOptimistic` |
| Effective sale price | `selling_price_*_override > 0 ? override : selling_price_*` |

**The last invariant matters a lot** — see D1.

---

## Severity legend

| | |
|---|---|
| 🔴 **Critical** | Silent money/stock corruption, or an operator gets blamed for a system error |
| 🟠 **High** | Wrong numbers reported, or a normal workflow is blocked/broken |
| 🟡 **Medium** | Edge case, degraded accuracy, or poor failure handling |
| 🔵 **Low** | Polish, performance headroom, latent trap |

---

# A. Cash & Shift Reconciliation

## A1 🔴 `cash_tendered` stores the money *handed over*, not the money *kept* — every drawer shows a false shortage

**Evidence**

`src/renderer-react/components/pos/CheckoutModal.tsx:155`
```ts
cash_tendered: paymentMethod === 'cash'
  ? (parsedCashTendered > 0 ? parsedCashTendered : totalAmount)
  : cashAmount,
```
`parsedCashTendered` is the **Amount Received** field — the note the customer handed over. Change is computed for display (line 93) but never subtracted before storage.

Consumers treat the column as cash retained:

`src/core/repositories/sql/shift.repository.ts:108-112`
```sql
SELECT COALESCE(SUM(cash_tendered), 0) FROM transactions
WHERE shift_id = ? AND is_voided = 0 AND transaction_type = 'sale'
```
`src/core/repositories/sql/shift.repository.ts:130-134`
```sql
SELECT COALESCE(SUM(total_amount - cash_tendered), 0) ...   -- "bank portion"
```
`src/core/repositories/sql/report.repository.ts:49` — `cash_sales` in the Cash Flow report, same expression.

**Reproduction**
Sale total 4,300. Cashier types 5,000 in *Amount Received*, hands back 700.
Stored: `total_amount = 4300`, `cash_tendered = 5000`.

- Expected cash for the shift is inflated by **700**.
- `total_amount - cash_tendered = -700` is booked as **negative bank sales**.
- At close, the drawer is 700 short of "expected" → recorded as a **shortage** against the cashier.

Repeat 40× a day → a shift closes several thousand SDG "short" with no explanation. This is almost certainly the single largest source of unexplained variance in production.

**Why it hides:** if the cashier leaves *Amount Received* blank, `cash_tendered` defaults to `totalAmount` and everything is correct. The bug only fires when the cashier uses the change calculator — i.e. exactly the intended workflow.

**Fix**
1. Add a distinct column `cash_received` (what was handed over, for the receipt/change display) and keep `cash_tendered` as **cash actually retained = min(received, total)**.
   Minimal version without a schema change: in `CheckoutModal`, send `cash_tendered: totalAmount` for pure-cash sales, and pass the received amount only as receipt metadata.
2. Backfill: `UPDATE transactions SET cash_tendered = total_amount WHERE transaction_type='sale' AND payment_method='cash' AND cash_tendered > total_amount;`
3. Harden the server: in `TransactionService._commitTransaction` (`src/core/services/transaction.service.ts:718`) clamp — `cashTendered = Math.min(data.cash_tendered ?? total, total)` for `payment_method='cash'`, after the sufficiency check on line 725.
4. Change `bank portion` derivations to `CASE WHEN payment_method='cash' THEN 0 ELSE total_amount - cash_tendered END` so a cash sale can never contribute negative bank revenue.

---

## A2 🔴 Returns are back-dated into the original sale's date **and shift** — closed periods mutate, and today's drawer goes short

**Evidence**

`src/core/services/transaction.service.ts:154-155`
```ts
// Return is attributed to the original sale's shift and date
const shiftId = original.shift_id;
```
`src/core/services/transaction.service.ts:401-405`
```ts
return await this._commitTransaction(
  txnData, lines, userId, shiftId,
  data.original_transaction_id,
  original.created_at            // ← return row gets the SALE's created_at
);
```
`_commitTransaction` writes it verbatim (`created_at: createdAt ?? null`, line 755). A migration even back-fills historical rows this way (`migration.repository.ts:1966-1975`).

**Four separate consequences**

1. **Closed shifts mutate after reconciliation.** `getExpectedCash` for the *original* shift now subtracts a refund that did not exist when the shift was closed. The stored `variance`/`actual_cash` no longer reproduce. Any re-audit of an old shift disagrees with the record.
2. **Today's drawer goes short.** The cashier physically hands cash out of *today's* drawer, but the deduction is booked against last week's shift. Today's `expected_cash` is unchanged → today closes short by the refund amount.
3. **Finalised P&L changes retroactively.** A refund processed today reduces last month's `total_returns` and `net_sales`. Reports the owner already printed and acted on silently change.
4. **No trace of when the refund happened.** There is no `returned_at` column. In *Product Sales History* (`transaction.repository.ts:158`, `ORDER BY t.created_at DESC`) a return sorts to the sale's date. The owner cannot answer "what did we refund today?" from any screen.

**Fix**
- Keep `parent_transaction_id` for linkage, but stamp the return with **its own** `created_at` (now) and **its own** `shift_id` (the refunding user's open shift).
- Add `original_sale_date` / keep the parent link for the "returns against period X" analysis, so cohort reporting is still possible without rewriting history.
- Add an explicit **Returns** column to the daily/shift summary so a refund is visible on the day it cost money.
- Migration: leave existing rows alone (rewriting them is another retroactive change); document the cut-over date.
- If back-dating is genuinely wanted for revenue-cohort reasons, it must **not** also move `shift_id` — cash attribution and revenue attribution are different questions.

---

## A3 🟠 An expense is attached to the current open shift regardless of its date

`src/core/services/expense.service.ts:109-119`
```ts
const shift = await this.shiftRepo.findOpenByUser(userId);
const result = await this.repo.create(
  { ...data, amount, expense_date: expenseDate, payment_method: paymentMethod },
  userId, shift?.id ?? null
);
```
`expense_date` is user-supplied and validated, then ignored for shift attribution.

**Impact:** recording a forgotten expense from last Tuesday deducts cash from *today's* expected drawer. Reports keyed on `expense_date` (`report.repository.ts:88`) and reconciliation keyed on `shift_id` (`shift.repository.ts:118-123`) disagree permanently.

**Fix:** only attach `shift_id` when `expense_date` equals the open shift's date; otherwise store `shift_id = NULL` and surface "this expense is dated outside your shift and will not affect your drawer count" in the form. Alternatively require the date to be today unless the user has an override permission.

---

## A4 🟠 Closed shifts have no write protection

There is no guard anywhere preventing a mutation that changes a **closed** shift's expected cash:

- `ExpenseService.delete` (`expense.service.ts:129-143`) hard-deletes a non-recurring expense with no shift-status check.
- `TransactionService.voidTransaction` (`transaction.service.ts:422`) voids with no age or shift-status check.
- `createReturn` books into a closed shift (see A2).

Once `shifts.status='closed'`, `expected_cash`, `actual_cash`, `variance` are frozen snapshots — but their inputs stay editable. Every such edit makes the stored variance unreproducible, and the audit trail records the mutation but not its effect on the closed shift.

**Fix:** in each of these paths, resolve the affected `shift_id` and reject if that shift is closed, unless the caller is an admin **and** supplies a reason. On admin override, write a compensating record (e.g. a `correction` adjustment or a shift note) rather than silently mutating.

---

## A5 🟡 `ShiftService.close` is a read-then-write with no transaction

`src/core/services/shift.service.ts:117-132`
```ts
const expected = await this.repo.getExpectedCash(shiftId);   // 6 separate SELECTs
const variance = Money.subtract(actual, expected.expected_cash);
await this.repo.close(shiftId, { ... });                      // separate UPDATE
```
`getExpectedCash` issues six independent queries; a sale committing between any of them, or between the read and the `close`, is silently excluded from `expected_cash` but is present in the drawer.

**Fix:** wrap `getExpectedCash` + `close` in `base.inTransaction()`, and inside it re-assert `status = 'open'` in the UPDATE's WHERE clause (`WHERE id = ? AND status = 'open'`), throwing `ConflictError` on 0 rows changed. Also collapse the six SELECTs into one CTE query.

---

## A6 🟡 The "Cash Flow" report contains no supplier payments — the largest cash outflow is missing

`src/core/repositories/sql/report.repository.ts:87-89`
```sql
FROM expenses
WHERE expense_date BETWEEN ? AND ?
  AND id NOT IN (SELECT expense_id FROM purchase_payments WHERE expense_id IS NOT NULL)
```
and line 118:
```ts
supplier_payments: 0, // Already included in COGS via batch cost_per_parent
```

The comment is correct **for a P&L** (COGS recognises cost when goods are sold) but the report is presented as *Cash Flow*. Money paid to a supplier for stock still sitting on the shelf leaves the bank and appears nowhere. `PurchaseService` deliberately does not create expense rows for supplier payments (`purchase.service.ts:579-580`).

**Impact:** the owner reads "net positive cash flow" on a month where they paid 3 suppliers and are actually cash-negative.

**Fix:** either rename the screen to *Profit & Loss (cash basis)*, or add a real cash-flow section sourced from `purchase_payments WHERE is_paid = 1 AND paid_date BETWEEN ? AND ?`, split by `payment_method`, shown as a separate outflow line (not folded into `operational_expenses`, which would double-count against COGS).

---

# B. Stock Integrity & Product CRUD

> This is the area flagged as most business-critical. Findings B1 and B2 are the two that can destroy stock records with no recoverable trace.

## B1 🔴 `deleteBatch` destroys stock with no adjustment record and no quantity in the audit log

`src/core/services/batch.service.ts:508-527`
```ts
const info = await this.repo.getBatchDeleteInfo(id);
if (info && (info.txn_count > 0 || info.adj_count > 0)) {
  throw new ValidationError('Cannot delete batch with transaction history...');
}
await this.repo.deleteBatch(id);          // hard DELETE
this.bus.emit('entity:mutated', {
  action: 'DELETE_BATCH', table: 'batches', recordId: id, userId,
  oldValues: { product_name, batch_number, expiry_date },   // ← no quantity_base
});
```

The guard only blocks batches with **history**. A batch with 500 units of stock and no sales yet is hard-deleted, and:

- No `inventory_adjustments` row → the Inventory Reconciliation report (`report.repository.ts:493`) permanently shows the variance as unexplained.
- No `stock:changed` event.
- The audit row does not record **how much** stock disappeared, so the loss cannot even be quantified after the fact.
- `bulkDeleteBatches` (line 529) loops this with no transaction — a partial run leaves an arbitrary subset deleted.

**Fix**
```ts
// inside repo.inTransaction:
if (batch.quantity_base > 0) {
  await this.repo.insertAdjustment({
    product_id: batch.product_id!, batch_id: id,
    quantity_base: batch.quantity_base,          // positive = removed
    reason: 'Batch deleted', type: 'correction', user_id: userId,
  });
}
```
…but note the adjustment FK points at a row about to vanish. Preferred: **never hard-delete a batch with stock.** Require the user to zero it first (via `reportDamage`, which already records an adjustment), then allow deletion only at `quantity_base = 0`. Include `quantity_base` and `product_id` in `oldValues` regardless. Wrap `bulkDeleteBatches` in one transaction.

---

## B2 🔴 Changing a product's conversion factor silently rewrites every batch quantity

`src/core/services/product.service.ts:94-99`
```ts
if (data.conversion_factor !== undefined && data.conversion_factor !== existing.conversion_factor) {
  await this.batchRepo.inTransaction(async () => {
    await this.repo.update(id, data);
    await this.batchRepo.rescaleQuantitiesForProduct(id, existing.conversion_factor!, data.conversion_factor!);
    await this.batchRepo.recalculateChildPricesForProduct(id, data.conversion_factor!);
  });
```
`src/core/repositories/sql/batch.repository.ts:409-419`
```sql
UPDATE batches SET quantity_base = quantity_base * ? / ?, version = version + 1
WHERE product_id = ?          -- ALL batches, any status
```

**Three distinct problems.**

**(a) The arithmetic invents or destroys physical stock.**
`quantity_base` is in **child units**. If a box actually contains 20 strips but the product was set up as 10, correcting cf 10→20 does not change how many strips are on the shelf. The code doubles them:
`120 strips × 20 / 10 = 240 strips`. 120 strips of inventory appear from nowhere, valued at full cost in every report.
Going the other way (20→10) halves real stock.

The only reading under which this is right is "the number the user typed was in parent units" — but the column is not parent units, and nothing in the UI states this.

**(b) Floor truncation loses units with no record.**
SQLite integer division floors. `7 * 3 / 2 = 10` (not 10.5). Losses are silent — no `inventory_adjustments` row, no `stock:changed` event.

**(c) Every manual price override on that product is wiped.**
`recalculateChildPricesForProduct` (`batch.repository.ts:391-403`) sets `cost_per_child_override = 0, selling_price_child_override = 0` on all active/quarantine batches. Deliberate per-batch pricing is destroyed with no warning and no undo.

Also: the operation emits **two** audit events (`CASCADE_CF_CHANGE` then `UPDATE_PRODUCT`, `product.service.ts:101` and `:111`) and neither records the before/after quantities.

**Fix**
1. Decide and document the semantic. The defensible one: **cf is metadata about packaging; correcting it must not change `quantity_base`.** Drop `rescaleQuantitiesForProduct` from the cascade entirely.
2. If a rescale really is wanted, make it explicit and reversible: show a preview table (`batch → old qty → new qty → units lost to rounding`), require confirmation, and write one `correction` adjustment per batch for the delta.
3. Block the cf change outright when the product has stock, and offer "create a new product instead" — that is what most pharmacy systems do.
4. Preserve overrides, or at minimum warn and list which batches will lose theirs.
5. Emit one event carrying `{ old_cf, new_cf, batches_affected, quantity_deltas }`.

---

## B3 🟠 A caller-supplied `batch_id` is never checked against `product_id`

`src/core/services/transaction.service.ts:604-611`
```ts
const batches: IFIFOBatch[] = item.batch_id
  ? await (async () => {
      const b = await this.batchRepo.getById(item.batch_id!) as unknown as IFIFOBatch | undefined;
      if (b && b.status !== 'active') throw new ValidationError(...);
      return b ? [b] : [];
    })()
  : await this.batchRepo.getAvailableByProduct(item.product_id);
```
The explicit-batch path checks status but never `b.product_id === item.product_id`. The FIFO path also skips the expiry check that `getAvailableByProduct` applies (`batch.repository.ts:69`, `expiry_date >= date('now')`).

**Impact:** a malformed or stale POS payload (a cart line whose `batch_id` was captured before the product was switched, or any REST caller) deducts stock from **product A's batch** while writing a `transaction_items` row with **product B's `product_id`**. Both products' stock records are then wrong, and the sales history attributes the sale to the wrong drug. Expired stock is also sellable through this path.

**Fix**
```ts
const b = await this.batchRepo.getById(item.batch_id!);
if (!b) throw new NotFoundError('Batch', item.batch_id!);
if (b.product_id !== item.product_id)
  throw new ValidationError(`Batch ${item.batch_id} does not belong to product ${item.product_id}`, 'batch_id');
if (b.status !== 'active') throw new ValidationError(...);
if (this._isBatchExpired(b.expiry_date))
  throw new ValidationError(`Batch ${item.batch_id} is expired`, 'batch_id');
```

---

## B4 🟠 A product can never be deactivated once it has been sold even once

`src/core/services/product.service.ts:125-127`
```ts
if (await this.repo.hasActiveBatches(id)) {
  throw new ValidationError('Cannot delete product with active stock. Sell or adjust all batches first.', 'id');
}
```
`src/core/repositories/sql/product.repository.ts:193-204`
```sql
SELECT COUNT(*) FROM batches
WHERE product_id = ? AND (quantity_base > 0
  OR EXISTS (SELECT 1 FROM transaction_items WHERE batch_id = batches.id)
  OR EXISTS (SELECT 1 FROM inventory_adjustments WHERE batch_id = batches.id))
```
Transaction and adjustment history never expires, so the condition is permanently true for any product that has ever moved. `delete()` is only a **soft** delete (`is_active = 0`, `product.repository.ts:186`), which is exactly the safe operation history should *not* block.

The error message tells the user to "sell or adjust all batches first" — they do, and it still fails. `getDeleteInfo` already returns `txn_count` so the UI could inform rather than block.

**Impact:** the catalogue only grows. Discontinued products stay in POS search, in the reorder report, and in the valuation list forever.

**Fix:** split the checks.
```ts
const hasStock = await this.repo.hasStock(id);   // quantity_base > 0 only
if (hasStock) throw new ValidationError('Cannot deactivate a product that still has stock...');
await this.repo.softDelete(id);                  // history is irrelevant to a soft delete
```
Keep the history check only if a **hard** delete is ever added.

---

## B5 🟡 Manual batch quantity edits need no justification

`src/core/services/batch.service.ts:193-202` correctly writes a `correction` adjustment for a manual quantity edit — good — but the reason is hard-coded:
```ts
reason: 'Manual batch quantity edit',
```
Anyone with `inventory.batches.manage` can set any batch to any quantity with no explanation captured. In a controlled-stock environment that is the one operation that most needs a reason.

**Fix:** add a required `reason` argument to `BatchService.update` when `quantity_base` changes; surface it as a mandatory field in `BatchForm`. Consider gating quantity edits behind a separate permission from price/metadata edits.

---

## B6 🟡 `reverseAdjustment` blocks legitimate reversals and detects prior reversals by string matching

`src/core/services/batch.service.ts:298-309`
```ts
if (adj.quantity_base < 0) throw new BusinessRuleError('Cannot reverse a reversal adjustment');

const allAdjustments = await this.repo.getAdjustments({ batch_id: adj.batch_id });
const alreadyReversed = allAdjustments.some(a => a.reason === `Reversal of adjustment #${id}`);
```

- The sign convention is "positive = stock removed". A **cycle-count overage** (counted more than the system had) is stored negative — so a genuine overage correction can never be reversed, and the error message blames a "reversal" that does not exist.
- Reversal detection compares a free-text `reason` string. Any change to that literal (translation, edit, a user typing the same text) silently breaks the double-reverse guard.

**Fix:** add a `reverses_adjustment_id INTEGER REFERENCES inventory_adjustments(id)` column, use it for both checks, and add a partial UNIQUE index so a double reverse is impossible at the DB level. Replace the sign heuristic with `if (adj.reverses_adjustment_id != null) throw ...`.

---

## B7 🟡 Two batch-creation paths disagree on whether expiry may be in the past

| Path | Validation |
|---|---|
| `BatchService.create` (`batch.service.ts:50`) | `Validate.futureDate` — **rejects** past expiry |
| `PurchaseService._createBatch` (`purchase.service.ts:1163`) | `Validate.dateString` — **accepts** past expiry, and defaults to *now + 2 years* when the field is blank (line 1155-1157) |

Manually recording short-dated stock you already own is impossible; importing the same stock from an invoice works. The 2-year silent default also means a missing expiry on an invoice produces a plausible-looking but fabricated date that nobody will question.

Also note `Validate.dateString` (`src/core/common/validation.ts:62-69`) is regex-only: `2026-02-31` passes (JS `Date` rolls it to Mar 3 rather than returning Invalid Date).

**Fix:** use the same validator in both paths — allow past dates but force the batch to `status='quarantine'` when expiry ≤ today. Make the blank-expiry default an explicit user prompt, never a silent 2-year guess. Add real calendar validation to `Validate.dateString` (compare `d.toISOString().slice(0,10)` to the input).

---

# C. Returns & Voids (worst-case handling)

## C1 🟠 A sale containing the same batch twice mis-computes the return limit

`src/core/services/transaction.service.ts:174-204`
```ts
let origItem = original.items?.find(i => i.batch_id === item.batch_id && i.unit_type === item.unit_type);
...
const key           = `${item.batch_id}`;                       // batch only
const alreadyBase   = (returnedMap[key] ?? 0) + (inRequestConsumed[key] ?? 0);
const remainingBase = origItem.quantity_base - alreadyBase;     // ONE item's quantity
```
`returnedMap` aggregates returns **per batch**, but `remainingBase` is measured against a **single** matched item.

A sale can legitimately contain two lines on the same batch — POS allows adding "1 box" and "3 strips" of the same product, and FIFO resolves both to the same batch. Then:
- returning against the parent line subtracts returns that belong to the child line → under-reports what is returnable, blocking a valid refund;
- the mirror bug exists in the UI (`src/renderer-react/components/finance/ReturnDialog.tsx:89-95`), which subtracts the full batch-level returned total from *each* item's `quantity_base`.

**Fix:** aggregate the original side by batch too:
```ts
const origForBatch = original.items!.filter(i => i.batch_id === item.batch_id);
const soldBase     = origForBatch.reduce((s, i) => s + i.quantity_base, 0);
const remainingBase = soldBase - alreadyBase;
```
and pick `origItem` (for price/cf) by preferring an exact `unit_type` match, else the parent line. Apply the identical aggregation in `ReturnDialog`.

Related: **the cart does not merge duplicate lines** (see H1), which makes this case common rather than rare.

---

## C2 🟠 Voiding a sale leaves its returns alive

`voidTransaction` (`transaction.service.ts:422-535`) correctly avoids double-restoring stock by subtracting already-returned quantities (line 463-470). But it never touches the child **return transactions**.

After voiding a sale that had a partial return:
- the sale is excluded from revenue (`is_voided = 1`);
- the return is **not** — it stays as a live negative-revenue row referencing a voided parent.

Net effect on `net_sales` = `0 - return_total` — the period is charged a refund for a sale that officially never happened. Stock is right; money is not.

**Fix:** inside the void transaction, find `SELECT id FROM transactions WHERE parent_transaction_id = ? AND is_voided = 0`, and either (a) refuse the void with "this sale has N returns; void those first", or (b) cascade the void with `void_reason = 'Parent sale #X voided'`. Option (a) is safer and easier to audit.

---

## C3 🟡 Splitting a parent line across batches rounds each fragment independently

`src/core/services/transaction.service.ts:654-659`
```ts
const lineTotal = item.unit_type === 'parent'
  ? Math.round((effectivePrice * take) / cf)
  : Money.multiply(effectivePrice, take);
```
`take` is in child units; each FIFO fragment is rounded on its own.

Example: 3 boxes at 101 SDG, cf 10, split 25 + 5 child units:
`round(101×25/10) = 253`, `round(101×5/10) = 51` → **304**, versus 3 × 101 = **303**. The customer is charged 1 SDG more than the price shown at the till.

**Fix:** compute the line total once from the requested display quantity, then distribute it across fragments with a largest-remainder allocation (the same pattern already used for `checkout_discount_allocation` at `transaction.service.ts:758-771`), so the fragments always sum to the quoted total.

---

## C4 🟡 Mixed payments are validated against the client's total, never re-validated after FIFO

`_validatePayment` (`transaction.service.ts:559-577`) checks `cashPart + bankPart === total_amount` using the **client-supplied** `total_amount`, before FIFO runs. `_commitTransaction` recomputes the real total and re-validates — but only for `payment_method === 'cash'`:

`transaction.service.ts:725`
```ts
if (data.transaction_type === 'sale' && data.payment_method === 'cash' && cashTendered < total) {
```

If the server total differs from the client's (C3 rounding, a price changed between grid load and checkout), a mixed payment is committed with a breakdown that does not add up to the stored total, and `cash_tendered` is wrong — feeding straight back into A1.

**Fix:** move the breakdown check into `_commitTransaction` against the computed `total`, for `mixed` and `bank_transfer` alike. Reject with a clear "the total changed while you were at checkout — please review" so the cashier re-confirms rather than silently mis-splitting.

---

## C5 🟡 Returning against a deleted batch fabricates a batch with a guessed expiry

`transaction.service.ts:254-266`
```ts
const originalExpiry = await auditRepo.getDeletedBatchExpiry(item.batch_id);
const newBatchId = await this.batchRepo.restoreDeletedBatch({
  batch_number: `RESTORED-${item.batch_id}-REVIEW`,
  expiry_date:  originalExpiry ?? '2099-12-31',
  ...
});
```
The recovery path is thoughtful (quarantine status forces review), but `2099-12-31` is a live, sellable-looking date on a physical medicine. If a pharmacist releases the batch from quarantine without noticing, expired stock re-enters circulation with a 73-year expiry and every expiry report stays clean.

Note B1 is the reason this path exists at all — fixing B1 makes this rare.

**Fix:** use a date that is unmistakably invalid for sale — set `expiry_date` to *today* (so it reads as expired everywhere) and put the "unknown expiry, verify physically" note in `batch_number`/audit. Add a UI badge for `RESTORED-*` batches on the quarantine list.

---

# D. Pricing

## D1 🔴 "Update prices by product" cannot change the POS price — overrides always win

The effective sale price is override-first:

`src/core/services/transaction.service.ts:640-644`
```ts
const unitPrice = item.unit_price ??
  (item.unit_type === 'parent'
    ? (batch.selling_price_parent_override || batch.selling_price_parent || 0)
    : (batch.selling_price_child_override  || batch.selling_price_child  || 0));
```

**Every batch is created with a non-zero override:**

| Creation path | Line | Override written |
|---|---|---|
| `BatchService.create` | `batch.service.ts:71-73` | `selling_price_parent_override: sellParent` |
| `PurchaseService._createBatch` | `purchase.service.ts:1174` | `sellParent, sellChild` into the override columns |
| `BatchRepository.create` default | `batch.repository.ts:148-149` | `?? data.selling_price_parent` |

So the override is *never* 0 in practice. Now:

`src/core/services/batch.service.ts:377`
```ts
const count = await this.repo.bulkUpdateSellingPrices(productId, sellingPriceParent, baseChildPrice, sellingPriceChild, true);
//                                                                                          preserveOverrides ─┘
```
`batch.repository.ts:332-342` with `preserveOverrides = true` updates **only** `selling_price_parent` / `selling_price_child` and leaves the overrides untouched.

**Result:** the operation reports "N batches updated", the batches table shows the new price, and the POS keeps charging the old one. Silent, and it reports success.

**Fix:** `updateSellingPricesByProduct` must pass `preserveOverrides = false` (which zeroes `selling_price_parent_override` — `batch.repository.ts:348`), the same as the bulk-margin and manual paths (`batch.service.ts:450` and `:493`). Longer term, remove the dual base/override columns: they encode no information the base column cannot, and every read site has to remember the `||` precedence. If they stay, add an integration test asserting that after any price-update path, `_deductFIFO` returns the new price.

---

## D2 🟠 Receiving a purchase silently overwrites deliberate per-batch prices

`src/core/services/purchase.service.ts:1103-1115`
```sql
UPDATE batches
SET selling_price_parent = ?, selling_price_parent_override = ?,
    selling_price_child  = ?, selling_price_child_override  = ?,
    version = version + 1
WHERE product_id = ? AND status = 'active' AND id != ?
```
Also `BatchService.create` → `propagateSellingPrices` (`batch.service.ts:88-91`).

The rationale in the comment is sound (FIFO would otherwise delay a price rise until old stock clears). But it is unconditional: a manually discounted near-expiry batch, or a price a pharmacist set deliberately last week, is overwritten by whatever price was typed on the new invoice line — including a typo. The audit event (`purchase.service.ts:1118`) records the new price and a count, **not the previous prices**, so there is nothing to roll back to.

**Fix:** record `oldValues` (batch id → previous prices) in the event so it is reversible; skip batches whose `updated_at` shows a manual price edit more recent than the last purchase; and show the operator a "this will re-price N existing batches from X to Y" confirmation during invoice entry.

---

## D3 🟡 `margin_over_cost` computes markup, not margin

`src/core/services/batch.service.ts:406-409`
```ts
const basis = opts.mode === 'margin_over_cost' ? p.latest_cost : p.current_sell;
const raw = (basis * (100 + opts.percent)) / 100;
```
At cost 1,000 and "25%", this produces 1,250 — a 25% **markup**, which is a **20% margin**. An owner setting "30% margin" across the catalogue gets 23% and will not notice until the year-end numbers are short.

**Fix:** keep the arithmetic (markup is the more common retail intent) and rename the mode and its UI label to `markup_over_cost` / "Markup on cost". Or add a true margin mode: `raw = cost / (1 - pct/100)`. Show the resulting margin % alongside the markup % in the preview table so the two can never be confused.

---

## D4 🟡 Bulk price updates are not reversible

`applyBulkPriceUpdate` (`batch.service.ts:443-460`) and `applyManualPriceUpdate` (`:467`) both emit a single event carrying the **new** prices and the options — no previous values. A mistaken 200% run across the catalogue can only be undone by restoring a backup.

**Fix:** capture `product_id → previous parent/child price` in the transaction and store it in `oldValues`. That alone enables an "undo last price update" action driven from the audit log.

---

# E. Reports

## E1 🟠 Inventory Valuation and the Dashboard value different stock

| Query | Filter on batches |
|---|---|
| Dashboard (`report.repository.ts:361`) | `quantity_base > 0 AND status = 'active' AND expiry_date >= date('now')` |
| Inventory Valuation (`report.repository.ts:284`, `:302`) | `quantity_base > 0` **only** |

Valuation therefore includes **expired** and **quarantined** stock at full cost and full retail. The two screens show different totals for the same moment, and the larger one is the wrong one — it books unsellable stock as an asset.

**Fix:** unify. Either apply the dashboard's filter to valuation, or (better) return valuation split into `sellable / expired / quarantined` columns so the write-off exposure is visible instead of hidden. Extract the filter into a shared SQL constant next to `COST_PER_CHILD_SQL`.

---

## E2 🟠 Reorder and Dead-Capital treat expired stock as stock

`getReorderRecommendations` (`report.repository.ts:211`) and `getDeadCapital` (`:245`) both join:
```sql
LEFT JOIN batches b ON p.id = b.product_id AND b.quantity_base > 0
```
with no status or expiry filter.

- **Reorder:** a product whose entire stock expired last month counts as fully stocked → it is **not** recommended for reorder → it silently goes out of stock on the shelf.
- **Dead capital:** expired stock inflates `stock_value`, mixing "slow-moving" with "already worthless" in one number.

Additionally `getReorderRecommendations` derives velocity as `SUM(quantity_base) / 30.0` over the last 30 days regardless of how long the product has been stocked, so a product introduced 3 days ago gets a velocity 10× too low.

**Fix:** add `AND b.status = 'active' AND b.expiry_date >= date('now')` to both joins. For velocity, divide by `MIN(30, days_since_first_batch)`.

---

## E3 🟡 Reconciliation recomputes historical purchases at the *current* conversion factor

`report.repository.ts:496-500`
```sql
PurchaseTotals AS (
  SELECT pi.product_id, SUM(pi.quantity_received * COALESCE(NULLIF(p.conversion_factor, 0), 1)) as qty
  FROM purchase_items pi JOIN products p ON pi.product_id = p.id
  GROUP BY pi.product_id
)
```
`quantity_received` is in parent units and is multiplied by **today's** cf, while `SalesTotals` uses the historical `quantity_base` recorded at sale time. Any cf change (see B2) makes the two sides use different scales, and the product shows a permanent phantom variance that no physical count can clear.

**Fix:** store `conversion_factor_snapshot` on `purchase_items` at insert time (mirroring `transaction_items`) and use it here. `transaction_items` already proves the pattern works.

---

## E4 🟡 Top-products revenue ignores checkout discounts

`report.repository.ts:175-183` sums `ti.line_total`, which is the pre-checkout-discount figure. `ti.checkout_discount_allocation` exists precisely to attribute the order-level discount to lines, and is not subtracted. Products sold mostly in discounted baskets look more profitable than they are.

**Fix:** `SUM(ti.line_total - COALESCE(ti.checkout_discount_allocation, 0)) as revenue`, and subtract the same from `profit`.

---

# F. Data Layer & Concurrency

## F1 🟠 A `BEGIN` is connection-wide — unrelated writes get swept into someone else's transaction

`src/core/repositories/sql/base.repository.ts:62-91`

The serial `_txQueue` guarantees two `inTransaction` calls never interleave. It does **not** guard plain `run()` / `runImmediate()` calls, which every repository makes freely. Because all repositories share one `better-sqlite3` connection (`createRepositories`), any write issued while a transaction is open joins that transaction and is committed or **rolled back with it**.

Realistic trigger: a sale is in `inTransaction`, and between two awaits the audit listener, the recurring-expense generator, or a settings write fires. If the sale then throws `ConflictError`, the `ROLLBACK` at line 77 silently discards that unrelated write too — and `createSale` retries the sale (line 93), so the sale succeeds and the collateral write is simply gone.

**Fix (pick one):**
- Route *all* writes through the queue: have `run`/`runImmediate` await `_txQueue` when it is pending.
- Or use a dedicated connection for background/audit writes.
- Or use `better-sqlite3`'s native `db.transaction(fn)` for genuinely synchronous units of work so no `await` can occur inside a `BEGIN`.

The third is the cleanest: today every `inTransaction` body is `async` but every statement inside it resolves synchronously, so the `await` points are gratuitous and are exactly what creates the window.

---

## F2 🟠 Nested `inTransaction` deadlocks

`base.repository.ts:62-68`
```ts
const prev = this._txQueue.catch(() => {});
const done = new Promise<void>((resolve) => { releaseQueue = resolve; });
this._txQueue = done;
await prev;                      // ← inner call waits on the outer's `done`
```
An inner `inTransaction` awaits the outer's completion promise, which only resolves after the inner returns. The process hangs with no error and no timeout.

No current path nests (verified), but the trap is one refactor away: `BatchService.reportDamage`, `CycleCountService.complete`, `PurchaseService.*` and `TransactionService.*` all open transactions, and services calling each other is a normal thing to do.

**Fix:** add re-entrancy detection — track `_txDepth`; if already inside a transaction, run `fn()` inline (join the outer transaction) instead of queueing. Or throw a loud `InternalError('nested transaction')` so it fails fast in development instead of hanging in production.

---

## F3 🟡 Audit writes are fire-and-forget from inside transactions

`src/core/events/audit.listener.ts:23-35`
```ts
private _logSafe(fn: () => Promise<void>, eventType: string): void {
  fn().then(...).catch(...);      // not awaited
}
```
Services emit inside `inTransaction`; the listener's write lands on a microtask, so whether it falls inside or outside the `BEGIN` is non-deterministic. Combined with F1, an audit row can be rolled back with an unrelated failure. Failures are only `console.error`'d — an audit trail can develop holes with no user-visible signal.

**Fix:** buffer events emitted during a transaction and flush them after `COMMIT` (an `EventBus` "transactional outbox"), so audit rows are written exactly once, after the fact they describe is durable. Surface repeated failures (`_failureCount`) in the UI rather than only the console.

---

## F4 🟡 Two different clocks in the schema

- Timestamps: `datetime('now', 'localtime')` — 29 uses in `migration.repository.ts`, all `created_at` defaults.
- Expiry comparisons: `date('now')` — **UTC** (`batch.repository.ts:69, 83, 216, 228, 289, 311, 318, 340, 353`; `product.repository.ts:12, 22, 28`).
- JS-side: `_isBatchExpired` (`transaction.service.ts:812-817`) builds a **local** date string.

Sudan is UTC+2, so between 00:00 and 02:00 local the UTC date is still yesterday. A batch expiring today is sellable in SQL but rejected by the JS check (or vice versa depending on the path), and dashboard "expired count" disagrees with what POS will actually sell.

**Fix:** use `date('now','localtime')` everywhere expiry is compared, matching how timestamps are stored. Add a single `TODAY_SQL` constant so this cannot drift again.

---

# I. Product & Transaction History / Traceability

> Deep-dive requested separately. The audit trail exists and fires on every mutation, but it cannot answer the three questions an owner actually asks: *what happened to this product?*, *what did this cost/price used to be?*, and *who changed this batch?*

## I1 🔴 `audit_logs` cannot be queried by record — there is no "history of this product/batch"

`src/core/repositories/sql/audit.repository.ts:30-73` — the only filters are `start_date`, `end_date`, `user_id`, `action`, `table_name`. **There is no `record_id` filter.**

Consequences:
- `BatchHistoryTab` can only ask for *all* batch events, ever (`BatchHistoryTab.tsx:58`: `{ table_name: 'batches', page, limit: 25 }`).
- There is **no way to ask "show me everything that happened to batch #412"** or "…to product #87" from any screen or any API.
- `AuditPage` (`src/renderer-react/components/admin/AuditPage.tsx:233-237`) exposes the same four filters — date, user, action, table. Same limitation.

The indexes reinforce it: `idx_audit_created`, `idx_audit_user_date` (`migration.repository.ts:377, 383`). **Nothing on `(table_name, record_id)`**, so even adding the filter would full-scan a table that grows by several rows per sale.

**Fix**
```sql
CREATE INDEX IF NOT EXISTS idx_audit_record ON audit_logs(table_name, record_id, created_at DESC);
```
```ts
// audit.repository.ts getAll()
if (filters.record_id) { conditions.push('al.record_id = ?'); params.push(filters.record_id); }
```
Then add a **Product History** panel (see I4) and a per-batch history drawer opened from the batches table.

---

## I2 🔴 `audit_logs.record_id` does not reliably point at a row in `table_name`

Two price paths write a **product** id into a row labelled `table_name = 'batches'`:

`src/core/services/purchase.service.ts:1118-1126`
```ts
this.bus.emit('entity:mutated', {
  action: 'PROPAGATE_SELLING_PRICE', table: 'batches',
  recordId: productId, userId,          // ← product id, table says batches
```
`src/core/services/batch.service.ts:379-383`
```ts
action: 'BULK_UPDATE_BATCH_PRICES', table: 'batches',
recordId: productId, userId,          // ← same
```

Others write `recordId: null` for bulk operations (`batch.service.ts:455`, `:498`; `product.service.ts:183`).

**Impact:** this is a latent data-integrity fault in the audit log itself. It is invisible today only because nothing queries by `record_id` — the moment I1 is fixed, `PROPAGATE_SELLING_PRICE` rows will attach themselves to whichever *batch* happens to share that id number, silently fabricating history for an unrelated batch.

**Fix (do this before or with I1, never after):**
- Change both to `table: 'products', recordId: productId`, since a product-wide re-price is genuinely a product-level event.
- For the null-recordId bulk events, add a `scope: 'bulk'` marker in `newValues` and the affected product ids, so the event is still attributable.
- Add a check constraint or a dev-mode assertion in `AuditListener` that `recordId` is null whenever the action is a bulk action, and non-null otherwise.

---

## I3 🔴 Almost no mutation records its **old** values — you can see what changed *to*, never *from*

Audited every `entity:mutated` emission that touches a product or batch:

| Action | Source | `oldValues` recorded |
|---|---|---|
| `UPDATE_PRODUCT` | `product.service.ts:111-115` | **`{ name }` only** |
| `UPDATE_BATCH` | `batch.service.ts:232-235` | **none** |
| `CREATE_BATCH` | `batch.service.ts:97-105` | n/a — but **no prices captured** |
| `DELETE_BATCH` | `batch.service.ts:522-526` | no `quantity_base` (see B1) |
| `BULK_UPDATE_BATCH_PRICES` | `batch.service.ts:379-383` | none |
| `BULK_MARGIN_PRICE_UPDATE` | `batch.service.ts:453-457` | none |
| `BULK_MANUAL_PRICE_UPDATE` | `batch.service.ts:496-503` | none |
| `PROPAGATE_SELLING_PRICE` | `purchase.service.ts:1118-1127` | none |
| `CASCADE_CF_CHANGE` | `product.service.ts:101-106` | cf only — **no quantity deltas** |
| `REPORT_DAMAGE` | `batch.service.ts:275-280` | ✅ correct — qty + status |
| `REVERSE_ADJUSTMENT` | `batch.service.ts:329-334` | ✅ correct |

So for a product edit, `newValues` is the **partial patch** the client sent and `oldValues` is `{ name }`. Change the selling price, min stock level, barcode or category and the previous value is gone forever.

This is the core reason the history feature cannot answer *"what was this priced at last month, and who changed it?"* — the data was never captured.

**Impact on the two 🔴 stock bugs:** B1 (batch delete) and B2 (cf rescale) are unrecoverable *specifically because* of this. With proper `oldValues` both would at least be reconstructable after the fact.

**Fix:** a small helper used at every mutation site:
```ts
function diff(before: Record<string, unknown>, patch: Record<string, unknown>) {
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) {
    if (before[k] !== patch[k]) { oldValues[k] = before[k]; newValues[k] = patch[k]; }
  }
  return { oldValues, newValues };
}
```
Both services already load `existing` before updating (`product.service.ts:78`, `batch.service.ts:112`), so the before-state is in hand — it is simply discarded. This is a cheap, high-value fix.

---

## I4 🟠 There is no product-information history view at all

`src/renderer-react/components/inventory/` contains `BatchHistoryTab.tsx` but **no product equivalent**. Product edits (`UPDATE_PRODUCT`, `CREATE_PRODUCT`, `DELETE_PRODUCT`, `CASCADE_CF_CHANGE`, `BULK_CREATE_PRODUCTS`) are only reachable through the global `AuditPage` with `table_name = 'products'` — an undifferentiated firehose across the whole catalogue, with no per-product filter (I1).

**Fix:** once I1 lands, add a **History** tab to the product detail view showing, merged and time-ordered:
- product field edits (`audit_logs` where `table_name='products' AND record_id=?`),
- batch events for that product (`table_name='batches'` joined via `batches.product_id`),
- stock movements (`inventory_adjustments` where `product_id=?`),
- sales/returns (`getSalesByProduct` — already exists),
- purchases (`getSuppliersByProduct` — already exists).

All five data sources exist. What is missing is the `record_id` filter and one screen that unions them.

---

## I5 🟠 Batch history search only searches the 25 rows currently on screen

`src/renderer-react/components/inventory/BatchHistoryTab.tsx:71-78`
```ts
const q = search.trim().toLowerCase();
const visible = q
  ? entries.filter(e => e.action.toLowerCase().includes(q) || ... )   // entries = current page only
  : entries;
```
`entries` is one page of 25 rows fetched at line 58. The search box filters **that page**, client-side — while the pagination footer keeps showing the unfiltered `total`.

**Reproduction:** 4,000 batch-history rows. Search "DELETE". You get whatever DELETE rows happen to be in rows 1–25 — probably zero — and the footer says "4,000 results". The user concludes no batches were deleted.

This is worse than having no search: it produces confident false negatives on exactly the question ("was this stock deleted, and by whom?") that the history screen exists to answer.

**Fix:** push the search term to the server as a filter over `action`, `username`, `record_id` and the `old_values`/`new_values` JSON text, and paginate the filtered set. Until then, disable the box and label it "filter this page" rather than "Search".

---

## I6 🟡 The batch-history action list omits several batch-mutating actions

`BatchHistoryTab.tsx:20-23`
```ts
const BATCH_ACTIONS = [
  'CREATE_BATCH', 'UPDATE_BATCH', 'DELETE_BATCH',
  'REPORT_DAMAGE', 'REVERSE_ADJUSTMENT', 'BULK_UPDATE_BATCH_PRICES',
];
```
Actions the services actually emit against batches that are **not** in this dropdown:

| Missing action | Emitted at |
|---|---|
| `RESTORE_BATCH` | `transaction.service.ts:272` |
| `PROPAGATE_SELLING_PRICE` | `purchase.service.ts:1118` |
| `BULK_MARGIN_PRICE_UPDATE` | `batch.service.ts:454` |
| `BULK_MANUAL_PRICE_UPDATE` | `batch.service.ts:497` |
| `VOID_STOCK_SKIP` | `transaction.service.ts:450` |
| `CASCADE_CF_CHANGE` | `product.service.ts:102` — logged under `products`, but it **rewrites batch quantities** (B2) |

They appear under "all", but a user filtering for price changes will not find the bulk ones, and `CASCADE_CF_CHANGE` — the single most destructive stock operation in the system — never appears in batch history at all.

**Fix:** derive the list from a shared constant exported next to the emitting services rather than hand-maintaining it in the component. Add `CASCADE_CF_CHANGE` to the batch view explicitly (or emit a per-batch event from the cascade, which B2's fix should do anyway).

---

## I7 🟡 History is displayed from `new_values` only, so an edit reads as an assertion

`BatchHistoryTab.tsx:33-43` (`summarize()`) renders one JSON blob as `key: value, key: value`. Because most batch events carry no `old_values` (I3), the row for a price edit reads `selling_price_parent: 4500` with no indication of what it was — indistinguishable from the batch having been created at that price.

**Fix (after I3):** render `field: old → new`, and grey out unchanged fields. The `diff()` helper above makes this a display-only change.

---

## I8 🟡 Purging the audit log silently breaks return recovery

`AuditService.purgeOlderThan` (`src/core/services/audit.service.ts:11-14`, default 365 days) hard-deletes rows. But `AuditRepository.getDeletedBatchExpiry` (`audit.repository.ts:83-97`) reads `DELETE_BATCH` audit rows to recover the expiry date of a deleted batch during a return (`transaction.service.ts:255`).

After a purge, that lookup returns `undefined` and the reconstructed batch silently falls back to `expiry_date: '2099-12-31'` (see C5).

More broadly: the audit log is the **only** record of product and batch edits. Purging it is not log rotation — it is the destruction of the inventory paper trail, and the operation is exposed with no warning about that.

**Fix:** never purge rows whose `table_name` is `products`, `batches`, or `transactions`; restrict purging to high-volume, low-value rows (`LOGIN`/`LOGOUT`). Better: stop depending on the audit log as a functional data source — add a `deleted_batches` archive table (or a `deleted_at` soft-delete column on `batches`, which also fixes B1) and read expiry from there.

---

## I9 🟡 A return's row in Product Sales History is dated to the sale, not the refund

Consequence of **A2**, restated here because it lands squarely on this feature. `getSalesByProduct` (`transaction.repository.ts:143-161`) selects `t.created_at` and orders by it. Since returns inherit the parent sale's `created_at`, a refund processed today sorts into last week's rows.

`transaction.repository.ts:125-126` — the `start_date`/`end_date` filters use `DATE(t.created_at)`, so filtering the history to "today" **excludes today's returns entirely**.

**Fix:** covered by A2. If A2's back-dating is retained for revenue-cohort reasons, this screen must additionally expose the true event time — which means the `returned_at` column is required regardless.

---

## I10 🔵 Purchase history per product exists but is not reachable from the product

`PurchaseService.getSuppliersByProduct` (`purchase.service.ts:158-168`) and `getProductsBySupplier` (`:140-152`) are implemented and wired, but the UI entry point is `SupplierProductsTab` — supplier-first. There is no "which suppliers have I bought this from, at what cost, and when" view opened from a product.

The data is all there; only the navigation is missing. Worth folding into the I4 unified history panel.

---

# G. POS Performance

## G0 🔴 Adding one item to the cart re-renders the entire product catalogue

The single largest POS performance problem. Three independent causes compound:

**(1) `POSPage` subscribes to the whole cart store.**
`src/renderer-react/components/pos/POSPage.tsx:28`
```ts
const cartStore = useCartStore();      // no selector → re-renders on ANY cart change
```
Every `addItem`, `updateQuantity`, `updateDiscount`, `removeItem` re-renders `POSPage`.

**(2) Every child prop is a fresh reference each render.**
`POSPage.tsx:48` — `function handleProductSelect(...)` is declared in the component body, so it is a new function identity on every render. Passed at `POSPage.tsx:141`:
```tsx
<ProductGrid onProductSelect={handleProductSelect} refreshKey={productRefreshKey} />
```
`ProductGrid` is not memoized either, so it re-renders regardless.

**(3) `ProductCard` is not memoized and is expensive.**
`src/renderer-react/components/pos/ProductCard.tsx:49`
```ts
export function ProductCard({ product, onClick }: ProductCardProps) {
  const { t } = useTranslation();          // ← context subscription, per card
```
Rendered as `onClick={() => onProductSelect(product.id)}` (`ProductGrid.tsx:276`) — a new closure per card per render. Each card that has `usage_instructions` also mounts a Radix `Tooltip` + `TooltipTrigger` + `TooltipContent` (`ProductCard.tsx:83-100`), each with its own state machine and portal wiring.

**Net:** pressing `+` on a cart line re-renders N `ProductCard`s, each re-subscribing to i18n and reconciling a Radix tooltip. At a few thousand products this is a visible freeze **between every keystroke at the till** — the worst possible place for it.

**Fix (in order of impact, all small):**
```ts
// 1. POSPage — subscribe narrowly
const cartItems  = useCartStore((s) => s.items);
const cartClear  = useCartStore((s) => s.clear);
const cartAdd    = useCartStore((s) => s.addItem);

// 2. Stabilise callbacks
const handleProductSelect = useCallback((id: number) => { ... }, []);

// 3. Memoise the card
export const ProductCard = memo(function ProductCard({ product, onClick }: Props) { ... });
// and pass a stable per-id handler, or move onClick to the grid via event delegation
```
Hoist `useTranslation()` out of `ProductCard` — resolve the two or three needed strings once in `ProductGrid` and pass them down, or wrap the tooltip content in a lazily-rendered child so `t` is only called for the card actually being hovered.

---

## G1 🟠 The POS grid loads the entire catalogue — on mount, on every category change, on every short query, and after every sale

`src/renderer-react/components/pos/ProductGrid.tsx:125-140`
```ts
if (debouncedQuery.length >= 2) {
  result = await api.products.search(debouncedQuery);        // LIMIT 100
  if (categoryId !== ALL_CATEGORIES) result = result.filter(...);   // client-side
} else {
  result = await api.products.getAll();                      // NO LIMIT
  if (categoryId !== ALL_CATEGORIES) result = result.filter(...);   // client-side
}
```

Every one of these triggers a **full, unbounded catalogue fetch**:
- initial mount;
- changing the category filter (the filter is applied in JS afterwards, so it never reduces the query);
- typing the 1st character, and deleting back to 1 character — each crossing of the 2-char boundary;
- `refreshKey` changing, which `POSPage.tsx:66` does **after every completed sale**.

The underlying query is itself heavy — `src/core/repositories/sql/product.repository.ts:32-40` runs **three** correlated subqueries per row (`STOCK_SUBQUERY` at line 10, plus two near-identical FIFO price subqueries at lines 16 and 23 that scan the same batches for the same row). At 5,000 products that is ~15,000 index seeks, then a multi-megabyte structured-clone across the IPC bridge, then a full re-render of an unvirtualised grid.

**Fix**
1. Make the category filter a **server** parameter and route the grid through the already-paginated `getList()` (`product.repository.ts:42`) instead of `getAll()`.
2. Collapse the two price subqueries into one lookup of the FIFO batch returning both parent and child price.
3. After a sale, refresh only the products that were just sold — `productRefreshKey` currently discards and refetches everything.
4. Lower the search threshold to 1 character (or make the empty state explicit) so a single character never falls back to "load everything".

---

## G2 🟠 The product grid is not virtualised

`ProductGrid.tsx:271-279` renders `products.map(...)` in full inside a `ScrollArea`. Combined with G1 (unbounded fetch) that is one DOM subtree per catalogue item — plus a Radix tooltip for every product with usage instructions — all mounted, all reconciled on every render (G0).

**Fix:** `@tanstack/react-virtual` over the grid, or cap the no-query view to the top N most-sold products and require a search for the rest. The latter is arguably better POS UX anyway: at a till, nobody scrolls 5,000 cards.

---

## G3 🟡 A barcode scan fires two queries and gives no feedback when it fails

`ProductGrid.tsx:192-207` — the scanner types the barcode (each character updating `query`) and presses Enter. The 250 ms debounce (line 93) fires `api.products.search(barcode)` while the Enter handler independently fires `api.products.findByBarcode(barcode)`. Two round-trips per scan.

If the barcode is unknown, the `catch` is empty and the comment says "normal search results are already showing" — but a `search()` on an unmatched barcode returns nothing, so the cashier gets a **silent no-op**: no beep, no toast, no "unknown barcode". They will scan again, and again.

**Fix:** suppress the debounced search while an Enter-triggered lookup is in flight; on a miss, `toast.error(t('Barcode not recognised'))` and keep the text in the box so it can be corrected.

---

## G4 🔵 The focus-restore handler schedules an uncancelled timer on every focus event

`ProductGrid.tsx:161-183`
```ts
const refocusSearch = useCallback(() => { setTimeout(() => searchInputRef.current?.focus(), 50); }, []);
...
document.addEventListener('focusin', handler);
```
Every focus change anywhere in the document that is not inside a dialog/popper/listbox queues a 50 ms timer, none of which are stored or cleared. The behaviour is right for a barcode workflow (dialogs are correctly excluded, and cart +/- buttons refocusing the scanner is desirable), but the timers accumulate during a busy session and the component can call `.focus()` after unmount.

**Fix:** keep one timer id in a ref, `clearTimeout` before re-arming, and clear it in the effect cleanup.

---

## G5 🟠 The full product catalogue is fetched, unbounded, from 14 other components

Outside POS, `api.products.getAll()` is called by: `BatchesTab` (**4 call sites** — lines 169, 367, 1000, 1019), `AdjustmentsTab` (×2 — 113, 127), `ProductExportDialog` (×2 — 59, 125), `QuickStockEntryPage` (×2 — 80, 248), `AddItemsDialog` (×2 — 313, 352), `BulkPriceUpdatePage:91`, `CycleCountsTab:103`, `ProductImportDialog:304`, `SalesHistoryTab:85`, `SupplierProductsTab:48`, `CreatePurchaseFlow:403`.

Several use it purely as a client-side search index — e.g. `SalesHistoryTab.tsx:92-104` loads every product then filters in JS to power a 20-result typeahead.

**Fix:** one shared, invalidated products store (Zustand) feeding all of them, and a proper server-side typeahead endpoint for the search boxes. Same underlying query fix as G1.

---

## G6 🟡 `findByName` cannot use an index and runs once per imported invoice line

`src/core/repositories/sql/product.repository.ts:118-120`
```sql
WHERE p.is_active = 1 AND LOWER(TRIM(p.name)) = LOWER(TRIM(?))
```
Wrapping the column in `LOWER(TRIM(...))` defeats `idx_products_name`. `PurchaseService._processItems` calls it once per item (`purchase.service.ts:987`), so a 200-line invoice performs 200 full product-table scans **inside a single open transaction** — blocking every other write for its duration (see F1).

**Fix:** `CREATE INDEX idx_products_name_norm ON products(LOWER(TRIM(name)))`. SQLite supports expression indexes and will match this expression exactly. Verify with `EXPLAIN QUERY PLAN`; the partial UNIQUE index referenced at `purchase.service.ts:974` may already serve, in which case just confirm it is being used.

---

## G7 🔵 Unbounded adjustment queries

`BatchRepository.getAdjustments` (`batch.repository.ts:249-271`) has no `LIMIT` and joins products, batches and users — the Adjustments tab loads the entire movement history every time. `BatchService.reverseAdjustment` (`batch.service.ts:303`) additionally pulls every adjustment for a batch just to string-match one `reason` (see B6).

**Fix:** paginate `getAdjustments`; replace the reversal lookup with the indexed `reverses_adjustment_id` column proposed in B6.

---

# H. UX & Failure Handling

## H1 🟠 The cart never merges duplicate lines, and clamps stock per line

`src/renderer-react/stores/cart.store.ts:53`
```ts
addItem: (item) => set({ items: [...get().items, item] }),
```
`:61-71`
```ts
const maxQty = item.availableStock ?? Infinity;
const clampedQty = Math.min(qty, maxQty);
```

Scanning the same barcode twice creates two lines. Each is clamped against the **full** available stock independently, so two lines of 10 pass client validation with only 10 in stock. The error appears at the very end, from the server, after the customer is waiting at the till — and the cashier has no indication which line is the problem.

This also creates the duplicate-batch sale that C1 mishandles on return.

**Fix:** merge on `(product_id, batch_id, unit_type, unit_price, discount_percent)` — sum the quantities. Clamp against remaining stock across all lines of the same batch. Show "only N left" inline on the line rather than failing at checkout.

---

## H2 🟠 Quantity edits are silently clamped

Same code path (`cart.store.ts:68`). The user types 10, the field shows 3, nothing explains why. `updateQuantity` also returns silently on a non-integer or `< 1` (line 62), so the input appears frozen.

**Fix:** return a status from `updateQuantity`, and toast/inline-warn "Only 3 available in this batch". Allow the field to hold the typed value while showing a validation state, rather than mutating what the user typed.

---

## H3 🟡 Checkout switches payment method while the user is typing

`src/renderer-react/components/pos/CheckoutModal.tsx:387-395`
```ts
onChange={(e) => {
  setBankAmount(val);
  if (parsed >= totalAmount && totalAmount > 0) setPaymentMethod('bank_transfer');
}}
```
Entering a bank amount for a 400 total: typing `5`, `50`, `500` flips the method to Bank Transfer at the third keystroke and the Mixed section disappears mid-edit. `bankAmount` is not cleared, so switching back re-triggers it.

**Fix:** validate on blur/submit, not per keystroke. Offer "this covers the full total — switch to Bank Transfer?" as a confirmation rather than acting silently.

---

## H4 🟡 `window.prompt` for the held-sale note

`src/renderer-react/components/pos/POSPage.tsx:81`
```ts
const promptResult = window.prompt(t('Customer note (optional)'));
```
A native OS dialog: unstyled, untranslatable beyond the message, not RTL-aware, blocks the renderer, and is disabled in some Electron sandbox configurations (the code already has a `try/catch` acknowledging this). The app has a full dialog system (`components/ui/dialog`) used everywhere else.

**Fix:** replace with a small controlled dialog.

---

## H5 🟡 `cart.extraDiscount` is dead state shadowed by a local copy — a latent double-count

`cart.store.ts` defines `extraDiscount`, `setExtraDiscount`, and folds it into both `getDiscountTotal()` (line 88) and `getTotal()` (line 93). Nothing ever calls `setExtraDiscount` — `CheckoutModal` keeps its own local `extraDiscount` state (line 68) and adds it again:

`CheckoutModal.tsx:152`
```ts
discount_amount: lineDiscountTotal + parsedExtraDiscount,   // lineDiscountTotal already includes cart.extraDiscount
```
Harmless today only because the store's field is permanently 0. The moment anyone wires a cart-level discount control to the store, the discount is counted twice and the sale total silently drops.

**Fix:** delete `extraDiscount`/`setExtraDiscount` from the store, or move the checkout's local state into it and stop adding it twice. One owner for the value.

---

## H6 🟡 Held sales can be deleted by any user

`src/core/services/held-sale.service.ts:52-59`
```ts
async delete(id: number, userId: number): Promise<void> {
  Validate.id(id);
  await this.repo.delete(id);     // no ownership / role check
```
`getAll` correctly scopes to the requesting user unless admin (line 14-19); `delete` does not. Any cashier can delete a colleague's parked sale by guessing a sequential id.

Related: a recalled held sale restores `unit_price`, `batch_id` and `availableStock` from a snapshot. If the batch sold out or was re-priced meanwhile, the recalled cart shows stale prices and fails at checkout with no explanation.

**Fix:** load the held sale, verify `user_id === userId || role === 'admin'`, else throw `PermissionError`. On recall, re-validate each line against current batch state and flag changed prices/unavailable batches before the cashier reaches checkout.

---

## H7 🔵 Three redundant error-unwrapping layers, and production hides the reason

IPC handlers return `{ success:false, error, code }` instead of throwing (`src/transport/middleware/error-handler.ts:48-56`). Three separate places compensate:

1. `src/main/preload.js:8-22` — `invoke()` throws. **This is the one that runs.**
2. `src/renderer-react/api/index.ts:20-30` — `throwIfError()`, exported and largely unused.
3. `CheckoutModal.tsx:183-191` — checks `result?.error` inline; unreachable now that (1) throws.

Not a bug, but three mechanisms mean the next contributor will guess wrong. Also:

`error-handler.ts:36-40`
```ts
if (process.env.NODE_ENV !== 'production') { ...err.message... }
return { ...error: 'An unexpected error occurred', code: 'INTERNAL_ERROR' };
```
In a packaged build, every non-`AppError` (including SQLite `UNIQUE constraint failed`, which surfaces when a product is renamed onto an existing name) becomes an untranslated "An unexpected error occurred" with nothing actionable.

**Fix:** delete (2) and (3), keep the preload wrapper as the single boundary. Map SQLite constraint errors to `ValidationError` with field names *before* they reach the generic handler (`BatchService` already does this for `idx_batches_product_batch` at `batch.service.ts:76-79` — apply the same to product name, barcode, and supplier name).

---

# Suggested Order of Work

Fixes are grouped so that each phase is independently shippable and testable.

### Phase 1 — Stop the bleeding (money & stock correctness)
| | Finding | Why first |
|---|---|---|
| 1 | **I3** capture `oldValues` everywhere | **Do this before anything else.** It is a ~1 hour change, and until it lands every other fix ships without a way to verify or reverse what it did. It is also the reason B1 and B2 are unrecoverable. |
| 2 | **A1** cash_tendered | Every shift is wrong today; prerequisite for trusting any cash report |
| 3 | **B1** batch delete destroys stock | Unrecoverable data loss, one click away |
| 4 | **B2** conversion-factor rescale | Unrecoverable, and inflates the balance sheet |
| 5 | **D1** price update is a no-op | Reports success while doing nothing |
| 6 | **B3** batch/product mismatch | Cheap fix, prevents cross-product corruption |

### Phase 2 — Make history usable (order matters within this phase)
**I2** (fix the wrong `record_id` values) → **I1** (add the `record_id` filter + index) → **I5** (server-side history search) → **I4** (unified product history panel) → **I6**, **I7**, **I8**, **I10**.

> **I2 must land before I1.** Adding a `record_id` filter while `PROPAGATE_SELLING_PRICE` and `BULK_UPDATE_BATCH_PRICES` still write a *product* id into `table_name='batches'` rows would attach fabricated history to unrelated batches.

### Phase 3 — POS responsiveness
**G0** (memoise + narrow the store subscription — biggest win, smallest diff) → **G1** (stop fetching the whole catalogue) → **G2** (virtualise) → **G3**, **G4**. Then **G5**/**G6** for the rest of the app.

G0 alone is roughly a 20-line change across three files and removes the freeze between keystrokes at the till.

### Phase 4 — Accounting truth
**A2** (return dating; also fixes **I9**) → **A4** (closed-shift protection) → **C2** (void leaves returns) → **A3** (expense shift) → **A6** (cash flow).
A2 is the largest change; do it with a documented cut-over date and leave historical rows untouched.

### Phase 5 — Reports & pricing accuracy
**E1**, **E2**, **E4** (share one SQL constant for "sellable stock"), then **D2**, **D3**, **D4**, **E3**.

### Phase 6 — Robustness
**F1**/**F2** together (same refactor), then **F3**, **F4**, **C1**, **C3**, **C4**, **B5**, **B6**, **B7**, **C5**.

### Phase 7 — Remaining UX
**H1**, **H2** (same file, and they fix C1's root cause), then **B4**, **H3**–**H7**, **G7**.

---

# Test Coverage This Audit Implies

The suites below do not currently exist and would have caught most of Phase 1–3.

| Test | Asserts |
|---|---|
| `cash-reconciliation.test.ts` | Cash sale with change → `expected_cash` equals opening + total, not opening + tendered |
| `return-attribution.test.ts` | Return created today lands on today's shift and today's date |
| `void-cascade.test.ts` | Voiding a sale with a return either fails or voids both |
| `price-propagation.test.ts` | After **every** price-update path, `_deductFIFO` returns the new price |
| `cf-change.test.ts` | Changing cf leaves `SUM(quantity_base)` unchanged |
| `batch-delete.test.ts` | Deleting a batch with stock either fails or writes an adjustment |
| `valuation-consistency.test.ts` | Dashboard inventory value == Valuation report total |
| `fifo-split-rounding.test.ts` | A parent line split across batches sums to price × qty exactly |
| `audit-oldvalues.test.ts` | Every product/batch mutation records the changed fields' previous values |
| `audit-record-id.test.ts` | For every emitted event, `record_id` identifies a real row in `table_name` (or is null for bulk) |
| `product-history.test.ts` | Editing a price twice then querying by `record_id` returns both edits, newest first, with old→new |

**POS render-cost regression guard** (React Testing Library, no DB needed):

| Test | Asserts |
|---|---|
| `pos-rerender.test.tsx` | Mutating the cart store does **not** re-render `ProductCard` (spy on a render counter) |
| `product-grid-fetch.test.tsx` | Changing the category filter issues **one** request carrying `category_id`, not a full `getAll()` |

> Note the pre-existing blocker recorded as `issues.md` #40b: `better-sqlite3` is built for Electron's ABI by `postinstall`, so Jest (Node ABI) cannot boot a real database. The integration suites above need that tooling decision resolved first — a pluggable `sql.js` test backend, running Jest under Electron, or a Node-ABI build for CI.

---

# Verified as NOT bugs

Checked during this pass and deliberately not reported:

- **Optimistic locking on batch edits** — `BatchForm` does send `version` (`BatchForm.tsx:249`) and `BatchService.update` compares it against a fresh read (`batch.service.ts:115-117`). Works. (It degrades to last-write-wins only for API callers that omit `version` — worth a server-side requirement, but not a live bug.)
- **`conversion_factor_snapshot` division by zero** — the column is `NOT NULL DEFAULT 1 CHECK(> 0)` (`migration.repository.ts:154`), so the COGS division in `getCashFlow` is safe.
- **Overpayment / underpayment schedule arithmetic** in `markPaymentPaid` (`purchase.service.ts:757-871`) — traced through overpay-partial, overpay-full and underpay cases; the `paid_amount = 0` convention keeps `getPaidTotal` and the installment sum consistent with `total_amount` in all three.
- **Sale FIFO atomicity** — `createSale` → `inTransaction` → optimistic-locked deductions with `ConflictError` retry is sound; the retry correctly re-runs FIFO from scratch.
- **`Money` rounding consistency** — `add`/`subtract`/`round` all use `Math.round` (fixed in the previous audit); the remaining `Math.trunc` in `multiply`/`percent`/`markup` applies to already-integer inputs.
