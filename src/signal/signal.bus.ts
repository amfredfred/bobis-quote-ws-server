import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';
import { InboundSignal } from '../common/types/signal.types';

@Injectable()
export class SignalBus {
  private readonly emitter = new EventEmitter();
  constructor() { this.emitter.setMaxListeners(500); }

  emit(signal: InboundSignal): void { this.emitter.emit('signal', signal); }
  onSignal(handler: (s: InboundSignal) => any): void { this.emitter.on('signal', handler); }
  offSignal(handler: (s: InboundSignal) => any): void { this.emitter.off('signal', handler); }
}
