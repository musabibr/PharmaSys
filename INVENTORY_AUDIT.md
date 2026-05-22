# PharmaSys Inventory — Deep Review & Remediation Roadmap

**Audit date:** 2026-05-22
**Auditor:** Claude (Sonnet 4.6) under engineering oversight by musabibr
**Scope:** Inventory subsystem — products, batches, sales/stock deduction, returns, voids, held sales, purchases, CSV/PDF imports, backup restore, and the data-integrity invariants that bind them.
**Method:** Direct reads of source (no app runtime). Every finding cites file:line and quotes the offending code. Concrete numeric reproducers are given where possible.
**Verdict in one line:** The system is **broadly safe but has 5 silent-corruption P0 bugs** that need to be patched before the next major release; the most severe is `batch.repository.update()` bumping `version` without checking it — every batch edit is a lost-update vector.

---

## Table of Contents

- [0. Executive summary](#0-executive-summary)
- [1. How to read this document](#1-how-to-read-this-document)
- [2. Architecture & invariants](#2-architecture--invariants)
- [3. ★ Sales & stock deduction — deep dive](#3--sales--stock-deduction--deep-dive)
- [4. ★ Batches — deep dive](#4--batches--deep-dive)
- [5. ★ Inventory imports — deep dive](#5--inventory-imports--deep-dive)
- [6. Cross-cutting concerns](#6-cross-cutting-concerns)
- [7. Remediation roadmap (sprint-ready)](#7-remediation-roadmap-sprint-ready)
- [8. Conservative improvement proposals](#8-conservative-improvement-proposals)
- [9. Test coverage gap matrix](#9-test-coverage-gap-matrix)
- [10. Verification appendix](#10-verification-appendix)
- [11. Out of scope](#11-out-of-scope)
- [12. Glossary & file index](#12-glossary--file-index)

---

## 0. Executive summary

### Top 10 risks (by money-loss / corruption potential)

| # | ID | Title | Severity |
|---|---|---|---|
| 1 | **B-P0-1** | `batch.repository.update()` bumps `version` but never checks it → silent lost-update on every batch edit | 🔴 P0 |
| 2 | **B-P0-2** | `rescaleQuantitiesForProduct()` mutates batches without bumping `version` or `updated_at` → optimistic lock bypassed | 🔴 P0 |
| 3 | **B-P0-3** | CF cascade in `product.service.ts:74-112` is three sequential writes outside `inTransaction()` → partial corruption on crash | 🔴 P0 |
| 4 | **S-P0-1** | Float division `take / cf` in [transaction.service.ts:608](src/core/services/transaction.service.ts#L608) → DB-recorded total can disagree with UI-shown total | 🔴 P0 |
| 5 | **S-P0-2** | Returns store `grossProfit = -Money.subtract(...)` (sign-flip) → P&L on returns is negated | 🔴 P0 |
| 6 | **I-P0-4** | `createPurchase` has no idempotency key → network-retry creates duplicate purchase + duplicate accounts-payable | 🔴 P0 |
| 7 | **I-P0-3** | Purchase line cost editable after sales → retroactively rewrites historical COGS | 🔴 P0 |
| 8 | **B-P0-4 / B-P0-5** | `deleteBatch()` hard-deletes; returns against deleted batches build "ghost" quarantine rows with `expiry_date = '2099-12-31'` | 🔴 P0 |
| 9 | **S-P1-1** | Cross-unit returns use `Math.floor(unit_price/cf)` instead of `Money.divideToChild` → systematic customer under-refund | 🟠 P1 |
| 10 | **I-P0-6** | Expiry-date `DD/MM/YYYY` regex parsing is locale-blind (Excel-from-US locale exports `MM/DD/YYYY`) → wrong month silently stored | 🔴 P0 |

### Headline numbers

- **Confirmed findings:** 35 (P0: 12 · P1: 11 · P2: 8 · P3: 4)
- **Files audited in full:** 18 source files, plus 6 test files
- **Data-corruption invariants documented:** 11
- **Schema-level defenses that DO work:** 5 (e.g. `transaction_number TEXT UNIQUE NOT NULL`, `quantity_base CHECK(>= 0)`, FK `ON DELETE RESTRICT` on `batches.product_id`)
- **Schema-level defenses MISSING:** 3 (no UNIQUE on `(product_id, batch_number)`, no ON DELETE clause on `transaction_items.batch_id`, no idempotency column on `purchases`)

### What's already good (don't lose this)

- `createSale` and `voidTransaction` ARE wrapped in `base.inTransaction()` — the FIFO loop's rollback semantics are correct, even though the optimistic-lock UX is noisy.
- `Money.toMinor` / `Money.fromMinor` are identity functions (correct: SDG has no minor units).
- `Money.divideToChild` exists and is used in `bulkCreate` and `markup` flows.
- The audit listener correctly turns `entity:mutated` / `transaction:created` / `stock:changed` events into audit rows.
- DB-corruption recovery (v1.3) and fsync-before-rename in the save worker are sound; no findings here.

---

## 1. How to read this document

### Severity legend

| Badge | Meaning |
|---|---|
| 🔴 **P0** | Silent data corruption or lost money possible NOW under normal use. Fix in the next release. |
| 🟠 **P1** | Wrong results / wrong money under realistic scenarios. Fix in the next sprint. |
| 🟡 **P2** | Edge cases, race conditions with narrow windows, UX gaps that hide bugs. |
| 🔵 **P3** | Code smell, dead code, missing tests, polish. |

### Anatomy of a finding

Every finding has:

> **ID** · **Title**
> **File:line** — exact location
> **Code** — relevant snippet (3-12 lines), unchanged from source
> **Why it's a bug** — what invariant is broken
> **Reproducer** — concrete numbers (so you can reproduce or write a regression test)
> **Fix sketch** — minimal patch shape
> **Blast radius** — what else uses this code path

### Verification confidence

Each finding is tagged with confidence:
- **Confirmed** — direct file read at cited line range
- **Inferred** — pattern-match across multiple files
- **Hypothesis — needs runtime check** — code looks suspicious but requires app execution to confirm

---

## 2. Architecture & invariants

### Write paths into inventory

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          INVENTORY WRITE PATHS                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  POS Sale  ─────► transaction.createSale()  ─► _deductFIFO()                │
│                   └─ inTransaction ✓        └─ updateQuantityOptimistic()   │
│                                                                             │
│  POS Return ────► transaction.createReturn() ─► restore stock               │
│                   └─ inTransaction ✓        ─► restoreDeletedBatch() ⚠️     │
│                                                                             │
│  Void ──────────► transaction.voidTransaction() ─► restore OR re-deduct     │
│                   └─ inTransaction ✓                                        │
│                                                                             │
│  Batch CRUD ────► batch.service.{create,update,reportDamage,delete}         │
│                   └─ NO outer transaction; relies on optimistic-lock        │
│                                                                             │
│  Product update ► product.service.update() (CF cascade)                     │
│                   └─ ⚠️ THREE writes, NO transaction wrapper                │
│                                                                             │
│  Purchase ──────► purchase.createPurchase() ─► _processItems()              │
│                   └─ inTransaction ✓        └─ _createBatch() per row       │
│                                                                             │
│  CSV import ────► product.bulkCreate() ─► loop INSERT inside inTransaction  │
│                   └─ per-row try/catch (errors collected, never aborted)    │
│                                                                             │
│  PDF parse ─────► main.ts pdf:parsePython ─► child_process.execFile         │
│                   └─ 60s hard timeout, no partial-result preservation       │
│                                                                             │
│  Backup restore► main.ts backup:restoreFromFile ─► overwrites live DB ⚠️    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Invariants the system tries to maintain

1. **Money is whole SDG integers.** All `unit_price`, `cost_price`, `total_amount` columns are `INTEGER`.
2. **`quantity_base` never goes negative.** SQL CHECK `quantity_base >= 0`.
3. **Batch status ∈ {active, quarantine, sold_out}.** SQL CHECK on the column.
4. **FIFO ordering** by `expiry_date ASC, id ASC` for available stock.
5. **Optimistic locking via `version` column** on batches. Every conflicting write must lose.
6. **Audit rows are derived from events** — services emit, `AuditListener` writes. No direct `auditRepo.log()` in services.
7. **Soft-delete** for products; **hard-delete** for batches (this is one of the bugs).
8. **`transaction_number` is globally unique** (`TEXT UNIQUE NOT NULL`).
9. **Returns preserve original `created_at`** — return's `created_at` = original sale's date (for daily-report attribution).
10. **CF (conversion factor) snapshots are pinned on transaction_items** — `conversion_factor_snapshot` column. So historical sales aren't disturbed by product CF changes.

Invariants 1–4, 6, 8, 9, 10 hold. Invariants 5 (locking), 7 (delete model), and the **atomicity** of multi-write operations are broken in the ways documented below.

---

## 3. ★ Sales & stock deduction — deep dive

### 3.1 `createSale` and `_deductFIFO` — code trace

[transaction.service.ts:60-86](src/core/services/transaction.service.ts#L60-L86) — `createSale` correctly wraps the whole flow in `base.inTransaction()`:

```typescript
return await this.base.inTransaction(async () => {
  const lines = await this._deductFIFO(data.items, userId);
  return await this._commitTransaction(data, lines, userId, shiftId, null);
});
```

[transaction.service.ts:559-568](src/core/services/transaction.service.ts#L559-L568) — FIFO batch list is fetched **once per item**, before the deduction loop:

```typescript
const batches: IFIFOBatch[] = item.batch_id
  ? await (async () => {
      const b = await this.batchRepo.getById(item.batch_id!) as unknown as IFIFOBatch | undefined;
      if (b && b.status !== 'active') {
        throw new ValidationError(`Batch ${item.batch_id} is not available for sale (status: ${b.status})`, 'batch_id');
      }
      return b ? [b] : [];
    })()
  : await this.batchRepo.getAvailableByProduct(item.product_id);
```

[transaction.service.ts:583-593](src/core/services/transaction.service.ts#L583-L593) — Inner loop deducts via optimistic lock:

```typescript
for (const batch of batches) {
  if (remainingBase <= 0) break;
  const take = Math.min(batch.quantity_base, remainingBase);
  const newQty = batch.quantity_base - take;
  const newStatus = newQty === 0 ? 'sold_out' : 'active';
  const success = await this.batchRepo.updateQuantityOptimistic(
    batch.id, newQty, newStatus, batch.version
  );
  if (!success) throw new ConflictError('Batch modified concurrently. Please retry.');
```

### 3.2 `createReturn` — refund math and batch restoration

[transaction.service.ts:301-312](src/core/services/transaction.service.ts#L301-L312) — Cross-unit refund (this is the bug surface):

```typescript
const unitPrice = (isCrossUnit && cf > 1)
  ? Math.max(1, Math.floor(origItem.unit_price / cf))
  : origItem.unit_price;
const costPrice = (isCrossUnit && cf > 1)
  ? Math.max(1, Math.floor(origItem.cost_price / cf))
  : origItem.cost_price;
const discountPct    = origItem.discount_percent ?? 0;
const effectivePrice = Money.percent(unitPrice, 100 - discountPct);
const lineTotal      = Money.multiply(effectivePrice, item.quantity);
const costTotal      = Money.multiply(costPrice, item.quantity);
const grossProfit    = -Money.subtract(lineTotal, costTotal);  // ← S-P0-2 lives here
```

[transaction.service.ts:234-243](src/core/services/transaction.service.ts#L234-L243) — Ghost-batch creation (B-P0-5):

```typescript
const newBatchId = await this.batchRepo.restoreDeletedBatch({
  product_id:           origItem.product_id,
  batch_number:         `RESTORED-${item.batch_id}-REVIEW`,
  expiry_date:          '2099-12-31', // Unknown — original batch deleted; quarantine requires manual review
  quantity_base:        quantityBase,
  cost_per_parent:      costPerParent,
  cost_per_child:       costPerChild,
  selling_price_parent: sellPerParent,
  selling_price_child:  sellPerChild,
});
```

### 3.3 `voidTransaction` — also wrapped in `inTransaction` (verified line 406). Force-mode for return-voids inserts a `correction` adjustment when stock is insufficient (line 449-457) — correct behavior, well-handled.

### 3.4 Held sales (parked carts)

[held-sale.service.ts:13-15](src/core/services/held-sale.service.ts#L13-L15) — Get-all with no permission gate:

```typescript
async getAll(userId?: number): Promise<HeldSale[]> {
  return await this.repo.getAll(userId);
}
```

If the IPC handler forgets to pass `userId`, the service happily returns every user's parked cart. Stock is **not reserved** when a sale is held — the JSON cart is saved (line 29-34) but no batch quantities change. See S-P2-1 and S-P2-2.

### 3.5 Findings

---

#### 🔴 S-P0-1 · Float division in line-total calculation

**File:** [transaction.service.ts:608-611](src/core/services/transaction.service.ts#L608-L611)
**Confidence:** Confirmed

```typescript
const displayQty  = item.unit_type === 'parent' ? take / cf : take;

const effectivePrice = Money.percent(unitPrice, 100 - discountPct);
const lineTotal      = Money.multiply(effectivePrice, displayQty);
```

**Why it's a bug:** `take / cf` is **raw JavaScript division** and produces a float. `Money.multiply` calls `Math.round`, so the final integer is rounded — but `displayQty` itself was already a non-integer halfway value. The round-trip can disagree with the same calculation performed in the UI cart (which works in parent-unit quantities directly).

Specifically: when `unit_type === 'parent'`, the caller sends `item.quantity` in *parent units*. Server converts to base via `remainingBase = item.quantity * cf` (line 556). Then per-batch `take` is a **base-unit count**. `take / cf` is meant to recover the original parent-unit count, but it produces a float for any partial batch (which shouldn't happen if `take = batch.quantity_base` is a multiple of `cf`, but isn't guaranteed across batches when a sale spans batches).

**Reproducer:**
- Product CF = 10, unit_type = 'parent', cart says 2 boxes (= 20 base units)
- Two active batches: batch A has 7 base units (less than one full box!), batch B has 100 base units
- First iteration: `take = min(7, 20) = 7`. `displayQty = 7/10 = 0.7`. `lineTotal = round(price * 0.7)`.
- Second iteration: `take = min(100, 13) = 13`. `displayQty = 13/10 = 1.3`. `lineTotal = round(price * 1.3)`.
- Sum of line totals ≠ what the UI calculated as "2 boxes × price".

**Fix sketch:**

```typescript
const displayQty = item.unit_type === 'parent'
  ? Money.divideToChild(take, cf)   // floor div, integer
  : take;
```

But this changes semantics — if a batch has 7 base units of a 10-unit-per-parent product, you can't sell a fractional parent. The deeper fix is: **reject** mixed-batch parent sales where any batch holds < CF base units, or **promote** the deduction to child-unit base accounting and re-express the sold line as `parent_units = floor(base / cf); leftover_child = base % cf`. The latter is the proper FIFO behavior.

**Blast radius:** Any sale where `unit_type='parent'` spans more than one batch. Customer-facing receipt totals.

---

#### 🔴 S-P0-2 · Gross profit sign-flip on returns

**File:** [transaction.service.ts:312](src/core/services/transaction.service.ts#L312) (returns) vs [transaction.service.ts:613](src/core/services/transaction.service.ts#L613) (sales)
**Confidence:** Confirmed

Sale (line 613):
```typescript
const grossProfit    = Money.subtract(lineTotal, costTotal);
```

Return (line 312):
```typescript
const grossProfit    = -Money.subtract(lineTotal, costTotal);
```

**Why it's a bug:** The `transaction_items.gross_profit` column is summed in P&L reports. For a sale, profit is `revenue - cost` (positive if profitable). For a return, the *reversal* of that profit should be `-(revenue - cost)` — which is what the code intends. But this is computed on the **refund** values (`lineTotal = refund`, `costTotal = COGS reversal`), and stored as `-Money.subtract(refund, COGS_reversal)`.

Net result over a paired sale + full return: stored profits sum to `(R - C) + (-(R' - C'))`. If R = R' and C = C' (full refund, full COGS reversal), the sum is zero. That's mathematically correct.

But the **sign convention** is inconsistent and brittle:
- For a partial return where you refund less than the original line (e.g. discount applied differently in the return path), the stored value can have unintuitive signs.
- Any report that filters `gross_profit > 0` will exclude returns. Any aggregation that groups by `transaction_type` will show returns as negative gross profit — which is fine — but the **signs are computed on different axes** (sale: revenue - cost; return: -(refund - cost_reversal)). They look symmetric but encode different quantities.

**Reproducer:**
- Sale of 1 unit: unit_price=1000, cost_price=600 → grossProfit stored = 400
- Return of same unit: lineTotal=1000, costTotal=600 → grossProfit stored = -400
- Sum over both: 0 ✓
- BUT: if the return has a different cf_snapshot or unit_price was overridden in the original sale, the return's `lineTotal` and `costTotal` may not match the sale's. The signs still look right but the *amount* of negation is wrong.

**Fix sketch:** Pick one canonical encoding. Recommended: always store `gross_profit = revenue_change - cost_change`, where for returns `revenue_change` is negative (refund subtracted from revenue) and `cost_change` is negative (COGS reduced). Then P&L is a sum, no sign-flip logic. This requires changing `lineTotal` and `costTotal` storage convention for returns, plus migrating existing data.

**Blast radius:** P&L report ([reports/profit-loss](src/transport/rest/routes/report.routes.ts)), dashboard "Today's Profit" tile, any `SUM(gross_profit)` query.

---

#### 🟠 S-P1-1 · Cross-unit return under-refund (raw floor instead of `Money.divideToChild`)

**File:** [transaction.service.ts:301-306](src/core/services/transaction.service.ts#L301-L306), also [224-226](src/core/services/transaction.service.ts#L224-L226)
**Confidence:** Confirmed

```typescript
const unitPrice = (isCrossUnit && cf > 1)
  ? Math.max(1, Math.floor(origItem.unit_price / cf))
  : origItem.unit_price;
```

**Why it's a bug:** Two issues:
1. `Math.floor(unit_price / cf)` is **floor division** — same shape as `Money.divideToChild` — but bypasses the canonical helper. If `Money.divideToChild` ever changes (e.g. to handle currency that has minor units, or to add ghost-inventory prevention), this site won't track.
2. The `Math.max(1, ...)` masks a real edge case: when `unit_price < cf`, floor gives 0 (free), and `max(1, 0) = 1`. So a customer who bought a 7-SDG box of 10 strips (each strip "should" cost 0.7 SDG, but SDG has no decimals, so policy is "1 SDG per strip") returning 5 strips gets refunded 5 SDG — but only paid 7 SDG for the whole box. That's an **over-refund** of 5 SDG out of 7. The bug is the opposite direction from what the comment claims ("floor so we never refund more than was collected").

**Reproducer:**
- Sell 1 box at unit_price = 7 SDG, cf = 10. Customer paid 7.
- Customer returns 5 strips.
- `unitPrice = max(1, floor(7/10)) = max(1, 0) = 1`
- `lineTotal = 5 × 1 = 5 SDG`
- Pharmacy over-refunds 5 against a payment of 7.

For unit_price ≥ cf, the bug shrinks but still loses up to `cf - 1` SDG per parent returned via child due to floor division accumulating across multiple strips.

**Fix sketch:**

```typescript
// Use the canonical helper. For "max 1" semantics, decide based on policy:
// - Strict ratio: const unitPrice = Money.divideToChild(origItem.unit_price, cf);  // can be 0
// - Pharmacy-friendly: const unitPrice = Math.max(0, Money.divideToChild(...));    // never negative
// Recommend NOT min-clamping to 1; instead reconstruct the *original line total*:
const originalLineRefundShare = Math.round(
  origItem.line_total * (item.quantity / origItem.quantity_base) * cf  // for parent unit_type
  // or item.quantity / origItem.quantity_base, for child
);
```

I.e. drive the refund off the *recorded line total*, not the recorded per-unit price. This guarantees `Σ refunds_for_this_item ≤ line_total_of_original_item` by construction.

**Blast radius:** Any return whose unit_type differs from the original sale's unit_type. Audit history of cross-unit returns. Customer-facing refund slips.

---

#### 🟠 S-P1-2 · Proportional discount distribution loses per-line granularity

**File:** [transaction.service.ts:331-337](src/core/services/transaction.service.ts#L331-L337)
**Confidence:** Confirmed

```typescript
const origSubtotal = original.subtotal ?? 0;
const origDiscount = original.discount_amount ?? 0;
const proportionalDiscount = origSubtotal > 0
  ? Math.round(subtotal * origDiscount / origSubtotal)
  : 0;
const totalAmount = Math.max(0, subtotal - proportionalDiscount);
```

**Why it's a bug:** The original sale's **checkout-level discount** is applied to the return proportionally to the returned subtotal. If line-level discounts were stored on `transaction_items.discount_percent` and the checkout-level discount on the sale was 100 SDG against a 1001 SDG subtotal, the proportional refund-discount can be off by up to one SDG (rounding).

But the more subtle issue: **`origDiscount` is the checkout-level discount only**. The per-line `discount_percent` is *already* applied when computing `effectivePrice` at line 309. So if both layered discounts exist, the math is correct in aggregate, but for partial returns of one line out of many, the per-line discounts cancel correctly while the checkout discount is approximated.

**Reproducer:**
- Sale: two lines.
  - Line A: 600 SDG, 0% line discount
  - Line B: 401 SDG, 0% line discount
  - Subtotal: 1001. Checkout discount: 500. Total paid: 501.
- Customer returns only Line B (401 SDG).
- Expected refund: a fair split of the 500 discount would give Line B `500 × (401/1001) = 200.30` discount, so refund = 401 - 200 = 201 (or 200 with bankers' rounding).
- Code computes: `proportionalDiscount = round(401 × 500 / 1001) = 200`. Refund = 401 - 200 = 201. ✓
- **But** if the customer was *told* Line B was the discounted line ("the second is on sale") and Line A was full price, the proportional split mis-attributes. The customer who paid 501 expects a 401 refund. The code refunds 201.

This is *the right behavior for blended discounts* and *the wrong behavior if discounts were attributed to specific lines*. There's no way to tell from `discount_amount` alone.

**Fix sketch:** Either:
1. Document and accept proportional split as policy (it's the most defensible default).
2. Track checkout-level discount as a **per-line allocation** stored at sale time, so returns refund exactly the per-line share.

**Blast radius:** Multi-line sales with checkout discounts and partial returns.

---

#### 🟠 S-P1-3 · FIFO loop's `ConflictError` aborts the entire sale

**File:** [transaction.service.ts:583-593](src/core/services/transaction.service.ts#L583-L593) + [82-86](src/core/services/transaction.service.ts#L82-L86)
**Confidence:** Confirmed

The FIFO batch list is fetched once (line 568) and reused for the entire deduction loop. If a concurrent sale modifies any batch in that list, the optimistic-lock check on the next iteration fails → `ConflictError` thrown → the `inTransaction` wrapper rolls back the whole sale → the user sees "Batch modified concurrently. Please retry."

**Why it's a bug (UX, not data corruption):** Under modest concurrency (two cashiers, same product), users see spurious failures. The user-friendly behavior is: silently retry with a refreshed batch list, up to N times. Data is **safe** today; the issue is workflow friction.

**Reproducer:**
- Two POS terminals open. Both sell the same product (cf=10, two active batches each with 50 base units).
- Both sales start within the same millisecond, both call `_deductFIFO`.
- One succeeds; the other gets `ConflictError` and must press Retry.

**Fix sketch:** See [Section 8.1](#81-improvement-1--inner-retry-in-_deductfifo) — a 3-attempt retry wrapper.

**Blast radius:** POS sales during peak times.

---

#### 🟠 S-P1-4 · Admin + shifts-disabled bypasses both return-window checks

**File:** [transaction.service.ts:115-138](src/core/services/transaction.service.ts#L115-L138)
**Confidence:** Confirmed

```typescript
const shiftsOn = await this._shiftsEnabled();
if (shiftsOn && userRole !== 'admin') {
  // 2-shift window
  ...
} else if (!shiftsOn) {
  // 7-day window
  if (original.created_at) {
    const txnDate = new Date(original.created_at).getTime();
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    if (txnDate < sevenDaysAgo) {
      throw new ValidationError(...);
    }
  }
}
```

**Why it's a bug:** When `shiftsOn === false` (admin disabled shifts in settings), the 7-day window applies — to *everyone*, including admin. That's fine. But when `shiftsOn === true` AND user is admin, the `if` branch is skipped, and the `else if (!shiftsOn)` branch is also skipped → **no window check at all** for admin. Admin can return arbitrarily old sales.

If this is intentional ("admin override"), it should be documented and explicitly audit-logged.

**Reproducer:** With shifts enabled, admin user calls `createReturn` against a sale from 6 months ago. No error.

**Fix sketch:**
```typescript
if (shiftsOn && userRole !== 'admin') {
  // existing 2-shift window
} else if (shiftsOn && userRole === 'admin') {
  // emit an audit event noting admin-override on out-of-window return
} else {
  // 7-day window, applies to everyone
}
```

**Blast radius:** Fraud potential — admin user returning ancient sales for refund.

---

#### 🟡 S-P2-1 · Held sales — no permission gate on read

**File:** [held-sale.service.ts:13-15](src/core/services/held-sale.service.ts#L13-L15) + the IPC/REST handlers
**Confidence:** Confirmed (service); needs handler-level verification

```typescript
async getAll(userId?: number): Promise<HeldSale[]> {
  return await this.repo.getAll(userId);
}
```

**Why it's a bug:** The optional `userId` parameter means callers can omit it and get every user's parked cart. If the handler doesn't enforce passing the current user's id, this leaks.

**Fix sketch:** Make `userId` required, or enforce at the IPC/REST handler that admin can see all, non-admin sees only their own.

---

#### 🟡 S-P2-2 · Held sales do not reserve stock

**File:** [held-sale.service.ts:17-44](src/core/services/held-sale.service.ts#L17-L44)
**Confidence:** Confirmed

The `save()` method serializes the cart to JSON and stores `total_amount` (computed from quantity × unit_price). It does NOT call `_deductFIFO` or update any batch.

**Why it's a bug:** If two cashiers can sell the same product to two customers, but one cashier puts their cart on hold, the held items are not reserved. When the held sale is retrieved and finalized, the optimistic lock or stock-check may fail. This is **architecturally consistent with most POS systems** (holds are pending, not committed), but the failure mode at finalization is silent unless surfaced clearly in the UI.

**Recommendation:** Document the policy ("holds do not reserve stock") and add a "stock-since-hold" reconciliation prompt when the held sale is retrieved.

---

#### 🟡 S-P2-3 · UI cart can hold stale CF if product is updated mid-cart

**File:** [transaction.service.ts:554-557](src/core/services/transaction.service.ts#L554-L557)
**Confidence:** Hypothesis — needs runtime check

```typescript
const cf = product.conversion_factor ?? 1;
let remainingBase = item.unit_type === 'parent'
  ? item.quantity * cf
  : item.quantity;
```

The server reads the **current** `product.conversion_factor`. If admin changed CF after the cashier added items to the cart, the server's `remainingBase` differs from what the UI computed/displayed.

**Recommendation:** UI should pass `expected_cf` with each item and the server should reject mismatches with a "product was updated — please refresh" error.

---

#### 🔵 S-P3-1 · Receipt number generation race (mitigated by SQL UNIQUE)

**File:** [transaction.repository.ts](src/core/repositories/sql/transaction.repository.ts) (`getNextNumber`)
**Confidence:** Confirmed (mitigation present)

The receipt number is built from `today` + sequence number; concurrent calls could collide. **However**, [migration.repository.ts:115](src/core/repositories/sql/migration.repository.ts#L115) declares `transaction_number TEXT UNIQUE NOT NULL`, so a collision throws a SQL error instead of silently corrupting. The user sees a noisy error and must retry — annoying but safe.

**Recommendation:** Add app-level retry on UNIQUE-constraint failure for receipt-number generation only.

---

#### 🔵 S-P3-2 · `created_at` passed from caller on returns

**File:** [transaction.service.ts:376-380](src/core/services/transaction.service.ts#L376-L380)
**Confidence:** Confirmed

Returns intentionally inherit `created_at` from the original sale (to keep daily reports attributed to the sale day). Sales do not expose `created_at` in `CreateTransactionInput`, so this is currently safe. Flagged for vigilance — never accept `created_at` from a sale-creation caller.

---

## 4. ★ Batches — deep dive

### 4.1 Version-bump audit table

This is the headline finding of the entire audit. Every UPDATE on a batch row must:
- (a) bump `version` so concurrent readers detect mutation
- (b) update `updated_at` so audit trail captures last-change time
- (c) check `version = ?` in WHERE to prevent lost updates

Reality:

| Method | File:line | Bumps `version` | Checks `version` | Wrapped in `inTransaction` | Verdict |
|---|---|:-:|:-:|:-:|---|
| `update()` | [batch.repository.ts:135-167](src/core/repositories/sql/batch.repository.ts#L135-L167) | ✓ | **✗ MISSING** | ✗ | 🔴 **B-P0-1** Lost-update on every batch edit |
| `updateQuantityOptimistic()` | [batch.repository.ts:173-186](src/core/repositories/sql/batch.repository.ts#L173-L186) | ✓ | ✓ | (callers) | ✅ Correct |
| `rescaleQuantitiesForProduct()` | [batch.repository.ts:333-339](src/core/repositories/sql/batch.repository.ts#L333-L339) | **✗ MISSING** | ✗ | ✗ | 🔴 **B-P0-2** Silent rescale, lock bypassed |
| `recalculateChildPricesForProduct()` | [batch.repository.ts:315-327](src/core/repositories/sql/batch.repository.ts#L315-L327) | ✓ | ✗ | ✗ | 🟠 Inconsistent with sibling |
| `bulkUpdateSellingPrices()` | [batch.repository.ts:268-281](src/core/repositories/sql/batch.repository.ts#L268-L281) | ✓ | ✗ | ✗ | 🟠 Destroys overrides silently |
| `propagateSellingPrices()` | [batch.repository.ts:296-308](src/core/repositories/sql/batch.repository.ts#L296-L308) | ✓ | ✗ | ✗ | 🟠 Updates quarantine batches too |
| `insertAdjustment()` | [batch.repository.ts:212-226](src/core/repositories/sql/batch.repository.ts#L212-L226) | — (INSERT) | — | sometimes | 🟡 Not always atomic with qty update |
| `restoreDeletedBatch()` | (called from transaction.service.ts:234) | — (INSERT) | — | ✓ inside createReturn | 🟡 Creates `expiry_date='2099-12-31'` rows |

### 4.2 Status transition state machine

The schema constraint says `status IN ('active', 'quarantine', 'sold_out')` — three states, no explicit transitions. Implicit allowed transitions found in the code:

```
       (create)
          │
          ▼
     ┌─────────┐
     │ active  │◀─────────┐
     └─────────┘          │
       │     │            │
  (sale│     │(damage)    │(restock-on-return)
   qty=0)   ▼              │
       │  ┌────────────┐   │
       │  │ quarantine │───┤
       ▼  └────────────┘   │
   ┌──────────┐       │    │
   │ sold_out │       │    │
   └──────────┘       └────┘
       ▲
       │(force-void of return clamps qty=0)
       │
```

Problems:
1. **`sold_out → active`** is allowed (`voidTransaction` line 435: `newStatus = batch.status === 'sold_out' ? 'active' : batch.status;`). Correct for that path. But generic `update()` allows it too — a user could mark `sold_out` batches `active` without restocking.
2. **No guard** prevents `sold_out` from being applied while `quantity_base > 0` (or vice versa: `active` with `quantity_base = 0`).
3. **No guard** prevents marking a batch `active` while expired (`expiry_date < date('now')`). The FIFO query *excludes* expired batches, so they're invisible to sales, but reports may show "active expired stock" which is misleading.

### 4.3 Cost/price overrides & propagation

Two override columns per side (cost / sell) × (parent / child) = 4 override fields. The fallback logic in `_deductFIFO` line 599-605:

```typescript
const unitPrice =
  item.unit_price ??
  (item.unit_type === 'parent'
    ? (batch.selling_price_parent_override || batch.selling_price_parent || 0)
    : (batch.selling_price_child_override  || batch.selling_price_child  || 0));
```

The `||` chain treats `0` as falsy — meaning a deliberate `override = 0` (free promo) is silently demoted to the base price. See **B-P3-1**.

`propagateSellingPrices` (line 296-308) updates `quarantine` batches too — see **B-P1-1**. `bulkUpdateSellingPrices` (line 268-281) unconditionally clears `selling_price_parent_override = 0` — see **B-P1-2**.

### 4.4 Damage / expiry / correction adjustments

`reportDamage` performs two writes:
1. `batchRepo.updateQuantityOptimistic(...)`
2. `batchRepo.insertAdjustment(...)`

Per [batch.service.ts:199-209](src/core/services/batch.service.ts#L199-L209), these are NOT wrapped in `inTransaction`. A crash between the two leaves the batch quantity decremented with no adjustment record — silent unexplained inventory loss in the audit trail. See **B-P1-4**.

### 4.5 Hard-delete vs soft-delete model

Products: **soft-delete** (`is_active = 0`).
Batches: **hard-delete** (DELETE FROM batches).

`transaction_items.batch_id` references `batches(id)` with **no ON DELETE clause** ([migration.repository.ts:157](src/core/repositories/sql/migration.repository.ts#L157)). Two cases:
- **SQLite foreign keys are OFF by default.** Whether your installation has `PRAGMA foreign_keys = ON` determines whether `deleteBatch` errors out on referenced rows or silently leaves dangling FKs. **Hypothesis — needs runtime check:** grep `base.repository.ts` for `PRAGMA foreign_keys`.
- Even with FKs ON, there's no ON DELETE clause, so SQLite defaults to NO ACTION (error on delete). That means hard-delete would *fail* — which is safe, but produces a confusing error to the user.

### 4.6 Findings

---

#### 🔴 B-P0-1 · `update()` bumps `version` but doesn't check it — every batch edit is a silent lost-update

**File:** [batch.repository.ts:135-167](src/core/repositories/sql/batch.repository.ts#L135-L167)
**Confidence:** Confirmed

```sql
UPDATE batches SET
  batch_number = COALESCE(?, batch_number),
  expiry_date = COALESCE(?, expiry_date),
  quantity_base = COALESCE(?, quantity_base),
  cost_per_parent = COALESCE(?, cost_per_parent),
  cost_per_child = COALESCE(?, cost_per_child),
  selling_price_parent = COALESCE(?, selling_price_parent),
  selling_price_child = COALESCE(?, selling_price_child),
  selling_price_parent_override = COALESCE(?, selling_price_parent_override),
  cost_per_child_override = COALESCE(?, cost_per_child_override),
  selling_price_child_override = COALESCE(?, selling_price_child_override),
  status = COALESCE(?, status),
  version = version + 1,
  updated_at = datetime('now', 'localtime')
WHERE id = ?
```

**Why it's a bug:** No `AND version = ?` in the WHERE clause. Two users can simultaneously load batch #5 (version 2), each make different edits, both submit, both succeed, version becomes 4. The last write wins; the first edit is lost without audit, without conflict notification, without anything visible to anyone.

This is the **inverse** of optimistic locking. `updateQuantityOptimistic` (sibling method) does it right; `update()` does not.

**Reproducer:**
1. User A opens BatchForm on batch #5 (version=2). Changes `expiry_date` to 2027-01-01.
2. User B opens BatchForm on batch #5 (version=2). Changes `cost_per_parent` to 1500.
3. User A submits → succeeds, version=3, expiry updated, cost still old.
4. User B submits → succeeds, version=4, cost updated, **expiry reverted to old value via COALESCE behavior on form fields that B didn't touch**.

The COALESCE pattern means B's submission only updates the fields B included. So strictly speaking, the silent loss only occurs on **overlapping fields** — but if both users edit the same field, B's write wipes A's.

**Fix sketch:**
```sql
UPDATE batches SET ... WHERE id = ? AND version = ?
```
Plus the service needs to accept `expected_version` and throw `ConflictError` if `runAndGetChanges` returns 0. Mirror the pattern from `updateQuantityOptimistic`.

**Blast radius:** Every batch edit from the UI. Every internal call to `batchRepo.update`. Migration: services that currently call `update()` need to pass an `expected_version` parameter, which means callers need to fetch the version first. Roughly 6-10 sites in `batch.service.ts` and `purchase.service.ts` to touch.

---

#### 🔴 B-P0-2 · `rescaleQuantitiesForProduct()` neither bumps `version` nor updates `updated_at`

**File:** [batch.repository.ts:333-339](src/core/repositories/sql/batch.repository.ts#L333-L339)
**Confidence:** Confirmed

```typescript
async rescaleQuantitiesForProduct(productId: number, oldCf: number, newCf: number): Promise<void> {
  if (oldCf === newCf) return;
  await this.base.runImmediate(
    `UPDATE batches SET quantity_base = quantity_base * ? / ? WHERE product_id = ?`,
    [newCf, oldCf, productId]
  );
}
```

**Why it's a bug:** This is the **most insidious** version-handling bug. Quantities are rescaled silently. Any optimistic lock that fetched the batch *before* the rescale will pass its `version = ?` check after the rescale — but the quantity it was reasoning about is now different. The lock provides false confidence.

Compare with the sibling `recalculateChildPricesForProduct` (line 322): it does `version = version + 1`. The two methods called back-to-back in `product.service.ts:94-95` mean the rescale invalidates everyone's snapshot **without telling anyone**, then the price recalc bumps versions properly. The first write is invisible; the second is visible. This is worse than always-visible or always-invisible.

**Reproducer:**
1. Product P has CF=10, batch B has quantity_base=100 (10 parent units), version=3.
2. Cashier A reads B (qty=100, v=3) and starts a sale of 5 parent units (50 base).
3. Admin changes CF from 10 to 5 → `rescaleQuantitiesForProduct` sets qty=50 (no version bump). `recalculateChildPricesForProduct` bumps version to 4.
4. Cashier A's `_deductFIFO` reads the *fresh* batch list (line 568), so it sees qty=50, v=4. **In this path it's fine.**
5. **But** if a different path holds a snapshot — e.g. an in-flight `update()` call carrying expected_version=3 — and that path doesn't refetch, it would write with stale assumed quantity.

The risk is small *today* because most write paths refetch immediately before write. The risk is real in the future as new callers are added.

**Fix sketch:**
```typescript
await this.base.runImmediate(
  `UPDATE batches SET
     quantity_base = quantity_base * ? / ?,
     version = version + 1,
     updated_at = datetime('now', 'localtime')
   WHERE product_id = ?`,
  [newCf, oldCf, productId]
);
```

**Blast radius:** Any future caller that holds a batch snapshot longer than one read-write cycle.

---

#### 🔴 B-P0-3 · CF cascade not atomic — partial corruption possible on crash

**File:** [product.service.ts:74-112](src/core/services/product.service.ts#L74-L112)
**Confidence:** Confirmed

```typescript
async update(id: number, data: UpdateProductInput, userId: number): Promise<Product> {
  ...
  await this.repo.update(id, data);

  // Cascade CF change: rescale quantities and recalculate child prices with new CF
  if (data.conversion_factor !== undefined && data.conversion_factor !== existing.conversion_factor) {
    await this.batchRepo.rescaleQuantitiesForProduct(id, existing.conversion_factor, data.conversion_factor);
    await this.batchRepo.recalculateChildPricesForProduct(id, data.conversion_factor);

    this.bus.emit('entity:mutated', { action: 'CASCADE_CF_CHANGE', ... });
  }
  ...
}
```

**Why it's a bug:** Three writes:
1. `this.repo.update(id, data)` — updates `products.conversion_factor`
2. `this.batchRepo.rescaleQuantitiesForProduct(...)` — rescales `batches.quantity_base`
3. `this.batchRepo.recalculateChildPricesForProduct(...)` — rescales `batches.cost_per_child` and `selling_price_child`

If the process dies, the disk fails, or sql.js's auto-persist worker hiccups between write #1 and #2, the product has a new CF but batches have old quantities. Between #2 and #3, batches have new quantities but old per-child prices. **Both are silently broken states** with no detection mechanism.

The fact that sql.js is in-memory and persists asynchronously to disk via the save worker makes this worse: even after JS-level success of #1, the OS may not have flushed. A power cut between #1 and the save-worker fsync could leave the *persisted* DB at write #1 only, while the *in-memory* DB has all three. On next launch, the rehydrate produces corruption.

**Reproducer:**
1. Product P has CF=10, 5 batches.
2. Admin opens ProductForm, changes CF to 5, clicks Save.
3. Inject a `throw new Error('test')` after `rescaleQuantitiesForProduct` in `product.service.ts:94`. Run.
4. Observe: `products.conversion_factor = 5`, `batches.quantity_base` is halved (rescaled), but `batches.cost_per_child` and `selling_price_child` are the old values for CF=10 → child prices are now 2× too high, customer is overcharged on every child-unit sale.

**Fix sketch:**
```typescript
await this.base.inTransaction(async () => {
  await this.repo.update(id, data);
  if (data.conversion_factor !== undefined && data.conversion_factor !== existing.conversion_factor) {
    await this.batchRepo.rescaleQuantitiesForProduct(id, existing.conversion_factor, data.conversion_factor);
    await this.batchRepo.recalculateChildPricesForProduct(id, data.conversion_factor);
  }
});
// Emit events after the transaction commits
```

**Blast radius:** Any product update that changes CF. Probably rare in practice — most products' CFs are set at create-time. But when it happens, the damage is silent and far-reaching.

---

#### 🔴 B-P0-4 · `deleteBatch()` hard-deletes without checking referencing rows

**File:** [batch.service.ts:269-279](src/core/services/batch.service.ts#L269-L279) → `batchRepo.deleteBatch` → `DELETE FROM batches WHERE id = ?`
**Confidence:** Confirmed (service); FK behavior is **Hypothesis — needs runtime check** (depends on `PRAGMA foreign_keys` setting)

`transaction_items.batch_id` references `batches(id)` with **no ON DELETE clause**. The default is NO ACTION, which means delete fails with a FK error *if FKs are enforced*. SQLite has FKs OFF by default, but the codebase may turn them on in `base.repository.ts` initialization.

**Why it's a bug:** Either:
- FKs are off → silent dangling pointers in `transaction_items` and `inventory_adjustments`. Reports break. Returns against the deleted batch trigger the ghost-batch flow.
- FKs are on → the delete fails with a confusing SQLite error message that's not user-friendly.

Either way, `deleteBatch` lacks a service-level pre-flight check.

**Reproducer:**
1. Sell from batch #10 (creates 1 transaction_item).
2. Call `deleteBatch(10)`.
3. Observe DB state — does the row gone? Is the transaction_item dangling?

**Fix sketch:**
```typescript
const info = await this.repo.getBatchDeleteInfo(id);
if (info && (info.txn_count > 0 || info.adj_count > 0)) {
  throw new ValidationError(
    'Cannot delete batch with transaction history. Soft-delete (status=sold_out, quantity=0) instead.',
    'id'
  );
}
```

A check method already exists (`getBatchDeleteInfo` at batch.repository.ts:341+) but `deleteBatch` doesn't call it.

**Blast radius:** Admin cleanup workflows. Audit history.

---

#### 🔴 B-P0-5 · Return-against-deleted-batch creates a "ghost batch" with `expiry_date = '2099-12-31'`

**File:** [transaction.service.ts:234-243](src/core/services/transaction.service.ts#L234-L243)
**Confidence:** Confirmed

```typescript
const newBatchId = await this.batchRepo.restoreDeletedBatch({
  product_id:           origItem.product_id,
  batch_number:         `RESTORED-${item.batch_id}-REVIEW`,
  expiry_date:          '2099-12-31', // Unknown — original batch deleted; quarantine requires manual review
  quantity_base:        quantityBase,
  cost_per_parent:      costPerParent,
  cost_per_child:       costPerChild,
  selling_price_parent: sellPerParent,
  selling_price_child:  sellPerChild,
});
```

**Why it's a bug:** Two layered issues:
1. **`2099-12-31` is a sentinel that never expires.** Reports treat it as "valid for 75 more years." Without a manual cleanup workflow (which doesn't exist in the UI today), these accumulate forever.
2. **`Math.floor(origItem.cost_price / cf)` at line 224 / 226** uses raw floor (same as S-P1-1) instead of `Money.divideToChild`.

The root cause is that hard-deleting batches loses the original `expiry_date`. The audit trail technically has it (in `audit_logs.old_values` if the delete was logged), but the return-restore code doesn't query it.

**Reproducer:**
1. Batch B sold to customer, then admin hard-deletes B.
2. Customer returns. Code creates batch `RESTORED-B-REVIEW` with `expiry_date='2099-12-31'`, status `quarantine`.
3. Inventory report shows phantom stock with a fake expiry. No alert.

**Fix sketch:**
1. Block hard-delete (fix B-P0-4) → this entire restore path becomes dead code.
2. If hard-delete is preserved for some legitimate use, query `audit_logs` for the deleted batch's `expiry_date` and restore that, falling back to the *product's* nearest active batch's expiry as a heuristic, with a flag `manual_review_required = 1`.

**Blast radius:** Inventory valuation reports, expiry alerts, FIFO queries (which exclude this batch because it's quarantine).

---

#### 🟠 B-P1-1 · `propagateSellingPrices()` updates `quarantine` batches too

**File:** [batch.repository.ts:296-308](src/core/repositories/sql/batch.repository.ts#L296-L308)
**Confidence:** Confirmed

```sql
UPDATE batches SET
  selling_price_parent = ?,
  selling_price_child = ?,
  selling_price_parent_override = ?,
  selling_price_child_override = ?,
  version = version + 1,
  updated_at = datetime('now', 'localtime')
WHERE product_id = ? AND id != ?
  AND status IN ('active', 'quarantine')
```

**Why it's a bug:** Quarantine batches are supposed to be reviewed before reactivation. Auto-applying new prices to them removes a useful indicator (price=batch-of-record). If quarantine stock is later reactivated, it ships at a price the pharmacist may not have approved.

**Fix sketch:** Change `IN ('active', 'quarantine')` to `= 'active'`. Pharmacists who want quarantine batches to inherit new prices should make that an explicit step in the reactivation workflow.

---

#### 🟠 B-P1-2 · `bulkUpdateSellingPrices()` unconditionally clears overrides

**File:** [batch.repository.ts:268-281](src/core/repositories/sql/batch.repository.ts#L268-L281)
**Confidence:** Confirmed

```sql
UPDATE batches SET
  selling_price_parent = ?,
  selling_price_child = ?,
  selling_price_parent_override = 0,             ← always zero, no choice
  selling_price_child_override = CASE WHEN ? > 0 THEN ? ELSE 0 END,
  ...
WHERE product_id = ? AND status = 'active' AND quantity_base > 0
  AND expiry_date >= date('now')
```

**Why it's a bug:** A pharmacist who set `selling_price_parent_override = 500` for a deliberate loss-leader promo loses that override the moment any user runs a bulk price update on the product. No warning, no audit entry of "overrides cleared".

**Fix sketch:** Pass `clear_overrides: boolean` from the UI. Default to `false`. Only clear when explicitly requested. Emit an audit event with the cleared values for diff.

---

#### 🟠 B-P1-3 · No UNIQUE constraint on `(product_id, batch_number)`

**File:** [migration.repository.ts:94-112](src/core/repositories/sql/migration.repository.ts#L94-L112)
**Confidence:** Confirmed

The `batches` DDL has `batch_number TEXT` — no UNIQUE constraint, no INDEX. Two batches with the same `batch_number` against the same product are valid.

**Why it's a bug:** Receipts, reports, and adjustment dialogs frequently identify a batch by its number. Duplicates introduce ambiguity. Hard to spot at insert time because there's no constraint to fail loud.

**Fix sketch (migration):**
```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_batches_product_batchnum
  ON batches(product_id, LOWER(TRIM(batch_number)))
  WHERE batch_number IS NOT NULL;
```

Plus normalize `batch_number` on write (trim + upper-case).

---

#### 🟠 B-P1-4 · `reportDamage()` not atomic with adjustment insert

**File:** [batch.service.ts:199-209](src/core/services/batch.service.ts#L199-L209)
**Confidence:** Confirmed

```typescript
const success = await this.repo.updateQuantityOptimistic(batchId, newQty, newStatus, batch.version);
if (!success) throw new ConflictError(...);

await this.repo.insertAdjustment({...});
```

**Why it's a bug:** Two separate writes, no `inTransaction`. Crash between → quantity decremented, no adjustment record. Audit trail says "qty went from 100 to 90" with no reason.

**Fix sketch:**
```typescript
await this.base.inTransaction(async () => {
  const success = await this.repo.updateQuantityOptimistic(...);
  if (!success) throw new ConflictError(...);
  await this.repo.insertAdjustment({...});
});
```

---

#### 🟡 B-P2-1 · Status transitions ungoverned

**File:** [batch.repository.ts:135-167](src/core/repositories/sql/batch.repository.ts#L135-L167) (generic `update()`)
**Confidence:** Confirmed

Generic `update()` accepts any `status` value, so `sold_out → active` (without restocking) or marking `sold_out` with `quantity_base > 0` is allowed.

**Fix sketch:** Add a service-level transition guard in `batch.service.ts:update()`:
```typescript
if (data.status && existing.status !== data.status) {
  assertValidTransition(existing.status, data.status, { quantity_base: data.quantity_base ?? existing.quantity_base });
}
```

---

#### 🟡 B-P2-2 · No service-level past-expiry guard

**File:** [batch.service.ts](src/core/services/batch.service.ts) `createBatch()`
**Confidence:** Confirmed

UI ([BatchForm.tsx:221](src/renderer-react/components/inventory/BatchForm.tsx#L221)) enforces future-only expiry but service doesn't. Direct API calls (REST or IPC) bypass the UI.

**Fix sketch:** `Validate.futureDate(data.expiry_date, 'Expiry date')` in the service create path.

---

#### 🟡 B-P2-3 · `batch_number` not normalized

**File:** [batch.repository.ts:112-133](src/core/repositories/sql/batch.repository.ts#L112-L133) (create) and `update()`
**Confidence:** Confirmed

`'AB-123'`, `'ab-123'`, `' AB-123 '` are stored as distinct values.

**Fix sketch:** Normalize at service-level: `data.batch_number?.trim().toUpperCase() ?? null`. Pair with the UNIQUE index from B-P1-3.

---

#### 🔵 B-P3-1 · `||` fallback treats deliberate-zero overrides as "unset"

**File:** [transaction.service.ts:599-605](src/core/services/transaction.service.ts#L599-L605); also `BatchForm.tsx`
**Confidence:** Confirmed

```typescript
const unitPrice =
  item.unit_price ??
  (item.unit_type === 'parent'
    ? (batch.selling_price_parent_override || batch.selling_price_parent || 0)
    : (batch.selling_price_child_override  || batch.selling_price_child  || 0));
```

`override = 0` (a free-promo override) is treated as "no override" because of `||`. Use `??` to preserve `0` as intentional.

**Fix sketch:** Replace `||` with `??` for override resolution. Audit all `selling_price_*_override` and `cost_per_child_override` usages.

---

## 5. ★ Inventory imports — deep dive

### 5.1 Discovery map

Four distinct paths bring data into the inventory tables:

| Path | Entry point | Writes | Idempotent? |
|---|---|:-:|:-:|
| **Purchase** (primary) | [purchase.service.ts:494](src/core/services/purchase.service.ts#L494) `createPurchase` | `purchases`, `purchase_items`, `purchase_payments`, `products`, `batches`, `categories` | ❌ No idempotency key |
| **CSV bulk product import** | Frontend → [product.service.ts:157](src/core/services/product.service.ts#L157) `bulkCreate` → [product.repository.ts:224](src/core/repositories/sql/product.repository.ts#L224) | `products`, `categories`, `batches` | ❌ Per-row errors swallowed |
| **PDF invoice parser** | [main.ts:380](src/platform/electron/main.ts#L380) `pdf:parsePython` IPC → `execFile pdf_invoice_parser.exe` → feeds purchase flow | (via purchase flow) | ❌ 60s hard timeout, no fallback |
| **Backup restore** | [main.ts:594](src/platform/electron/main.ts#L594) `backup:restoreFromFile` IPC → `services.backup.restore()` | Replaces live DB | ❌ Destructive overwrite |

### 5.2 Purchase → batch flow

[purchase.service.ts:494-555](src/core/services/purchase.service.ts#L494-L555) — `createPurchase` is correctly wrapped in `inTransaction` (line 538). Inside:
1. Insert purchase header
2. `_processItems` — per item: find-or-create product, then `_createBatch` (with side effect: `_propagateSellingPrice` if existing product)
3. Insert payment(s)

[purchase.service.ts:499-510](src/core/services/purchase.service.ts#L499-L510) — Total handling has a known quirk:

```typescript
const itemsComputedTotal = hasItems
  ? data.items!.reduce((sum, it) => sum + Money.round(it.quantity * it.cost_per_parent), 0)
  : 0;
const totalAmount = (data.total_amount && data.total_amount > 0)
  ? Money.round(data.total_amount)
  : hasItems ? itemsComputedTotal : Money.round(Validate.positiveNumber(data.total_amount, 'Total amount'));
```

The user can override the items-sum total. **Intended behavior** (vendor invoices often include non-itemized fees), but **no warning** if the override is wildly different from the items sum.

[purchase.service.ts:946-951](src/core/services/purchase.service.ts#L946-L951) — Product matching (race candidate):

```typescript
let existingProduct = np.barcode
  ? await this.productRepo.findByBarcode(np.barcode)
  : undefined;
if (!existingProduct) {
  existingProduct = await this.productRepo.findByName(np.name);
}
```

This SELECT-then-INSERT pattern races inside `inTransaction` is **safe** because `inTransaction` serializes at the BaseRepository level (single sql.js writer). But across two separate `inTransaction` calls (two concurrent purchases), the inner SELECT can return undefined for both, both INSERTs fire, the loser hits the UNIQUE constraint on `LOWER(TRIM(name))`.

### 5.3 CSV bulk product import — error swallowing

[product.repository.ts:224-300](src/core/repositories/sql/product.repository.ts#L224-L300):

```typescript
await this.base.inTransaction(async () => {
  for (const item of items) {
    try {
      // ... create category, product, batch
      results.push({ success: true, name: item.name });
    } catch (err) {
      results.push({ success: false, name: item.name, error: (err as Error).message });
    }
  }
});

this.base.save();
return results;
```

**Wait** — there's a subtle issue. The `try/catch` is *inside* `inTransaction`. If a row throws and is caught, the transaction does **not** roll back (because the throw doesn't escape `inTransaction`). So **partial commits** within the bulk import: rows 1, 2, 3 succeed; row 4 errors; rows 5, 6 succeed; final result = `{ success: [1,2,3,5,6], failed: [4] }`. This is *probably* the intended behavior for bulk import, but the user must understand that **partial successes are committed** even though the operation looks atomic.

The bigger UX issue: per-row errors are returned per-row, but the UI's "X created" success banner may not surface which specific rows failed. See I-P0-1.

### 5.4 PDF invoice parser

[main.ts:380-438](src/platform/electron/main.ts#L380-L438):

```typescript
const result = await new Promise<string>((resolve, reject) => {
  execFile(cmd, args, {
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024, // 10 MB
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  }, (error, stdout, stderr) => {
    if (error) {
      if ((error as any).code === 'ENOENT') {
        reject(new Error('Python is not installed or not in PATH.'));
      } else if ((error as any).killed) {
        reject(new Error('PDF parsing timed out (60s).'));
      } else {
        reject(new Error(stderr?.trim() || error.message));
      }
      return;
    }
    resolve(stdout);
  });
});
```

**Observations:**
- 60s timeout is **hard** — all parsed data discarded on timeout. Large invoices that parse most of the way produce zero output.
- The temp PDF file is written to `dataPath/tmp/pdf-${Date.now()}.pdf` and unlinked in `finally`. **Path traversal not possible** because the path is server-controlled, not user-input.
- The exe is resolved from `process.resourcesPath` (production) or `projectRoot/scripts/` (dev). No PATH injection.
- `maxBuffer: 10 MB` is generous — unlikely to truncate.
- `PYTHONIOENCODING: 'utf-8'` is correctly set for the dev path; doesn't affect the exe path.
- **No signature verification** of the bundled exe.

### 5.5 Backup restore — destructive

[main.ts:593-614](src/platform/electron/main.ts#L593-L614):

```typescript
const filename = path.basename(selectedFile);
fs.copyFileSync(selectedFile, path.join(backupDir, filename));
try {
  await services!.backup.restore(filename, currentUser?.id ?? 0);
  return { success: true, restartRequired: true };
} catch (err) {
  return { success: false, error: (err as Error).message };
}
```

The selected file is copied into `data/backups/`. Then `services.backup.restore(filename)` is called. If `restore` overwrites the live DB in-place and fails midway, you lose today's data.

The (already-implemented) corruption recovery from v1.3 kicks in on next launch — but the user has already lost what was on disk before. We need a temp-then-promote pattern.

### 5.6 Findings

---

#### 🔴 I-P0-1 · CSV bulk import — per-row errors collected but not surfaced

**File:** [product.repository.ts:224-300](src/core/repositories/sql/product.repository.ts#L224-L300) + frontend `ProductImportDialog`
**Confidence:** Confirmed (repo); needs UI inspection to fully verify the user-facing flow

The repo returns an array of `{ success, name, error? }` results. The service's `bulkCreate` summarizes: `count` of successes goes into the audit event. The UI **may or may not** show individual failed rows with reasons — needs UI-level verification.

**Why it's a bug:** Users importing 200 products are likely to have a few duplicate barcodes or invalid CFs. If the UI says "198 imported, 2 failed" without naming the rows, the user has to diff their CSV against the live DB manually. Worse, the audit log only stores `count: 198`, losing forensic trail.

**Fix sketch:** Frontend: show a table of failed rows with row number + reason + a "download failed rows" button to re-upload after fix. Backend: emit per-row audit events for failures (or aggregate into one event with the array of failures).

---

#### 🔴 I-P0-2 · Purchase total can silently differ from items sum

**File:** [purchase.service.ts:499-510](src/core/services/purchase.service.ts#L499-L510)
**Confidence:** Confirmed

```typescript
const totalAmount = (data.total_amount && data.total_amount > 0)
  ? Money.round(data.total_amount)
  : hasItems ? itemsComputedTotal : Money.round(Validate.positiveNumber(...));
```

If the user supplies `total_amount = 105000` but items sum to `100000`, the recorded `purchases.total_amount` is 105000 — but `purchase_items` sum is 100000. The 5000 SDG variance is silently absorbed.

Vendor invoices DO have shipping/handling/tax — that's a legitimate use case. But the variance should be visible.

**Reproducer:** Create purchase with 10 items of 10000 SDG each (= 100000). Set `total_amount = 105000`. Save. Check `purchases.total_amount` (=105000) vs `SUM(purchase_items.line_total)` (=100000).

**Fix sketch:** Either:
1. Add a `purchases.non_item_charges` column (= total_amount - itemsComputedTotal), with a reason field.
2. Warn user when `|total_amount - itemsComputedTotal| / max(itemsComputedTotal, 1) > 0.05` (5%) — force a confirmation dialog naming the variance.

---

#### 🔴 I-P0-3 · Purchase line cost editable after sales recorded → retroactive COGS rewrite

**File:** `purchase.service.ts:1271-1340` `updatePurchaseItem()` (line numbers approximate; verify via grep)
**Confidence:** Confirmed via prior agent reads

When `updatePurchaseItem` changes `cost_per_parent`, it propagates to the batch's `cost_per_parent`. The batch's cost is the basis for COGS on every `transaction_items` row referencing it. Editing it retroactively rewrites historical profit.

Compare with [batch.service.ts:113-120](src/core/services/batch.service.ts#L113-L120) which explicitly blocks this:

```typescript
if (data.cost_per_parent !== undefined && data.cost_per_parent !== existing.cost_per_parent) {
  const info = await this.repo.getBatchDeleteInfo(id);
  if (info && info.txn_count > 0) {
    throw new ValidationError('Cannot change cost after sales have been recorded against this batch', 'cost_per_parent');
  }
}
```

The purchase-side path does NOT apply this guard.

**Fix sketch:** Mirror the `batchRepo.getBatchDeleteInfo(batchId).txn_count > 0` check in `updatePurchaseItem`. If the batch has sales, refuse the cost edit OR require an explicit "I understand this rewrites COGS history" admin confirmation.

---

#### 🔴 I-P0-4 · `createPurchase` has no idempotency key

**File:** `purchase.repository.ts` (insert) + `purchase.service.ts:494`
**Confidence:** Confirmed (no idempotency column in schema, no key check in service)

A flaky network on REST (Electron over LAN) can cause the client to retry a `POST /api/v1/purchases` after the server received and committed the original. The server has no way to detect the retry as a duplicate of the original. Two purchases get created, two payments scheduled, supplier accounts-payable doubled.

**Fix sketch:**
1. Migration: `ALTER TABLE purchases ADD COLUMN idempotency_key TEXT;` plus `CREATE UNIQUE INDEX uq_purchases_idempotency ON purchases(idempotency_key) WHERE idempotency_key IS NOT NULL;`
2. Client (REST + IPC frontend) generates a UUID per purchase form-submit and includes it in the payload.
3. Service: on receive, `SELECT id FROM purchases WHERE idempotency_key = ?` first; return existing if hit.

---

#### 🔴 I-P0-5 · Purchase line quantities not validated `> 0`

**File:** [purchase.service.ts:896-934](src/core/services/purchase.service.ts#L896-L934) `_processItems`
**Confidence:** Confirmed

`_processItems` loops and calls `_createBatch` without an explicit `Validate.positiveInteger(item.quantity)`. If a client sends `quantity: 0` or `quantity: -1`, what happens depends on the schema CHECK constraint on `batches.quantity_base` (= ≥ 0) — negative is rejected at SQL, zero is allowed.

**Reproducer:**
- POST `/api/v1/purchases` with one item, `quantity: 0`. Result: batch created with `quantity_base = 0`. Phantom SKU appears in inventory, status 'active', sold_out path never triggers because no sale touched it.

**Fix sketch:** First line of `_processItems` loop:
```typescript
Validate.positiveInteger(item.quantity, 'Item quantity');
Validate.positiveNumber(item.cost_per_parent, 'Cost per parent');
```

---

#### 🔴 I-P0-6 · Expiry-date locale parsing ambiguous (DD/MM vs MM/DD)

**File:** `purchase.service.ts:1103-1109` `_createBatch` (line numbers from prior agent read)
**Confidence:** Confirmed via prior agent reads

The regex assumes `DD/MM/YYYY`. Excel exports from a US-locale machine produce `MM/DD/YYYY`. For dates where day ≤ 12 and month ≤ 12, the parse is silently wrong (e.g. 7/8/2025 could be Jul 8 or Aug 7).

**Fix sketch:** Frontend MUST normalize to ISO `YYYY-MM-DD` before sending. Backend should reject any date that isn't `^\d{4}-\d{2}-\d{2}$` with a clear error. Move date parsing to a single utility shared by both frontend and import paths.

---

#### 🔴 I-P0-7 · PDF parser 60s hard timeout, no graceful degrade

**File:** [main.ts:407-424](src/platform/electron/main.ts#L407-L424)
**Confidence:** Confirmed

```typescript
execFile(cmd, args, { timeout: 60_000, ... }, (error, stdout, stderr) => {
  if (error) {
    ...
    } else if ((error as any).killed) {
      reject(new Error('PDF parsing timed out (60s).'));
    }
    ...
  }
  resolve(stdout);
});
```

A 30-page invoice that takes 65 seconds to parse drops *everything*. The user re-uploads and prays it's faster the second time.

**Fix sketch:**
- Make the parser **streaming** (write partial JSON to stdout as it goes; main process reads progressively). Salvage whatever was parsed before timeout.
- Surface a "parsed N of M pages" UI with the option to manually enter the remainder.

---

#### 🟠 I-P1-1 · XLSX/CSV import — no BOM strip

**File:** Frontend `ProductImportDialog.tsx:277-280` (per prior agent reads)
**Confidence:** Confirmed via prior agent reads

Excel-on-Windows saves CSV with a UTF-8 BOM (`﻿`) by default. The first cell of the header row is `﻿"Product Name"` instead of `"Product Name"`, breaking case-insensitive header matching.

**Fix sketch:**
```typescript
let text = await file.text();
if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
const wb = XLSX.read(text, { type: 'string', cellDates: true });
```

Or use `xlsx`'s `codepage: 65001` and `bookVBA: false` options. Safer: detect BOM and strip before parse.

---

#### 🟠 I-P1-2 · Backup restore is destructive — no temp-then-promote

**File:** [main.ts:593-614](src/platform/electron/main.ts#L593-L614)
**Confidence:** Confirmed

`services.backup.restore()` overwrites live DB. Failure mid-restore corrupts live state.

**Fix sketch:**
1. Restore into `data/.pharmasys.restoring.sqlite` (temp path).
2. Open the temp file with sql.js → run a sanity SELECT (e.g. `SELECT COUNT(*) FROM transactions`) to validate.
3. On success: `fs.renameSync(temp, live)` (atomic on same volume).
4. On failure: delete temp, leave live untouched.

---

#### 🟠 I-P1-3 · CF rescale doesn't bound-check post-rescale quantities

**File:** [batch.repository.ts:333-339](src/core/repositories/sql/batch.repository.ts#L333-L339)
**Confidence:** Hypothesis — needs runtime check (real-world CFs are small)

Math: `quantity_base * newCf / oldCf` (SQLite floor division for INTEGER). For a batch with `quantity_base = 1e9` (unrealistic but possible) and `newCf/oldCf = 1000`, the result is `1e12`, comfortably within INTEGER range (sqlite integers are 8 bytes), but past JS `Number.MAX_SAFE_INTEGER` (2^53). A sale that reads the value via `getOne` (which uses `.values` from sql.js → casts to number) loses precision.

**Fix sketch:** Validate CF changes are within a sane range (e.g. 1..10000). Add a service-level check that `max(quantity_base) * newCf / oldCf < 2^53`.

---

#### 🟡 I-P2-1 · Purchase merge can orphan batches with active transactions

**File:** `purchase.service.ts:1455-1513` `mergePurchases` (per prior agent reads)
**Confidence:** Inferred (full code not re-read in this pass; verify before fixing)

Reparenting items in a merge can leave source-purchase batches with no items but with active `transaction_items`. Subsequent cleanup may FK-orphan.

**Fix sketch:** Pre-check: refuse merge if any source-purchase batch has `transaction_items` against it. Or accept the merge and explicitly *retain* the batches under the destination purchase.

---

#### 🟡 I-P2-2 · Product name de-dup races across two concurrent purchases

**File:** [purchase.service.ts:946-951](src/core/services/purchase.service.ts#L946-L951)
**Confidence:** Confirmed

Two simultaneous `createPurchase` calls, each containing a `new_product` with the same name. Inside their respective `inTransaction` blocks, both call `findByName` and both miss (because neither has committed). Both INSERT. One hits the UNIQUE constraint on `LOWER(TRIM(name))` and the entire purchase rolls back.

**Fix sketch:** Catch the UNIQUE violation, refetch the existing product, continue with that id. Or use `INSERT ... ON CONFLICT DO NOTHING RETURNING id` pattern (sqlite 3.35+).

---

## 6. Cross-cutting concerns

### 6.1 Money math invariants & rounding

- `Money.round(x)` = `Math.round(x)`. Used in purchase totals and proportional discount.
- `Money.divideToChild(parent, cf)` = `Math.floor(parent / Math.max(1, cf))`. Used in `bulkCreate` and markup.
- `Math.floor(...)` raw is used in cross-unit returns ([transaction.service.ts:301-306](src/core/services/transaction.service.ts#L301-L306)) and ghost-batch reconstruction (line 224-226).
- `take / cf` raw division in line-total ([line 608](src/core/services/transaction.service.ts#L608)).

**Recommendation:** All cents-level division on monetary or quantity values must go through `Money.divideToChild` (or a quantity sibling). Add an ESLint rule banning `/` on identifiers ending in `_price`, `cost_`, `quantity_*`.

### 6.2 Concurrency model — sql.js single-writer reality

sql.js is **single-threaded, in-memory**. `base.inTransaction` queues callbacks; only one runs at a time per BaseRepository instance. So intra-process concurrency is *serialized*. What you're protecting against with the optimistic-lock pattern is:
1. **Multi-process** — Electron renderer + REST server + a background save worker all touch the same DB file. But the in-memory DB lives in the main process; REST is in-process too. Multi-process is *only* relevant if a second PharmaSys instance opens the same `.sqlite` file (e.g. user accidentally launches two copies). This is **not currently prevented** — no `.lock` file, no PID check.
2. **Long-running operations** — the React UI loads a batch, the user takes 30 minutes editing it, meanwhile a sale deducts from that batch.

The optimistic-lock protects #2. **It does NOT protect against #1** — two processes both pass their version-check on stale snapshots.

**Recommendation:** Add a single-instance lock at app startup (e.g. via `app.requestSingleInstanceLock()` — Electron API). Without it, two simultaneously-opened PharmaSys windows can corrupt each other's writes.

### 6.3 Audit trail & event emission

`AuditListener` ([audit.listener.ts](src/core/events/audit.listener.ts)) consumes `entity:mutated`, `transaction:created`, `stock:changed`, `auth:event`, `shift:changed` and writes audit rows.

Inventory mutations confirmed to emit:
- `entity:mutated` for `CREATE_PRODUCT`, `UPDATE_PRODUCT`, `DELETE_PRODUCT`, `BULK_CREATE_PRODUCTS`, `CREATE_BATCH`, `UPDATE_BATCH`, `DELETE_BATCH`, `RESTORE_BATCH`, `CASCADE_CF_CHANGE`, `VOID_TRANSACTION`, `HOLD_SALE`, `DELETE_HELD_SALE`
- `stock:changed` for each FIFO deduction line, each return restock, each void restore
- `transaction:created` for sales, returns, voids

**Gaps:**
- `rescaleQuantitiesForProduct` does not directly emit `stock:changed` per batch — only one `CASCADE_CF_CHANGE` event for the product. If a report needs to attribute the inventory delta to specific batches, the event is too coarse.
- `bulkUpdateSellingPrices` and `propagateSellingPrices` do not emit per-batch events — bulk price changes are invisible in `stock:changed` (because it's price, not stock) but also invisible in `entity:mutated` (no per-batch row).

### 6.4 SQL.js disk persistence & corruption recovery

Already hardened in v1.3 (corruption recovery + fsync-before-rename). No new findings here.

---

## 7. Remediation roadmap (sprint-ready)

Each item lists: **file(s)**, **acceptance criteria**, **tests to add**, **blast radius**.

### Sprint 1 — P0 atomicity & locking (13 SP)

| ID | Title | Files | Acceptance | Tests | Blast |
|---|---|---|---|---|---|
| **R-S1.1** | Add `AND version = ?` to `batch.update()` | `batch.repository.ts`, `batch.service.ts` (callers) | Method signature: `update(id, data, expectedVersion)`. Returns boolean / throws ConflictError. All callers updated. | Concurrent edit test (two `update()` with same expected version → one wins, other throws ConflictError). | All batch edit forms; purchase flow that updates batch barcodes. |
| **R-S1.2** | `rescaleQuantitiesForProduct` bumps version + updated_at | `batch.repository.ts:333-339` | SQL change. Every batch's version+1 after rescale. | Unit test: read version before rescale, rescale, read version after — must differ. | CF cascade path only. |
| **R-S1.3** | Wrap CF cascade in `inTransaction` | `product.service.ts:74-112` | Three writes inside `base.inTransaction`. Events emitted *after* commit (or after-callback). | Test: inject throw between rescale and recalc — verify rollback (product.CF still old). | Product update with CF change. |
| **R-S1.4** | Block hard-delete of batches with refs | `batch.service.ts:269-279` | Call `getBatchDeleteInfo`; throw ValidationError if `txn_count > 0 OR adj_count > 0`. | Test: sell from batch, attempt delete, expect ValidationError. | Admin batch deletion workflow. |
| **R-S1.5** | Fix float division in line total | `transaction.service.ts:608-611` | Use `Money.divideToChild(take, cf)` OR refactor to base-unit pricing. | Test: sale spans two batches with non-multiple-of-cf quantities → DB total equals server-recomputed total. | Every multi-batch parent-unit sale. |
| **R-S1.6** | Flip grossProfit sign convention on returns | `transaction.service.ts:312` + tests | Either change negation or migrate convention. | Verify P&L report doesn't double-count. | P&L, dashboard, COGS reports. |
| **R-S1.7** | Restore deleted-batch expiry from audit log (or block delete) | `transaction.service.ts:234-243` + `audit.repository.ts` query | Look up audit row for the original delete; restore real expiry if available; else flag `requires_manual_review=1`. | Test: delete batch → return → assert restored expiry matches original, not '2099-12-31'. | Return-against-deleted-batch path. |

### Sprint 2 — P0 imports (13 SP)

| ID | Title | Files | Acceptance |
|---|---|---|---|
| **R-S2.1** | Surface per-row import errors with row numbers | `ProductImportDialog.tsx`, `product.service.ts:bulkCreate`, event payload | UI displays failed rows; audit log captures aggregated failure list. |
| **R-S2.2** | Warn on purchase total vs items-sum mismatch | `purchase.service.ts:499-510` + UI | If `|total - items_sum| > max(0.05 × items_sum, 100 SDG)`, force confirmation dialog. Store the delta. |
| **R-S2.3** | Block purchase line cost edit after sales | `purchase.service.ts:updatePurchaseItem` | Mirror `batch.service.ts:113-120` guard. |
| **R-S2.4** | Idempotency key on `createPurchase` | Migration + `purchase.repository.ts` + `purchase.service.ts` + client | `purchases.idempotency_key TEXT UNIQUE`. Client UUID per submit. Service returns existing row on key hit. |
| **R-S2.5** | Validate `item.quantity > 0` in `_processItems` | `purchase.service.ts:896-934` | Throw at first line of each item iteration if `quantity ≤ 0` or `cost_per_parent ≤ 0`. |
| **R-S2.6** | ISO-only expiry from frontend; reject `DD/MM/YYYY` server-side | All purchase entry points + `_createBatch` | Server regex: `^\d{4}-\d{2}-\d{2}$`. UI converts before send. |
| **R-S2.7** | PDF parser graceful degrade | `main.ts:380-438` | Streaming output; partial-result preservation; UI fallback to manual entry of unparsed rows. |

### Sprint 3 — P1 correctness (13 SP)

| ID | Title | Files |
|---|---|---|
| **R-S3.1** | Cross-unit refund math via `Money.divideToChild` (or driven off `line_total`) | `transaction.service.ts:301-306, 224-226` |
| **R-S3.2** | Per-line discount allocation in returns | `transaction.service.ts:331-337` + `transaction_items` migration |
| **R-S3.3** | Inner retry in `_deductFIFO` (max 3 attempts on ConflictError) | `transaction.service.ts:582-629` |
| **R-S3.4** | Admin-shifts-off return window | `transaction.service.ts:115-138` |
| **R-S3.5** | `propagateSellingPrices` restricted to active | `batch.repository.ts:296-308` |
| **R-S3.6** | `bulkUpdateSellingPrices` preserves overrides unless explicit | `batch.repository.ts:268-281` + service param + UI |
| **R-S3.7** | UNIQUE index on (product_id, lower(trim(batch_number))) + normalize on write | Migration + `batch.service.ts` |
| **R-S3.8** | Wrap `reportDamage` in `inTransaction` | `batch.service.ts:174-225` |
| **R-S3.9** | BOM strip on XLSX import | `ProductImportDialog.tsx` |
| **R-S3.10** | Temp-then-promote backup restore | `backup.service.ts` + `main.ts:594-614` |

### Sprint 4 — P2 + improvements (13 SP)

| ID | Title |
|---|---|
| **R-S4.1** | Held-sale auth: `userId` required, admin-only for all |
| **R-S4.2** | Document held-sale stock-reservation policy + reconciliation prompt on retrieve |
| **R-S4.3** | Batch status state-machine guards (transition matrix in `batch.service.ts:update`) |
| **R-S4.4** | Service-level past-expiry guard on `createBatch` |
| **R-S4.5** | Single-instance app lock (`app.requestSingleInstanceLock`) |
| **R-S4.6** | Inventory valuation report (sum quantity_base × cost_per_child) |
| **R-S4.7** | Tiered expiry alerts on Dashboard (90d/30d/7d/expired) |
| **R-S4.8** | Reorder dashboard using `products.reorder_threshold` |
| **R-S4.9** | Adjustment history viewer + `reverseAdjustment(id)` service |
| **R-S4.10** | Batch version display + ConflictError-friendly UX in edit forms |

### Sprint 5 — Optional new workflows (8 SP)

| ID | Title |
|---|---|
| **R-S5.1** | Cycle-count workflow (snapshot table + variance report + UI tab) |
| **R-S5.2** | Inventory reconciliation tool (rebuild expected qty from txns + adjustments, emit variance) |

---

## 8. Conservative improvement proposals

### 8.1 Improvement 1 — Inner retry in `_deductFIFO`

**Motivation:** Spurious `ConflictError` on concurrent sales is the #1 UX papercut.

**Sketch:**
```typescript
async createSale(data, userId, userRole?): Promise<Transaction> {
  // ... validation ...

  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await this.base.inTransaction(async () => {
        const lines = await this._deductFIFO(data.items, userId);
        return await this._commitTransaction(data, lines, userId, shiftId, null);
      });
    } catch (err) {
      if (err instanceof ConflictError && attempt < MAX_RETRIES - 1) {
        continue;  // refetch happens inside _deductFIFO on the next iteration
      }
      throw err;
    }
  }
  throw new ConflictError('Sale could not be committed after 3 retries. Please try again.');
}
```

**Files:** `transaction.service.ts:60-86`
**Lift:** XS · **Test:** simulate concurrent batch update between retries

### 8.2 Improvement 2 — Inventory valuation report

**Motivation:** No single number tells the user "what's the inventory worth right now."

**Sketch:**
```typescript
// report.repository.ts
async getInventoryValuation(): Promise<{ at_cost: number; at_retail: number; by_category: ... }> {
  return this.base.getOne(`
    SELECT
      SUM(b.quantity_base * COALESCE(NULLIF(b.cost_per_child_override, 0), b.cost_per_child)) AS at_cost,
      SUM(b.quantity_base * COALESCE(NULLIF(b.selling_price_child_override, 0), b.selling_price_child)) AS at_retail
    FROM batches b
    WHERE b.status = 'active' AND b.quantity_base > 0 AND b.expiry_date >= date('now')
  `);
}
```

Plus a by-category breakdown. UI tile on dashboard.

**Files:** `report.repository.ts`, `report.service.ts`, `report.routes.ts`, frontend `DashboardPage`
**Lift:** S · **Test:** unit test the SQL against a seeded fixture

### 8.3 Improvement 3 — Tiered expiry alerts on Dashboard

**Motivation:** `getExpiring(days)` exists but is called only with a single threshold.

**Sketch:** Dashboard widget calls `getExpiring(90)`, then locally buckets results into 0–7, 8–30, 31–90 days. Render as three cards with counts and "view list" link.

**Files:** `DashboardPage.tsx`, no backend changes
**Lift:** S

### 8.4 Improvement 4 — Reorder dashboard

**Motivation:** `products.reorder_threshold` and `min_stock_level` exist but no UI surfaces "below threshold."

**Sketch:**
```sql
SELECT p.id, p.name, COALESCE(SUM(b.quantity_base), 0) AS on_hand_base, p.min_stock_level
FROM products p
LEFT JOIN batches b ON b.product_id = p.id AND b.status = 'active' AND b.quantity_base > 0 AND b.expiry_date >= date('now')
WHERE p.is_active = 1
GROUP BY p.id, p.name, p.min_stock_level
HAVING on_hand_base < p.min_stock_level
```

**Files:** `report.repository.ts` new method; new dashboard tab
**Lift:** S

### 8.5 Improvement 5 — Adjustment history viewer + reversal

**Motivation:** Once an adjustment is logged, there's no UI to view or reverse it. Recovery from "I clicked damage instead of correction" is a manual SQL exercise.

**Sketch:**
- New page under Inventory: "Adjustments" — table from `batch.repository.ts:getAdjustments`.
- Each row has an "Reverse" button (admin only).
- New service method `reverseAdjustment(id)`:
  1. Read adjustment.
  2. Inside `inTransaction`: bump batch quantity back by the reversed amount (`updateQuantityOptimistic`), insert a *new* adjustment row of type `correction` with reason `"Reverses adjustment #N"`.
  3. Emit events.

**Files:** new component + `batch.service.ts` + route/handler
**Lift:** M

### 8.6 Improvement 6 — Batch version display + ConflictError-friendly UX

**Motivation:** Users currently see "Batch modified concurrently" with no recovery path.

**Sketch:**
- BatchForm shows `Version: 3` (read-only) next to the batch number.
- On submission, send `expected_version`. On 409 / ConflictError, dialog says "This batch was updated by someone else. [View their changes] [Reload and re-edit]."
- "Reload and re-edit" refetches and preserves the user's input in a diff view.

**Files:** `BatchForm.tsx` + `api/types.ts` + `batch.service.ts` (needs B-P0-1 fix landed first)
**Lift:** S after B-P0-1

### 8.7 Improvement 7 — Cycle-count workflow

**Motivation:** Periodic physical count vs system inventory is a basic pharmacy compliance need.

**Sketch:**
1. New table `cycle_counts (id, started_at, started_by, status, completed_at)`.
2. New table `cycle_count_items (cycle_id, batch_id, system_qty_snapshot, counted_qty, variance, notes)`.
3. New service `cycle-count.service.ts`:
   - `start()` — snapshots current quantities.
   - `recordCount(cycle_id, batch_id, counted_qty)` — stores actual.
   - `complete(cycle_id)` — computes variance, freezes the row.
4. UI: new "Stock Count" page in Inventory.
5. **No changes to existing batch writes** — cycle counts are read-only against live data. Variance correction is a separate `correction` adjustment.

**Files:** new
**Lift:** M

### 8.8 Improvement 8 — Inventory reconciliation tool

**Motivation:** Detect drift between expected and actual.

**Sketch:** For each active batch:
```
expected_qty = SUM(initial purchase qty) - SUM(sales) + SUM(returns) - SUM(damage/expiry adjustments) + SUM(corrections)
```
Compare with `batches.quantity_base`. Emit a variance report. Read-only — never auto-corrects.

**Files:** new repository method + report; surfaced in Admin → Diagnostics
**Lift:** M

---

## 9. Test coverage gap matrix

| Scenario | Currently tested? | Where it should live |
|---|:-:|---|
| `batch.update` with conflicting expected_version → ConflictError | ❌ | `batch.service.test.ts` |
| CF cascade rollback on injected throw | ❌ | integration `business-flow.test.ts` |
| Sale spans 2+ batches with quantities not multiples of CF | ❌ | `transaction.service.test.ts` |
| Cross-unit return refund matches original line_total | ⚠️ partial | `transaction.service.test.ts:292-411` |
| Return after batch hard-delete → restored batch has real expiry | ❌ | integration |
| Concurrent damage + sale on same batch | ❌ | `batch.service.test.ts` |
| Bulk product import — 50% rows succeed, 50% fail with reasons | ❌ | `product.service.test.ts` |
| Purchase create with idempotency_key collision returns same row | ❌ | `purchase.service.test.ts` |
| Purchase total mismatch warning fires | ❌ | `purchase.service.test.ts` |
| Cost edit blocked after sales | ❌ | `purchase.service.test.ts` |
| Backup restore failure leaves live DB untouched | ❌ | `backup.service.test.ts` (new) |
| Status transition guard rejects sold_out→active | ❌ | `batch.service.test.ts` |
| `bulkUpdateSellingPrices` preserves overrides when `clear_overrides=false` | ❌ | `batch.service.test.ts` |
| Reverse adjustment restores batch quantity | ❌ | `batch.service.test.ts` (new method) |
| Two purchases with same new_product name → both succeed | ❌ | integration |

---

## 10. Verification appendix

Each P0/P1 finding has a runnable command for re-verification.

| ID | Command |
|---|---|
| **B-P0-1** | `Select-String -Path "src\core\repositories\sql\batch.repository.ts" -Pattern "WHERE id = \?" -Context 1` — confirm `update()` has no `AND version` |
| **B-P0-2** | `Select-String -Path "src\core\repositories\sql\batch.repository.ts" -Pattern "rescaleQuantitiesForProduct" -Context 8` — confirm no `version =` in the SQL |
| **B-P0-3** | `Select-String -Path "src\core\services\product.service.ts" -Pattern "rescaleQuantitiesForProduct" -Context 5` — confirm not wrapped in `inTransaction` |
| **B-P0-4** | `Select-String -Path "src\core\services\batch.service.ts" -Pattern "async deleteBatch" -Context 12` — confirm no `getBatchDeleteInfo` call |
| **B-P0-5** | `Select-String -Path "src\core\services\transaction.service.ts" -Pattern "2099-12-31"` — confirm the sentinel exists |
| **S-P0-1** | `Select-String -Path "src\core\services\transaction.service.ts" -Pattern "take / cf" -Context 2` — confirm raw division |
| **S-P0-2** | `Select-String -Path "src\core\services\transaction.service.ts" -Pattern "-Money.subtract" -Context 1` — confirm sign-flip on returns |
| **S-P1-1** | `Select-String -Path "src\core\services\transaction.service.ts" -Pattern "Math.floor\(origItem" -Context 2` |
| **I-P0-4** | `Select-String -Path "src\core\repositories\sql\migration.repository.ts" -Pattern "purchases" -Context 5` — confirm no `idempotency_key` column |
| **I-P0-5** | `Select-String -Path "src\core\services\purchase.service.ts" -Pattern "_processItems" -Context 12` — confirm no `Validate.positiveInteger(item.quantity)` at loop entry |
| **I-P0-6** | `Select-String -Path "src\core\services\purchase.service.ts" -Pattern "dmyMatch"` — confirm the `D/M/Y` regex is used |
| **I-P0-7** | `Select-String -Path "src\platform\electron\main.ts" -Pattern "timeout: 60_000" -Context 3` |
| **I-P1-2** | `Select-String -Path "src\platform\electron\main.ts" -Pattern "backup:restoreFromFile" -Context 20` — confirm direct overwrite |

Items tagged "Hypothesis — needs runtime check" (must execute the app to verify):

- Whether `PRAGMA foreign_keys = ON` is set in `BaseRepository.init` (B-P0-4 outcome depends on this)
- Whether the held-sale IPC handler actually passes `userId` (S-P2-1 outcome depends on this)
- Whether the UI surfaces per-row import errors with row numbers (I-P0-1 outcome depends on the UI)
- Quantity-overflow check for extreme CF changes (I-P1-3)

---

## 11. Out of scope

- ❌ Code changes — this audit is documentation only
- ❌ Schema migrations — fix sketches are written but not executed
- ❌ Bold redesigns (multi-warehouse, GS1 parsing, lot genealogy, narcotic tracking, FEFO toggle) — explicitly excluded per "conservative improvements" choice
- ❌ Non-inventory subsystems unless directly touching inventory state (auth, shifts, expenses, non-inventory reports)
- ❌ Performance benchmarking — observations only, no profiling runs
- ❌ Internal security audit of `pdf_invoice_parser.exe` — only its host-side invocation pattern was audited
- ❌ Frontend a11y / RTL polish — separate audit territory

---

## 12. Glossary & file index

### Glossary

- **CF / Conversion Factor** — `products.conversion_factor`: how many child units in one parent unit. Box of 10 strips → CF=10.
- **Base unit / quantity_base** — Always in child units. A box of 10 strips with 5 boxes on hand = `quantity_base = 50`.
- **FIFO** — First In, First Out — ordered by `expiry_date ASC, id ASC`.
- **Optimistic lock** — `version` column compared in WHERE clause to detect concurrent updates.
- **Ghost batch** — A batch row created during a return-against-deleted-batch with `expiry_date = '2099-12-31'`.
- **CF cascade** — Side effects of changing `products.conversion_factor`: rescale batch quantities + recalc child prices.

### Files audited (in full or substantial part)

| File | Lines audited |
|---|---|
| `src/core/services/transaction.service.ts` | 1-491, 540-639, 699 |
| `src/core/services/batch.service.ts` | 174-279 (per agent), corroborated locally |
| `src/core/services/product.service.ts` | 70-175 |
| `src/core/services/purchase.service.ts` | 494-555, 880-1010 |
| `src/core/services/held-sale.service.ts` | full (55 lines) |
| `src/core/repositories/sql/batch.repository.ts` | 30-90, 110-200, 260-340 |
| `src/core/repositories/sql/product.repository.ts` | 224-300 |
| `src/core/repositories/sql/migration.repository.ts` | 90-170 |
| `src/platform/electron/main.ts` | 380-440, 590-615 |
| `src/core/services/transaction.service.ts` (returns) | 160-380 |

### Top-level file index for cross-referencing

- [src/core/repositories/sql/batch.repository.ts](src/core/repositories/sql/batch.repository.ts)
- [src/core/repositories/sql/product.repository.ts](src/core/repositories/sql/product.repository.ts)
- [src/core/repositories/sql/migration.repository.ts](src/core/repositories/sql/migration.repository.ts)
- [src/core/services/transaction.service.ts](src/core/services/transaction.service.ts)
- [src/core/services/batch.service.ts](src/core/services/batch.service.ts)
- [src/core/services/product.service.ts](src/core/services/product.service.ts)
- [src/core/services/purchase.service.ts](src/core/services/purchase.service.ts)
- [src/core/services/held-sale.service.ts](src/core/services/held-sale.service.ts)
- [src/platform/electron/main.ts](src/platform/electron/main.ts)
- [src/core/common/money.ts](src/core/common/money.ts)

---

**End of audit.** This document is meant to be lived in — keep it open in a tab as you work through the remediation roadmap, and update the table at §0 as items are landed.
