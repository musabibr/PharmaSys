/**
 * Audit listener — subscribes to entity:mutated and auth:event events
 * and auto-writes audit log entries. This replaces the 40+ manual
 * logAudit() calls scattered throughout the original database.js.
 *
 * Since auditRepo.log() is async, we fire-and-forget with .catch()
 * to avoid blocking the service layer.
 */

import type { EventBus } from './event-bus';
import type { IAuditRepository } from '../types/repositories';

export class AuditListener {
  private _failureCount = 0;

  constructor(
    private readonly eventBus: EventBus,
    private readonly auditRepo: IAuditRepository
  ) {
    this._subscribe();
  }

  private _logSafe(fn: () => Promise<void>, eventType: string): void {
    fn().then(() => {
      this._failureCount = 0;
    }).catch((error) => {
      this._failureCount++;
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[AuditListener] Failed to log event', {
        type: eventType,
        failure: this._failureCount,
        reason: err.message,
      });
    });
  }

  private _subscribe(): void {
    this.eventBus.on('entity:mutated', (event) => {
      this._logSafe(() => {
        return this.auditRepo.log(
          event.userId,
          event.action,
          event.table,
          event.recordId,
          event.oldValues ?? null,
          event.newValues ?? null
        );
      }, event.action);
    });

    this.eventBus.on('auth:event', (event) => {
      this._logSafe(() => {
        return this.auditRepo.log(
          event.userId,
          event.action.toUpperCase(),
          'users',
          event.userId,
          null,
          { username: event.username, ...(event.metadata ?? {}) }
        );
      }, `auth:${event.action}`);
    });

    this.eventBus.on('transaction:created', (event) => {
      this._logSafe(() => {
        return this.auditRepo.log(
          event.userId,
          `${event.transactionType.toUpperCase()}_CREATED`,
          'transactions',
          event.transactionId,
          null,
          {
            total_amount: event.totalAmount,
            shift_id: event.shiftId,
            item_count: event.itemCount,
          }
        );
      }, `transaction:${event.transactionType}`);
    });

    this.eventBus.on('shift:changed', (event) => {
      this._logSafe(() => {
        return this.auditRepo.log(
          event.userId,
          `SHIFT_${event.action.toUpperCase()}`,
          'shifts',
          event.shiftId,
          null,
          {
            opening_amount: event.openingAmount,
            expected_cash: event.expectedCash,
            actual_cash: event.actualCash,
            variance: event.variance,
          }
        );
      }, `shift:${event.action}`);
    });
  }
}
