import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { SynchronizationListener, type MetatraderDeal, type MetatraderPosition } from 'metaapi.cloud-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { MetaApiService } from '../brokers/metaapi/metaapi.service';
import { TradingAccountService, TradingAccount } from '../trading-account/trading-account.service';
import { createLogger } from '../common/logger/logger';

const logger = createLogger('broker-sync');

class AccountSyncListener extends SynchronizationListener {
    private readonly pendingRemovals = new Map<string | number, ReturnType<typeof setTimeout>>();
    private synced = false;

    constructor(
        private readonly account: TradingAccount,
        private readonly prisma: PrismaService,
        private readonly accountSvc: TradingAccountService,
    ) {
        super();
    }

    override async onDealsSynchronized(_instanceIndex: string, _synchronizationId: string): Promise<void> {
        this.synced = true;
        logger.info('BrokerSync: initial sync complete — live mode', { accountId: this.account.id });
        return Promise.resolve()
    }

    override async onAccountInformationUpdated(
        _instanceIndex: string,
        info: { balance: number },
    ): Promise<void> {
        try {
            await this.accountSvc.update(this.account.id, this.account.userId, {
                currentBalance: info.balance,
                lastSyncAt: new Date().toISOString(),
            });
        } catch (err) {
            logger.warn('BrokerSync: failed to persist balance', {
                accountId: this.account.id, error: String(err),
            });
        }
    }

    override async onPositionUpdated(
        _instanceIndex: string,
        position: MetatraderPosition,
    ): Promise<any> {
        const pending = this.pendingRemovals.get(position.id);
        if (pending) { clearTimeout(pending); this.pendingRemovals.delete(position.id); }

        const ticketId: string = String(position.id);
        const direction = position.type === 'POSITION_TYPE_BUY' ? 'long' : 'short';

        try {
            await this.prisma.journalTrade.upsert({
                where: { ticketId_accountId: { ticketId, accountId: this.account.id } },
                create: {
                    userId: this.account.userId,
                    accountId: this.account.id,
                    strategyId: null,
                    signalId: null,
                    symbol: position.symbol,
                    direction: direction as any,
                    status: 'open' as any,
                    result: null,
                    entryPrice: position.openPrice,
                    exitPrice: null,
                    quantity: position.volume,
                    ticketId,
                    pnl: null,
                    commission: position.commission,
                    swap: position.swap,
                    screenshotUrls: [],
                    source: 'broker_sync',
                    tradeDate: new Date(position.time),
                    closedAt: null,
                },
                update: { status: 'open' as any },
            });
            logger.info('BrokerSync: position upserted', {
                accountId: this.account.id, ticketId, symbol: position.symbol,
            });
        } catch (err) {
            logger.error('BrokerSync: failed to upsert position', {
                accountId: this.account.id, ticketId, error: String(err),
            });
        }
    }

    override async onPositionRemoved(
        _instanceIndex: string,
        positionId: string,
    ): Promise<void> {
        if (!this.synced) return;

        const existing = this.pendingRemovals.get(positionId);
        if (existing) return;

        const timer = setTimeout(async () => {
            await this._closePosition(positionId, null);
            this.pendingRemovals.delete(positionId);
        }, 3_000);

        this.pendingRemovals.set(positionId, timer);

        return Promise.resolve();
    }

    override async onDealAdded(
        _instanceIndex: string,
        deal: MetatraderDeal,
    ): Promise<void> {
        if (!this.synced) return;
        if (deal.entryType !== 'DEAL_ENTRY_OUT' || !deal.positionId) return;

        const pending = this.pendingRemovals.get(deal.positionId);
        if (pending) { clearTimeout(pending); this.pendingRemovals.delete(deal.positionId); }

        await this._closePosition(deal.positionId, deal);
    }

    private async _closePosition(
        positionId: string,
        deal: MetatraderDeal | null,
    ): Promise<void> {
        const exitPrice = deal?.price ?? null;
        const pnl = deal
            ? (deal.profit ?? 0) + (deal.swap ?? 0) + (deal.commission ?? 0)
            : null;
        const closedAt = deal?.time ? new Date(deal.time) : new Date();
        const result = pnl == null ? null : pnl > 0 ? 'profit' : pnl < 0 ? 'loss' : 'breakeven';

        try {
            await this.prisma.journalTrade.updateMany({
                where: { accountId: this.account.id, ticketId: positionId, status: 'open' },
                data: {
                    status: 'closed' as any,
                    result: result as any,
                    exitPrice: exitPrice ?? undefined,
                    pnl: pnl ?? undefined,
                    commission: deal?.commission ?? undefined,
                    swap: deal?.swap ?? undefined,
                    closedAt,
                    updatedAt: new Date(),
                },
            });
            logger.info('BrokerSync: position closed', {
                accountId: this.account.id, positionId, exitPrice, pnl, result,
                closedAt: closedAt.toISOString(),
            });
        } catch (err) {
            logger.error('BrokerSync: failed to journal close', {
                accountId: this.account.id, positionId, error: String(err),
            });
        }
    }

    destroy(): void {
        for (const t of this.pendingRemovals.values()) clearTimeout(t);
        this.pendingRemovals.clear();
    }
}

@Injectable()
export class BrokerSyncService implements OnModuleInit, OnModuleDestroy {
    private readonly listeners = new Map<string, AccountSyncListener>();

    constructor(
        private readonly accountSvc: TradingAccountService,
        private readonly metaApi: MetaApiService,
        private readonly prisma: PrismaService,
    ) { }

    async onModuleInit(): Promise<void> {
        const accounts = await this.accountSvc.findAllSync();
        logger.info('BrokerSyncService starting', { accounts: accounts.length });
        await Promise.allSettled(accounts.map(a => this._startAccount(a)));
    }

    async onModuleDestroy(): Promise<void> {
        for (const [accountId, listener] of this.listeners) {
            listener.destroy();
            await this.metaApi.disconnectStreamingAccount(accountId);
        }
        this.listeners.clear();
    }

    async startAccount(account: TradingAccount): Promise<void> {
        if (this.listeners.has(account.id)) return;
        await this._startAccount(account);
    }

    async stopAccount(accountId: string): Promise<void> {
        const listener = this.listeners.get(accountId);
        if (listener) {
            listener.destroy();
            this.listeners.delete(accountId);
            await this.metaApi.disconnectStreamingAccount(accountId);
            logger.info('BrokerSync stopped', { accountId });
        }
    }

    private async _startAccount(account: TradingAccount): Promise<void> {
        const metaId = account.metaApiAccountId!;
        const listener = new AccountSyncListener(account, this.prisma, this.accountSvc);

        try {
            await this.metaApi.connectStreamingAccount(metaId, listener);
            this.listeners.set(account.id, listener);
            logger.info('BrokerSync streaming started', { accountId: account.id, name: account.name });
        } catch (err) {
            listener.destroy();
            logger.error('BrokerSync: streaming connect failed — account skipped', {
                accountId: account.id, error: String(err),
            });
        }
    }
}