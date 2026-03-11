export interface AccountInfo {
  login:       number;
  server:      string;
  currency:    string;
  balance:     number;
  equity:      number;
  margin:      number;
  freeMargin:  number;
  marginLevel: number;
  leverage:    number;
}

export interface SymbolInfo {
  symbol:       string;
  digits:       number;
  point:        number;
  tickSize:     number;
  tickValue:    number;
  contractSize: number;
  minLot:       number;
  maxLot:       number;
  lotStep:      number;
  spread:       number;
  ask:          number;
  bid:          number;
}

export interface Position {
  ticket:       number;
  symbol:       string;
  side:         'BUY' | 'SELL';
  lots:         number;
  openPrice:    number;
  currentPrice: number;
  stopLoss:     number;
  takeProfit:   number;
  swap:         number;
  commission:   number;
  profit:       number;
  openTime:     number;
  comment:      string;
  magic:        number;
}
