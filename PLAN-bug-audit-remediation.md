# PharmaSys — Expanded Bug Audit & Remediation Plan

## Context

The user reports "tons of bugs across the system" and points to the existing audit in
[issues.md](issues.md) (31 documented issues). The goal is to
**(1) verify and expand that audit with newly-discovered bugs**, then **(2) produce a prioritized
remediation plan covering all severities** — including code-quality items and documentation drift.

Three parallel sub-audits (backend services/repos, transport/platform, React frontend) were run and
their findings were then **manually verified against the actual source** to separate real bugs from
speculation. A key discovery: **the codebase has evolved well past `CLAUDE.md`** —
services/repositories are now **async** (better-sqlite3, not synchronous sql.js), and auth uses a
**granular micro-permission system** (`inventory.batches.view`, `purchases.manage`, …) rather than the
3-permission model the docs describe. Several agent "bugs" were just this evolution and are excluded.

---

## Part A — New verified bugs to ADD to issues.md (#32+)

These were confirmed by reading the actual source, and are **not** already in issues.md.

### 🔴 Critical

**#32 — Cycle-count REST routes have ZERO auth and crash on every write**
[cycle-count.routes.ts](src/transport/rest/routes/cycle-count.routes.ts)
All 6 handlers lack `requireAuth`/`requireMicroPerm`. [server.ts](src/transport/rest/server.ts#L108)
applies **no** global auth middleware, so:
- POST `/`, `/:id/start`, `/items/:itemId/record`, `/:id/complete` call `req.user!.id` with `req.user`
  undefined → **TypeError → 500**, the feature is simply broken over REST/LAN.
- GET `/` and `/:id` leak cycle-count data to unauthenticated callers.
The IPC equivalents in `cycle-count.handler.ts` correctly gate with `inventory.batches.view/manage`.
Fix: add `requireMicroPerm('inventory.batches.view'|'inventory.batches.manage')` per route and switch
to the shared `handle()` helper for consistent error shaping.

### 🟠 High

**#33 — Batch REST/IPC parity gap (4 operations missing over REST)**
[batch.routes.ts](src/transport/rest/routes/batch.routes.ts) is missing
routes that exist in [batch.handler.ts](src/transport/ipc/handlers/batch.handler.ts):
`getActiveBatchesForPriceUpdate`, `updatePricesByProduct`, `bulkDelete`, `getDeleteInfo`.
LAN/client mode loses price-by-product updates and batch bulk-delete entirely.

**#34 — Purchase REST/IPC parity gap (large; ~10 operations missing over REST)**
[purchase.routes.ts](src/transport/rest/routes/purchase.routes.ts)
implements suppliers, purchase CRUD, schedule, and `markPaymentPaid` only. Missing vs the IPC handler /
preload: payment `update`/`delete`/`unpay`, item `update`/`delete`, all `pending-items` operations
(get/getAll/complete/update/delete), and `merge`. Major feature gap for multi-device deployments.
(Note: agent wrongly said `replaceUnpaidSchedule` was missing — it exists at line 129.)

**#35 — `updatePaymentSchedule` HTTP method mismatch risk**
[purchase.routes.ts:121](src/transport/rest/routes/purchase.routes.ts#L121)
exposes `updatePaymentSchedule` as `PATCH /:id/schedule` while `replaceUnpaidSchedule` is `PUT /:id/schedule`.
Verify `preload-rest.js` calls the correct verb for each; a mismatch means the schedule update silently
404s/mis-routes in LAN mode.

### 🟡 Medium

**#36 — Recurring-expense `toggleActive` is a non-atomic read-modify-write**
`recurring-expense.service.ts` reads `is_active`, flips it, and writes back without a transaction or
version check — concurrent toggles can lose an update. Lower real-world risk (single-user desktop) but
should be a single SQL `UPDATE ... SET is_active = NOT is_active`.

**#37 — `updatePaymentSchedule` validation is TOCTOU**
`purchase.service.ts` validates "sum of scheduled payments == purchase total" then writes in a loop; a
concurrent payment insert between check and write breaks the invariant even inside the SQL transaction
(application-level check happens before writes). Re-validate inside the transaction after re-reading.

### 🔵 Low

**#38 — `held-sale.service.ts:28` uses `Math.round` instead of `Money.round`**
[held-sale.service.ts:28](src/core/services/held-sale.service.ts#L28).
Functionally fine for integer inputs but violates the project-wide Money rule; normalize for consistency.

**#39 — `cart.store.ts` gross-rounding inconsistency (cosmetic)**
[cart.store.ts](src/renderer-react/stores/cart.store.ts) — `getTotal`
uses unrounded `unit_price * quantity` while `getSubtotal`/`getDiscountTotal` use `Math.round(...)`.
Identical in practice (whole-integer money + integer-enforced quantities), but normalize via a single
shared `lineGross()` helper so the three numbers can never diverge if inputs ever become fractional.

> **Frontend agent findings explicitly downgraded as non-issues / speculative** (do not act without
> re-verification): CartPanel rounding (#9 in its report — same non-issue as #39), LoginPage
> forgot-password "no await" claim (the multi-step flow needs re-reading before trusting), ProductGrid
> "no cleanup" and useApiCall claims (the code uses ref-based cancellation). These will be confirmed or
> dismissed during Phase 5 below, not assumed.

---

## Part B — Corrections to the existing audit

- **issues.md #3/#4** (`deletePurchaseItem` / `updatePurchaseItem` not in a transaction) are real and
  remain top priority. (The backend agent re-discovered these as "new #32/#33" — they are duplicates,
  ignore that numbering.)
- **issues.md #11** (`Validate.id` rejects string IDs) and **#25/#26** (`as any` casts) intersect with
  the async/micro-permission evolution — fix in the same pass that aligns types.
- **CLAUDE.md is stale** in three load-bearing ways: (a) claims services are synchronous, (b) describes a
  3-permission model, (c) lists sql.js as the engine. This causes wrong assumptions during any future
  work and should be corrected (Phase 6).

---

## Part C — Remediation plan (phased; covers all severities)

> Each phase ends with `npm run tsc` + `npm test`. Transport changes require touching **both**
> IPC and REST per the dual-transport rule.

### Phase 1 — Critical: data integrity & security
1. **Transactions** — wrap `deletePurchaseItem` and `updatePurchaseItem` (issues.md #3, #4) in
   `this.base.inTransaction(...)`, mirroring `deletePurchase`.
2. **Cycle-count REST auth (#32)** — add per-route `requireMicroPerm(...)` and `handle()` wrapper.
3. **Backup restore (issues.md #1, #2)** — fix `restore()` signature/3-arg call and the
   rename-on-open-file path in `main.ts`; inject the real `userData` data path into `AuthService` for
   emergency reset instead of `process.cwd()`.
4. **Silent product merge (issues.md #5)** — require explicit confirmation / disambiguation before a
   name-match attaches a batch to an existing product.

### Phase 2 — High: parity gaps & logic errors
5. **Batch REST parity (#33)** — add the 4 missing routes with matching micro-permissions/`adminOnly`.
6. **Purchase REST parity (#34, #35)** — add the ~10 missing routes; reconcile PATCH vs PUT schedule
   verbs against `preload-rest.js`.
7. **`autoCloseStale` event (issues.md #7)** — emit the real `actualCash`/`variance`, not `0`.
8. **`Validate.id` string coercion (issues.md #11)** — accept numeric strings (`Number(val)`), still
   reject non-integers/≤0.
9. **Shift close UX (issues.md #12)** — allow admins through `close()` or surface `forceClose` clearly.
10. **Recurring-expense (issues.md #8, #10; #36)** — accurate monthly projection, update
    `last_generated_date`, atomic `toggleActive`.

### Phase 3 — Medium: guards & robustness
11. Purchase payment guards (issues.md #14, #18): block delete/edit of `is_paid` payments.
12. Barcode uniqueness on product update (issues.md #17); `batch_number` length/char validation (#19).
13. `updatePaymentSchedule` TOCTOU re-validation (#37).
14. IPC size-check: avoid `JSON.stringify(args)` on every call / handle ArrayBuffer (issues.md #16).
15. Verify `BatchService.reportDamage` uses the shared `BaseRepository` tx queue (issues.md #15).
16. Path-traversal symmetry on `backup:restoreFromFile` (issues.md #13).

### Phase 4 — Low: code quality & consistency
17. Money consistency: `Math.round`→`Money.round` in held-sale (#38); cart `lineGross()` helper (#39);
    reconcile `trunc` vs `round` in `money.ts` (issues.md #29).
18. DI cleanup: inject `AuditRepository` into `TransactionService` (issues.md #21); remove dead code /
    unused imports (issues.md #20, #22); remove `as any` casts by fixing `BatchFilters`/`Batch` types
    (issues.md #25, #26).
19. `package.json`: move React/UI libs to `dependencies`, drop unused `sql.js` (issues.md #23, #24).
20. `main.ts`: dedupe `app.on('activate')` (issues.md #28); firewall-rule cleanup (issues.md #27);
    standalone wizard / duplicate Toaster (issues.md #6, #31).

### Phase 5 — Verify-then-fix the speculative frontend findings
Re-read each downgraded frontend item (Part A note) and either fix or formally dismiss in issues.md:
LoginPage forgot-password await, CheckoutModal NaN bank-amount validation, ProductGrid/useApiCall
unmount handling, CloseShiftDialog stale state, ReceiptModal `displayQty` conversion fallback.

### Phase 6 — Documentation
Update `CLAUDE.md` to reflect: async services/repos (better-sqlite3), the micro-permission system, and
the actual SQLite engine. Append all verified #32+ items to `issues.md`.

---

## Critical files

- Services: `src/core/services/{purchase,shift,recurring-expense,held-sale,batch,transaction,auth}.service.ts`
- Common: `src/core/common/{validation,money}.ts`
- Transport REST: `src/transport/rest/routes/{cycle-count,batch,purchase}.routes.ts`, `server.ts`
- Transport IPC: `src/transport/ipc/handlers/*.handler.ts`, `register.ts` (parity reference)
- Platform: `src/platform/electron/main.ts`, `src/core/repositories/sql/backup.repository.ts`
- Frontend: `src/renderer-react/{App.tsx,stores/cart.store.ts,components/pos/*,components/auth/LoginPage.tsx}`
- Bridge: `src/main/preload.js`, `src/main/preload-rest.js` (parity source of truth)

## Verification

- `npm run tsc` clean and `npm test` green after each phase (strict mode — no new `any`).
- Transport parity: for each newly added REST route, confirm an IPC counterpart and a matching
  `preload-rest.js` call; smoke-test via `npm run start:server` + `curl` against `/api/v1/...` with and
  without a session token (expect 401/403 where guarded, 200 with a valid token).
- Cycle-count: confirm unauthenticated REST calls now return 401, authenticated succeed.
- Money/cart: run POS checkout in `npm run dev`; subtotal − discounts == total for multi-line carts.
- Backup: create + restore a backup in the packaged/Electron path (not just `process.cwd()`).
- Spot-check audit-log entries for `autoCloseStale` and recurring-expense generation.
