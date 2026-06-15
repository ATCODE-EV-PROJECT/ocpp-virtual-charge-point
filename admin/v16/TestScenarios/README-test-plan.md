# Balance Overshoot Test Plan — VCP Local Test

ທົດສອບ balance overshoot bug ໃນ code ປ ander ander ander ander ander ander ander ander ander ander ander

**ອ້າງອີງ**: `docs/2026-06-14/2026-06-14T10:23:05-Balance_Overshoot_Analysis.md`

---

## Setup ກ່ອນ Run

### 1. ລ ander ander ander Services

```bash
# Terminal 1 — OCPP CSMS
cd panda-ev-ocpp && npm run start:dev

# Terminal 2 — Mobile API
cd panda-ev-client-mobile && npm run start:dev

# Terminal 3 — VCP (PANDA-PHONSAY-01 = CCS2 120kW)
cd ocpp-virtual-charge-point && npm start index_16.ts
```

### 2. ຕ ander ander balance ຂ ander Test User

```sql
-- ຕ ander ander balance ກ ander ander ander ander test scenario
UPDATE panda_ev_core.wallets
SET balance = 30000
WHERE user_id = '<USER_ID>';

-- ander ander ander balance ຫ ander ander ander ander test
SELECT w.balance, u.email
FROM panda_ev_core.wallets w
JOIN panda_ev_core.mobile_users u ON u.id = w.user_id
WHERE u.id = '<USER_ID>';
```

**Test users:**
| email | user_id |
|-------|---------|
| siriviengkham@yahoo.com | bf253998-... |
| thongthepphahukmalida@gmail.com | 6efed0be-... |

### 3. ຕ ander ander ander Session + ເອົາ TRANSACTION_ID

```bash
# Step 1: Start session ຜ ander mobile API (QR ຫ ander regular)
# POST /api/mobile/v1/charging-sessions/qr-start

# Step 2: ເອ ander TRANSACTION_ID ຈາກ DB
psql "$DATABASE_URL" \
  -c "SELECT id, ocpp_transaction_id, charger_identity, status, started_at
      FROM panda_ev_core.charging_sessions
      ORDER BY created_at DESC LIMIT 3;"
```

### 4. ກ ander ander ander ander ander ander ander ander Pricing

```sql
-- ander ander rate ands ander station PANDA-PHONSAY-01
SELECT pt.rate_per_kwh, pt.plug_type, sp.priority
FROM panda_ev_system.pricing_tiers pt
JOIN panda_ev_system.station_pricings sp ON sp.pricing_tier_id = pt.id
JOIN panda_ev_system.stations s ON s.id = sp.station_id
JOIN panda_ev_system.chargers ch ON ch.station_id = s.id
WHERE ch.ocpp_identity = 'PANDA-PHONSAY-01'
  AND pt.deleted_at IS NULL AND sp.deleted_at IS NULL
ORDER BY sp.priority DESC LIMIT 5;
```

### 5. ກ ander ander ander App Config

```sql
SELECT key, value FROM panda_ev_core.app_configs
WHERE key IN ('min_charging_balance', 'min_wallet_reserve');
-- ander ander: min_wallet_reserve = 15,000 LAK
--              min_charging_balance = 1,000 LAK
```

---

## TC-01: 120 kW DC + Balance 30,000 LAK

**ຈ ander ander ander**: ລ ander ander ander grace burn ≈ 10,000 LAK > remaining ≈ 5,000 LAK → platform loss ≈ 5,000 LAK ❌

```bash
# ຕ ander balance
psql "$DATABASE_URL" \
  -c "UPDATE panda_ev_core.wallets SET balance = 30000 WHERE user_id = '<USER_ID>';"

# Run test (ໃຊ ander ເວລາ ~4 ນາທີ)
TRANSACTION_ID=<n> BALANCE=30000 RATE=5000 \
  npx tsx admin/v16/TestScenarios/tc01-high-power-low-balance.ts
```

**Expected timeline:**
```
MV #1 (t=60s):  2kWh = 10,000 LAK | 30k > 25k? ✅ pass
MV #2 (t=120s): 4kWh = 20,000 LAK | 30k > 35k? ❌ → grace ເລ ander anding
MV #3 (t=185s): 6kWh = 30,000 LAK | elapsed=65s ≥ 60s → RemoteStop
VCP stop (~t=215s): meterStop ≈ 7,000 Wh = 35,000 LAK

actualDebit = min(35,000, 30,000) = 30,000 LAK
Platform loss ≈ 5,000 LAK ❌
```

---

## TC-02: 7.4 kW AC + Balance 30,000 LAK (ຄວນ ✅)

**ຈ ander ander ander**: power ຕ ander — overshoot ໜ ander → platform loss ≈ 0

```bash
# ຕ ander balance
psql "$DATABASE_URL" \
  -c "UPDATE panda_ev_core.wallets SET balance = 30000 WHERE user_id = '<USER_ID>';"

# Run test (ໃຊ ander ເວລາ ~27 ນາທີ)
TRANSACTION_ID=<n> BALANCE=30000 RATE=5000 \
  npx tsx admin/v16/TestScenarios/tc02-slow-charger-low-balance.ts
```

**Expected:**
```
MV #1-24: ✅ pass (cost < 15,000)
MV #25 (t=25min): cost=15,375 LAK | 30k > 30,375? ❌ → grace ເລ ander anding
MV #26 (t=26min+5s): elapsed=65s → RemoteStop
VCP stop (~t=26.5min)

meterStop ≈ 3,321 Wh = 16,605 LAK → actualDebit = 16,605 LAK
Platform loss ≈ 0 LAK ✅
```

---

## TC-03: 120 kW + Balance 16,000 LAK (Edge Case — grace ທ ander ander)

```bash
psql "$DATABASE_URL" \
  -c "UPDATE panda_ev_core.wallets SET balance = 16000 WHERE user_id = '<USER_ID>';"

# ໃຊ ander tc01 script ດ ander ander ander ກ ander BALANCE=16000
TRANSACTION_ID=<n> BALANCE=16000 RATE=5000 \
  npx tsx admin/v16/TestScenarios/tc01-high-power-low-balance.ts
```

**Expected:**
```
MV #1 (t=60s): 2kWh=10,000 | 16k > 25k? ❌ → grace ທ ander andi (MV#1 ທ ander ander ander)
MV #2 (t=125s): elapsed=65s → RemoteStop
VCP stop (~t=155s): meterStop ≈ 4,556 Wh = 22,778 LAK

actualDebit = min(22,778, 16,000) = 16,000 LAK
Platform loss ≈ 6,778 LAK ❌
```

---

## TC-04: 120 kW + Balance 50,000 LAK (ຄາດ loss ໜ ander ander)

```bash
psql "$DATABASE_URL" \
  -c "UPDATE panda_ev_core.wallets SET balance = 50000 WHERE user_id = '<USER_ID>';"

TRANSACTION_ID=<n> BALANCE=50000 RATE=5000 \
  npx tsx admin/v16/TestScenarios/tc01-high-power-low-balance.ts
```

**Expected:**
```
MV #1 t=60s:  2kWh=10k | 50k > 25k? ✅
MV #2 t=120s: 4kWh=20k | 50k > 35k? ✅
MV #3 t=180s: 6kWh=30k | 50k > 45k? ✅
MV #4 t=240s: 8kWh=40k | 50k > 55k? ❌ → grace ເລ ander anding
MV #5 t=305s: elapsed=65s → RemoteStop
VCP stop ~t=335s: meterStop ≈ 10,100 Wh = 50,500 LAK

actualDebit = min(50,500, 50,000) = 50,000 LAK
Platform loss ≈ 500 LAK (ໜ ander ander) ✅
```

---

## ການ Monitor ລະຫວ ander ander Test

**Terminal (Mobile API logs):**
```
[OcppConsumer] Session XXX: wallet exhausted ... grace period started   ← detect
[OcppConsumer] Session XXX: grace period ended ... sending auto-stop    ← stop
```

**Redis:**
```bash
redis-cli GET "charging:grace_start:<SESSION_UUID>"   # timestamp grace start
redis-cli GET "charging:balance_stop:<SESSION_UUID>"  # set when RemoteStop sent
redis-cli GET "charging:live:PANDA-PHONSAY-01:1"      # last meterWh + powerW
```

**DB ຫ ander ather session:**
```sql
SELECT
  id,
  ocpp_transaction_id,
  status,
  meter_start,
  meter_stop,
  energy_kwh,
  actual_cost,
  started_at,
  ended_at,
  EXTRACT(EPOCH FROM (ended_at - started_at))/60 AS duration_min
FROM panda_ev_core.charging_sessions
ORDER BY created_at DESC LIMIT 3;

-- Platform loss formula:
-- loss = (meter_stop / 1000.0 * rate_per_kwh) - actual_cost
-- ຕ ander ander ander: loss = 0 (TC-02, TC-04)
-- ander ander ander: loss > 0 (TC-01, TC-03) ← bug to fix
```

---

## Quick Reference Commands

```bash
# Reset balance ກ ander ander ander test
psql "$DATABASE_URL" \
  -c "UPDATE panda_ev_core.wallets SET balance = 30000 WHERE user_id = '<USER_ID>';"

# ander ander ander session ander
psql "$DATABASE_URL" \
  -c "SELECT id, ocpp_transaction_id, status, meter_start, meter_stop, energy_kwh, actual_cost, started_at, ended_at \
      FROM panda_ev_core.charging_sessions ORDER BY created_at DESC LIMIT 3;"

# ander ander wallet
psql "$DATABASE_URL" \
  -c "SELECT balance FROM panda_ev_core.wallets WHERE user_id = '<USER_ID>';"

# Redis ander ander
redis-cli KEYS "charging:*"
redis-cli GET "charging:live:PANDA-PHONSAY-01:1"
```
