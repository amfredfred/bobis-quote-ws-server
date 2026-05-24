'use strict';

import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Injectable, Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtVerifierService } from '../auth/jwt-verifier.service';
import { resolveError } from '../common/errors';
import { CreateJournalTradeDto, JournalTradeFilters, UpdateJournalTradeDto } from '../journal/journal-trade.service';
import { UpdateProfileDto } from '../profile/profile.service';
import { CreateStrategyDto, UpdateStrategyDto } from '../strategy/strategy.service';
import { CreateTradingAccountDto, UpdateTradingAccountDto } from '../trading-account/trading-account.service';
import { AccountHandler } from './handlers/account.handler';
import { AnalyticsHandler } from './handlers/analytics.handler';
import { DashboardHandler } from './handlers/dashboard.handler';
import { JournalHandler } from './handlers/journal.handler';
import { NotificationsHandler } from './handlers/notifications.handler';
import { ProfileHandler } from './handlers/profile.handler';
import { StrategyHandler } from './handlers/strategy.handler';
import { SubscriptionHandler } from './handlers/subscription.handler';
import { SystemHandler } from './handlers/system.handler';

interface Payloads {
  'system.config': Record<string, never>;
  'dashboard.get': { accountId: string };
  'dashboard.equity': { accountId: string; startDate?: string; endDate?: string };
  'dashboard.monthlyStats': { accountId: string; year: number; month: number };
  'dashboard.calendar': { accountId: string; year: number; month: number };
  'dashboard.metrics': { accountId: string; startDate?: string; endDate?: string };
  'dashboard.daily': { accountId: string; date: string };
  'profile.get': Record<string, never>;
  'profile.update': UpdateProfileDto;
  'profile.pushToken': { token: string };
  'accounts.list': { includeInactive?: boolean };
  'account.get': { id: string };
  'account.create': CreateTradingAccountDto;
  'account.update': { id: string } & UpdateTradingAccountDto;
  'account.delete': { id: string };
  'account.stats': { id: string };
  'strategies.list': Record<string, never>;
  'strategy.get': { id: string };
  'strategy.create': CreateStrategyDto;
  'strategy.update': { id: string } & UpdateStrategyDto;
  'strategy.delete': { id: string };
  'trades.list': JournalTradeFilters;
  'trade.get': { id: string };
  'trade.create': CreateJournalTradeDto;
  'trade.update': { id: string } & UpdateJournalTradeDto;
  'trade.delete': { id: string };
  'trades.analytics': { accountId?: string };
  'notifications.list': { limit?: number };
  'notification.markOpened': { id: string };
  'notifications.markAllOpened': Record<string, never>;
  'analytics.ror': { accountId: string };
  'analytics.equity': { accountId: string; startDate?: string; endDate?: string };
  'analytics.rolling': { accountId: string };
  'analytics.strategies': { accountId?: string };
  'analytics.hours': { accountId?: string };
  'analytics.streaks': { accountId?: string };
  'analytics.patterns': { accountId?: string };
  'analytics.monthly': { accountId?: string; months?: number };
  'analytics.full': { accountId: string };
  'analytics.projection': {
    accountId: string;
    winRatePct?: number;
    avgWin?: number;
    avgLoss?: number;
    tradesPerMonth?: number;
    riskPct?: number;
    months?: number;
    propPayoutTargetPct?: number;
    propPayoutSplitPct?: number;
  };
  'trial.start': Record<string, never>;
  'trial.status': Record<string, never>;
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

const PUBLIC_COMMANDS = new Set<Command>(['system.config']);
const RL_RATE = 10;
const RL_BURST = 30;
const RL_CLEANUP = 5 * 60 * 1000;
const RL_COSTS: Partial<Record<string, number>> = {
  'analytics.full': 5,
  'analytics.projection': 3,
  'analytics.rolling': 3,
  'analytics.patterns': 3,
  'analytics.strategies': 3,
  'trade.create': 3,
  'trade.update': 3,
  'trade.delete': 3,
};

interface Bucket { tokens: number; lastMs: number; timer: ReturnType<typeof setTimeout>; }

class WsRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  allow(userId: string, command: string): boolean {
    const now = Date.now();
    const cost = RL_COSTS[command] ?? 1;
    let bucket = this.buckets.get(userId);
    if (!bucket) {
      bucket = { tokens: RL_BURST, lastMs: now, timer: null! };
      this.buckets.set(userId, bucket);
    } else {
      clearTimeout(bucket.timer);
      bucket.tokens = Math.min(RL_BURST, bucket.tokens + ((now - bucket.lastMs) / 1000) * RL_RATE);
      bucket.lastMs = now;
    }
    bucket.timer = setTimeout(() => this.buckets.delete(userId), RL_CLEANUP);
    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }
}

@SkipThrottle()
@WebSocketGateway({
  cors: { origin: process.env['CORS_ORIGIN'] ?? '*', credentials: true },
  namespace: '/ws',
})
@Injectable()
export class AppGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;

  private readonly logger = new Logger(AppGateway.name);
  private readonly rateLimiter = new WsRateLimiter();
  private readonly connAttempts = new Map<string, { count: number; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly jwtVerifier: JwtVerifierService,
    private readonly accountHandler: AccountHandler,
    private readonly analyticsHandler: AnalyticsHandler,
    private readonly dashboardHandler: DashboardHandler,
    private readonly journalHandler: JournalHandler,
    private readonly notifHandler: NotificationsHandler,
    private readonly profileHandler: ProfileHandler,
    private readonly strategyHandler: StrategyHandler,
    private readonly subscriptionHandler: SubscriptionHandler,
    private readonly systemHandler: SystemHandler,
  ) {}

  afterInit(): void {
    this.logger.log('Journal gateway initialised');
  }

  async handleConnection(client: AuthSocket): Promise<void> {
    client.emit('system.config', this.systemHandler.getConfig());
    try {
      const ip = (client.handshake.headers?.['x-forwarded-for'] as string)?.split(',')[0].trim() ?? client.handshake.address;
      const entry = this.connAttempts.get(ip);
      if (entry) {
        entry.count++;
        if (entry.count > 10) {
          client.disconnect();
          return;
        }
      } else {
        const timer = setTimeout(() => this.connAttempts.delete(ip), 60_000);
        this.connAttempts.set(ip, { count: 1, timer });
      }

      const token =
        (client.handshake.auth?.['token']) ??
        (client.handshake.headers?.['authorization'])?.replace('Bearer ', '');
      if (!token) {
        client.disconnect();
        return;
      }

      const user = await this.jwtVerifier.verifyAndGetUser(token as string);
      client.userId = user.id;
      client.commandMap = this.buildCommandMap(user.id);
      await client.join(`user:${user.id}`);
      client.emit('connected', { userId: user.id });
    } catch (err) {
      this.logger.error(`Rejected: ${client.id}`, err instanceof Error ? err.message : err);
      client.emit('error', { message: 'Authentication failed' });
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthSocket): void {
    this.logger.log(`Disconnected: ${client.id} (${client.userId ?? 'unauthenticated'})`);
  }

  @SubscribeMessage('command')
  async handleCommand(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() msg: WsMessage,
  ): Promise<void> {
    if (PUBLIC_COMMANDS.has(msg.command)) {
      try {
        this.reply(client, msg.command, this.systemHandler.getConfig(), msg.requestId);
      } catch (e: unknown) {
        const { message } = resolveError(e);
        this.error(client, msg.requestId, message, msg.command);
      }
      return;
    }

    if (!client.userId || !client.commandMap) {
      this.error(client, msg.requestId, 'Unauthorized', msg.command);
      return;
    }

    if (!this.rateLimiter.allow(client.userId, msg.command)) {
      this.error(client, msg.requestId, 'Rate limit exceeded', msg.command);
      return;
    }

    try {
      const handler = client.commandMap[msg.command];
      if (!handler) {
        this.error(client, msg.requestId, `Unknown command: ${msg.command}`, msg.command);
        return;
      }
      const data = await (handler as (p: any) => Promise<unknown>)(msg.payload);
      this.reply(client, msg.command, data, msg.requestId);
    } catch (e: unknown) {
      const { message, code, internal } = resolveError(e);
      this.logger.error(`[${msg.command}] ${code}`, internal instanceof Error ? internal.stack : String(internal));
      this.error(client, msg.requestId, message, msg.command);
    }
  }

  pushToUser(userId: string, event: string, data: unknown): void {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  broadcast(event: string, data: unknown): void {
    this.server.emit(event, data);
  }

  private buildCommandMap(userId: string): CommandMap {
    return {
      'system.config': () => Promise.resolve(this.systemHandler.getConfig()),
      'dashboard.get': p => this.dashboardHandler.get(userId, p.accountId),
      'dashboard.equity': p => this.dashboardHandler.equity(userId, p.accountId, p.startDate, p.endDate),
      'dashboard.monthlyStats': p => this.dashboardHandler.monthlyStats(userId, p.accountId, p.year, p.month),
      'dashboard.calendar': p => this.dashboardHandler.calendar(userId, p.accountId, p.year, p.month),
      'dashboard.metrics': p => this.dashboardHandler.metrics(userId, p.accountId, p.startDate, p.endDate),
      'dashboard.daily': p => this.dashboardHandler.daily(userId, p.accountId, p.date),
      'profile.get': () => this.profileHandler.get(userId),
      'profile.update': p => this.profileHandler.update(userId, p),
      'profile.pushToken': p => this.profileHandler.pushToken(userId, p.token),
      'accounts.list': p => this.accountHandler.list(userId, Boolean(p.includeInactive)),
      'account.get': p => this.accountHandler.get(userId, p.id),
      'account.create': p => this.accountHandler.create(userId, p),
      'account.update': p => {
        const { id, ...rest } = p;
        return this.accountHandler.update(userId, id, rest);
      },
      'account.delete': p => this.accountHandler.delete(userId, p.id),
      'account.stats': p => this.accountHandler.stats(userId, p.id),
      'strategies.list': () => this.strategyHandler.list(userId),
      'strategy.get': p => this.strategyHandler.get(userId, p.id),
      'strategy.create': p => this.strategyHandler.create(userId, p),
      'strategy.update': p => {
        const { id, ...rest } = p;
        return this.strategyHandler.update(userId, id, rest);
      },
      'strategy.delete': p => this.strategyHandler.delete(userId, p.id),
      'trades.list': p => this.journalHandler.list(userId, p),
      'trade.get': p => this.journalHandler.get(userId, p.id),
      'trade.create': p => this.journalHandler.create(userId, p),
      'trade.update': p => {
        const { id, ...rest } = p;
        return this.journalHandler.update(userId, id, rest);
      },
      'trade.delete': p => this.journalHandler.delete(userId, p.id),
      'trades.analytics': p => this.journalHandler.analytics(userId, p.accountId),
      'notifications.list': p => this.notifHandler.list(userId, p.limit),
      'notification.markOpened': p => this.notifHandler.markOpened(p.id),
      'notifications.markAllOpened': () => this.notifHandler.markAllOpened(userId),
      'analytics.ror': p => this.analyticsHandler.ror(userId, p.accountId),
      'analytics.equity': p => this.analyticsHandler.equity(userId, p.accountId, p.startDate, p.endDate),
      'analytics.rolling': p => this.analyticsHandler.rolling(userId, p.accountId),
      'analytics.strategies': p => this.analyticsHandler.strategies(userId, p.accountId),
      'analytics.hours': p => this.analyticsHandler.hours(userId, p.accountId),
      'analytics.streaks': p => this.analyticsHandler.streaks(userId, p.accountId),
      'analytics.patterns': p => this.analyticsHandler.patterns(userId, p.accountId),
      'analytics.monthly': p => this.analyticsHandler.monthly(userId, p.accountId, p.months),
      'analytics.full': p => this.analyticsHandler.full(userId, p.accountId),
      'analytics.projection': p => this.analyticsHandler.projection(userId, p.accountId, p),
      'trial.start': () => this.subscriptionHandler.startTrial(userId),
      'trial.status': () => this.subscriptionHandler.getTrialStatus(userId),
    };
  }

  private reply<T>(client: Socket, command: string, data: T, requestId?: string): void {
    client.emit('response', { command, data, requestId, ok: true } satisfies WsResponse<T>);
  }

  private error(client: Socket, requestId?: string, message?: string, command?: string): void {
    client.emit('response', { command: command ?? '', requestId, ok: false, error: message } satisfies WsResponse);
  }
}
