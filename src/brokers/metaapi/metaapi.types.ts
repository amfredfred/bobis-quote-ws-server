export interface OpenOrderParams {
  symbol:     string;
  side:       'BUY' | 'SELL';
  volume:     number;
  stopLoss:   number;
  takeProfit: number;
  magic:      number;
  comment:    string;
}

export interface OpenOrderResult {
  ticket:        number;
  executedPrice: number;
  filledLots:    number;
  filledAt:      number;
}
