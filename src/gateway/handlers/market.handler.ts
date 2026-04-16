'use strict';

import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';
import { MarketService } from '../../market/market.service';
import { TierGuard } from '../../auth/tier.guard';

@Injectable()
export class MarketHandler {
  constructor(
    private readonly svc: MarketService,
    private readonly tierGuard: TierGuard,
  ) { }

  async listAlerts(
    userId: string,
    params: { symbol?: string; status?: string; limit?: number; offset?: number },
  ) {
    // If caller requests a specific symbol, honour it directly.
    // Otherwise, scope to the user's own subscribed symbols so they only see
    // their feed — not the entire global SignalAlert table.
    const subs = await this.svc.getSubscriptions(userId);
    const symbols: string[] = (subs as any)?.symbols ?? [];
    if (!params.symbol) {
      if (symbols.length > 0) {
        return this.svc.getAlerts(userId, { ...params, symbols });
      }
    }
    return this.svc.getAlerts(userId, { ...params, symbols });
  }

  async getAlert(id: string) {
    return this.svc.getAlert(id);
  }

  async dashboardStats(userId: string) {
    // Aggregate only over the user's subscribed symbols
    const subs = await this.svc.getSubscriptions(userId);
    const symbols: string[] = (subs as any)?.symbols ?? [];
    return this.svc.getDashboardStats(symbols.length > 0 ? symbols : undefined);
  }

  async tradeIdeasList(
    userId: string,
    params: { symbol?: string; status?: string; limit?: number; offset?: number },
  ) {
    // await this.tierGuard.checkCanAccessTradeIdeas(userId);
    return this.listAlerts(userId, params);
  }

  async tradeIdeasDashboard(userId: string) {
    // await this.tierGuard.checkCanAccessTradeIdeas(userId);
    return this.dashboardStats(userId);
  }

  calendar(userId: string, year: number, month: number) {
    return this.svc.getCalendar(userId, year, month);
  }

  async listZones(userId: string, params: { symbol?: string; status?: string; limit?: number; offset?: number }) {
    return await this.svc.getZones(userId, params)
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
