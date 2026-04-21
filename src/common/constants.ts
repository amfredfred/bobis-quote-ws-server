'use strict'

import { SEED_CONFIG } from "@src/system/system-config.service";
export const AUTHORIZED_SYMBOLS = Object.freeze(SEED_CONFIG.supportedPairs.map(pair => pair.symbol));
export type AUTHORIZED_SYMBOL_TYPE = typeof AUTHORIZED_SYMBOLS[number];