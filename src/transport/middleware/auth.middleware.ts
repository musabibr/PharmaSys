/**
 * Shared auth middleware for REST API.
 * Uses session tokens stored in memory (same pattern as Electron's currentUser).
 * For Phase 4 the token is a signed JWT; the session store is a simple Map.
 */

import type { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import type { UserPublic } from '../../core/types/models';
import { AuthenticationError, PermissionError } from '../../core/types/errors';
import { resolvePermissions, hasPermission, hasAnyPermission } from '../../core/common/permissions';
import type { PermissionKey } from '../../core/common/permissions';

// ─── Session Store ────────────────────────────────────────────────────────────

interface Session {
  user: UserPublic;
  createdAt: number;
  lastActivity: number;
}

const SESSION_TTL_MS  = 8 * 60 * 60 * 1000; // 8 hours (full shift duration)
const sessions        = new Map<string, Session>();

/** Creates a new session token and stores it. Returns the token. */
export function createSession(user: UserPublic): string {
  const token = crypto.randomBytes(32).toString('hex');
  const now   = Date.now();
  sessions.set(token, { user, createdAt: now, lastActivity: now });
  return token;
}

/** Destroys a session. */
export function destroySession(token: string): void {
  sessions.delete(token);
}

/** Returns the session user if the token is valid and not expired. */
export function getSessionUser(token: string): UserPublic | null {
  const session = sessions.get(token);
  if (!session) return null;

  const now = Date.now();
  if (now - session.lastActivity > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }

  session.lastActivity = now;
  return session.user;
}

/** Garbage-collect expired sessions (call periodically). */
export function pruneExpiredSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [token, session] of sessions) {
    if (session.lastActivity < cutoff) sessions.delete(token);
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      user?: UserPublic;
    }
  }
}

function extractToken(req: Request): string | null {
  const bearer = req.headers.authorization;
  if (bearer && bearer.startsWith('Bearer ')) return bearer.slice(7);
  // Also accept x-session-token header
  const header = req.headers['x-session-token'];
  return typeof header === 'string' ? header : null;
}

/** Middleware: requires a valid session. Sets req.user. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    next(new AuthenticationError('Authentication required. Please log in.'));
    return;
  }
  const user = getSessionUser(token);
  if (!user) {
    next(new AuthenticationError('Session expired. Please log in again.'));
    return;
  }
  req.user = user;
  next();
}

/** Middleware factory: requires auth + a specific permission (admin bypasses). */
export function requirePerm(permission: keyof Pick<UserPublic, 'perm_finance' | 'perm_inventory' | 'perm_reports'>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    requireAuth(req, _res, (err) => {
      if (err) { next(err); return; }
      const user = req.user!;
      if (user.role !== 'admin' && !user[permission]) {
        next(new PermissionError('You do not have permission for this action.'));
        return;
      }
      next();
    });
  };
}

/** Middleware factory: requires auth + a specific micro-permission (admin bypasses). */
export function requireMicroPerm(permission: PermissionKey) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    requireAuth(req, _res, (err) => {
      if (err) { next(err); return; }
      const user = req.user!;
      const perms = resolvePermissions(user);
      if (!hasPermission(user.role, perms, permission)) {
        next(new PermissionError('You do not have permission for this action.'));
        return;
      }
      next();
    });
  };
}

/** Middleware factory: requires auth + any of the given micro-permissions (admin bypasses). */
export function requireAnyMicroPerm(permissions: PermissionKey[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    requireAuth(req, _res, (err) => {
      if (err) { next(err); return; }
      const user = req.user!;
      const perms = resolvePermissions(user);
      if (!hasAnyPermission(user.role, perms, permissions)) {
        next(new PermissionError('You do not have permission for this action.'));
        return;
      }
      next();
    });
  };
}

/** Middleware factory: requires auth + admin role. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  requireAuth(req, _res, (err) => {
    if (err) { next(err); return; }
    if (req.user!.role !== 'admin') {
      next(new PermissionError('Admin access required.'));
      return;
    }
    next();
  });
}
