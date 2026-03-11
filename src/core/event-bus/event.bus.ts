import { EventName, EventPayloadMap, Listener, AnyListener } from './event.types';
import { createLogger } from '../../common/logger/logger';

const logger = createLogger('event-bus');

export class EventBus {
  private readonly listeners = new Map<EventName, Array<Listener<EventName>>>();
  private readonly wildcards: AnyListener[] = [];

  on<E extends EventName>(event: E, listener: Listener<E>): void {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(listener as Listener<EventName>);
  }

  off<E extends EventName>(event: E, listener: Listener<E>): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(listener as Listener<EventName>);
    if (idx !== -1) arr.splice(idx, 1);
  }

  onAny(listener: AnyListener): void {
    this.wildcards.push(listener);
  }

  emit<E extends EventName>(event: E, payload: EventPayloadMap[E]): void {
    logger.debug(`emit ${event}`);

    const arr = this.listeners.get(event) ?? [];
    for (const fn of [...arr]) {
      try { fn(payload); } catch (err) {
        logger.error(`Listener error on ${event}`, { error: String(err) });
      }
    }

    for (const fn of this.wildcards) {
      try { fn(event, payload as EventPayloadMap[EventName]); } catch (err) {
        logger.error(`Wildcard error on ${event}`, { error: String(err) });
      }
    }
  }

  removeAll(event?: EventName): void {
    if (event) this.listeners.delete(event);
    else { this.listeners.clear(); this.wildcards.length = 0; }
  }
}
