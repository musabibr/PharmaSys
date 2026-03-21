/**
 * Custom error hierarchy for PharmaSys.
 * Transport layers map these to HTTP status codes / IPC error responses.
 */

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 400 — Input validation failed */
export class ValidationError extends AppError {
  public readonly field?: string;

  constructor(message: string, field?: string) {
    super(message, 400, 'VALIDATION_ERROR');
    this.field = field;
  }
}

/** 401 — Not authenticated */
export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'AUTHENTICATION_ERROR');
  }
}

/** 403 — Authenticated but lacks permission */
export class PermissionError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super(message, 403, 'PERMISSION_ERROR');
  }
}

/** 404 — Entity not found */
export class NotFoundError extends AppError {
  public readonly entity: string;
  public readonly entityId?: number | string;

  constructor(entity: string, entityId?: number | string) {
    const msg = entityId
      ? `${entity} with ID ${entityId} not found`
      : `${entity} not found`;
    super(msg, 404, 'NOT_FOUND');
    this.entity = entity;
    this.entityId = entityId;
  }
}

/** 409 — Optimistic locking conflict or duplicate */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT');
  }
}

/** 423 — Account locked */
export class AccountLockedError extends AppError {
  public readonly lockedUntil?: string;

  constructor(message: string, lockedUntil?: string) {
    super(message, 423, 'ACCOUNT_LOCKED');
    this.lockedUntil = lockedUntil;
  }
}

/** 422 — Business rule violation */
export class BusinessRuleError extends AppError {
  constructor(message: string) {
    super(message, 422, 'BUSINESS_RULE_ERROR');
  }
}

/** 500 — Internal / unexpected error */
export class InternalError extends AppError {
  constructor(message = 'An internal error occurred') {
    super(message, 500, 'INTERNAL_ERROR');
  }
}
