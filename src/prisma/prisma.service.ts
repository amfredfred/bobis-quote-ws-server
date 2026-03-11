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
                max: 10,              // max pool connections (tune to your plan)
                idleTimeoutMillis: 30_000,
                connectionTimeoutMillis: 5_000,
            }),
        });
    }

    async onModuleInit(): Promise<void> {
        await this.$connect();
        logger.info('Database connected');
    }

    async onModuleDestroy(): Promise<void> {
        await this.$disconnect();
        logger.info('Database disconnected');
    }
}