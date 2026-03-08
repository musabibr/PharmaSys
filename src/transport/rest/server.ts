/**
 * Express application setup.
 * Mounts all route groups under /api/v1 and wires shared middleware.
 */

import express, { type Application } from 'express';
import cors                          from 'cors';
import type { ServiceContainer }     from '../../core/services/index';
import { expressErrorHandler }       from '../middleware/error-handler';
import { pruneExpiredSessions }      from '../middleware/auth.middleware';

import { authRoutes }                from './routes/auth.routes';
import { userRoutes }                from './routes/user.routes';
import { productRoutes }             from './routes/product.routes';
import { batchRoutes }               from './routes/batch.routes';
import { transactionRoutes }         from './routes/transaction.routes';
import { shiftRoutes }               from './routes/shift.routes';
import { expenseRoutes }             from './routes/expense.routes';
import { reportRoutes }              from './routes/report.routes';
import {
  categoryRoutes, heldSaleRoutes,
  auditRoutes, settingsRoutes, backupRoutes, appInfoRoutes,
} from './routes/misc.routes';
import { purchaseRoutes }           from './routes/purchase.routes';

export function createApp(services: ServiceContainer): Application {
  const app = express();

  // ─── Global Middleware ───────────────────────────────────────────────────────

  // CORS: restrict to LAN IPs + localhost unless CORS_ORIGIN is explicitly set
  const corsOrigin = process.env.CORS_ORIGIN;
  app.use(cors({
    origin: corsOrigin
      ? corsOrigin
      : (origin, cb) => {
          // Allow requests with no origin (same-origin, curl, Electron)
          // Allow no-origin (same-origin, curl) and 'null' origin (file:// in Electron client)
          if (!origin || origin === 'null') return cb(null, true);
          // Allow localhost and private network IPs
          const allowed = /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/;
          cb(null, allowed.test(origin));
        },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-session-token'],
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // Prune expired sessions periodically
  setInterval(pruneExpiredSessions, 5 * 60 * 1000);

  // ─── Health Check ────────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
  });

  // ─── API Routes ──────────────────────────────────────────────────────────────
  const api = express.Router();

  api.use('/auth',         authRoutes(services));
  api.use('/users',        userRoutes(services));
  api.use('/categories',   categoryRoutes(services));
  api.use('/products',     productRoutes(services));
  api.use('/batches',      batchRoutes(services));
  api.use('/transactions', transactionRoutes(services));
  api.use('/shifts',       shiftRoutes(services));
  api.use('/expenses',     expenseRoutes(services));
  api.use('/held-sales',   heldSaleRoutes(services));
  api.use('/reports',      reportRoutes(services));
  api.use('/audit',        auditRoutes(services));
  api.use('/settings',     settingsRoutes(services));
  api.use('/backups',      backupRoutes(services));
  api.use('/purchases',    purchaseRoutes(services));
  api.use('/app',          appInfoRoutes(services));

  app.use('/api/v1', api);

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ error: 'Route not found', code: 'NOT_FOUND' });
  });

  // Global error handler — must be last
  app.use(expressErrorHandler);

  return app;
}
