'use strict'

'use strict';

import { InboundSignal } from '../common/types/signal.types';

export interface ValidationResult {
    valid: boolean;
    errors: string[];
}

export class SignalValidator {
    validate(signal: InboundSignal): ValidationResult {
        const errors: string[] = [];

        // ── Direction ──────────────────────────────────────────────────────────
        if (signal.direction !== 'LONG' && signal.direction !== 'SHORT')
            errors.push(`Unknown direction: ${signal!.direction}`);

        // ── Price sanity ───────────────────────────────────────────────────────
        for (const [name, val] of [
            ['entryPrice', signal.entryPrice],
            ['stopLoss', signal.stopLoss],
            ['tp1', signal.tp1],
            ['tp2', signal.tp2],
        ] as [string, number][]) {
            if (val <= 0) errors.push(`${name} must be > 0`);
        }

        if (signal.direction === 'LONG') {
            if (signal.stopLoss >= signal.entryPrice)
                errors.push('LONG: stopLoss must be below entryPrice');
            if (signal.tp1 <= signal.entryPrice)
                errors.push('LONG: tp1 must be above entryPrice');
            if (signal.tp2 <= signal.tp1)
                errors.push('LONG: tp2 must be above tp1');
        }

        if (signal.direction === 'SHORT') {
            if (signal.stopLoss <= signal.entryPrice)
                errors.push('SHORT: stopLoss must be above entryPrice');
            if (signal.tp1 >= signal.entryPrice)
                errors.push('SHORT: tp1 must be below entryPrice');
            if (signal.tp2 >= signal.tp1)
                errors.push('SHORT: tp2 must be below tp1');
        }

        // ── R:R ───────────────────────────────────────────────────────────────
        if (signal.riskRewardRatio <= 0)
            errors.push('riskRewardRatio must be > 0');
        if (signal.riskPips <= 0)
            errors.push('riskPips must be > 0');

        // ── HTF range ─────────────────────────────────────────────────────────
        const htf = signal.htfRange;
        if (htf.rangeHigh <= htf.rangeLow)
            errors.push('htfRange: rangeHigh must be > rangeLow');
        if (!htf.bosDirection || (htf.bosDirection !== 'BULLISH' && htf.bosDirection !== 'BEARISH'))
            errors.push(`htfRange: unknown bosDirection: ${htf.bosDirection}`);

        // ── LTF range ─────────────────────────────────────────────────────────
        const ltf = signal.ltfRange;
        if (ltf.rangeHigh <= ltf.rangeLow)
            errors.push('ltfRange: rangeHigh must be > rangeLow');

        // ── Timestamps ────────────────────────────────────────────────────────
        if (!signal.createdAt || signal.createdAt <= 0)
            errors.push('createdAt must be a valid timestamp');

        return { valid: errors.length === 0, errors };
    }
}