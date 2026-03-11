'use strict';

/**
 * gateway/app.gateway.ts
 *
 * Thin WebSocket gateway — responsible only for:
 *  1. Connection lifecycle (auth handshake, room joins)
 *  2. Command dispatch (routing to feature handlers)
 *  3. Server-push helpers (pushToUser, pushToSymbol, broadcast)
 *
 * All command business logic lives in the feature handlers under ./handlers/.
 * To add a new feature domain: create a handler, register it in gateway.module.ts,
 * inject it here, and add its commands to _buildCommandMap().
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
import { MarketService } from '../market/market.service';

import { DashboardHandler } from './handlers/dashboard.handler';
import { ProfileHandler } from './handlers/profile.handler';
import { AccountHandler } from './handlers/account.handler';
import { StrategyHandler } from './handlers/strategy.handler';
import { JournalHandler } from './handlers/journal.handler';
import { MarketHandler } from './handlers/market.handler';
import { NotificationsHandler } from './handlers/notifications.handler';

import {
  CreateTradingAccountDto,
  UpdateTradingAccountDto,
} from '../trading-account/trading-account.service';
import { UpdateProfileDto } from '../profile/profile.service';
import {
  CreateJournalTradeDto,
  JournalTradeFilters,
  UpdateJournalTradeDto,
} from '../journal/journal-trade.service';
import { CreateStrategyDto, UpdateStrategyDto } from '../strategy/strategy.service';

// ── Payload shapes ─────────────────────────────────────────────────────────────

interface Payloads {
  'dashboard.get':          { accountId?: string };
  'dashboard.equity':       { accountId: string; startDate?: string; endDate?: string };
  'dashboard.monthlyStats': { accountId: string; year: number; month: number };
  'dashboard.calendar':     { accountId: string; year: number; month: number };
  'dashboard.metrics':      { accountId: string; startDate?: string; endDate?: string };
  'dashboard.daily':        { accountId: string; date: string };
  'profile.get':            Record<string, never>;
  'profile.update':         UpdateProfileDto;
  'profile.pushToken':      { token: string };
  'accounts.list':          { includeInactive?: boolean };
  'account.get':            { id: string };
  'account.create':         CreateTradingAccountDto;
  'account.update':         { id: string } & UpdateTradingAccountDto;
  'account.delete':         { id: string };
  'account.stats':          { id: string };
  'account.toggleAutoTrade':{ id: string; enabled: boolean };
  'strategies.list':        Record<string, never>;
  'strategy.get':           { id: string };
  'strategy.create':        CreateStrategyDto;
  'strategy.update':        { id: string } & UpdateStrategyDto;
  'strategy.delete':        { id: string };
  'trades.list':            JournalTradeFilters;
  'trade.get':              { id: string };
  'trade.create':           CreateJournalTradeDto;
  'trade.update':           { id: string } & UpdateJournalTradeDto;
  'trade.delete':           { id: string };
  'trades.analytics':       { accountId?: string };
  'signals.list':           { symbol?: string; status?: string; limit?: number; offset?: number };
  'signal.get':             { id: string };
  'signals.dashboard':      Record<string, never>;
  'trades.calendar':        { year: number; month: number };
  'zones.list':             { symbol?: string; status?: string; limit?: number; offset?: number };
  'subscriptions.get':      Record<string, never>;
  'subscriptions.add':      { symbols: string[] };
  'subscriptions.remove':   { symbols: string[] };
  'notifications.list':     { limit?: number };
  'notification.markOpened':{ id: string };
}

type Command    = keyof Payloads;
type CommandMap = { [C in Command]: (p: Payloads[C]) => Promise<unknown> };

interface WsMessage<C extends Command = Command> {
  command:    C;
  payload:    Payloads[C];
  requestId?: string;
}

interface WsResponse<T = unknown> {
  command:    string;
  requestId?: string;
  ok:         boolean;
  data?:      T;
  error?:     string;
}

interface AuthSocket extends Socket {
  userId?:     string;
  commandMap?: CommandMap;
}

// ── Gateway ────────────────────────────────────────────────────────────────────

@WebSocketGateway({
  cors:      { origin: process.env['CORS_ORIGIN'] ?? '*', credentials: true },
  namespace: '/ws',
})
@Injectable()
export class AppGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;

  private readonly logger = new Logger(AppGateway.name);

  constructor(
    private readonly jwtVerifier:      JwtVerifierService,
    private readonly dashboardHandler: DashboardHandler,
    private readonly profileHandler:   ProfileHandler,
    private readonly accountHandler:   AccountHandler,
    private readonly strategyHandler:  StrategyHandler,
    private readonly journalHandler:   JournalHandler,
    private readonly marketHandler:    MarketHandler,
    private readonly notifHandler:     NotificationsHandler,
    private readonly marketSvc:        MarketService,
  ) {}

  afterInit(): void {
    this.logger.log('AppGateway initialised ✓');
  }

  async handleConnection(client: AuthSocket): Promise<void> {
    try {
      const token =
        (client.handshake.auth?.['token']) ??
        (client.handshake.headers?.['authorization'])?.replace('Bearer ', '');

      if (!token) { client.disconnect(); return; }

      const user        = await this.jwtVerifier.verifyAndGetUser(token as string);
      client.userId     = user.id;
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

  private _buildCommandMap(userId: string): CommandMap {
    return {
      // Dashboard
      'dashboard.get':          (p) => this.dashboardHandler.get(userId, p.accountId),
      'dashboard.equity':       (p) => this.dashboardHandler.equity(userId, p.accountId, p.startDate, p.endDate),
      'dashboard.monthlyStats': (p) => this.dashboardHandler.monthlyStats(userId, p.accountId, p.year, p.month),
      'dashboard.calendar':     (p) => this.dashboardHandler.calendar(userId, p.accountId, p.year, p.month),
      'dashboard.metrics':      (p) => this.dashboardHandler.metrics(userId, p.accountId, p.startDate, p.endDate),
      'dashboard.daily':        (p) => this.dashboardHandler.daily(userId, p.accountId, p.date),
      // Profile
      'profile.get':       ()  => this.profileHandler.get(userId),
      'profile.update':    (p) => this.profileHandler.update(userId, p),
      'profile.pushToken': (p) => this.profileHandler.pushToken(userId, p.token),
      // Accounts
      'accounts.list':           (p) => this.accountHandler.list(userId, Boolean(p.includeInactive)),
      'account.get':             (p) => this.accountHandler.get(userId, p.id),
      'account.create':          (p) => this.accountHandler.create(userId, p),
      'account.update':          (p) => { const { id, ...rest } = p; return this.accountHandler.update(userId, id, rest); },
      'account.delete':          (p) => this.accountHandler.delete(userId, p.id),
      'account.stats':           (p) => this.accountHandler.stats(userId, p.id),
      'account.toggleAutoTrade': (p) => this.accountHandler.toggleAutoTrade(userId, p.id, p.enabled),
      // Strategies
      'strategies.list':  ()  => this.strategyHandler.list(userId),
      'strategy.get':     (p) => this.strategyHandler.get(userId, p.id),
      'strategy.create':  (p) => this.strategyHandler.create(userId, p),
      'strategy.update':  (p) => { const { id, ...rest } = p; return this.strategyHandler.update(userId, id, rest); },
      'strategy.delete':  (p) => this.strategyHandler.delete(userId, p.id),
      // Journal
      'trades.list':      (p) => this.journalHandler.list(userId, p),
      'trade.get':        (p) => this.journalHandler.get(userId, p.id),
      'trade.create':     (p) => this.journalHandler.create(userId, p),
      'trade.update':     (p) => { const { id, ...rest } = p; return this.journalHandler.update(userId, id, rest); },
      'trade.delete':     (p) => this.journalHandler.delete(userId, p.id),
      'trades.analytics': (p) => this.journalHandler.analytics(userId, p.accountId),
      // Market / signals
      'signals.list':      (p) => this.marketHandler.listAlerts(p),
      'signal.get':        (p) => this.marketHandler.getAlert(p.id),
      'signals.dashboard': ()  => this.marketHandler.dashboardStats(),
      'trades.calendar':   (p) => this.marketHandler.calendar(userId, p.year, p.month),
      'zones.list':        (p) => this.marketHandler.listZones(p),
      // Subscriptions
      'subscriptions.get':    ()  => this.marketHandler.getSubscriptions(userId),
      'subscriptions.add':    (p) => this.marketHandler.subscribe(userId, p.symbols, this.server),
      'subscriptions.remove': (p) => this.marketHandler.unsubscribe(userId, p.symbols, this.server),
      // Notifications
      'notifications.list':      (p) => this.notifHandler.list(userId, p.limit),
      'notification.markOpened': (p) => this.notifHandler.markOpened(p.id),
    };
  }

  // ── Symbol room bootstrap ──────────────────────────────────────────────────

  private async _joinUserSymbolRooms(client: AuthSocket, userId: string): Promise<void> {
    try {
      const subs    = await this.marketSvc.getSubscriptions(userId);
      const symbols: string[] = (subs as any)?.symbols ?? [];
      for (const s of symbols) {
        await client.join(`symbol:${s.toUpperCase()}`);
      }
    } catch {
      this.logger.warn(`Could not bootstrap symbol rooms for ${userId}`);
    }
  }

  // ── Server push ────────────────────────────────────────────────────────────

  pushToUser(userId: string, event: string, data: unknown): void {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  broadcast(event: string, data: unknown): void {
    this.server.emit(event, data);
  }

  /**
   * Push a signal event to all subscribers of a symbol.
   * Uses the symbol room for fast fan-out plus each subscriber's user room as a
   * fallback for recently-reconnected sockets that haven't re-joined yet.
   * Socket.IO deduplicates delivery when a socket belongs to both rooms.
   */
  async pushToSymbol(symbol: string, event: string, data: unknown): Promise<void> {
    const upper = symbol.toUpperCase();
    this.server.to(`symbol:${upper}`).emit(event, data);
    try {
      const subscriberIds = await this.marketHandler.getSubscriberIds(upper);
      for (const userId of subscriberIds) {
        this.server.to(`user:${userId}`).emit(event, data);
      }
    } catch (err) {
      this.logger.warn(`pushToSymbol user-room fallback failed for ${upper}: ${(err as Error).message}`);
    }
  }

  // ── Response helpers ───────────────────────────────────────────────────────

  private _reply<T>(client: Socket, command: string, data: T, requestId?: string): void {
    client.emit('response', { command, data, requestId, ok: true } satisfies WsResponse<T>);
  }

  private _error(client: Socket, requestId?: string, message?: string, command?: string): void {
    client.emit('response', { command: command ?? '', requestId, ok: false, error: message } satisfies WsResponse);
  }
}
