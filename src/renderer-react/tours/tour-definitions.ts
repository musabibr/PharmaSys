import type { TourDefinition } from './types';

export const TOURS: TourDefinition[] = [
  // ─── 1. Welcome Tour ──────────────────────────────────────────────────────
  {
    id: 'welcome',
    name: 'Welcome Tour',
    description: 'Get to know the basics of PharmaSys',
    route: '/',
    steps: [
      {
        id: 'welcome-intro',
        title: 'Welcome to PharmaSys!',
        text: 'This quick tour will show you the main areas of the system. You can access these tours anytime from the help menu.',
      },
      {
        id: 'welcome-sidebar',
        target: '[data-tour="sidebar"]',
        title: 'Navigation Sidebar',
        text: 'Use the sidebar to navigate between different sections. It shows only the pages you have access to.',
        position: 'right',
      },
      {
        id: 'welcome-theme',
        target: '[data-tour="header-theme"]',
        title: 'Theme Toggle',
        text: 'Switch between light and dark mode to suit your preference.',
        position: 'bottom',
      },
      {
        id: 'welcome-lang',
        target: '[data-tour="header-lang"]',
        title: 'Language Switch',
        text: 'Toggle between English and Arabic. The entire interface will update instantly.',
        position: 'bottom',
      },
      {
        id: 'welcome-user',
        target: '[data-tour="header-user"]',
        title: 'Your Account',
        text: 'Access your profile, change your password, or log out from here.',
        position: 'bottom',
      },
      {
        id: 'welcome-help',
        target: '[data-tour="header-help"]',
        title: 'Guided Tours',
        text: 'Come back here anytime to replay tours or explore new features!',
        position: 'bottom',
      },
    ],
  },

  // ─── 2. Dashboard Tour ────────────────────────────────────────────────────
  {
    id: 'dashboard',
    name: 'Dashboard Tour',
    description: 'Understand your daily overview and alerts',
    route: '/',
    steps: [
      {
        id: 'dash-hero',
        target: '[data-tour="dashboard-hero"]',
        title: 'Daily Summary',
        text: 'Your daily summary shows a greeting, the date, and quick stats about your shift.',
        position: 'bottom',
      },
      {
        id: 'dash-bento',
        target: '[data-tour="dashboard-bento"]',
        title: 'Key Metrics',
        text: 'These cards show your most important numbers — revenue, items sold, profit, and alerts. Click any card to dive deeper.',
        position: 'bottom',
      },
      {
        id: 'dash-alerts',
        target: '[data-tour="dashboard-alerts"]',
        title: 'Low Stock Alerts',
        text: 'Products that need reordering appear here. Keep an eye on these to avoid running out of stock.',
        position: 'top',
      },
      {
        id: 'dash-expiring',
        target: '[data-tour="dashboard-expiring"]',
        title: 'Expiring Soon',
        text: 'Products nearing their expiry date are listed here sorted by date. Take action before they expire.',
        position: 'top',
      },
    ],
  },

  // ─── 3. POS Tour ──────────────────────────────────────────────────────────
  {
    id: 'pos',
    name: 'Point of Sale Tour',
    description: 'Learn how to make sales and manage the cart',
    route: '/pos',
    steps: [
      {
        id: 'pos-search',
        target: '[data-tour="pos-search"]',
        title: 'Product Search',
        text: 'Search for products by name, barcode, or generic name. Results appear instantly as you type.',
        position: 'bottom',
      },
      {
        id: 'pos-grid',
        target: '[data-tour="pos-grid"]',
        title: 'Product Grid',
        text: 'Click any product card to add it to the cart. Each card shows the name, price, and available stock.',
        position: 'right',
      },
      {
        id: 'pos-cart',
        target: '[data-tour="pos-cart"]',
        title: 'Shopping Cart',
        text: 'Items you add appear here. You can adjust quantities, apply discounts, or remove items.',
        position: 'left',
      },
      {
        id: 'pos-cart-total',
        target: '[data-tour="pos-cart-total"]',
        title: 'Cart Total',
        text: 'The running total updates automatically as you modify the cart.',
        position: 'top',
      },
      {
        id: 'pos-hold',
        target: '[data-tour="pos-hold"]',
        title: 'Hold Sale',
        text: 'Need to serve another customer? Hold the current sale and come back to it later.',
        position: 'top',
      },
      {
        id: 'pos-checkout',
        target: '[data-tour="pos-checkout"]',
        title: 'Checkout',
        text: 'When ready, click checkout to complete the sale. Choose payment method and confirm.',
        position: 'top',
      },
    ],
  },

  // ─── 4. Inventory Tour ────────────────────────────────────────────────────
  {
    id: 'inventory',
    name: 'Inventory Tour',
    description: 'Manage products, batches, and stock levels',
    route: '/inventory',
    requiredPermission: 'inventory.products.view',
    steps: [
      {
        id: 'inv-tabs',
        target: '[data-tour="inv-tabs"]',
        title: 'Inventory Tabs',
        text: 'Switch between Products, Batches, Categories, and stock reports using these tabs.',
        position: 'bottom',
      },
      {
        id: 'inv-search',
        target: '[data-tour="inv-search"]',
        title: 'Search & Filter',
        text: 'Quickly find products by name, barcode, or category.',
        position: 'bottom',
      },
      {
        id: 'inv-add-product',
        target: '[data-tour="inv-add-product"]',
        title: 'Add Product',
        text: 'Add a new product to your inventory with details like name, pricing, and units.',
        position: 'bottom',
        requiredPermission: 'inventory.products.manage',
      },
      {
        id: 'inv-bulk-import',
        target: '[data-tour="inv-bulk-import"]',
        title: 'Bulk Import',
        text: 'Import many products at once from a CSV file. Great for initial setup or large stock updates.',
        position: 'bottom',
        requiredPermission: 'inventory.products.bulk_import',
      },
    ],
  },

  // ─── 5. Transactions Tour ─────────────────────────────────────────────────
  {
    id: 'transactions',
    name: 'Transactions Tour',
    description: 'View sales, process returns, and void transactions',
    route: '/transactions',
    requiredPermission: 'finance.transactions.view',
    steps: [
      {
        id: 'txn-filter',
        target: '[data-tour="txn-filter"]',
        title: 'Filter Transactions',
        text: 'Filter by date range, transaction type (sale, return, void), or search by transaction number.',
        position: 'bottom',
      },
      {
        id: 'txn-list',
        target: '[data-tour="txn-list"]',
        title: 'Transaction List',
        text: 'All transactions appear here. Click any row to see full details including items sold.',
        position: 'top',
      },
    ],
  },

  // ─── 6. Expenses Tour ─────────────────────────────────────────────────────
  {
    id: 'expenses',
    name: 'Expenses Tour',
    description: 'Track expenses and manage cash drops',
    route: '/expenses',
    requiredPermission: 'finance.expenses.view',
    steps: [
      {
        id: 'expense-list',
        target: '[data-tour="expense-list"]',
        title: 'Expenses List',
        text: 'All recorded expenses appear here. Track rent, utilities, supplies, and other costs.',
        position: 'top',
      },
      {
        id: 'expense-add',
        target: '[data-tour="expense-add"]',
        title: 'Add Expense',
        text: 'Record a new expense with amount, category, and payment method.',
        position: 'bottom',
        requiredPermission: 'finance.expenses.manage',
      },
    ],
  },

  // ─── 7. Shifts Tour ───────────────────────────────────────────────────────
  {
    id: 'shifts',
    name: 'Shifts Tour',
    description: 'Open and close shifts, track cash in the drawer',
    route: '/shifts',
    requiredPermission: 'finance.shifts.view',
    steps: [
      {
        id: 'shift-status',
        target: '[data-tour="shift-status"]',
        title: 'Current Shift',
        text: 'See the current shift status, who opened it, and when it started.',
        position: 'bottom',
      },
      {
        id: 'shift-open',
        target: '[data-tour="shift-open"]',
        title: 'Open Shift',
        text: 'Start a new shift by entering the opening cash amount in the drawer.',
        position: 'bottom',
      },
      {
        id: 'shift-close',
        target: '[data-tour="shift-close"]',
        title: 'Close Shift',
        text: 'Close the current shift. The system automatically calculates expected cash based on sales, returns, and expenses.',
        position: 'bottom',
      },
    ],
  },

  // ─── 8. Purchases Tour ────────────────────────────────────────────────────
  {
    id: 'purchases',
    name: 'Purchases Tour',
    description: 'Track supplier purchases and installment payments',
    route: '/purchases',
    requiredPermission: 'purchases.view',
    steps: [
      {
        id: 'purchases-list',
        target: '[data-tour="purchases-list"]',
        title: 'Purchases List',
        text: 'Track all supplier purchases, their payment status, and remaining balances.',
        position: 'top',
      },
      {
        id: 'purchases-add',
        target: '[data-tour="purchases-add"]',
        title: 'New Purchase',
        text: 'Record a new purchase from a supplier. Set the total amount and payment schedule.',
        position: 'bottom',
        requiredPermission: 'purchases.manage',
      },
    ],
  },

  // ─── 9. Cash Flow Report Tour ─────────────────────────────────────────────
  {
    id: 'cash-flow',
    name: 'Cash Flow Report Tour',
    description: 'Understand your cash flow analysis',
    route: '/cash-flow',
    requiredPermission: 'reports.cash_flow',
    steps: [
      {
        id: 'report-daterange',
        target: '[data-tour="report-daterange"]',
        title: 'Date Range',
        text: 'Select the reporting period to analyze. Choose from presets or set a custom range.',
        position: 'bottom',
      },
      {
        id: 'report-summary',
        target: '[data-tour="report-summary"]',
        title: 'Cash Flow Summary',
        text: 'Key figures: total revenue, expenses, and net cash flow for the selected period.',
        position: 'bottom',
      },
      {
        id: 'report-chart',
        target: '[data-tour="report-chart"]',
        title: 'Visual Breakdown',
        text: 'The chart shows cash movement over time — helping you spot trends and patterns.',
        position: 'top',
      },
    ],
  },

  // ─── 10. Profit & Loss Report Tour ────────────────────────────────────────
  {
    id: 'profit-loss',
    name: 'Profit & Loss Report Tour',
    description: 'Analyze your profitability',
    route: '/profit-loss',
    requiredPermission: 'reports.profit_loss',
    steps: [
      {
        id: 'pl-summary',
        target: '[data-tour="pl-summary"]',
        title: 'Profit Summary',
        text: 'See gross profit, cost of goods sold, expenses, and net profit at a glance.',
        position: 'bottom',
      },
      {
        id: 'pl-chart',
        target: '[data-tour="pl-chart"]',
        title: 'Profit Trend',
        text: 'The daily trend chart helps you understand how profitability changes over time.',
        position: 'top',
      },
    ],
  },

  // ─── 11. Users Tour ───────────────────────────────────────────────────────
  {
    id: 'users',
    name: 'User Management Tour',
    description: 'Manage staff accounts and permissions',
    route: '/users',
    requiredRole: ['admin'],
    steps: [
      {
        id: 'users-list',
        target: '[data-tour="users-list"]',
        title: 'User List',
        text: 'All staff accounts are listed here with their roles and status.',
        position: 'top',
      },
      {
        id: 'users-add',
        target: '[data-tour="users-add"]',
        title: 'Add User',
        text: 'Create new accounts for your staff. Assign them a role to control what they can access.',
        position: 'bottom',
      },
    ],
  },

  // ─── 12. Audit Log Tour ───────────────────────────────────────────────────
  {
    id: 'audit',
    name: 'Audit Log Tour',
    description: 'Review all system activity',
    route: '/audit',
    requiredRole: ['admin'],
    steps: [
      {
        id: 'audit-filter',
        target: '[data-tour="audit-filter"]',
        title: 'Filter Activity',
        text: 'Filter the audit log by user, action type, or date range to find specific events.',
        position: 'bottom',
      },
      {
        id: 'audit-list',
        target: '[data-tour="audit-list"]',
        title: 'Activity Log',
        text: 'Every action in the system is recorded here — sales, stock changes, user logins, and more.',
        position: 'top',
      },
    ],
  },

  // ─── 13. Settings Tour ────────────────────────────────────────────────────
  {
    id: 'settings',
    name: 'Settings Tour',
    description: 'Configure your pharmacy system',
    route: '/settings',
    requiredRole: ['admin'],
    steps: [
      {
        id: 'settings-pharmacy',
        target: '[data-tour="settings-pharmacy"]',
        title: 'Pharmacy Details',
        text: 'Set your pharmacy name, address, and contact info. This appears on receipts.',
        position: 'bottom',
      },
      {
        id: 'settings-receipt',
        target: '[data-tour="settings-receipt"]',
        title: 'Receipt Settings',
        text: 'Customize what appears on printed receipts — header, footer, and layout.',
        position: 'bottom',
      },
      {
        id: 'settings-tours',
        target: '[data-tour="settings-tours"]',
        title: 'Guided Tours',
        text: 'Reset and replay guided tours from here. Useful when training new staff.',
        position: 'top',
      },
    ],
  },
];
