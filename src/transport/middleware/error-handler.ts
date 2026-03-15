/**
 * Unified error handler — maps AppError subclasses to:
 *   - IPC: { success: false, error, code, statusCode }
 *   - REST: HTTP response with matching status code + JSON body
 */

import type { Request, Response, NextFunction } from 'express';
import {
  AppError, ValidationError, NotFoundError,
  AuthenticationError, PermissionError, ConflictError,
} from '../../core/types/errors';

export interface IpcErrorResponse {
  success: false;
  error: string;
  code: string;
  statusCode: number;
  field?: string;
}

export interface IpcSuccessResponse<T = unknown> {
  success: true;
  data: T;
}

export type IpcResponse<T = unknown> = IpcSuccessResponse<T> | IpcErrorResponse;

/** Converts any thrown value into a typed IPC error response. */
export function toIpcError(err: unknown): IpcErrorResponse {
  if (err instanceof ValidationError) {
    return { success: false, error: err.message, code: err.code, statusCode: 400, field: err.field };
  }
  if (err instanceof AppError) {
    return { success: false, error: err.message, code: err.code, statusCode: err.statusCode };
  }
  if (process.env.NODE_ENV !== 'production') {
    const msg = err instanceof Error ? err.message : 'An unexpected error occurred';
    return { success: false, error: msg, code: 'INTERNAL_ERROR', statusCode: 500 };
  }
  return { success: false, error: 'An unexpected error occurred', code: 'INTERNAL_ERROR', statusCode: 500 };
}

/**
 * Wraps a service call for safe IPC handler use.
 * Returns the handler's raw result on success (matching legacy secureHandler behaviour).
 * On error, returns { success: false, error, code, statusCode }.
 */
export async function safeIpc<T>(
  fn: () => T | Promise<T>
): Promise<T | IpcErrorResponse> {
  try {
    return await fn();
  } catch (err) {
    return toIpcError(err);
  }
}

/** Express error-handling middleware — must be registered LAST. */
export function expressErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message, code: err.code, field: err.field });
    return;
  }
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof AuthenticationError) {
    res.status(401).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof PermissionError) {
    res.status(403).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof ConflictError) {
    res.status(409).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }
  console.error('[REST Error]', err);
  const msg = process.env.NODE_ENV !== 'production' && err instanceof Error
    ? err.message
    : 'An unexpected error occurred';
  res.status(500).json({ error: msg, code: 'INTERNAL_ERROR' });
}
