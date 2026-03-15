const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {

    // ════════════════════════════════════════
    //  AUTHENTICATION & SESSION
    // ════════════════════════════════════════

    auth: {
        login: (username, password) =>
            ipcRenderer.invoke('auth:login', { username, password }),

        logout: () =>
            ipcRenderer.invoke('auth:logout'),

        getCurrentUser: () =>
            ipcRenderer.invoke('auth:getCurrentUser'),

        changePassword: (currentPassword, newPassword) =>
            ipcRenderer.invoke('auth:changePassword', { currentPassword, newPassword }),

        // Security question — self-service password reset from the login page
        getSecurityQuestion: (username) =>
            ipcRenderer.invoke('auth:getSecurityQuestion', username),

        resetPasswordWithSecurityAnswer: (username, answer, newPassword) =>
            ipcRenderer.invoke('auth:resetPasswordWithSecurityAnswer', { username, answer, newPassword }),

        setSecurityQuestion: (question, answer) =>
            ipcRenderer.invoke('auth:setSecurityQuestion', { question, answer }),

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
            ipcRenderer.invoke('session:activity'),

        // Manually extend session (called from warning dialog)
        extend: () =>
            ipcRenderer.invoke('session:extend'),

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
            ipcRenderer.invoke('users:getAll'),

        getById: (id) =>
            ipcRenderer.invoke('users:getById', id),

        create: (userData) =>
            ipcRenderer.invoke('users:create', userData),

        update: (id, data) =>
            ipcRenderer.invoke('users:update', { id, data }),

        resetPassword: (userId, newPassword) =>
            ipcRenderer.invoke('users:resetPassword', { userId, newPassword }),

        unlockAccount: (userId) =>
            ipcRenderer.invoke('users:unlockAccount', userId),
    },

    // ════════════════════════════════════════
    //  CATEGORIES
    // ════════════════════════════════════════

    categories: {
        getAll: () =>
            ipcRenderer.invoke('categories:getAll'),

        create: (name) =>
            ipcRenderer.invoke('categories:create', name),

        update: (id, name) =>
            ipcRenderer.invoke('categories:update', { id, name }),
    },

    // ════════════════════════════════════════
    //  PRODUCTS
    // ════════════════════════════════════════

    products: {
        getAll: () =>
            ipcRenderer.invoke('products:getAll'),

        getList: (filters) =>
            ipcRenderer.invoke('products:getList', filters),

        getById: (id) =>
            ipcRenderer.invoke('products:getById', id),

        create: (productData) =>
            ipcRenderer.invoke('products:create', productData),

        update: (id, data) =>
            ipcRenderer.invoke('products:update', { id, data }),

        delete: (id) =>
            ipcRenderer.invoke('products:delete', id),

        search: (query) =>
            ipcRenderer.invoke('products:search', query),

        findByBarcode: (barcode) =>
            ipcRenderer.invoke('products:findByBarcode', barcode),

        bulkCreate: (items) =>
            ipcRenderer.invoke('products:bulkCreate', items),
    },

    // ════════════════════════════════════════
    //  BATCHES
    // ════════════════════════════════════════

    batches: {
        getByProduct: (productId) =>
            ipcRenderer.invoke('batches:getByProduct', productId),

        getAvailable: (productId) =>
            ipcRenderer.invoke('batches:getAvailable', productId),

        getAllAvailable: (filters) =>
            ipcRenderer.invoke('batches:getAllAvailable', filters),

        create: (batchData) =>
            ipcRenderer.invoke('batches:create', batchData),

        update: (id, data) =>
            ipcRenderer.invoke('batches:update', { id, data }),

        getExpiring: (days) =>
            ipcRenderer.invoke('batches:getExpiring', days),

        getExpired: () =>
            ipcRenderer.invoke('batches:getExpired'),
    },

    // ════════════════════════════════════════
    //  INVENTORY ADJUSTMENTS
    // ════════════════════════════════════════

    inventory: {
        reportDamage: (batchId, quantity, reason, type) =>
            ipcRenderer.invoke('inventory:reportDamage', { batchId, quantity, reason, type }),

        getAdjustments: (filters) =>
            ipcRenderer.invoke('inventory:getAdjustments', filters),
    },

    // ════════════════════════════════════════
    //  CASH DROPS
    // ════════════════════════════════════════

    cashDrops: {
        // user_id and shift_id injected server-side
        create: (amount, reason) =>
            ipcRenderer.invoke('cashDrops:create', { amount, reason }),

        getByShift: (shiftId) =>
            ipcRenderer.invoke('cashDrops:getByShift', shiftId),
    },

    // ════════════════════════════════════════
    //  TRANSACTIONS (POS)
    //  Note: user_id and shift_id are injected
    //  server-side — never sent from renderer
    // ════════════════════════════════════════

    transactions: {
        create: (transactionData) =>
            ipcRenderer.invoke('transactions:create', transactionData),

        getAll: (filters) =>
            ipcRenderer.invoke('transactions:getAll', filters),

        getById: (id) =>
            ipcRenderer.invoke('transactions:getById', id),

        // userId injected server-side — only id and reason needed
        // force: admin-only flag to bypass stock checks on return voids
        void: (id, reason, force = false) =>
            ipcRenderer.invoke('transactions:void', { id, reason, force }),

        // Get already-returned quantities for a sale (batch_id → returned_base)
        getReturnedQty: (originalTxnId) =>
            ipcRenderer.invoke('transactions:getReturnedQty', originalTxnId),

        // Create a return for some or all items from a sale
        createReturn: (returnData) =>
            ipcRenderer.invoke('transactions:return', returnData),
    },

    // ════════════════════════════════════════
    //  EXPENSES
    // ════════════════════════════════════════

    expenses: {
        getCategories: () =>
            ipcRenderer.invoke('expenses:getCategories'),

        createCategory: (name) =>
            ipcRenderer.invoke('expenses:createCategory', name),

        getAll: (filters) =>
            ipcRenderer.invoke('expenses:getAll', filters),

        // user_id and shift_id injected server-side
        create: (expenseData) =>
            ipcRenderer.invoke('expenses:create', expenseData),

        delete: (id) =>
            ipcRenderer.invoke('expenses:delete', id),
    },

    // ════════════════════════════════════════
    //  SHIFTS
    //  Note: userId injected server-side
    // ════════════════════════════════════════

    shifts: {
        open: (openingAmount) =>
            ipcRenderer.invoke('shifts:open', { openingAmount }),

        getLastCash: () =>
            ipcRenderer.invoke('shifts:getLastCash'),

        getExpectedCash: (shiftId) =>
            ipcRenderer.invoke('shifts:getExpectedCash', shiftId),

        close: (shiftId, actualCash, notes) =>
            ipcRenderer.invoke('shifts:close', { shiftId, actualCash, notes }),

        getCurrent: () =>
            ipcRenderer.invoke('shifts:getCurrent'),

        getReport: (shiftId) =>
            ipcRenderer.invoke('shifts:getReport', shiftId),

        getAll: (filters) =>
            ipcRenderer.invoke('shifts:getAll', filters),
    },

    // ════════════════════════════════════════
    //  HELD SALES
    //  Note: userId injected server-side
    // ════════════════════════════════════════

    held: {
        save: (items, customerNote) =>
            ipcRenderer.invoke('held:save', { items, customerNote }),

        getAll: () =>
            ipcRenderer.invoke('held:getAll'),

        delete: (id) =>
            ipcRenderer.invoke('held:delete', id),
    },

    // ════════════════════════════════════════
    //  REPORTS
    // ════════════════════════════════════════

    reports: {
        cashFlow: (startDate, endDate) =>
            ipcRenderer.invoke('reports:cashFlow', { startDate, endDate }),

        profitLoss: (startDate, endDate) =>
            ipcRenderer.invoke('reports:profitLoss', { startDate, endDate }),

        reorderRecommendations: () =>
            ipcRenderer.invoke('reports:reorderRecommendations'),

        deadCapital: (days) =>
            ipcRenderer.invoke('reports:deadCapital', days),

        inventoryValuation: (filters) =>
            ipcRenderer.invoke('reports:inventoryValuation', filters),

        purchaseReport: (startDate, endDate, supplierId, paymentStatus) =>
            ipcRenderer.invoke('reports:purchaseReport', {
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
            ipcRenderer.invoke('dashboard:stats'),
    },

    // ════════════════════════════════════════
    //  AUDIT LOGS (read-only, admin only)
    // ════════════════════════════════════════

    audit: {
        getAll: (filters) =>
            ipcRenderer.invoke('audit:getAll', filters),
        // No audit:log — all auditing is server-side only
    },

    // ════════════════════════════════════════
    //  SETTINGS
    // ════════════════════════════════════════

    settings: {
        get: (key) =>
            ipcRenderer.invoke('settings:get', key),

        getAll: () =>
            ipcRenderer.invoke('settings:getAll'),

        set: (key, value) =>
            ipcRenderer.invoke('settings:set', { key, value }),
    },

    // ════════════════════════════════════════
    //  BACKUP & RESTORE
    // ════════════════════════════════════════

    backup: {
        create: () =>
            ipcRenderer.invoke('backup:create'),

        list: () =>
            ipcRenderer.invoke('backup:list'),

        restore: (filename) =>
            ipcRenderer.invoke('backup:restore', { filename }),

        saveAs: (sourcePath) =>
            ipcRenderer.invoke('backup:saveAs', sourcePath),

        restoreFromFile: () =>
            ipcRenderer.invoke('backup:restoreFromFile'),

        restartAutoBackupTimer: () =>
            ipcRenderer.send('autoBackupTimerRestart'),
    },

    // ════════════════════════════════════════
    //  SUPPLIERS
    // ════════════════════════════════════════

    suppliers: {
        getAll: (includeInactive) =>
            ipcRenderer.invoke('suppliers:getAll', includeInactive),

        getById: (id) =>
            ipcRenderer.invoke('suppliers:getById', id),

        create: (data) =>
            ipcRenderer.invoke('suppliers:create', data),

        update: (id, data) =>
            ipcRenderer.invoke('suppliers:update', id, data),
    },

    // ════════════════════════════════════════
    //  PURCHASES
    // ════════════════════════════════════════

    purchases: {
        getAll: (filters) =>
            ipcRenderer.invoke('purchases:getAll', filters),

        getById: (id) =>
            ipcRenderer.invoke('purchases:getById', id),

        getItems: (purchaseId) =>
            ipcRenderer.invoke('purchases:getItems', purchaseId),

        getPayments: (purchaseId) =>
            ipcRenderer.invoke('purchases:getPayments', purchaseId),

        create: (data) =>
            ipcRenderer.invoke('purchases:create', data),

        update: (id, data) =>
            ipcRenderer.invoke('purchases:update', id, data),

        delete: (id) =>
            ipcRenderer.invoke('purchases:delete', id),

        addItems: (purchaseId, data) =>
            ipcRenderer.invoke('purchases:addItems', purchaseId, data),

        markPaymentPaid: (paymentId, paymentMethod, referenceNumber, paidAmount, adjustmentStrategy) =>
            ipcRenderer.invoke('purchases:markPaymentPaid', paymentId, paymentMethod, referenceNumber, paidAmount, adjustmentStrategy),

        updatePaymentSchedule: (purchaseId, payments) =>
            ipcRenderer.invoke('purchases:updateSchedule', purchaseId, payments),
        replaceUnpaidSchedule: (purchaseId, payments) =>
            ipcRenderer.invoke('purchases:replaceUnpaidSchedule', purchaseId, payments),

        getAgingPayments: () =>
            ipcRenderer.invoke('purchases:getAgingPayments'),

        getOverdueSummary: () =>
            ipcRenderer.invoke('purchases:getOverdueSummary'),

        getUpcomingPayments: () =>
            ipcRenderer.invoke('purchases:getUpcomingPayments'),

        getUpcomingSummary: () =>
            ipcRenderer.invoke('purchases:getUpcomingSummary'),
    },

    // ════════════════════════════════════════
    //  PDF PARSING
    // ════════════════════════════════════════

    pdf: {
        parsePython: (buffer) =>
            ipcRenderer.invoke('pdf:parsePython', buffer),
    },

    // ════════════════════════════════════════
    //  APP INFO
    // ════════════════════════════════════════

    app: {
        info: () =>
            ipcRenderer.invoke('app:info'),

        restart: () =>
            ipcRenderer.invoke('app:restart'),
    },

    // ════════════════════════════════════════
    //  DEVICE CONFIG (LAN multi-client)
    // ════════════════════════════════════════

    device: {
        getConfig: () =>
            ipcRenderer.invoke('device:getConfig'),

        saveConfig: (config) =>
            ipcRenderer.invoke('device:saveConfig', config),
    },

    // ════════════════════════════════════════
    //  LAN DISCOVERY
    // ════════════════════════════════════════

    discovery: {
        scan: () =>
            ipcRenderer.invoke('discovery:scan'),
    },
});