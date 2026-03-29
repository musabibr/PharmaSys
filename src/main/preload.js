const { contextBridge, ipcRenderer } = require('electron');

/**
 * Wrapper around ipcRenderer.invoke that auto-throws on IPC error responses.
 * The IPC layer returns { success: false, error: "..." } on failure instead of
 * throwing, so without this wrapper, errors are silently swallowed by callers.
 */
async function invoke(channel, ...args) {
    const result = await ipcRenderer.invoke(channel, ...args);
    if (
        result &&
        typeof result === 'object' &&
        result.success === false &&
        typeof result.error === 'string'
    ) {
        const err = new Error(result.error);
        err.code = result.code;
        err.statusCode = result.statusCode;
        throw err;
    }
    return result;
}

contextBridge.exposeInMainWorld('api', {

    // ════════════════════════════════════════
    //  AUTHENTICATION & SESSION
    // ════════════════════════════════════════

    auth: {
        login: (username, password) =>
            invoke('auth:login', { username, password }),

        logout: () =>
            invoke('auth:logout'),

        getCurrentUser: () =>
            invoke('auth:getCurrentUser'),

        changePassword: (currentPassword, newPassword) =>
            invoke('auth:changePassword', { currentPassword, newPassword }),

        // Security question — self-service password reset from the login page
        getSecurityQuestion: (username) =>
            invoke('auth:getSecurityQuestion', username),

        resetPasswordWithSecurityAnswer: (username, answer, newPassword) =>
            invoke('auth:resetPasswordWithSecurityAnswer', { username, answer, newPassword }),

        setSecurityQuestion: (question, answer) =>
            invoke('auth:setSecurityQuestion', { question, answer }),

        // Listen for forced session expiry (e.g., after backup restore)
        onSessionExpired: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('auth:sessionExpired', handler);
            // Return cleanup function
            return () => ipcRenderer.removeListener('auth:sessionExpired', handler);
        },
    },

    // ════════════════════════════════════════
    //  SESSION MANAGEMENT
    // ════════════════════════════════════════

    session: {
        // Track user activity to reset idle timeout
        trackActivity: () =>
            invoke('session:activity'),

        // Manually extend session (called from warning dialog)
        extend: () =>
            invoke('session:extend'),

        // Listen for session timeout warning (5 minutes before expiry)
        onWarning: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('session:warning', handler);
            return () => ipcRenderer.removeListener('session:warning', handler);
        },

        // Listen for session expiry (30 minutes idle)
        onExpired: (callback) => {
            const handler = (_event, data) => callback(data);
            ipcRenderer.on('session:expired', handler);
            return () => ipcRenderer.removeListener('session:expired', handler);
        },
    },

    // ════════════════════════════════════════
    //  USER MANAGEMENT (admin only)
    // ════════════════════════════════════════

    users: {
        getAll: () =>
            invoke('users:getAll'),

        getById: (id) =>
            invoke('users:getById', id),

        create: (userData) =>
            invoke('users:create', userData),

        update: (id, data) =>
            invoke('users:update', { id, data }),

        resetPassword: (userId, newPassword) =>
            invoke('users:resetPassword', { userId, newPassword }),

        unlockAccount: (userId) =>
            invoke('users:unlockAccount', userId),
    },

    // ════════════════════════════════════════
    //  CATEGORIES
    // ════════════════════════════════════════

    categories: {
        getAll: () =>
            invoke('categories:getAll'),

        create: (name) =>
            invoke('categories:create', name),

        update: (id, name) =>
            invoke('categories:update', { id, name }),
    },

    // ════════════════════════════════════════
    //  PRODUCTS
    // ════════════════════════════════════════

    products: {
        getAll: () =>
            invoke('products:getAll'),

        getList: (filters) =>
            invoke('products:getList', filters),

        getById: (id) =>
            invoke('products:getById', id),

        create: (productData) =>
            invoke('products:create', productData),

        update: (id, data) =>
            invoke('products:update', { id, data }),

        delete: (id) =>
            invoke('products:delete', id),

        search: (query) =>
            invoke('products:search', query),

        findByBarcode: (barcode) =>
            invoke('products:findByBarcode', barcode),

        bulkCreate: (items) =>
            invoke('products:bulkCreate', items),

        getDeleteInfo: (id) =>
            invoke('products:getDeleteInfo', id),

        bulkDelete: (ids) =>
            invoke('products:bulkDelete', ids),
    },

    // ════════════════════════════════════════
    //  BATCHES
    // ════════════════════════════════════════

    batches: {
        getByProduct: (productId) =>
            invoke('batches:getByProduct', productId),

        getAvailable: (productId) =>
            invoke('batches:getAvailable', productId),

        getAllAvailable: (filters) =>
            invoke('batches:getAllAvailable', filters),

        create: (batchData) =>
            invoke('batches:create', batchData),

        update: (id, data) =>
            invoke('batches:update', { id, data }),

        getExpiring: (days) =>
            invoke('batches:getExpiring', days),

        getExpired: () =>
            invoke('batches:getExpired'),

        getActiveBatchesForPriceUpdate: (productId) =>
            invoke('batches:getActiveBatchesForPriceUpdate', productId),

        updatePricesByProduct: (data) =>
            invoke('batches:updatePricesByProduct', data),

        getDeleteInfo: (id) =>
            invoke('batches:getDeleteInfo', id),

        bulkDelete: (ids) =>
            invoke('batches:bulkDelete', ids),
    },

    // ════════════════════════════════════════
    //  INVENTORY ADJUSTMENTS
    // ════════════════════════════════════════

    inventory: {
        reportDamage: (batchId, quantity, reason, type) =>
            invoke('inventory:reportDamage', { batchId, quantity, reason, type }),

        getAdjustments: (filters) =>
            invoke('inventory:getAdjustments', filters),
    },

    // ════════════════════════════════════════
    //  CASH DROPS
    // ════════════════════════════════════════

    cashDrops: {
        // user_id and shift_id injected server-side
        create: (amount, reason) =>
            invoke('cashDrops:create', { amount, reason }),

        getByShift: (shiftId) =>
            invoke('cashDrops:getByShift', shiftId),
    },

    // ════════════════════════════════════════
    //  TRANSACTIONS (POS)
    //  Note: user_id and shift_id are injected
    //  server-side — never sent from renderer
    // ════════════════════════════════════════

    transactions: {
        create: (transactionData) =>
            invoke('transactions:create', transactionData),

        getAll: (filters) =>
            invoke('transactions:getAll', filters),

        getById: (id) =>
            invoke('transactions:getById', id),

        // userId injected server-side — only id and reason needed
        // force: admin-only flag to bypass stock checks on return voids
        void: (id, reason, force = false) =>
            invoke('transactions:void', { id, reason, force }),

        // Get already-returned quantities for a sale (batch_id → returned_base)
        getReturnedQty: (originalTxnId) =>
            invoke('transactions:getReturnedQty', originalTxnId),

        // Create a return for some or all items from a sale
        createReturn: (returnData) =>
            invoke('transactions:return', returnData),

        // Sales history per product / batch
        getSalesByProduct: (filters) =>
            invoke('transactions:getSalesByProduct', filters ?? {}),
    },

    // ════════════════════════════════════════
    //  EXPENSES
    // ════════════════════════════════════════

    expenses: {
        getCategories: () =>
            invoke('expenses:getCategories'),

        createCategory: (name) =>
            invoke('expenses:createCategory', name),

        getAll: (filters) =>
            invoke('expenses:getAll', filters),

        // user_id and shift_id injected server-side
        create: (expenseData) =>
            invoke('expenses:create', expenseData),

        update: (id, data) =>
            invoke('expenses:update', { id, data }),

        delete: (id) =>
            invoke('expenses:delete', id),

        updateCategory: (id, name) =>
            invoke('expenses:updateCategory', { id, name }),

        deleteCategory: (id) =>
            invoke('expenses:deleteCategory', id),
    },

    // ════════════════════════════════════════
    //  RECURRING EXPENSES
    // ════════════════════════════════════════

    recurringExpenses: {
        getAll: () =>
            invoke('recurringExpenses:getAll'),

        create: (data) =>
            invoke('recurringExpenses:create', data),

        update: (id, data) =>
            invoke('recurringExpenses:update', { id, data }),

        delete: (id) =>
            invoke('recurringExpenses:delete', id),

        toggleActive: (id) =>
            invoke('recurringExpenses:toggleActive', id),

        preview: () =>
            invoke('recurringExpenses:preview'),

        generate: (itemIds) =>
            invoke('recurringExpenses:generate', itemIds),

        restartTimer: () =>
            ipcRenderer.send('recurringExpenseTimerRestart'),
    },

    // ════════════════════════════════════════
    //  SHIFTS
    //  Note: userId injected server-side
    // ════════════════════════════════════════

    shifts: {
        open: (openingAmount) =>
            invoke('shifts:open', { openingAmount }),

        getLastCash: () =>
            invoke('shifts:getLastCash'),

        getExpectedCash: (shiftId) =>
            invoke('shifts:getExpectedCash', shiftId),

        close: (shiftId, actualCash, notes) =>
            invoke('shifts:close', { shiftId, actualCash, notes }),

        getCurrent: () =>
            invoke('shifts:getCurrent'),

        getReport: (shiftId) =>
            invoke('shifts:getReport', shiftId),

        getAll: (filters) =>
            invoke('shifts:getAll', filters),

        forceClose: (shiftId, actualCash, notes) =>
            invoke('shifts:forceClose', { shiftId, actualCash, notes }),

        updateOpeningAmount: (shiftId, openingAmount, reason) =>
            invoke('shifts:updateOpeningAmount', { shiftId, openingAmount, reason }),
    },

    // ════════════════════════════════════════
    //  HELD SALES
    //  Note: userId injected server-side
    // ════════════════════════════════════════

    held: {
        save: (items, customerNote) =>
            invoke('held:save', { items, customerNote }),

        getAll: () =>
            invoke('held:getAll'),

        delete: (id) =>
            invoke('held:delete', id),
    },

    // ════════════════════════════════════════
    //  REPORTS
    // ════════════════════════════════════════

    reports: {
        cashFlow: (startDate, endDate) =>
            invoke('reports:cashFlow', { startDate, endDate }),

        profitLoss: (startDate, endDate) =>
            invoke('reports:profitLoss', { startDate, endDate }),

        reorderRecommendations: () =>
            invoke('reports:reorderRecommendations'),

        deadCapital: (days) =>
            invoke('reports:deadCapital', days),

        inventoryValuation: (filters) =>
            invoke('reports:inventoryValuation', filters),

        purchaseReport: (startDate, endDate, supplierId, paymentStatus) =>
            invoke('reports:purchaseReport', {
                start_date: startDate, end_date: endDate,
                supplier_id: supplierId || undefined,
                payment_status: paymentStatus || undefined,
            }),
    },

    // ════════════════════════════════════════
    //  DASHBOARD
    // ════════════════════════════════════════

    dashboard: {
        stats: () =>
            invoke('dashboard:stats'),
    },

    // ════════════════════════════════════════
    //  AUDIT LOGS (read-only, admin only)
    // ════════════════════════════════════════

    audit: {
        getAll: (filters) =>
            invoke('audit:getAll', filters),
        // No audit:log — all auditing is server-side only
    },

    // ════════════════════════════════════════
    //  SETTINGS
    // ════════════════════════════════════════

    settings: {
        get: (key) =>
            invoke('settings:get', key),

        getAll: () =>
            invoke('settings:getAll'),

        set: (key, value) =>
            invoke('settings:set', { key, value }),
    },

    // ════════════════════════════════════════
    //  BACKUP & RESTORE
    // ════════════════════════════════════════

    backup: {
        create: () =>
            invoke('backup:create'),

        list: () =>
            invoke('backup:list'),

        restore: (filename) =>
            invoke('backup:restore', { filename }),

        saveAs: (sourcePath) =>
            invoke('backup:saveAs', sourcePath),

        restoreFromFile: () =>
            invoke('backup:restoreFromFile'),

        restartAutoBackupTimer: () =>
            ipcRenderer.send('autoBackupTimerRestart'),
    },

    // ════════════════════════════════════════
    //  SUPPLIERS
    // ════════════════════════════════════════

    suppliers: {
        getAll: (includeInactive) =>
            invoke('suppliers:getAll', includeInactive),

        getById: (id) =>
            invoke('suppliers:getById', id),

        create: (data) =>
            invoke('suppliers:create', data),

        update: (id, data) =>
            invoke('suppliers:update', id, data),

        delete: (id) =>
            invoke('suppliers:delete', id),
    },

    // ════════════════════════════════════════
    //  PURCHASES
    // ════════════════════════════════════════

    purchases: {
        getAll: (filters) =>
            invoke('purchases:getAll', filters),

        getById: (id) =>
            invoke('purchases:getById', id),

        getItems: (purchaseId) =>
            invoke('purchases:getItems', purchaseId),

        getPayments: (purchaseId) =>
            invoke('purchases:getPayments', purchaseId),

        create: (data) =>
            invoke('purchases:create', data),

        update: (id, data) =>
            invoke('purchases:update', id, data),

        delete: (id, force) =>
            invoke('purchases:delete', id, force),

        addItems: (purchaseId, data) =>
            invoke('purchases:addItems', purchaseId, data),

        markPaymentPaid: (paymentId, paymentMethod, referenceNumber, paidAmount, adjustmentStrategy) =>
            invoke('purchases:markPaymentPaid', paymentId, paymentMethod, referenceNumber, paidAmount, adjustmentStrategy),

        updatePaymentSchedule: (purchaseId, payments) =>
            invoke('purchases:updateSchedule', purchaseId, payments),
        replaceUnpaidSchedule: (purchaseId, payments) =>
            invoke('purchases:replaceUnpaidSchedule', purchaseId, payments),

        getAgingPayments: () =>
            invoke('purchases:getAgingPayments'),

        getOverdueSummary: () =>
            invoke('purchases:getOverdueSummary'),

        getUpcomingPayments: () =>
            invoke('purchases:getUpcomingPayments'),

        getUpcomingSummary: () =>
            invoke('purchases:getUpcomingSummary'),

        getPendingItems: (purchaseId) =>
            invoke('purchases:getPendingItems', purchaseId),

        completePendingItem: (pendingItemId, itemData) =>
            invoke('purchases:completePendingItem', pendingItemId, itemData),

        deletePendingItem: (pendingItemId) =>
            invoke('purchases:deletePendingItem', pendingItemId),

        updatePendingItem: (pendingItemId, rawData, notes) =>
            invoke('purchases:updatePendingItem', pendingItemId, rawData, notes),

        updatePayment: (paymentId, data) =>
            invoke('purchases:updatePayment', { paymentId, data }),

        unmarkPaymentPaid: (paymentId) =>
            invoke('purchases:unmarkPaymentPaid', paymentId),

        deletePayment: (paymentId) =>
            invoke('purchases:deletePayment', paymentId),

        updateItem: (itemId, data) =>
            invoke('purchases:updateItem', { itemId, data }),

        deleteItem: (itemId) =>
            invoke('purchases:deleteItem', itemId),

        merge: (targetId, sourceIds) =>
            invoke('purchases:merge', targetId, sourceIds),

        getAllPendingItems: (filters) =>
            invoke('purchases:getAllPendingItems', filters),
    },

    // ════════════════════════════════════════
    //  PDF PARSING
    // ════════════════════════════════════════

    pdf: {
        parsePython: (buffer) =>
            invoke('pdf:parsePython', buffer),
    },

    // ════════════════════════════════════════
    //  APP INFO
    // ════════════════════════════════════════

    app: {
        info: () =>
            invoke('app:info'),

        restart: () =>
            invoke('app:restart'),
    },

    // ════════════════════════════════════════
    //  DEVICE CONFIG (LAN multi-client)
    // ════════════════════════════════════════

    device: {
        getConfig: () =>
            invoke('device:getConfig'),

        saveConfig: (config) =>
            invoke('device:saveConfig', config),
    },

    // ════════════════════════════════════════
    //  LAN DISCOVERY
    // ════════════════════════════════════════

    discovery: {
        scan: () =>
            invoke('discovery:scan'),
    },

    // ════════════════════════════════════════
    //  STARTUP NOTIFICATIONS
    // ════════════════════════════════════════

    notifyReady: () =>
        ipcRenderer.send('app:ready'),

    onStartupRecurringGenerated: (callback) => {
        ipcRenderer.on('startup:recurringGenerated', (_event, data) => callback(data));
    },
});