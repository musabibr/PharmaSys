import { EventBus } from '@core/events/event-bus';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  describe('on / emit', () => {
    it('delivers events to listeners', () => {
      const handler = jest.fn();
      bus.on('entity:mutated', handler);
      bus.emit('entity:mutated', {
        action: 'CREATE_PRODUCT', table: 'products',
        recordId: 1, userId: 1,
      });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'CREATE_PRODUCT', table: 'products' })
      );
    });

    it('delivers to multiple listeners', () => {
      const h1 = jest.fn();
      const h2 = jest.fn();
      bus.on('entity:mutated', h1);
      bus.on('entity:mutated', h2);
      bus.emit('entity:mutated', {
        action: 'UPDATE_PRODUCT', table: 'products', recordId: null, userId: null,
      });
      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
    });

    it('does not deliver to wrong event', () => {
      const handler = jest.fn();
      bus.on('entity:mutated', handler);
      bus.emit('auth:event', {
        action: 'login', userId: 1, username: 'admin',
      });
      expect(handler).not.toHaveBeenCalled();
    });

    it('passes full payload', () => {
      const handler = jest.fn();
      bus.on('transaction:created', handler);
      bus.emit('transaction:created', {
        transactionId: 42,
        transactionType: 'sale',
        userId: 1,
        shiftId: 5,
        totalAmount: 10000,
        itemCount: 3,
      });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ transactionId: 42, totalAmount: 10000 })
      );
    });
  });

  describe('once', () => {
    it('fires only once', () => {
      const handler = jest.fn();
      bus.once('entity:mutated', handler);
      const payload = { action: 'DELETE_PRODUCT' as const, table: 'products', recordId: null, userId: null };
      bus.emit('entity:mutated', payload);
      bus.emit('entity:mutated', payload);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('off', () => {
    it('removes a specific listener', () => {
      const handler = jest.fn();
      bus.on('entity:mutated', handler);
      bus.off('entity:mutated', handler);
      bus.emit('entity:mutated', {
        action: 'UPDATE_PRODUCT', table: 'products', recordId: null, userId: null,
      });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('removeAllListeners', () => {
    it('removes all listeners', () => {
      const h1 = jest.fn();
      const h2 = jest.fn();
      bus.on('entity:mutated', h1);
      bus.on('auth:event', h2);
      bus.removeAllListeners();
      bus.emit('entity:mutated', {
        action: 'UPDATE_PRODUCT', table: 'products', recordId: null, userId: null,
      });
      bus.emit('auth:event', {
        action: 'login', userId: 1, username: 'admin',
      });
      expect(h1).not.toHaveBeenCalled();
      expect(h2).not.toHaveBeenCalled();
    });
  });

  describe('auth:event types', () => {
    it('emits login event', () => {
      const handler = jest.fn();
      bus.on('auth:event', handler);
      bus.emit('auth:event', {
        action: 'login', userId: 1, username: 'admin',
      });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'login' })
      );
    });

    it('emits account_locked event', () => {
      const handler = jest.fn();
      bus.on('auth:event', handler);
      bus.emit('auth:event', {
        action: 'account_locked', userId: 1, username: 'user1',
      });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'account_locked' })
      );
    });
  });

  describe('shift:changed types', () => {
    it('emits opened event', () => {
      const handler = jest.fn();
      bus.on('shift:changed', handler);
      bus.emit('shift:changed', {
        action: 'opened', shiftId: 1, userId: 1,
      });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'opened', shiftId: 1 })
      );
    });

    it('emits closed event with cash data', () => {
      const handler = jest.fn();
      bus.on('shift:changed', handler);
      bus.emit('shift:changed', {
        action: 'closed', shiftId: 1, userId: 1,
        actualCash: 5000, expectedCash: 5000, variance: 0,
      });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'closed', variance: 0 })
      );
    });
  });

  describe('stock:changed', () => {
    it('emits stock change for sale', () => {
      const handler = jest.fn();
      bus.on('stock:changed', handler);
      bus.emit('stock:changed', {
        batchId: 10, productId: 5,
        previousQuantity: 100, newQuantity: 95,
        changeReason: 'sale', userId: 1,
      });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ changeReason: 'sale', newQuantity: 95 })
      );
    });
  });
});
