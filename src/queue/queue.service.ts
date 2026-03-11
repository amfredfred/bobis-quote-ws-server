'use strict';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type JobHandler = (data: unknown) => Promise<void>;

@Injectable()
export class QueueService implements OnModuleInit {
  private readonly logger = new Logger(QueueService.name);
  private readonly handlers = new Map<string, JobHandler>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) { }

  onModuleInit() {
    this.timer = setInterval(() => { this._poll().catch() }, 5000);
  }

  register(jobName: string, handler: JobHandler) {
    this.handlers.set(jobName, handler);
  }

  async enqueue(queueName: string, jobName: string, data: unknown, delayMs = 0) {
    await this.prisma.queueJob.create({
      data: {
        queueName,
        jobName,
        jobData: JSON.stringify(data),
        scheduledAt: new Date(Date.now() + delayMs),
      },
    });
  }

  private async _poll() {
    const jobs = await this.prisma.queueJob.findMany({
      where: { status: 'pending', scheduledAt: { lte: new Date() } },
      orderBy: [{ priority: 'desc' }, { scheduledAt: 'asc' }],
      take: 10,
    });

    for (const job of jobs) {
      const handler = this.handlers.get(job.jobName);
      if (!handler) continue;

      await this.prisma.queueJob.update({
        where: { id: job.id },
        data: { status: 'processing', startedAt: new Date(), attempts: { increment: 1 } },
      });

      try {
        await handler(JSON.parse(job.jobData));
        await this.prisma.queueJob.update({
          where: { id: job.id },
          data: { status: 'completed', completedAt: new Date() },
        });
      } catch (e) {
        const failed = job.attempts + 1 >= job.maxAttempts;
        const delay = job.backoffType === 'exponential'
          ? job.backoffDelay * 2 ** job.attempts
          : job.backoffDelay;

        await this.prisma.queueJob.update({
          where: { id: job.id },
          data: {
            status: failed ? 'failed' : 'pending',
            error: String(e),
            scheduledAt: failed ? undefined : new Date(Date.now() + delay),
          },
        });
        this.logger.error(`Job ${job.jobName} failed`, e);
      }
    }
  }
}
