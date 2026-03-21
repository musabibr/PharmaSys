# Multi-Domain Business Template System

## Context

PharmaSys is currently hardcoded for pharmacy operations. The goal is to make the same codebase support **multiple business domains** (pharmacy, electronics, grocery, general retail) selected at **build time**, with **predefined templates** that users can further customize post-install via Settings.

The core architecture (POS, inventory, shifts, expenses, reports, auth) is already domain-agnostic. Only ~36 translation keys, a few model fields, demo data, and UI labels are pharmacy-specific.

---

## Approach: Config-Driven Templates

A `BusinessTemplate` TypeScript object controls all domain-specific behavior. Templates live in `src/core/templates/` and are shared by backend and frontend. The active domain is set via `BUSINESS_DOMAIN` env var at build time.

---

## Phase 1: Template Infrastructure (no behavior change)

### New files:
- **`src/core/templates/types.ts`** — `BusinessTemplate` interface + `BusinessDomain` type
- **`src/core/templates/pharmacy.template.ts`** — exact current behavior encoded as template
- **`src/core/templates/index.ts`** — `resolveTemplate(domain)` lookup

### `BusinessTemplate` key sections:
```
branding:       { appName, appId, logoLetter, tagline, defaultBusinessName }
productFields:  { genericName: {visible, label}, usageInstructions: {visible, label} }
units:          { defaultParentUnit, defaultChildUnit }
expiry:         { enabled, required, warningDays }
batches:        { batchNumberRequired, quarantineEnabled }
roles:          { staffRoleLabel }  // DB value stays 'pharmacist' everywhere
inventoryTabs:  { expiryTab, quarantineFilter }
dashboard:      { showExpiringSoon, showExpiredCount }
adjustmentTypes: ['damage', 'expiry', 'correction']
demo:           { categories[], products[], productNamePlaceholder }
bulkImport:     { includeGenericColumn, includeExpiryColumn, exampleRow }
```

### Modified files:
- **`src/core/services/index.ts`** — `ServiceContainer` constructor takes `template: BusinessTemplate` as 3rd param, stores it publicly
- **`src/platform/electron/main.ts`** — read `BUSINESS_DOMAIN` env var, resolve template, pass to ServiceContainer
- **`src/platform/server/index.ts`** — same as above

---

## Phase 2: Schema & Backend Flexibility

### `src/core/repositories/sql/migration.repository.ts`:
- Schema: `expiry_date TEXT NOT NULL` → `expiry_date TEXT` (nullable)
- Accept template in constructor for seed data
- `_seedDefaultData()`: use `template.branding.defaultBusinessName`, `template.expiry.warningDays`
- `_seedDemoData()`: use `template.demo.categories` and `template.demo.products`

### `src/core/services/batch.service.ts`:
- `create()`: conditionally validate expiry based on `template.expiry.required`
  - `enabled=false`: skip expiry validation entirely, accept null
  - `required=false, enabled=true`: validate only if provided
  - `required=true`: current behavior (always required)

### `src/core/repositories/sql/batch.repository.ts`:
- FIFO ordering: `ORDER BY b.expiry_date ASC NULLS LAST, b.id ASC` (handles null expiry)

### `src/core/types/models.ts`:
- `Batch.expiry_date`: `string` → `string | null`
- `CreateBatchInput.expiry_date`: make optional

### No changes needed:
- Report queries: NULL expiry_date rows naturally return 0 counts
- Role DB value: stays `'pharmacist'` in all domains (only label changes)

---

## Phase 3: Frontend Template-Driven UI

### New files:
- **`src/renderer-react/lib/template.ts`** — imports resolved template via `__BUSINESS_DOMAIN__` compile-time constant

### Build config:
- **`vite.config.mts`**: add `define: { __BUSINESS_DOMAIN__ }` + `@templates` path alias
- **`tsconfig.renderer.json`**: add `"@templates/*"` path mapping

### Component changes (all use `import { template } from '@/lib/template'`):

| Component | Change |
|-----------|--------|
| `LoginPage.tsx` | `template.branding.appName` + `tagline` |
| `Sidebar.tsx` | `template.branding.logoLetter` + `appName` |
| `ReceiptModal.tsx` | Fallback to `template.branding.defaultBusinessName` |
| `DamageReportForm.tsx` | Print header uses `template.branding.appName` |
| `ProductForm.tsx` | Conditional `generic_name`, `usage_instructions` fields; default units from template |
| `BatchForm.tsx` | Expiry field: required/optional/hidden based on `template.expiry` |
| `InventoryPage.tsx` | Show/hide ExpiryTab based on `template.inventoryTabs.expiryTab` |
| `DashboardPage.tsx` | Show/hide expiry cards based on `template.dashboard` |
| `UsersPage.tsx` | Role label from `template.roles.staffRoleLabel` |
| `BulkImportDialog.tsx` | Conditional generic/expiry columns |
| `SettingsPage.tsx` | Domain customization section for overriding template defaults |
| `DeviceSetupPage.tsx` | Remove "pharmacy network" text |
| `index.html` | Generic title (overridden by `document.title` in App.tsx) |

---

## Phase 4: Additional Templates & Build Scripts

### New files:
- **`src/core/templates/electronics.template.ts`** — expiry disabled, genericName hidden, units Item/Piece, role "Technician"
- **`src/core/templates/grocery.template.ts`** — expiry optional (not required), units Pack/Item, role "Staff"
- **`src/core/templates/general.template.ts`** — expiry disabled, all pharmacy fields hidden, role "Staff"
- **`scripts/build-config.js`** — reads `BUSINESS_DOMAIN`, generates electron-builder config (appId, productName, shortcutName)

### `package.json`:
```
"build:pharmacy": "cross-env BUSINESS_DOMAIN=pharmacy npm run build",
"build:electronics": "cross-env BUSINESS_DOMAIN=electronics npm run build",
"build:grocery": "cross-env BUSINESS_DOMAIN=grocery npm run build",
"dev:electronics": "cross-env BUSINESS_DOMAIN=electronics npm run dev"
```

### `ar.json`:
- Add translations for: "Technician", "Staff", new taglines, domain-neutral labels

---

## Phase 5: Settings Overrides (post-install customization)

Users can override template defaults in Settings (stored in `settings` table):
- `default_parent_unit` / `default_child_unit`
- `expiry_tracking`: `'enabled'|'disabled'|'optional'`
- `generic_name_field_visible`: `'true'|'false'`
- `staff_role_label`

A `getEffectiveConfig(template, getSetting)` function merges template defaults with user overrides.

---

## Key Design Decisions

1. **DB role value stays `'pharmacist'`** — only the display label changes. Avoids schema migrations and test breakage.
2. **`expiry_date` becomes nullable** — non-perishable domains just leave it NULL. Dashboard/report queries naturally return 0 for expiry counts.
3. **FIFO with `NULLS LAST`** — non-perishable items get FIFO by insertion order (id).
4. **No plugin system** — simple config objects, not dynamic extensibility. Right amount of complexity.
5. **`cross-env`** npm package for Windows-compatible env vars in build scripts.

---

## Verification

1. `npm run tsc` — clean compile
2. `npm test` — all existing tests pass (pharmacy template = current behavior)
3. Add tests: batch creation without expiry (electronics template)
4. `BUSINESS_DOMAIN=pharmacy npm run dev` — current behavior, unchanged
5. `BUSINESS_DOMAIN=electronics npm run dev` — no expiry fields, "Technician" role, electronics demo data
6. `BUSINESS_DOMAIN=grocery npm run dev` — optional expiry, grocery categories
7. Build installers per domain and verify branding
