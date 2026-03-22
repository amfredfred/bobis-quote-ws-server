'use strict';

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from './generated/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createLogger } from '../common/logger/logger';

const logger = createLogger('prisma.service');

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
    constructor() {
        super({
            adapter: new PrismaPg({
                connectionString: process.env.DATABASE_URL!,
                max: 10,
                idleTimeoutMillis: 30_000,
                connectionTimeoutMillis: 5_000,
                // Keep connections alive so pg-pool doesn't get a stale
                // connection killed by a firewall/load balancer between queries
                keepAlive: true,
                keepAliveInitialDelayMillis: 10_000,
            }),
        });
    }

    async onModuleInit(): Promise<void> {
        await this._connectWithRetry();
    }

    async onModuleDestroy(): Promise<void> {
        await this.$disconnect();
        logger.info('Database disconnected');
    }

    private async _connectWithRetry(attempts = 5, delayMs = 2_000): Promise<void> {
        for (let i = 1; i <= attempts; i++) {
            try {
                await this.$connect();
                logger.info('Database connected');
                return;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (i === attempts) {
                    logger.error('Database connection failed after all retries', { msg });
                    throw err;
                }
                logger.warn(`Database connect attempt ${i}/${attempts} failed — retrying in ${delayMs}ms`, { msg });
                await new Promise(r => setTimeout(r, delayMs));
                delayMs = Math.min(delayMs * 2, 15_000); // exponential backoff, cap 15s
            }
        }
    }
}
