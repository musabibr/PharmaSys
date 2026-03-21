/**
 * Validation helpers — shared between services and transport layers.
 * All functions throw ValidationError on failure.
 */

import { ValidationError } from '../types/errors';

export const Validate = {
  requiredString(val: unknown, fieldName: string, maxLen = 255): string {
    if (!val || typeof val !== 'string' || !val.trim()) {
      throw new ValidationError(`${fieldName} is required`, fieldName);
    }
    if (val.trim().length > maxLen) {
      throw new ValidationError(`${fieldName} must be ${maxLen} characters or less`, fieldName);
    }
    return val.trim();
  },

  optionalString(val: unknown, fieldName: string, maxLen = 255): string | null {
    if (val == null || val === '') return null;
    if (typeof val !== 'string') throw new ValidationError(`${fieldName} must be a string`, fieldName);
    if (val.trim().length > maxLen) {
      throw new ValidationError(`${fieldName} must be ${maxLen} characters or less`, fieldName);
    }
    return val.trim();
  },

  positiveNumber(val: unknown, fieldName: string): number {
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 0) {
      throw new ValidationError(`${fieldName} must be a positive number`, fieldName);
    }
    return n;
  },

  nonNegativeNumber(val: unknown, fieldName: string): number {
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0) {
      throw new ValidationError(`${fieldName} must be a non-negative number`, fieldName);
    }
    return n;
  },

  positiveInteger(val: unknown, fieldName: string): number {
    const n = Number(val);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ValidationError(`${fieldName} must be a positive integer`, fieldName);
    }
    return n;
  },

  id(val: unknown, fieldName = 'ID'): number {
    if (typeof val !== 'number' || !Number.isInteger(val) || val <= 0) {
      throw new ValidationError(`Invalid ${fieldName}`, fieldName);
    }
    return val;
  },

  dateString(val: unknown, fieldName: string): string {
    if (!val || !/^\d{4}-\d{2}-\d{2}$/.test(String(val))) {
      throw new ValidationError(`${fieldName} must be a valid date (YYYY-MM-DD)`, fieldName);
    }
    const d = new Date(String(val) + 'T00:00:00Z');
    if (isNaN(d.getTime())) throw new ValidationError(`${fieldName} is not a valid date`, fieldName);
    return String(val);
  },

  enum<T extends string>(val: unknown, allowed: readonly T[], fieldName: string): T {
    if (!allowed.includes(val as T)) {
      throw new ValidationError(`${fieldName} must be one of: ${allowed.join(', ')}`, fieldName);
    }
    return val as T;
  },

  passwordString(val: unknown, fieldName = 'Password'): string {
    if (!val || typeof val !== 'string' || val.trim().length < 8) {
      throw new ValidationError(`${fieldName} must be at least 8 characters`, fieldName);
    }
    return val;
  },

  escapeLike(str: string): string {
    return str.replace(/[%_\\]/g, '\\$&');
  },
} as const;
