'use strict'

export const AUTHORIZED_SYMBOLS = Object.freeze([
    // Forex Majors (7)
    'EURUSD',
    'GBPUSD',
    'USDJPY',
    'USDCHF',
    'AUDUSD',
    'USDCAD',
    'NZDUSD',
    // Commodities (1)
    'XAUUSD',
    // Indices (3)
    'US500',
    'US30',
    'US100',
    // Crypto (1)
    'BTCUSD',
] as const);

export type AUTHORIZED_SYMBOL_TYPE = typeof AUTHORIZED_SYMBOLS[number];