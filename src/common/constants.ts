'use strict'

export const AUTHORIZED_SYMBOLS = Object.freeze([
    'EURUSD',
    'GBPUSD',
    'USDJPY',
    'USDCHF',
    'AUDUSD',
    'USDCAD',
    'NZDUSD',
    'EURJPY',
    'XAUUSD',
    'US500',
] as const);

export type AUTHORIZED_SYMBOL_TYPE = typeof AUTHORIZED_SYMBOLS[number];