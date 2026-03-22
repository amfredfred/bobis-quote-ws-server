'use strict'

import { toBrokerSymbol, toEngineSymbol, symbolMatches } from '../../src/common/utils/symbol.utils';

describe('symbol.utils', () => {

  describe('toBrokerSymbol', () => {
    it('appends suffix when provided', () => {
      expect(toBrokerSymbol('EURUSD', 'm')).toBe('EURUSDm');
      expect(toBrokerSymbol('XAUUSD', '.')).toBe('XAUUSD.');
      expect(toBrokerSymbol('BTCUSD', '+')).toBe('BTCUSD+');
    });

    it('returns clean symbol when suffix is empty', () => {
      expect(toBrokerSymbol('EURUSD', '')).toBe('EURUSD');
      expect(toBrokerSymbol('XAUUSD', '')).toBe('XAUUSD');
    });

    it('strips slash before applying suffix', () => {
      expect(toBrokerSymbol('EUR/USD', 'm')).toBe('EURUSDm');
      expect(toBrokerSymbol('XAU/USD', '')).toBe('XAUUSD');
    });

    it('uppercases the symbol', () => {
      expect(toBrokerSymbol('eurusd', 'm')).toBe('EURUSDm');
      expect(toBrokerSymbol('eurusd', '')).toBe('EURUSD');
    });
  });

  describe('toEngineSymbol', () => {
    it('strips suffix when present', () => {
      expect(toEngineSymbol('EURUSDm', 'm')).toBe('EURUSD');
      expect(toEngineSymbol('XAUUSD.', '.')).toBe('XAUUSD');
      expect(toEngineSymbol('BTCUSD+', '+')).toBe('BTCUSD');
    });

    it('returns symbol unchanged when suffix is empty', () => {
      expect(toEngineSymbol('EURUSD', '')).toBe('EURUSD');
    });

    it('does not strip if suffix not at end', () => {
      expect(toEngineSymbol('EURUSDm', '.')).toBe('EURRUSDM');
      // the suffix '.' is not at the end of 'EURUSDm', so it should not strip
      expect(toEngineSymbol('EURUSDm', '.')).not.toBe('EURUSD');
    });

    it('uppercases the result', () => {
      expect(toEngineSymbol('eurUSDm', 'm')).toBe('EURUSD');
    });
  });

  describe('symbolMatches', () => {
    it('matches when broker symbol equals engine symbol + suffix', () => {
      expect(symbolMatches('EURUSDm', 'EURUSD', 'm')).toBe(true);
      expect(symbolMatches('XAUUSD.', 'XAUUSD', '.')).toBe(true);
    });

    it('matches when no suffix used', () => {
      expect(symbolMatches('EURUSD', 'EURUSD', '')).toBe(true);
    });

    it('does not match wrong symbol', () => {
      expect(symbolMatches('GBPUSDm', 'EURUSD', 'm')).toBe(false);
    });

    it('does not match wrong suffix', () => {
      expect(symbolMatches('EURUSDm', 'EURUSD', '.')).toBe(false);
    });

    it('is case-insensitive', () => {
      expect(symbolMatches('eurUSDm', 'EURUSD', 'm')).toBe(true);
    });
  });

});
