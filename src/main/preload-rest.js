/**
 * REST-based preload for LAN client mode.
 *
 * Exposes the same window.api shape as preload.js, but routes through
 * fetch() to the remote PharmaSys server instead of Electron IPC.
 *
 * Server URL is passed via webPreferences.additionalArguments:
 *   --server-url=http://192.168.1.100:3001
 */

const { contextBridge } = require('electron');

// ─── Server URL from CLI args ────────────────────────────────────────────────

const serverUrlArg = process.argv.find(a => a.startsWith('--server-url='));
const SERVER_URL = serverUrlArg
  ? serverUrlArg.split('=').slice(1).join('=')   // handle '=' in URL
  : 'http://localhost:3001';

// ─── Token Management ───────────────────────────────────────────────────────

let _token = null;

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (_token) h['x-session-token'] = _token;
  return h;
}

// ─── HTTP Helpers ────────────────────────────────────────────────────────────

/** Build an Error carrying the transport's code/status, matching preload.js. */
function apiError(message, code, statusCode) {
  const err = new Error(message);
  err.code = code;
  if (statusCode !== undefined) err.statusCode = statusCode;
  return err;
}

/**
 * THROWS on failure, exactly like preload.js's invoke().
 *
 * This used to RETURN `{ success: false, error }` while preload.js threw.
 * Renderer code is shared between both modes, so every call site that didn't
 * remember to wrap its result in throwIfError() silently treated a failed
 * request as a successful one in LAN/client mode — showing "saved"/"deleted"
 * toasts for operations the server had rejected. Having exactly one error
 * boundary, which behaves the same in both modes, is the fix (audit H7);
 * throwIfError() then degrades to a harmless no-op wherever it's still used.
 */
async function request(method, path, body) {
  const opts = { method, headers: authHeaders() };
  if (body !== undefined) opts.body = JSON.stringify(body);

  let res;
  let json;
  try {
    res = await fetch(`${SERVER_URL}${path}`, opts);
    json = await res.json();
  } catch (err) {
    // Network/parse failure — never reached the server, or it spoke nonsense.
    const host = SERVER_URL.replace('http://', '');
    const detail = err.message || 'Network error';
    if (detail.includes('fetch') || detail.includes('ECONNREFUSED') || detail.includes('network')) {
      throw apiError(
        `Cannot reach server at ${host}. Make sure the server is running and both devices are on the same network.`,
        'NETWORK_ERROR'
      );
    }
    throw apiError(`Server error (${host}): ${detail}`, 'NETWORK_ERROR');
  }

  if (!res.ok) {
    throw apiError(json.error || 'Request failed', json.code || 'UNKNOWN', res.status);
  }
  return json.data;
}

function get(path)        { return request('GET',    path); }
function post(path, body) { return request('POST',   path, body); }
function put(path, body)  { return request('PUT',    path, body); }
function del(path, body)  { return request('DELETE', path, body); }

/** Build query string from an object, filtering out null/undefined/empty values */
function qs(params) {
  if (!params || typeof params !== 'object') return '';
  const entries = Object.entries(params).filter(([, v]) => v != null && v !== '');
  if (entries.length === 0) return '';
  return '?' + new URLSearchParams(entries).toString();
}

// ─── Expose API ──────────────────────────────────────────────────────────────

const noop = () => () => {};  // for event listeners not supported over REST

contextBridge.exposeInMainWorld('api', {

  // ════════════════════════════════════════
  //  AUTHENTICATION & SESSION
  // ════════════════════════════════════════

  auth: {
    // Note: request() now throws on failure, so the old `if (result?.error)`
    // guards here are gone — a bad login propagates as a thrown Error and is
    // caught by LoginPage, same as in Electron/IPC mode.
    login: async (username, password) => {
      const result = await post('/api/v1/auth/login', { username, password });
      _token = result.token;
      return { success: true, user: result.user };
    },

    logout: async () => {
      await post('/api/v1/auth/logout', {});
      _token = null;
      return { success: true };
    },

    // Deliberately does NOT propagate a failure: "not logged in" is the
    // normal answer to a session check, not an exceptional one.
    getCurrentUser: async () => {
      if (!_token) return { success: false, user: null };
      try {
        const result = await get('/api/v1/auth/me');
        return { success: true, user: result };
      } catch {
        return { success: false, user: null };
      }
    },

    changePassword: async (currentPassword, newPassword) => {
      await post('/api/v1/auth/change-password', { currentPassword, newPassword });
      return { success: true };
    },

    getSecurityQuestion: async (username) => {
      return await get(`/api/v1/auth/security-question?username=${encodeURIComponent(username)}`);
    },

    resetPasswordWithSecurityAnswer: async (username, answer, newPassword) => {
      await post('/api/v1/auth/reset-password', { username, answer, newPassword });
      return { success: true };
    },

    setSecurityQuestion: async (question, answer) => {
      await post('/api/v1/auth/security-question/set', { question, answer });
      return { success: true };
    },

    onSessionExpired: noop,
  },

  // ════════════════════════════════════════
  //  SESSION MANAGEMENT
  // ════════════════════════════════════════

  session: {
    trackActivity: async () => { /* no-op — REST sessions managed server-side */ },
    extend:        async () => { /* no-op */ },
    onWarning:     noop,
    onExpired:     noop,
  },

  // ════════════════════════════════════════
  //  USER MANAGEMENT
  // ════════════════════════════════════════

  users: {
    getAll:   async ()          => get('/api/v1/users'),
    getById:  async (id)        => get(`/api/v1/users/${id}`),
    create:   async (userData)  => post('/api/v1/users', userData),
    update:   async (id, data)  => put(`/api/v1/users/${id}`, data),

    resetPassword: async (userId, newPassword) => {
      await post(`/api/v1/users/${userId}/reset-password`, { newPassword });
      return { success: true };
    },

    unlockAccount: async (userId) => {
      await post(`/api/v1/users/${userId}/unlock`, {});
      return { success: true };
    },
  },

  // ════════════════════════════════════════
  //  CATEGORIES
  // ════════════════════════════════════════

  categories: {
    getAll: async ()           => get('/api/v1/categories'),
    create: async (name)       => post('/api/v1/categories', { name }),
    update: async (id, name)   => put(`/api/v1/categories/${id}`, { name }),
  },

  // ════════════════════════════════════════
  //  PRODUCTS
  // ════════════════════════════════════════

  products: {
    getAll:        async ()             => get('/api/v1/products'),
    getList:       async (filters)      => get(`/api/v1/products/list${qs(filters)}`),
    getById:       async (id)           => get(`/api/v1/products/${id}`),
    create:        async (productData)  => post('/api/v1/products', productData),
    update:        async (id, data)     => put(`/api/v1/products/${id}`, data),
    delete:        async (id)           => del(`/api/v1/products/${id}`),
    search:        async (query)        => get(`/api/v1/products/search?q=${encodeURIComponent(query)}`),
    findByBarcode: async (barcode)      => get(`/api/v1/products/barcode/${encodeURIComponent(barcode)}`),
    bulkCreate:    async (items)        => post('/api/v1/products/bulk', items),
    getDeleteInfo: async (id)           => get(`/api/v1/products/${id}/delete-info`),
    bulkDelete:    async (ids)          => post('/api/v1/products/bulk-delete', { ids }),
  },

  // ════════════════════════════════════════
  //  BATCHES
  // ════════════════════════════════════════

  batches: {
    getByProduct:                  async (productId) => get(`/api/v1/batches/by-product/${productId}`),
    getAvailable:                  async (productId) => get(`/api/v1/batches/available/${productId}`),
    getAllAvailable:                async (filters)   => get(`/api/v1/batches/available${qs(filters)}`),
    create:                        async (batchData) => post('/api/v1/batches', batchData),
    update:                        async (id, data)  => put(`/api/v1/batches/${id}`, data),
    getExpiring:                   async (days)      => get(`/api/v1/batches/expiring?days=${days}`),
    getExpired:                    async ()          => get('/api/v1/batches/expired'),
    getActiveBatchesForPriceUpdate: async (productId) => get(`/api/v1/batches/active/${productId}`),
    updatePricesByProduct:         async (data)      => post('/api/v1/batches/update-prices', data),
    previewBulkPriceUpdate:        async (opts)      => post('/api/v1/batches/price-update/preview', opts),
    applyBulkPriceUpdate:          async (opts)      => post('/api/v1/batches/price-update/apply', opts),
    applyManualPriceUpdate:        async (items)     => post('/api/v1/batches/price-update/manual', items),
    getDeleteInfo:                 async (id)        => get(`/api/v1/batches/${id}/delete-info`),
    bulkDelete:                    async (ids)       => post('/api/v1/batches/bulk-delete', { ids }),
  },

  // ════════════════════════════════════════
  //  INVENTORY ADJUSTMENTS
  // ════════════════════════════════════════

  inventory: {
    reportDamage: async (batchId, quantity, reason, type) =>
      post(`/api/v1/batches/${batchId}/damage`, { quantityBase: quantity, reason, type }),

    getAdjustments: async (filters) =>
      get(`/api/v1/batches/adjustments${qs(filters)}`),

    reverseAdjustment: async (id) =>
      post(`/api/v1/batches/adjustments/${id}/reverse`, {}),
  },

  // ════════════════════════════════════════
  //  CASH DROPS
  // ════════════════════════════════════════

  cashDrops: {
    create: async (amount, reason) =>
      post('/api/v1/expenses/cash-drops', { amount, reason }),

    getByShift: async (shiftId) =>
      get(`/api/v1/expenses/cash-drops?shiftId=${shiftId}`),
  },

  // ════════════════════════════════════════
  //  CASH EXCHANGES
  // ════════════════════════════════════════

  cashExchanges: {
    getAll: async (filters) =>
      get(`/api/v1/cash-exchanges${qs(filters)}`),

    getById: async (id) =>
      get(`/api/v1/cash-exchanges/${id}`),

    create: async (exchangeData) =>
      post('/api/v1/cash-exchanges', exchangeData),

    getValidationSettings: async () =>
      get('/api/v1/cash-exchanges/validation-settings'),

    updateValidationSettings: async (settings) =>
      put('/api/v1/cash-exchanges/validation-settings', settings),

    validateCashAvailability: async (data) =>
      post('/api/v1/cash-exchanges/validate-availability', data),
  },

  // ════════════════════════════════════════
  //  TRANSACTIONS (POS)
  // ════════════════════════════════════════

  transactions: {
    create:     async (transactionData) => post('/api/v1/transactions/sale', transactionData),
    getAll:     async (filters)         => get(`/api/v1/transactions${qs(filters)}`),
    getById:    async (id)              => get(`/api/v1/transactions/${id}`),

    void: async (id, reason, force = false) =>
      post(`/api/v1/transactions/${id}/void`, { reason, force }),

    getReturnedQty: async (originalTxnId) =>
      get(`/api/v1/transactions/${originalTxnId}/returned-qty`),

    createReturn: async (returnData) =>
      post('/api/v1/transactions/return', returnData),
  },

  // ════════════════════════════════════════
  //  EXPENSES
  // ════════════════════════════════════════

  expenses: {
    getCategories:  async ()              => get('/api/v1/expenses/categories'),
    createCategory: async (name)          => post('/api/v1/expenses/categories', { name }),
    updateCategory: async (id, name)      => put(`/api/v1/expenses/categories/${id}`, { name }),
    deleteCategory: async (id)            => del(`/api/v1/expenses/categories/${id}`),
    getAll:         async (filters)       => get(`/api/v1/expenses${qs(filters)}`),
    create:         async (expenseData)   => post('/api/v1/expenses', expenseData),
    update:         async (id, data)      => put(`/api/v1/expenses/${id}`, data),
    delete:         async (id, reason)    => del(`/api/v1/expenses/${id}`, { reason }),
  },

  // ════════════════════════════════════════
  //  SHIFTS
  // ════════════════════════════════════════

  shifts: {
    open: async (openingAmount) =>
      post('/api/v1/shifts/open', { openingAmount }),

    getLastCash: async () =>
      get('/api/v1/shifts/last-cash'),

    getExpectedCash: async (shiftId) =>
      get(`/api/v1/shifts/${shiftId}/expected-cash`),

    close: async (shiftId, actualCash, notes) => {
      const result = await post(`/api/v1/shifts/${shiftId}/close`, { actualCash, notes });
      return { success: true, ...result };
    },

    getCurrent: async () => {
      const result = await get('/api/v1/shifts/current');
      // REST returns null when no current shift, which is { data: null }
      return result;
    },

    getReport: async (shiftId) =>
      get(`/api/v1/shifts/${shiftId}/report`),

    getAll: async (filters) =>
      get(`/api/v1/shifts${qs(filters)}`),
  },

  // ════════════════════════════════════════
  //  HELD SALES
  // ════════════════════════════════════════

  held: {
    save: async (items, customerNote) => {
      await post('/api/v1/held-sales', { items, customerNote });
      return { success: true };
    },

    getAll: async () =>
      get('/api/v1/held-sales'),

    delete: async (id) => {
      await del(`/api/v1/held-sales/${id}`);
      return { success: true };
    },
  },

  // ════════════════════════════════════════
  //  REPORTS
  // ════════════════════════════════════════

  reports: {
    cashFlow: async (startDate, endDate) =>
      get(`/api/v1/reports/cash-flow?startDate=${startDate}&endDate=${endDate}`),

    profitLoss: async (startDate, endDate) =>
      get(`/api/v1/reports/profit-loss?startDate=${startDate}&endDate=${endDate}`),

    reorderRecommendations: async () =>
      get('/api/v1/reports/reorder'),

    deadCapital: async (days) =>
      get(`/api/v1/reports/dead-capital?days=${days || 90}`),

    inventoryValuation: async (filters) =>
      get(`/api/v1/reports/inventory-valuation${qs(filters)}`),

    productStockLedger: async (opts) =>
      get(`/api/v1/reports/product-stock-ledger${qs(opts)}`),

    productMovements: async (productId) =>
      get(`/api/v1/reports/product-movements/${productId}`),
  },

  // ════════════════════════════════════════
  //  DASHBOARD
  // ════════════════════════════════════════

  dashboard: {
    stats: async () =>
      get('/api/v1/reports/dashboard'),
  },

  // ════════════════════════════════════════
  //  AUDIT LOGS
  // ════════════════════════════════════════

  audit: {
    getAll: async (filters) =>
      get(`/api/v1/audit${qs(filters)}`),
    getProductHistory: async (productId) =>
      get(`/api/v1/audit/product/${productId}`),
  },

  // ════════════════════════════════════════
  //  SETTINGS
  // ════════════════════════════════════════

  settings: {
    get: async (key) => {
      const result = await get(`/api/v1/settings/${encodeURIComponent(key)}`);
      return result?.value ?? null;
    },

    getAll: async () =>
      get('/api/v1/settings'),

    set: async (key, value) => {
      await put(`/api/v1/settings/${encodeURIComponent(key)}`, { value });
      return { success: true };
    },
  },

  // ════════════════════════════════════════
  //  BACKUP & RESTORE
  // ════════════════════════════════════════

  backup: {
    create:  async ()         => post('/api/v1/backups', {}),
    list:    async ()         => get('/api/v1/backups'),
    restore: async (filename) => post('/api/v1/backups/restore', { filename }),
  },

  // ════════════════════════════════════════
  //  SUPPLIERS
  // ════════════════════════════════════════

  suppliers: {
    getAll:  async (includeInactive) => get(`/api/v1/purchases/suppliers${includeInactive ? '?includeInactive=true' : ''}`),
    getById: async (id)              => get(`/api/v1/purchases/suppliers/${id}`),
    create:  async (data)            => post('/api/v1/purchases/suppliers', data),
    update:  async (id, data)        => put(`/api/v1/purchases/suppliers/${id}`, data),
    delete:  async (id)              => del(`/api/v1/purchases/suppliers/${id}`),
  },

  // ════════════════════════════════════════
  //  PURCHASES
  // ════════════════════════════════════════

  purchases: {
    getAll:              async (filters)                   => get(`/api/v1/purchases${qs(filters)}`),
    getById:             async (id)                        => get(`/api/v1/purchases/${id}`),
    getItems:            async (purchaseId)                => get(`/api/v1/purchases/${purchaseId}/items`),
    getPayments:         async (purchaseId)                => get(`/api/v1/purchases/${purchaseId}/payments`),
    create:              async (data)                      => post('/api/v1/purchases', data),
    update:              async (id, data)                  => put(`/api/v1/purchases/${id}`, data),
    delete:              async (id, force)                 => del(`/api/v1/purchases/${id}${force ? '?force=true' : ''}`),
    addItems:            async (purchaseId, data)          => post(`/api/v1/purchases/${purchaseId}/items`, data),
    markPaymentPaid:     async (paymentId, paymentMethod, referenceNumber, paidAmount, adjustmentStrategy) =>
      post(`/api/v1/purchases/payments/${paymentId}/pay`, { payment_method: paymentMethod, reference_number: referenceNumber, paid_amount: paidAmount, adjustment_strategy: adjustmentStrategy }),
    updatePaymentSchedule:  async (purchaseId, payments)   => put(`/api/v1/purchases/${purchaseId}/schedule`, { payments }),
    replaceUnpaidSchedule:  async (purchaseId, payments)   => put(`/api/v1/purchases/${purchaseId}/schedule/replace`, { payments }),
    getAgingPayments:       async ()                       => get('/api/v1/purchases/aging'),
    getOverdueSummary:      async ()                       => get('/api/v1/purchases/overdue-summary'),
    getUpcomingPayments:    async ()                       => get('/api/v1/purchases/upcoming-payments'),
    getUpcomingSummary:     async ()                       => get('/api/v1/purchases/upcoming-summary'),
    getPendingItems:        async (purchaseId)             => get(`/api/v1/purchases/${purchaseId}/pending-items`),
    completePendingItem:    async (pendingItemId, itemData) => post(`/api/v1/purchases/pending-items/${pendingItemId}/complete`, itemData),
    deletePendingItem:      async (pendingItemId)          => del(`/api/v1/purchases/pending-items/${pendingItemId}`),
    updatePendingItem:      async (pendingItemId, rawData, notes) => put(`/api/v1/purchases/pending-items/${pendingItemId}`, { rawData, notes }),
    updatePayment:          async (paymentId, data)        => put(`/api/v1/purchases/payments/${paymentId}`, data),
    unmarkPaymentPaid:      async (paymentId)              => post(`/api/v1/purchases/payments/${paymentId}/unpay`, {}),
    deletePayment:          async (paymentId)              => del(`/api/v1/purchases/payments/${paymentId}`),
    updateItem:             async (itemId, data)           => put(`/api/v1/purchases/items/${itemId}`, data),
    deleteItem:             async (itemId)                 => del(`/api/v1/purchases/items/${itemId}`),
    merge:                  async (targetId, sourceIds)    => post(`/api/v1/purchases/${targetId}/merge`, { sourceIds }),
    getAllPendingItems:     async (filters)                => get(`/api/v1/purchases/pending-items${qs(filters)}`),
    getProductsBySupplier:  async (supplierId, filters)    => get(`/api/v1/purchases/suppliers/${supplierId}/products${qs(filters)}`),
  },

  // ════════════════════════════════════════
  //  RECURRING EXPENSES
  // ════════════════════════════════════════

  recurringExpenses: {
    getAll:       async ()         => get('/api/v1/recurring-expenses'),
    create:       async (data)     => post('/api/v1/recurring-expenses', data),
    update:       async (id, data) => put(`/api/v1/recurring-expenses/${id}`, data),
    delete:       async (id)       => del(`/api/v1/recurring-expenses/${id}`),
    toggleActive: async (id)       => post(`/api/v1/recurring-expenses/${id}/toggle`, {}),
    preview:      async ()         => get('/api/v1/recurring-expenses/preview'),
    generate:     async (itemIds)  => post('/api/v1/recurring-expenses/generate', { itemIds }),
    restartTimer: async ()         => { /* no-op in client mode — timer runs on server */ },
  },

  // ════════════════════════════════════════
  //  CYCLE COUNTS
  // ════════════════════════════════════════

  cycleCounts: {
    getAll:      async ()               => get('/api/v1/cycle-counts'),
    getById:     async (id)             => get(`/api/v1/cycle-counts/${id}`),
    create:      async (data)           => post('/api/v1/cycle-counts', data),
    start:       async (id, productIds) => post(`/api/v1/cycle-counts/${id}/start`, { productIds }),
    recordCount: async (itemId, counted_quantity) => post(`/api/v1/cycle-counts/items/${itemId}`, { counted_quantity }),
    complete:    async (id, applyAdjustments) => post(`/api/v1/cycle-counts/${id}/complete`, { applyAdjustments }),
  },

  // ════════════════════════════════════════
  //  APP INFO
  // ════════════════════════════════════════

  app: {
    info: async () =>
      get('/api/v1/app'),

    restart: () => {
      const { ipcRenderer } = require('electron');
      return ipcRenderer.invoke('app:restart');
    },
  },

  // ════════════════════════════════════════
  //  DEVICE CONFIG (LAN multi-client)
  // ════════════════════════════════════════

  device: {
    getConfig: async () => {
      // In client mode, device config is managed via Electron IPC (not REST)
      const { ipcRenderer } = require('electron');
      return ipcRenderer.invoke('device:getConfig');
    },

    saveConfig: async (config) => {
      const { ipcRenderer } = require('electron');
      return ipcRenderer.invoke('device:saveConfig', config);
    },
  },

  // ════════════════════════════════════════
  //  LAN DISCOVERY
  // ════════════════════════════════════════

  discovery: {
    scan: () => {
      const { ipcRenderer } = require('electron');
      return ipcRenderer.invoke('discovery:scan');
    },
  },

  // ════════════════════════════════════════
  //  PDF PARSING (not available in client mode)
  // ════════════════════════════════════════

  pdf: {
    parsePython: async () => ({ error: 'PDF parsing is only available on the server device', code: 'NOT_AVAILABLE' }),
  },

  // ════════════════════════════════════════
  //  STARTUP NOTIFICATIONS
  // ════════════════════════════════════════

  notifyReady: () => {},
  onStartupRecurringGenerated: noop,
});

console.log(`[Preload-REST] PharmaSys client mode → ${SERVER_URL}`);
