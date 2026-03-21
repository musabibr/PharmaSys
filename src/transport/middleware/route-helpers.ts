/**
 * Route helpers — eliminates repetitive try/catch boilerplate in REST routes.
 */

import type { Request, Response, NextFunction } from 'express';

type RouteHandler = (req: Request, res: Response) => void | Promise<void>;

/**
 * Wraps an async route handler to forward any thrown error to the Express error handler.
 * Replaces the manual `try { ... } catch (e) { next(e); }` pattern.
 */
export function handle(fn: RouteHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const result = fn(req, res);
      if (result && typeof result === 'object' && 'catch' in result) {
        (result as Promise<void>).catch(next);
      }
    } catch (e) {
      next(e);
    }
  };
}
