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

async function request(method, path, body) {
  const opts = { method, headers: authHeaders() };
  if (body !== undefined) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(`${SERVER_URL}${path}`, opts);
    const json = await res.json();
    if (!res.ok) {
      return { error: json.error || 'Request failed', code: json.code || 'UNKNOWN' };
    }
    return json.data;
  } catch (err) {
    // Provide a user-friendly error that includes the server address
    const host = SERVER_URL.replace('http://', '');
    const detail = err.message || 'Network error';
    if (detail.includes('fetch') || detail.includes('ECONNREFUSED') || detail.includes('network')) {
      return {
        error: `Cannot reach server at ${host}. Make sure the server is running and both devices are on the same network.`,
        code: 'NETWORK_ERROR',
      };
    }
    return { error: `Server error (${host}): ${detail}`, code: 'NETWORK_ERROR' };
  }
}

function get(path)        { return request('GET',    path); }
function post(path, body) { return request('POST',   path, body); }
function put(path, body)  { return request('PUT',    path, body); }
function del(path)        { return request('DELETE', path); }

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
    login: async (username, password) => {
      const result = await post('/api/v1/auth/login', { username, password });
      if (result?.error) return result;
      _token = result.token;
      return { success: true, user: result.user };
    },

    logout: async () => {
      await post('/api/v1/auth/logout', {});
      _token = null;
      return { success: true };
    },

    getCurrentUser: async () => {
      if (!_token) return { success: false, user: null };
      const result = await get('/api/v1/auth/me');
      if (result?.error) return { success: false, user: null };
      return { success: true, user: result };
    },

    changePassword: async (currentPassword, newPassword) => {
      const result = await post('/api/v1/auth/change-password', { currentPassword, newPassword });
      if (result?.error) return result;
      return { success: true };
    },

    getSecurityQuestion: async (username) => {
      return await get(`/api/v1/auth/security-question?username=${encodeURIComponent(username)}`);
    },

    resetPasswordWithSecurityAnswer: async (username, answer, newPassword) => {
      const result = await post('/api/v1/auth/reset-password', { username, answer, newPassword });
      if (result?.error) return result;
      return { success: true };
    },

    setSecurityQuestion: async (question, answer) => {
      const result = await post('/api/v1/auth/security-question/set', { question, answer });
      if (result?.error) return result;
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
      const result = await post(`/api/v1/users/${userId}/reset-password`, { newPassword });
      if (result?.error) return result;
      return { success: true };
    },

    unlockAccount: async (userId) => {
      const result = await post(`/api/v1/users/${userId}/unlock`, {});
      if (result?.error) return result;
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
    getAll:     async ()             => get('/api/v1/products'),
    getById:    async (id)           => get(`/api/v1/products/${id}`),
    create:     async (productData)  => post('/api/v1/products', productData),
    update:     async (id, data)     => put(`/api/v1/products/${id}`, data),
    delete:     async (id)           => del(`/api/v1/products/${id}`),
    search:     async (query)        => get(`/api/v1/products/search?q=${encodeURIComponent(query)}`),
    bulkCreate: async (items)        => post('/api/v1/products/bulk', items),
  },

  // ════════════════════════════════════════
  //  BATCHES
  // ════════════════════════════════════════

  batches: {
    getByProduct:   async (productId) => get(`/api/v1/batches/by-product/${productId}`),
    getAvailable:   async (productId) => get(`/api/v1/batches/available/${productId}`),
    getAllAvailable: async (filters)   => get(`/api/v1/batches/available${qs(filters)}`),
    create:         async (batchData) => post('/api/v1/batches', batchData),
    update:         async (id, data)  => put(`/api/v1/batches/${id}`, data),
    getExpiring:    async (days)      => get(`/api/v1/batches/expiring?days=${days}`),
    getExpired:     async ()          => get('/api/v1/batches/expired'),
  },

  // ════════════════════════════════════════
  //  INVENTORY ADJUSTMENTS
  // ════════════════════════════════════════

  inventory: {
    reportDamage: async (batchId, quantity, reason, type) =>
      post(`/api/v1/batches/${batchId}/damage`, { quantityBase: quantity, reason, type }),

    getAdjustments: async (filters) =>
      get(`/api/v1/batches/adjustments${qs(filters)}`),
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
    getCategories:  async ()           => get('/api/v1/expenses/categories'),
    createCategory: async (name)       => post('/api/v1/expenses/categories', { name }),
    getAll:         async (filters)    => get(`/api/v1/expenses${qs(filters)}`),
    create:         async (expenseData) => post('/api/v1/expenses', expenseData),
    delete:         async (id)         => del(`/api/v1/expenses/${id}`),
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
      if (result?.error) return result;
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
      const result = await post('/api/v1/held-sales', { items, customerNote });
      if (result?.error) return result;
      return { success: true };
    },

    getAll: async () =>
      get('/api/v1/held-sales'),

    delete: async (id) => {
      const result = await del(`/api/v1/held-sales/${id}`);
      if (result?.error) return result;
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
  },

  // ════════════════════════════════════════
  //  SETTINGS
  // ════════════════════════════════════════

  settings: {
    get: async (key) => {
      const result = await get(`/api/v1/settings/${encodeURIComponent(key)}`);
      if (result?.error) return result;
      return result?.value ?? null;
    },

    getAll: async () =>
      get('/api/v1/settings'),

    set: async (key, value) => {
      const result = await put(`/api/v1/settings/${encodeURIComponent(key)}`, { value });
      if (result?.error) return result;
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
    markPaymentPaid:     async (paymentId, paymentMethod)  => post(`/api/v1/purchases/payments/${paymentId}/pay`, { payment_method: paymentMethod }),
    getAgingPayments:    async ()                          => get('/api/v1/purchases/aging'),
    getOverdueSummary:   async ()                          => get('/api/v1/purchases/overdue-summary'),
    getUpcomingPayments: async ()                          => get('/api/v1/purchases/upcoming-payments'),
    getUpcomingSummary:  async ()                          => get('/api/v1/purchases/upcoming-summary'),
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
});

console.log(`[Preload-REST] PharmaSys client mode → ${SERVER_URL}`);
