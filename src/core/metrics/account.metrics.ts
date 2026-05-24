import { MetricsService } from './metrics.service';

/**
 * Thin wrapper around MetricsService that namespaces every key under
 * `account.<accountId>.<metric>`.
 *
 * Per-account journal and analytics components can receive an AccountMetrics
 * instance instead of the global MetricsService.
 * The admin layer calls MetricsService.aggregateByAccount() to roll up.
 */
export class AccountMetrics {
  private readonly prefix: string;

  constructor(
    private readonly svc:       MetricsService,
    private readonly accountId: string,
  ) {
    this.prefix = `account.${accountId}`;
  }

  increment(name: string, by = 1): void {
    this.svc.increment(`${this.prefix}.${name}`, by);
  }

  setGauge(name: string, value: number): void {
    this.svc.setGauge(`${this.prefix}.${name}`, value);
  }

  counter(name: string): number { return this.svc.counter(`${this.prefix}.${name}`); }
  gauge(name: string):   number { return this.svc.gauge(`${this.prefix}.${name}`); }

  get id(): string { return this.accountId; }
}
