# BB Platform

Multi-account trading platform for the BB Setup strategy.

## Architecture

```
Signal Engine (Python WS)
        ↓
  SignalGateway          ← single WS connection, exponential-backoff reconnect
        ↓
   SignalBus             ← in-process EventEmitter fan-out
        ↓
 PipelineManager         ← accountId → PipelineService map
   ↙    ↓    ↘
 Acct A  B   C           ← each account runs its own isolated pipeline
   ↓    ↓    ↓
 Risk  Risk  Risk        ← per-account RiskEngine (symbol filter, daily loss, etc.)
   ↓    ↓    ↓
 Exec  Exec  Exec        ← per-account ExecutionEngine
   ↓    ↓    ↓
MetaApi MetaApi MetaApi  ← one RPC connection per account
```

## Setup

```bash
cp .env.example .env
# Fill in METAAPI_TOKEN, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

npm install
npm run start:dev
```

## Supabase

Run `supabase/migrations/001_accounts.sql` in the Supabase SQL editor.

## REST API

All routes require `Authorization: Bearer <supabase_jwt>`.

| Method | Route | Description |
|--------|-------|-------------|
| `POST`   | `/api/v1/accounts`         | Add account, start pipeline |
| `GET`    | `/api/v1/accounts`         | List your accounts |
| `GET`    | `/api/v1/accounts/:id`     | Get account |
| `PATCH`  | `/api/v1/accounts/:id`     | Update risk config (restarts pipeline) |
| `DELETE` | `/api/v1/accounts/:id`     | Remove + stop pipeline |
| `POST`   | `/api/v1/accounts/:id/start` | Start pipeline |
| `POST`   | `/api/v1/accounts/:id/stop`  | Pause pipeline |
| `GET`    | `/api/v1/accounts/:id/trades` | Live open trades |

## Risk config per account

```json
{
  "riskMode": "percentage",        // "percentage" or "fixed"
  "riskPercent": 1.0,              // % of balance per trade
  "riskFixedAmount": 100.0,        // fixed $ per trade (if fixed mode)
  "maxOpenTrades": 5,
  "maxDailyLossPercent": 200.0,
  "maxExposurePerSymbol": 2,
  "minRRRatio": 1.5,
  "symbolFilter": [],              // [] = all symbols, or ["EURUSD", "GBPUSD"]
  "tp1PartialClose": 50,
  "moveSlToBE": false,
  "spreadRiskMultiplier": 1.0,
  "maxEntrySlippagePips": 3.0,
  "magicNumber": 20240101,
  "comment": "bb-platform"
}
```
