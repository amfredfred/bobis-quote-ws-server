'use strict';

import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';
import { MarketService } from '../../market/market.service';
import { TierGuard } from '../../auth/tier.guard';

@Injectable()
export class MarketHandler {
  constructor(
    private readonly svc:       MarketService,
    private readonly tierGuard: TierGuard,
  ) {}

  listAlerts(params: { symbol?: string; status?: string; limit?: number; offset?: number }) {
    return this.svc.getAlerts(params);
  }

  getAlert(id: string) {
    return this.svc.getAlert(id);
  }

  dashboardStats() {
    return this.svc.getDashboardStats();
  }

  calendar(userId: string, year: number, month: number) {
    return this.svc.getCalendar(userId, year, month);
  }

  listZones(params: { symbol?: string; status?: string; limit?: number; offset?: number }) {
    return this.svc.getZones(params);
  }

  getSubscriptions(userId: string) {
    return this.svc.getSubscriptions(userId);
  }

  async subscribe(
    userId: string,
    symbols: string[],
    server: Server,
  ) {
    await this.tierGuard.checkCanSubscribeSignal(userId, symbols.length);
    const result = await this.svc.subscribe(userId, symbols);
    // Join the symbol room on every active socket for this user
    const rooms = symbols.map((s) => `symbol:${s.toUpperCase()}`);
    const sockets = await server.in(`user:${userId}`).fetchSockets();
    for (const socket of sockets) {
      for (const room of rooms) socket.join(room);
    }
    return result;
  }

  async unsubscribe(
    userId: string,
    symbols: string[],
    server: Server,
  ) {
    const result = await this.svc.unsubscribe(userId, symbols);
    // Leave the symbol room on every active socket for this user
    const rooms = symbols.map((s) => `symbol:${s.toUpperCase()}`);
    const sockets = await server.in(`user:${userId}`).fetchSockets();
    for (const socket of sockets) {
      for (const room of rooms) socket.leave(room);
    }
    return result;
  }

  getSubscriberIds(symbol: string) {
    return this.svc.getSubscriberIds(symbol);
  }

  getZone(id: string) {
    return this.svc.getZone(id);
  }
}
