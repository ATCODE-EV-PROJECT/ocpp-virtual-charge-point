# STUCK_AWAITING_REPORT Reconnect Recovery — Test Plan (VCP Local Test)

ທົດສອບ `OcppConsumerService.recoverStuckAwaitingReportSession()` — ການແກ້ໄຂບັນຫາ session
ຄ້າງ `STUCK_AWAITING_REPORT` ຫຼັງເຄືອຂ່າຍກັບຄືນ, ເຮັດໃຫ້ user stop charging ຜ່ານ App ບໍ່ໄດ້.

**ອ້າງອີງ**: `docs/2026-09-15/2026-09-15T19:02:42-STUCK_AWAITING_REPORT_Reconnect_Recovery_Fix.md`

**Unit test coverage** (mocked, ບໍ່ຕ້ອງການ services ຈິງ): `offline-panda-ev-client-mobile/src/modules/charging-session/charger-reconnected-notification.spec.ts`
— ໄຟລ໌ນີ້ແມ່ນ **end-to-end test** ຜ່ານ services ຈິງ + VCP simulator, ໃຊ້ຢືນຢັນຄືນວ່າ fix ເຮັດວຽກຈິງກັບ OCPP protocol timing.

---

## Setup ກ່ອນ Run

### 1. ລັນ Services

```bash
# Terminal 1 — OCPP CSMS
cd offline-panda-ev-ocpp && npm run start:dev

# Terminal 2 — Mobile API
cd offline-panda-ev-client-mobile && npm run start:dev

# Terminal 3 — VCP (charger ໃດກໍ່ໄດ້, ຕົວຢ່າງ PANDA-PHONSAY-01)
cd ocpp-virtual-charge-point && npm start index_16.ts
```

**ສຳຄັນ**: `index_16.ts`'s `onReconnect` handler ສົ່ງພຽງ `StatusNotification` — **ບໍ່ສົ່ງ
`BootNotification` ຄືນ**. ນີ້ຄືສິ່ງທີ່ຈຳລອງ "network blip ແທ້ໆ" (charger firmware ບໍ່ໄດ້ reboot,
ພຽງແຕ່ signal ຫາຍໄປຊົ່ວຄາວ) — ຕົງກັບ scenario ຈິງທີ່ trigger ບັນຫານີ້. ຖ້າ restart ທັງ VCP process
(Ctrl-C ແລ້ວ `npm start` ໃໝ່) ຈະສົ່ງ BootNotification ຄືນ ແລະ ໄປທາງ `charger.booted` (force-stop)
ແທນ — ບໍ່ແມ່ນ scenario ທີ່ test ນີ້ຕ້ອງການ.

### 2. Start Session + ເອົາ TRANSACTION_ID

```bash
# ຜ່ານ Mobile API (QR ຫຼື regular start)
# POST /api/mobile/v1/charging-sessions/qr-start

psql "$DATABASE_URL" \
  -c "SELECT id, ocpp_transaction_id, charger_identity, connector_id, status
      FROM panda_ev_core.charging_sessions
      ORDER BY created_at DESC LIMIT 1;"
```

---

## TC-05: Reconnect After STUCK_AWAITING_REPORT

**ຈຸດປະສົງ**: ຢືນຢັນວ່າ ເມື່ອຫົວສາກ offline ດົນກວ່າ ~105-120s (ເກີນ STUCK_AWAITING_REPORT
threshold) ແລ້ວເຊື່ອມຕໍ່ຄືນ ພ້ອມລາຍງານ transactionId ເກົ່າ — session ຖືກກູ້ຄືນກັບ `ACTIVE`
ໂດຍອັດຕະໂນມັດ, ບໍ່ຄ້າງລໍຖ້າ StopTransaction ນານເຖິງ 24 ຊົ່ວໂມງ.

```bash
TRANSACTION_ID=<n> CONNECTOR_ID=1 \
  npx tsx admin/v16/TestScenarios/tc05-reconnect-after-stuck-awaiting-report.ts
```

**ໃຊ້ເວລາ ~4-5 ນາທີ.**

### Timeline ທີ່ຄາດຫວັງ

```
t=0s      MV baseline (online)              → charging:live:* ຖືກຕັ້ງຄ່າ
t=0s      forceDisconnect() ຄັ້ງທຳອິດ
t=0-150s  ຄືນ forceDisconnect() ທຸກ 8s        → ຫົວສາກ "offline" ຕໍ່ເນື່ອງ
t=15s     OCPP: "<identity> disconnected — offline event in 15s" ຄົບກຳນົດ
              → markChargerOfflineEvents() → charger.offline ຖືກ publish
t=15s     Mobile: "Charger <identity> went offline with active session
              <id> — 90s grace period started"
t=105s    Mobile grace (90s) ໝົດອາຍຸ — ລໍຖ້າ ParkingMonitorService cron
              (ທຸກ 15s) ຮອບຕໍ່ໄປ
t=105-120s  ParkingMonitor: "no StopTransaction after ... reconnect grace.
              Session <id> held as STUCK_AWAITING_REPORT until <+24h>."
              → DB: status = STUCK_AWAITING_REPORT
t=150s    script ຢຸດ force-disconnect, ປ່ອຍໃຫ້ VCP auto-reconnect ຕາມປົກກະຕິ
t=150-220s  VCP reconnects (backoff ≤60s) → StatusNotification ເທົ່ານັ້ນ
              (ບໍ່ມີ BootNotification)
              → OCPP: updateChargerOnline() ເຫັນ previousStatus=OFFLINE
              → publish charger.reconnected
t=~150-220s Mobile: handleChargerReconnected() ພົບ grace key ຫາຍໄປແລ້ວ
              → ເອີ້ນ recoverStuckAwaitingReportSession()
              → ຖ້າ charging:live:*.transactionId ກົງກັບ session.ocppTransactionId:
                "[StuckRecovery] Charger <identity> reconnected — session <id>
                (txId=<n>) still live, recovered from STUCK_AWAITING_REPORT
                back to ACTIVE"
              → DB: status = ACTIVE, offline_held_at/offline_deadline_at = NULL
              → subscribeToMeterBalance() resubscribed
t=220s    script ສົ່ງ MV ຄືນ (resumed, txId ດຽວກັນ) — ບໍ່ຄວນຖືກ skip ອີກຕໍ່ໄປ
```

### ຜົນທີ່ຄາດຫວັງ (Pass criteria)

| # | ກວດສອບ | ຄາດຫວັງ |
|---|---|---|
| 1 | Mobile API log ຫຼັງ reconnect | ມີ `[StuckRecovery] ... recovered from STUCK_AWAITING_REPORT back to ACTIVE` |
| 2 | `SELECT status, offline_held_at, offline_deadline_at FROM charging_sessions WHERE id='<id>'` | `status='ACTIVE'`, ທັງສອງ offline_* field = `NULL` |
| 3 | `DELETE /api/mobile/v1/charging-sessions/<id>` (ຫຼັງ recovery, ລອງຢຸດຜ່ານ App) | `200 OK` — **ບໍ່ແມ່ນ 409/503 ອີກຕໍ່ໄປ** |
| 4 | MV ຄັ້ງຫຼັງສຸດ (Phase 3 ໃນ script) | Mobile logs **ບໍ່ມີ** `[BalanceCheck] ... is STUCK_AWAITING_REPORT — skipping stale meter callback` |
| 5 | `redis-cli GET "charging:balance_stop:<id>"` | `nil` (watchdog active ຄືນ, ຍັງບໍ່ trigger stop) |

### ກໍລະນີບໍ່ຄວນກູ້ຄືນ (regression guard — ບໍ່ໄດ້ automate ໃນ script ນີ້, ອ້າງອີງ unit test)

ກວມຢູ່ໃນ `charger-reconnected-notification.spec.ts` ແລ້ວ (mocked, ໄວ):
- Live `transactionId` ບໍ່ກົງກັບ session (transaction ຖືກແທນທີ່ໄປແລ້ວ) → ບໍ່ກູ້ຄືນ
- ບໍ່ມີ live meter data ເລີຍ (ຫົວສາກຍັງງຽບແທ້ໆ) → ບໍ່ກູ້ຄືນ
- Grace key ຍັງບໍ່ໝົດອາຍຸ (ຍັງ ACTIVE ປົກກະຕິ, ບໍ່ທັນເຖິງ STUCK) → path ເກົ່າເຮັດວຽກຄືເດີມ

---

## ການ Monitor ລະຫວ່າງ Test

**OCPP logs:**
```
<identity> disconnected — offline event in 15s
MeterValues: <identity>:<connectorId> → <n> Wh (txId=<n>)   ← ຫຼັງ reconnect, ຄວນເຫັນອີກ
```

**Mobile API logs:**
```
Charger <identity> went offline with active session <id> — 90s grace period started
no StopTransaction after ... reconnect grace. Session <id> held as STUCK_AWAITING_REPORT ...
[StuckRecovery] Charger <identity> reconnected — session <id> ... recovered from STUCK_AWAITING_REPORT back to ACTIVE
```

**Redis:**
```bash
redis-cli GET "charger:offline:grace:<identity>:<connectorId>"   # ຄວນ nil ຫຼັງ 105-120s (ຖືກ consume ໄປແລ້ວ)
redis-cli GET "charging:live:<identity>:<connectorId>"           # transactionId ຄວນຍັງກົງ
redis-cli GET "charging:balance_stop:<SESSION_UUID>"             # nil = watchdog ຍັງບໍ່ trigger stop
```

**DB:**
```sql
SELECT id, status, ocpp_transaction_id, offline_held_at, offline_deadline_at
FROM panda_ev_core.charging_sessions
ORDER BY created_at DESC LIMIT 1;
```

---

## ໝາຍເຫດ

- ເວລາໃນ script (`OFFLINE_HOLD_MS = 150_000`) ຖືກຄິດໄລ່ຈາກ code ຈິງ (15s offline-confirm +
  90s Mobile grace + ≤15s cron jitter ≈ 105-120s) + buffer. ຖ້າ code ປ່ຽນຄ່າເຫຼົ່ານີ້ໃນອະນາຄົດ
  (`ocpp.gateway.ts` L437 `15_000`, `ocpp-consumer.service.ts` `handleChargerOffline` L1374
  `90 * 1000`, ຫຼື `parking-monitor.service.ts` cron `*/15 * * * * *`), ຕ້ອງອັບເດດຄ່ານີ້ນຳ.
- Log message ໃນ `parking-monitor.service.ts` (`"no StopTransaction after 3-min reconnect
  grace"`) ເປັນ string ທີ່ບໍ່ກົງກັບຄ່າຈິງ (90s, ບໍ່ແມ່ນ 3 ນາທີ) — ບໍ່ແມ່ນ bug ທີ່ test ນີ້ກວດ, ພຽງແຕ່
  ໝາຍເຫດໄວ້ບໍ່ໃຫ້ສັບສົນເວລາອ່ານ log.
- ຖ້າຢາກຈຳລອງ network fault ແບບ realistic ກວ່າ (packet loss, latency ແທນ hard disconnect),
  ໃຊ້ Option B ໃນ `ocpp-virtual-charge-point/README.md` (`test-unstable-net.sh` + Toxiproxy)
  ແທນ admin `/disconnect` loop ນີ້.
