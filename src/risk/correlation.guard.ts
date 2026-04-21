'use strict';

import { InboundSignal } from '../common/types/signal.types';
import { Trade } from '../common/types/trade.types';
import { createLogger } from '../common/logger/logger';
import { PipelineService } from '@src/pipeline/pipeline.service';

const logger = createLogger('correlation.guard');

// ── Correlation groups ─────────────────────────────────────────────────────────
//
// Each group represents a shared macro risk factor.  Every member symbol has a
// directional weight that encodes which way it moves when that factor rises:
//
//   weight +1 → price rises when the factor rises  (e.g. EURUSD in USD_EXPOSURE)
//   weight -1 → price falls when the factor rises  (e.g. USDJPY in USD_EXPOSURE)
//
// The guard accumulates a net-directional score across all open positions and
// the proposed new trade.  A long adds +weight; a short adds −weight.
// If |projected score| ≥ maxCorrelatedExposure the trade is blocked.
//
// Example — USD_EXPOSURE, maxCorrelatedExposure = 3:
//   Account A: LONG EURUSD  → +1   (short USD)
//   Account B: LONG GBPUSD  → +1   (short USD)
//   Incoming:  LONG AUDUSD  → +1   (short USD, projected score = 3)  → BLOCKED
//   Incoming:  SHORT USDJPY → +1   (short USD, same result)           → BLOCKED
//   Incoming:  SHORT EURUSD → −1   (long USD, projected score = 1)   → ALLOWED (hedge)

export interface CorrelationMember {
  /** Raw symbol string, normalised internally (uppercase, no separators). */
  symbol: string;
  /** Directional multiplier within this group. */
  weight: 1 | -1;
}

export interface CorrelationGroup {
  /** Human-readable identifier used in log messages and rejection reasons. */
  id: string;
  members: CorrelationMember[];
}

/** Strip separators and upper-case for uniform symbol comparison. */
export function normalizeSymbol(raw: string): string {
  return raw.toUpperCase().replace(/[/_\-\s]/g, '');
}

// ── Built-in correlation groups ────────────────────────────────────────────────

export const CORRELATION_GROUPS: CorrelationGroup[] = [
  {
    id: 'USD_EXPOSURE',
    // Risk factor: USD strength.
    //   +1 → position profits when USD weakens (EURUSD long, USDJPY short, …)
    //   -1 → position profits when USD strengthens
    members: [
      // Direct USD pairs (short USD exposure)
      { symbol: 'EURUSD', weight: 1 },
      { symbol: 'GBPUSD', weight: 1 },
      { symbol: 'AUDUSD', weight: 1 },
      { symbol: 'NZDUSD', weight: 1 },
      { symbol: 'XAUUSD', weight: 1 },   // gold inverse to USD

      // Inverse USD pairs (long USD exposure)
      { symbol: 'USDJPY', weight: -1 },
      { symbol: 'USDCHF', weight: -1 },
      { symbol: 'USDCAD', weight: -1 },
    ],
  },
  {
    id: 'JPY_EXPOSURE',
    // Risk factor: JPY strength (safe-haven demand).
    //   +1 → profits when JPY weakens
    members: [
      { symbol: 'USDJPY', weight: 1 },
    ],
  },
  {
    id: 'RISK_APPETITE',
    // Risk factor: global risk-on sentiment.
    //   +1 → profits in risk-on (equities up, AUD/NZD up, JPY/CHF down)
    members: [
      // Risk-on currencies
      { symbol: 'AUDUSD', weight: 1 },
      { symbol: 'NZDUSD', weight: 1 },

      // US Indices (your refined list)
      { symbol: 'US30', weight: 1 },   // Dow Jones
      { symbol: 'US100', weight: 1 },  // NASDAQ-100
      { symbol: 'US500', weight: 1 },  // S&P 500 / Nasdaq

      // Safe-haven currencies (inverse relationship)
      { symbol: 'USDCHF', weight: 1 },   // CHF weakens in risk-on → USDCHF rises
      { symbol: 'USDJPY', weight: 1 },   // JPY weakens in risk-on → USDJPY rises
    ],
  },
  {
    id: 'CRYPTO_RISK',
    // Risk factor: Crypto market sentiment (BTC as proxy for entire crypto space)
    //   +1 → profits when crypto market rallies
    members: [
      { symbol: 'BTCUSD', weight: 1 },
    ],
  },
  {
    id: 'METALS',
    // Risk factor: precious-metals demand.
    members: [
      { symbol: 'XAUUSD', weight: 1 },
    ],
  },
  {
    id: 'ENERGY',
    // Risk factor: crude-oil price.
    members: [
      { symbol: 'USOIL', weight: 1 },
      // Removed: UKOIL, WTIUSD, BCOUSD, NGAS (keeping single oil proxy)
    ],
    // Note: ENERGY group has no symbols in your refined list
    // Consider removing this group or keeping as placeholder for future
  },
];

// ── Internal index ──────────────────────────────────────────────────────────────

type GroupEntry = { group: CorrelationGroup; weight: 1 | -1 };
type SymbolGroupIndex = Map<string, GroupEntry[]>;

function buildIndex(groups: CorrelationGroup[]): SymbolGroupIndex {
  const idx: SymbolGroupIndex = new Map();
  for (const group of groups) {
    for (const member of group.members) {
      const key = normalizeSymbol(member.symbol);
      const list = idx.get(key) ?? [];
      list.push({ group, weight: member.weight });
      idx.set(key, list);
    }
  }
  return idx;
}

// ── Public types ────────────────────────────────────────────────────────────────

export interface PortfolioPosition {
  accountId: string;
  /** Normalised symbol. */
  symbol: string;
  side: 'BUY' | 'SELL';
  /** Current open lots (used for future lot-weighted scoring; currently counts as 1 unit). */
  lots: number;
  userId?: string;  // only populated in user-level snapshots, not the portfolio snapshot used for checks
}

export interface CorrelationViolation {
  blocked: true;
  groupId: string;
  /** Net directional score across all open positions before this trade. */
  currentExposure: number;
  /** Projected score if this trade were accepted. */
  projectedExposure: number;
  maxAllowed: number;
  reason: string;
}

export interface CorrelationApproved {
  blocked: false;
}

export type CorrelationCheckResult = CorrelationViolation | CorrelationApproved;

// ── CorrelationGuard ────────────────────────────────────────────────────────────

/**
 * Portfolio-level correlation guard.
 *
 * Operates at the `PipelineManager` layer so it has visibility across every
 * connected account before any individual pipeline's `RiskEngine` runs.
 *
 * Two responsibilities:
 *   1. `checkAuthorizedPairs`         — enforce per-account pair whitelist
 *   2. `evaluatePortfolioCorrelation` — block trades that push aggregate
 *                                       directional exposure over the limit
 */
export class CorrelationGuard {
  private readonly index: SymbolGroupIndex;

  constructor(private readonly groups: CorrelationGroup[] = CORRELATION_GROUPS) {
    this.index = buildIndex(groups);
  }

  // ── 1. Authorized-pairs whitelist ─────────────────────────────────────────

  /**
   * Returns `true` when the symbol is allowed for this account.
   * An empty / absent whitelist means **all pairs are allowed** (opt-in model).
   */
  checkAuthorizedPairs(
    symbol: string,
    authorizedPairs: string[] | undefined,
    accountId: string,
  ): boolean {
    if (!authorizedPairs || authorizedPairs.length === 0) return true;

    const norm = normalizeSymbol(symbol);
    const allowed = authorizedPairs.map(normalizeSymbol);
    const pass = allowed.includes(norm);

    if (!pass) {
      logger.warn('Authorized-pairs block', { accountId, symbol, authorizedPairs });
    }
    return pass;
  }

  // ── 2. Portfolio correlation check ────────────────────────────────────────

  /**
   * Evaluate whether accepting this signal would push the portfolio's
   * net directional exposure in any correlation group past `maxExposure`.
   *
   * A trade is only blocked if it **increases** risk in the same direction
   * as the existing skew — hedging trades (opposite direction) always pass.
   *
   * @param signal        Incoming signal to evaluate (direction determines sign)
   * @param allPositions  Aggregate open positions from ALL connected accounts
   * @param maxExposure   Absolute threshold per correlation group (integer count)
   */
  evaluatePortfolioCorrelation(
    signal: InboundSignal,
    allPositions: PortfolioPosition[],
    maxExposure: number,
  ): CorrelationCheckResult {
    if (maxExposure <= 0) return { blocked: false };  // guard disabled

    const normSymbol = normalizeSymbol(signal.symbol);
    const groupEntries = this.index.get(normSymbol);

    // Symbol not tracked in any correlation group → no constraint
    if (!groupEntries || groupEntries.length === 0) return { blocked: false };

    // Incoming trade directional contribution before applying group weight
    const incomingRawSign: 1 | -1 = signal.direction === 'LONG' ? 1 : -1;

    for (const { group, weight: symWeight } of groupEntries) {
      // Aggregate current score for this group across all open positions
      let currentScore = 0;
      for (const pos of allPositions) {
        const posEntries = this.index.get(pos.symbol);
        if (!posEntries) continue;
        const posGroupEntry = posEntries.find(e => e.group.id === group.id);
        if (!posGroupEntry) continue;
        const posSign: 1 | -1 = pos.side === 'BUY' ? 1 : -1;
        currentScore += posSign * posGroupEntry.weight;
      }

      // Projected score if the incoming trade were accepted
      const incomingContribution = incomingRawSign * symWeight;
      const projectedScore = currentScore + incomingContribution;

      // Only block when the trade pushes us further in the same direction
      // (|projected| > |current|) AND hits the ceiling.
      const amplifiesRisk = Math.abs(projectedScore) > Math.abs(currentScore);
      if (amplifiesRisk && Math.abs(projectedScore) >= maxExposure) {
        const fmt = (n: number) => (n > 0 ? `+${n}` : String(n));
        const reason =
          `Portfolio correlation block [${group.id}]: ` +
          `current exposure ${fmt(currentScore)}, ` +
          `projected ${fmt(projectedScore)} ≥ limit ±${maxExposure}`;

        logger.warn('Correlation guard triggered', {
          groupId: group.id,
          symbol: signal.symbol,
          direction: signal.direction,
          currentScore,
          projectedScore,
          maxExposure,
        });

        return {
          blocked: true,
          groupId: group.id,
          currentExposure: currentScore,
          projectedExposure: projectedScore,
          maxAllowed: maxExposure,
          reason,
        };
      }
    }

    return { blocked: false };
  }

  // ── Snapshot builder ───────────────────────────────────────────────────────

  /**
   * Flatten all open trades across every running pipeline into a single
   * `PortfolioPosition[]` that `evaluatePortfolioCorrelation` can consume.
   *
   * Accepts a generic iterable so it is testable without real pipeline objects.
   */
  buildPortfolioSnapshot(
    pipelines: Iterable<{
      account: { id: string };
      getOpenTrades: () => Trade[];
    }>,
  ): PortfolioPosition[] {
    const positions: PortfolioPosition[] = [];

    for (const pipeline of pipelines) {
      for (const trade of pipeline.getOpenTrades()) {
        if (trade.status !== 'OPEN' && trade.status !== 'PARTIALLY_CLOSED') continue;
        positions.push({
          accountId: pipeline.account.id,
          symbol: normalizeSymbol(trade.symbol),
          side: trade.side,
          lots: trade.currentLots,
        });
      }
    }

    return positions;
  }

  buildUserPortfolios(pipelines: Iterable<PipelineService>) {
    const map = new Map<string, PortfolioPosition[]>();

    for (const pipeline of pipelines) {
      const userId = pipeline.account.userId;
      const trades = pipeline.getOpenTrades();

      const list = map.get(userId) ?? [];

      for (const trade of trades) {
        if (trade.status !== 'OPEN' && trade.status !== 'PARTIALLY_CLOSED') continue;

        list.push({
          userId,
          accountId: pipeline.account.id,
          symbol: normalizeSymbol(trade.symbol),
          side: trade.side,
          lots: trade.currentLots,
        });
      }

      map.set(userId, list);
    }

    return map;
  }
}