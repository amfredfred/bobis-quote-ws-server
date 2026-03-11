import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { createLogger } from '../../common/logger/logger';
import { nowMs } from '../../common/utils/time.utils';
import { AccountMetrics } from './account.metrics';

const logger         = createLogger('metrics');
const FLUSH_INTERVAL = 30_000;

export interface MetricsSnapshot {
  counters: Record<string, number>;
  gauges:   Record<string, number>;
}

export interface AccountMetricsSnapshot {
  accountId: string;
  counters:  Record<string, number>;
  gauges:    Record<string, number>;
}

@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly counters = new Map<string, number>();
  private readonly gauges   = new Map<string, number>();
  private flushTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this._restore();
    this.flushTimer = setInterval(() => { this.flush().catch(() => {}); }, FLUSH_INTERVAL);
    logger.info('Metrics service started');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
  }

  // ── Per-account scope ──────────────────────────────────────────────────────

  forAccount(accountId: string): AccountMetrics {
    return new AccountMetrics(this, accountId);
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  counter(name: string): number { return this.counters.get(name) ?? 0; }
  gauge(name: string):   number { return this.gauges.get(name)   ?? 0; }

  snapshot(): MetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      gauges:   Object.fromEntries(this.gauges),
    };
  }

  aggregateByAccount(): Record<string, AccountMetricsSnapshot> {
    const result: Record<string, AccountMetricsSnapshot> = {
      _global: { accountId: '_global', counters: {}, gauges: {} },
    };

    for (const [key, value] of this.counters) {
      const parsed = this._parseKey(key);
      if (!parsed) { result['_global'].counters[key] = value; continue; }
      this._ensureBucket(result, parsed.accountId).counters[parsed.metricName] = value;
    }

    for (const [key, value] of this.gauges) {
      const parsed = this._parseKey(key);
      if (!parsed) { result['_global'].gauges[key] = value; continue; }
      this._ensureBucket(result, parsed.accountId).gauges[parsed.metricName] = value;
    }

    return result;
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  /**
   * M-2 FIX: Batch the entire flush into two statements using unnest() rather
   * than N individual upserts, dramatically reducing RPC round-trips under
   * Supabase's connection pool limits.
   */
  async flush(): Promise<void> {
    const ts = BigInt(nowMs());

    try {
      const counterEntries = Array.from(this.counters.entries());
      const gaugeEntries   = Array.from(this.gauges.entries());

      if (counterEntries.length > 0) {
        const names  = counterEntries.map(([n]) => n);
        const values = counterEntries.map(([, v]) => BigInt(v));
        await this.prisma.$executeRaw`
          INSERT INTO public.metrics_counters (name, value, updated_at)
          SELECT unnest(${names}::text[]), unnest(${values}::bigint[]), ${ts}
          ON CONFLICT (name) DO UPDATE
            SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
        `;
      }

      if (gaugeEntries.length > 0) {
        const names  = gaugeEntries.map(([n]) => n);
        const values = gaugeEntries.map(([, v]) => v);
        await this.prisma.$executeRaw`
          INSERT INTO public.metrics_gauges (name, value, updated_at)
          SELECT unnest(${names}::text[]), unnest(${values}::float8[]), ${ts}
          ON CONFLICT (name) DO UPDATE
            SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
        `;
      }
    } catch (err) {
      logger.error('Metrics flush failed', { error: String(err) });
    }
  }

  private async _restore(): Promise<void> {
    try {
      const [counters, gauges] = await Promise.all([
        this.prisma.metricsCounter.findMany(),
        this.prisma.metricsGauge.findMany(),
      ]);
      for (const row of counters) this.counters.set(row.name, Number(row.value));
      for (const row of gauges)   this.gauges.set(row.name,   row.value);
      logger.info('Metrics restored', { counters: counters.length, gauges: gauges.length });
    } catch (err) {
      logger.warn('Could not restore metrics (first run?)', { error: String(err) });
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _parseKey(key: string): { accountId: string; metricName: string } | null {
    const match = key.match(/^account\.([^.]+)\.(.+)$/);
    if (!match) return null;
    return { accountId: match[1], metricName: match[2] };
  }

  private _ensureBucket(
    result: Record<string, AccountMetricsSnapshot>,
    accountId: string,
  ): AccountMetricsSnapshot {
    if (!result[accountId]) {
      result[accountId] = { accountId, counters: {}, gauges: {} };
    }
    return result[accountId];
  }
}
