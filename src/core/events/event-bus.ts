/**
 * Typed event bus — thin wrapper around Node's EventEmitter.
 * Services emit events; listeners (audit, notifications) subscribe.
 */

import { EventEmitter } from 'events';
import type { EventMap, EventName } from '../types/events';

export class EventBus {
  private emitter = new EventEmitter();

  on<K extends EventName>(event: K, listener: (payload: EventMap[K]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  once<K extends EventName>(event: K, listener: (payload: EventMap[K]) => void): this {
    this.emitter.once(event, listener);
    return this;
  }

  off<K extends EventName>(event: K, listener: (payload: EventMap[K]) => void): this {
    this.emitter.off(event, listener);
    return this;
  }

  emit<K extends EventName>(event: K, payload: EventMap[K]): boolean {
    return this.emitter.emit(event, payload);
  }

  /** Remove all listeners (useful for testing teardown) */
  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}
