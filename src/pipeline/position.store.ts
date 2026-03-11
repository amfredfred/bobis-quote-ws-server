import { Trade } from '../common/types/trade';
import { nowMs } from '../common/utils/time-utils';

export class PositionStore {
  private readonly trades = new Map<string, Trade>();

  hydrate(trades: Trade[]): void {
    this.trades.clear();
    for (const t of trades) this.trades.set(t.id, t);
  }

  add(trade: Trade): void {
    this.trades.set(trade.id, trade);
  }

  get(id: string): Trade | undefined {
    return this.trades.get(id);
  }

  getByTicket(ticket: number): Trade | undefined {
    for (const t of this.trades.values()) {
      if (t.entryTicket === ticket) return t;
    }
    return undefined;
  }

  getOpenTrades(): Trade[] {
    return [...this.trades.values()].filter(
      t => t.status === 'OPEN' || t.status === 'PARTIALLY_CLOSED',
    );
  }

  getAllTrades(): Trade[] {
    return [...this.trades.values()];
  }

  update(id: string, patch: Partial<Trade>): Trade | null {
    const trade = this.trades.get(id);
    if (!trade) return null;
    const updated: Trade = { ...trade, ...patch, updatedAt: nowMs() };
    this.trades.set(id, updated);
    return updated;
  }

  remove(id: string): void {
    this.trades.delete(id);
  }

  count(): number { return this.trades.size; }
  openCount(): number { return this.getOpenTrades().length; }
}
