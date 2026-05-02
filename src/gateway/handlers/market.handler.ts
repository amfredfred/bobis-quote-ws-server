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

  async dashboardStats(userId: string): Promise<ReturnType<typeof emptyDashboard>> {
    const subs = (await this.svc.getSubscriptions(userId)).symbols;
    const symbols: string[] = Array.isArray(subs) ? subs : [];

    if (symbols.length === 0) {
      //  No subscriptions, so return empty stats without hitting the database
      return emptyDashboard();
    }

    const dash = await this.svc.getDashboardStats(symbols);
    return dash;
  }

  async tradeIdeasList(
    userId: string,
    params: { symbol?: string; status?: string; limit?: number; offset?: number },
  ) {
    // await this.tierGuard.checkCanAccessTradeIdeas(userId);
    return await this.listAlerts(userId, params);
  }

  async tradeIdeasDashboard(userId: string) {
    // await this.tierGuard.checkCanAccessTradeIdeas(userId);
    return await this.dashboardStats(userId);
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

function emptyDashboard() {
  return {
    total: 0,
    closed: 0,
    active: 0,
    pending: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    winRate: 0,
    totalRR: 0,
    avgRR: 0,
    bySymbol: {},
    dailyRR: {},
    zones: {
      total: 0,
      watching: 0,
      triggered: 0,
      missed: 0,
      conversionRate: 0,
    },
  };
}