'use strict';

/**
 * gateway/app.gateway.ts
 *
 * Single WebSocket gateway — ALL client-facing commands live here.
 * No HTTP endpoints needed for app clients. HTTP remains only for:
 *  - /accounts  (MetaApi broker deployment — long async + credentials)
 *  - /admin     (internal tooling)
 *
 * Added commands vs previous version:
 *  dashboard.equity          — equity curve (accountId, startDate?, endDate?)
 *  dashboard.monthlyStats    — monthly P&L breakdown (accountId, year, month)
 *  dashboard.calendar        — calendar heatmap (accountId, year, month)
 *  dashboard.metrics         — Sharpe/Sortino/drawdown metrics (accountId, startDate?, endDate?)
 *  dashboard.daily           — single-day trade breakdown (accountId, date)
 *  trades.calendar           — signal alert calendar (year, month)
 */

import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger } from '@nestjs/common';
import { JwtVerifierService } from '../auth/jwt-verifier.service';
import { ProfileService, UpdateProfileDto } from '../profile/profile.service';
import { TradingAccountService, CreateTradingAccountDto, UpdateTradingAccountDto } from '../trading-account/trading-account.service';
import {
  CreateJournalTradeDto,
  JournalTradeFilters,
  JournalTradeService,
  UpdateJournalTradeDto,
} from '../journal/journal-trade.service';
import { CreateStrategyDto, StrategyService, UpdateStrategyDto } from '../strategy/strategy.service';
import { MarketService } from '../market/market.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PipelineManager } from '../pipeline/pipeline.manager';

// ── Payload shapes ────────────────────────────────────────────────────────────

interface Payloads {
  // dashboard
  'dashboard.get': Record<string, never>;
  'dashboard.equity': { accountId: string; startDate?: string; endDate?: string };
  'dashboard.monthlyStats': { accountId: string; year: number; month: number };
  'dashboard.calendar': { accountId: string; year: number; month: number };
  'dashboard.metrics': { accountId: string; startDate?: string; endDate?: string };
  'dashboard.daily': { accountId: string; date: string };

  // profile
  'profile.get': Record<string, never>;
  'profile.update': UpdateProfileDto;
  'profile.pushToken': { token: string };

  // trading accounts
  'accounts.list': { includeInactive?: boolean };
  'account.get': { id: string };
  'account.create': CreateTradingAccountDto;
  'account.update': { id: string } & UpdateTradingAccountDto;
  'account.delete': { id: string };
  'account.stats': { id: string };
  'account.toggleAutoTrade': { id: string; enabled: boolean };

  // strategies
  'strategies.list': Record<string, never>;
  'strategy.get': { id: string };
  'strategy.create': CreateStrategyDto;
  'strategy.update': { id: string } & UpdateStrategyDto;
  'strategy.delete': { id: string };

  // journal trades
  'trades.list': JournalTradeFilters;
  'trade.get': { id: string };
  'trade.create': CreateJournalTradeDto;
  'trade.update': { id: string } & UpdateJournalTradeDto;
  'trade.delete': { id: string };
  'trades.analytics': { accountId?: string };

  // signals
  'signals.list': { symbol?: string; status?: string; limit?: number; offset?: number };
  'signal.get': { id: string };
  'signals.dashboard': Record<string, never>;
  'trades.calendar': { year: number; month: number };
  'zones.list': { symbol?: string; status?: string; limit?: number; offset?: number };

  // subscriptions
  'subscriptions.get': Record<string, never>;
  'subscriptions.add': { symbols: string[] };
  'subscriptions.remove': { symbols: string[] };

  // notifications
  'notifications.list': { limit?: number };
  'notification.markOpened': { id: string };
}

type Command = keyof Payloads;
type CommandMap = { [C in Command]: (p: Payloads[C]) => Promise<unknown> };

interface WsMessage<C extends Command = Command> {
  command: C;
  payload: Payloads[C];
  requestId?: string;
}

interface WsResponse<T = unknown> {
  command: string;
  requestId?: string;
  ok: boolean;
  data?: T;
  error?: string;
}

interface AuthSocket extends Socket {
  userId?: string;
  commandMap?: CommandMap;
}

// ── Gateway ───────────────────────────────────────────────────────────────────

@WebSocketGateway({
  cors: { origin: process.env['CORS_ORIGIN'] ?? '*', credentials: true },
  namespace: '/ws',
})
@Injectable()
export class AppGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;

  private readonly logger = new Logger(AppGateway.name);

  constructor(
    private readonly jwtVerifier:     JwtVerifierService,
    private readonly profileSvc:      ProfileService,
    private readonly accountSvc:      TradingAccountService,
    private readonly journalTradeSvc: JournalTradeService,
    private readonly strategySvc:     StrategyService,
    private readonly marketSvc:       MarketService,
    private readonly dashboardSvc:    DashboardService,
    private readonly notificationsSvc: NotificationsService,
    private readonly pipelineMgr:     PipelineManager,
  ) { }

  afterInit(): void {
    this.logger.log('AppGateway initialised ✓');
  }

  async handleConnection(client: AuthSocket): Promise<void> {
    try {
      const token =
        (client.handshake.auth?.['token']) ??
        (client.handshake.headers?.['authorization'])?.replace('Bearer ', '');

      if (!token) { client.disconnect(); return; }

      const user = await this.jwtVerifier.verifyAndGetUser(token as string);
      client.userId = user.id;
      client.commandMap = this._buildCommandMap(user.id);

      await client.join(`user:${user.id}`);
      await this._joinUserSymbolRooms(client, user.id);

      client.emit('connected', { userId: user.id });
      this.logger.log(`Connected: ${client.id} (user: ${user.id})`);
    } catch (err) {
      this.logger.error(`Rejected: ${client.id}`, err instanceof Error ? err.message : err);
      client.emit('error', { message: 'Authentication failed' });
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthSocket): void {
    this.logger.log(`Disconnected: ${client.id} (user: ${client.userId ?? 'unauthenticated'})`);
  }

  @SubscribeMessage('command')
  async handleCommand(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() msg: WsMessage,
  ): Promise<void> {
    if (!client.userId || !client.commandMap) {
      this._error(client, msg.requestId, 'Unauthorized', msg.command);
      return;
    }
    try {
      const handler = client.commandMap[msg.command];
      if (!handler) {
        this._error(client, msg.requestId, `Unknown command: ${msg.command}`, msg.command);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await (handler as (p: any) => Promise<unknown>)(msg.payload);
      this._reply(client, msg.command, data, msg.requestId);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Internal error';
      this.logger.error(`[${msg.command}] ${message}`);
      this._error(client, msg.requestId, message, msg.command);
    }
  }

  // ── Command map ───────────────────────────────────────────────────────────

  private _buildCommandMap(userId: string): CommandMap {
    return {
      // ── Dashboard ──────────────────────────────────────────────────────────

      'dashboard.get': (p) =>
        this.dashboardSvc.get(userId, p.accountId),

      'dashboard.equity': (p) =>
        this.dashboardSvc.getEquityCurve(userId, p.accountId, p.startDate, p.endDate),

      'dashboard.monthlyStats': (p) =>
        this.dashboardSvc.getMonthlyStats(userId, p.accountId, p.year, p.month),

      'dashboard.calendar': (p) =>
        this.dashboardSvc.getCalendar(userId, p.accountId, p.year, p.month),

      'dashboard.metrics': (p) =>
        this.dashboardSvc.getMetrics(userId, p.accountId, p.startDate, p.endDate),

      'dashboard.daily': (p) =>
        this.dashboardSvc.getDailyBreakdown(userId, p.accountId, p.date),

      // ── Profile ────────────────────────────────────────────────────────────

      'profile.get': () => this.profileSvc.findOrCreate(userId),
      'profile.update': (p) => this.profileSvc.update(userId, p),
      'profile.pushToken': (p) => this.profileSvc.updatePushToken(userId, p.token),

      // ── Trading accounts ───────────────────────────────────────────────────

      'accounts.list': (p) => this.accountSvc.findAll(userId, Boolean(p.includeInactive)),
      'account.get': (p) => this.accountSvc.findOne(p.id, userId),
      'account.create': (p) => this.accountSvc.create(userId, p),
      'account.update': (p) => { const { id, ...rest } = p; return this.accountSvc.update(id, userId, rest); },
      'account.delete': (p) => this.accountSvc.delete(p.id, userId),
      'account.stats': (p) => this.accountSvc.getStats(p.id, userId),
      'account.toggleAutoTrade': async (p) => {
        const account = await this.accountSvc.setAutoTrade(p.id, userId, p.enabled);
        if (p.enabled) {
          await this.pipelineMgr.startPipeline(account);
        } else {
          await this.pipelineMgr.stopPipeline(p.id);
        }
        return account;
      },

      // ── Strategies ─────────────────────────────────────────────────────────

      'strategies.list': () => this.strategySvc.findAll(userId),
      'strategy.get': (p) => this.strategySvc.findOne(p.id, userId),
      'strategy.create': (p) => this.strategySvc.create(userId, p),
      'strategy.update': (p) => { const { id, ...rest } = p; return this.strategySvc.update(id, userId, rest); },
      'strategy.delete': (p) => this.strategySvc.delete(p.id, userId),

      // ── Journal trades ─────────────────────────────────────────────────────

      'trades.list': (p) => this.journalTradeSvc.findAll(userId, p),
      'trade.get': (p) => this.journalTradeSvc.findOne(p.id, userId),
      'trade.create': (p) => this.journalTradeSvc.create(userId, p),
      'trade.update': (p) => { const { id, ...rest } = p; return this.journalTradeSvc.update(id, userId, rest); },
      'trade.delete': (p) => this.journalTradeSvc.delete(p.id, userId),
      'trades.analytics': (p) => this.journalTradeSvc.getAnalytics(userId, p.accountId),

      // ── Signals ────────────────────────────────────────────────────────────

      'signals.list': (p) => this.marketSvc.getAlerts(p),
      'signal.get': (p) => this.marketSvc.getAlert(p.id),
      'signals.dashboard': () => this.marketSvc.getDashboardStats(),
      'trades.calendar': (p) => this.marketSvc.getCalendar(userId, p.year, p.month),
      'zones.list': (p) => this.marketSvc.getZones(p),

      // ── Subscriptions ──────────────────────────────────────────────────────

      'subscriptions.get': () => this.marketSvc.getSubscriptions(userId),
      'subscriptions.add': async (p) => {
        const result = await this.marketSvc.subscribe(userId, p.symbols);
        // Join the symbol room on every active socket for this user
        const rooms = p.symbols.map((s) => `symbol:${s.toUpperCase()}`);
        await this._joinRoomsForUser(userId, rooms);
        return result;
      },
      'subscriptions.remove': async (p) => {
        const result = await this.marketSvc.unsubscribe(userId, p.symbols);
        // Leave the symbol room on every active socket for this user
        const rooms = p.symbols.map((s) => `symbol:${s.toUpperCase()}`);
        await this._leaveRoomsForUser(userId, rooms);
        return result;
      },

      // ── Notifications ──────────────────────────────────────────────────────

      'notifications.list': (p) => this.notificationsSvc.getForUser(userId, p.limit),
      'notification.markOpened': (p) => this.notificationsSvc.markOpened(p.id),
    };
  }

  // ── Symbol room bootstrap ─────────────────────────────────────────────────

  private async _joinUserSymbolRooms(client: AuthSocket, userId: string): Promise<void> {
    try {
      const subs = await this.marketSvc.getSubscriptions(userId);
      const symbols: string[] = (subs as any)?.symbols ?? [];
      for (const s of symbols) {
        await client.join(`symbol:${s.toUpperCase()}`);
      }
    } catch {
      this.logger.warn(`Could not bootstrap symbol rooms for ${userId}`);
    }
  }

  /**
   * Join every currently-connected socket for a user into the given rooms.
   * Handles multiple devices / tabs correctly.
   */
  private async _joinRoomsForUser(userId: string, rooms: string[]): Promise<void> {
    const sockets = await this.server.in(`user:${userId}`).fetchSockets();
    for (const socket of sockets) {
      for (const room of rooms) socket.join(room);
    }
  }

  /**
   * Remove every currently-connected socket for a user from the given rooms.
   */
  private async _leaveRoomsForUser(userId: string, rooms: string[]): Promise<void> {
    const sockets = await this.server.in(`user:${userId}`).fetchSockets();
    for (const socket of sockets) {
      for (const room of rooms) socket.leave(room);
    }
  }

  // ── Server push ───────────────────────────────────────────────────────────

  pushToUser(userId: string, event: string, data: unknown): void {
    console.log("listenerRef.current(data) ------------------------")
    this.server.to(`user:${userId}`).emit(event, data);
  }

  broadcast(event: string, data: unknown): void {
    this.server.emit(event, data);
  }

  /**
   * Push a signal event to all subscribers of a symbol.
   *
   * Uses BOTH the symbol room (fast fan-out to all connected sockets in the
   * room) AND each subscriber's individual `user:${id}` room as a fallback —
   * so a socket that reconnected before its symbol rooms were re-joined still
   * receives the event. Socket.IO deduplicates delivery to the same socket
   * automatically when it belongs to both rooms.
   */
  async pushToSymbol(symbol: string, event: string, data: unknown): Promise<void> {
    const upper = symbol.toUpperCase();

    // Fan-out to every socket currently in the symbol room
    this.server.to(`symbol:${upper}`).emit(event, data);

    // Fallback: push directly to each subscriber's user room
    try {
      const subscriberIds = await this.marketSvc.getSubscriberIds(upper);
      console.log("subscriberIds=================subscriberIds", subscriberIds)
      for (const userId of subscriberIds) {
        this.server.to(`user:${userId}`).emit(event, data);
      }
    } catch (err) {
      this.logger.warn(`pushToSymbol user-room fallback failed for ${upper}: ${(err as Error).message}`);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _reply<T>(client: Socket, command: string, data: T, requestId?: string): void {
    client.emit('response', { command, data, requestId, ok: true } satisfies WsResponse<T>);
  }

  private _error(client: Socket, requestId?: string, message?: string, command?: string): void {
    client.emit('response', { command: command ?? '', requestId, ok: false, error: message } satisfies WsResponse);
  }
}