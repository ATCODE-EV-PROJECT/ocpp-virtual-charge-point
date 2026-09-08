#!/bin/bash
# ============================================================
# LockedBalance Lifecycle Test — Scenario C2 / F1 / F2
# ຄູ່ມືລະອຽດ: docs/2026-09-07/2026-09-07T21:54:50-VCP_Offline_Charging_Test_Plan.md
#
# Usage:
#   ./test-lockedbalance-lifecycle.sh c2   # STUCK_AWAITING_REPORT -> 24h auto free-charge -> lock released
#   ./test-lockedbalance-lifecycle.sh f    # ACTIVE >8h -> FAILED (lock kept) -> 48h reaper force-release (lock released) -> idempotency check
#   ./test-lockedbalance-lifecycle.sh f1   # only the ACTIVE >8h -> FAILED half of f
#   SESSION_ID=<uuid> ./test-lockedbalance-lifecycle.sh f2   # only the 48h-reaper half, resuming a FAILED session from a prior f1 run
#
# f/f1/f2 poll real NestJS crons that run every 30 minutes ('*/30 * * * *',
# fires at :00/:30 wall-clock) — each stage can take up to ~32 minutes of
# real wall-clock time. Run this in a terminal you can leave open, or with
# `run_in_background` if driving it from an agent.
# ============================================================
set -e

CHARGER="${CHARGER:-PANDA-PHONSAY-01}"
STATION_ID="${STATION_ID:-3a3944e2-25f4-4344-a27c-f830cc02f65b}"
MOBILE_DB="postgresql://postgresuser:postgrespassword@localhost:5432/panda_ev_mobile"
LOGIN_PHONE="${LOGIN_PHONE:-2055553333}"
LOGIN_PASSWORD="${LOGIN_PASSWORD:-Test@123456}"

SCENARIO="${1:-}"
if [[ "$SCENARIO" != "c2" && "$SCENARIO" != "f" && "$SCENARIO" != "f1" && "$SCENARIO" != "f2" ]]; then
  echo "Usage: $0 <c2|f|f1|f2>"
  exit 1
fi

psql_val() { psql "$MOBILE_DB" -t -c "$1" 2>/dev/null | tr -d ' \n'; }

wallet_row() {
  psql "$MOBILE_DB" -c "SELECT balance, locked_balance FROM panda_ev_mobile.wallets WHERE user_id='${USER_ID}';"
}

# ── f2-only path: resume against an already-FAILED session ────────────────
if [[ "$SCENARIO" == "f2" ]]; then
  if [[ -z "$SESSION_ID" ]]; then
    echo "SESSION_ID env var required for f2 (id of a session already status=FAILED)"; exit 1
  fi
  USER_ID=$(psql_val "SELECT user_id FROM panda_ev_mobile.charging_sessions WHERE id='${SESSION_ID}';")
  TX_ID=$(psql_val "SELECT ocpp_transaction_id FROM panda_ev_mobile.charging_sessions WHERE id='${SESSION_ID}';")
  echo "=== [f2] Resuming session ${SESSION_ID} (user ${USER_ID}) ==="
fi

# ── Shared setup: VCP + login + start session (c2, f, f1) ─────────────────
if [[ "$SCENARIO" != "f2" ]]; then
  echo "=== [1] Kill stale VCP + clean Redis ==="
  pkill -f "index_16.ts" 2>/dev/null && echo "Old VCP killed" || echo "No VCP running"
  sleep 2
  docker exec redis redis-cli DEL \
    "charging:live:${CHARGER}:1" "charging:charger:${CHARGER}:1" \
    "charger:offline:grace:${CHARGER}:1" > /dev/null 2>&1 || true

  echo "=== [2] Start VCP ==="
  WS_URL=ws://localhost:4002/ocpp CP_ID=${CHARGER} npm start index_16.ts > /tmp/vcp_lock_test.log 2>&1 &
  VCP_PID=$!
  until grep -q "Available" /tmp/vcp_lock_test.log 2>/dev/null; do sleep 1; done
  echo "VCP ready (PID=$VCP_PID) ✅"

  echo "=== [3] Login ==="
  TOKEN=$(curl -s -X POST http://localhost:4001/api/mobile/v1/auth/login \
    -H "Content-Type: application/json" \
    -d "{\"countryCode\":\"856\",\"mobilePhone\":\"${LOGIN_PHONE}\",\"password\":\"${LOGIN_PASSWORD}\"}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['accessToken'])")
  echo "Login OK ✅"

  echo "=== [4] Start session ==="
  RESP=$(curl -s -X POST http://localhost:4001/api/mobile/v1/charging-sessions/start \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"chargerIdentity\":\"${CHARGER}\",\"connectorId\":1,\"stationId\":\"${STATION_ID}\",\"stationName\":\"Lock Test\"}")
  SESSION_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
  STATUS=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['status'])")
  if [ "$STATUS" != "ACTIVE" ]; then
    echo "ERROR: session status=$STATUS (expected ACTIVE). Response: $RESP"; kill $VCP_PID 2>/dev/null; exit 1
  fi
  USER_ID=$(psql_val "SELECT user_id FROM panda_ev_mobile.charging_sessions WHERE id='${SESSION_ID}';")
  echo "Session: $SESSION_ID  User: $USER_ID  ✅"

  echo "=== [5] Wait for StartTransaction + first MeterValues ==="
  until docker exec redis redis-cli GET "charging:live:${CHARGER}:1" 2>/dev/null | grep -q '"meterWh":[0-9]'; do sleep 3; done
  TX_ID=$(psql_val "SELECT ocpp_transaction_id FROM panda_ev_mobile.charging_sessions WHERE id='${SESSION_ID}';")
  echo "txId: $TX_ID  ✅"
  echo ""
  echo "Baseline wallet:"; wallet_row
fi

# ── Scenario C2: freeze network -> STUCK_AWAITING_REPORT -> 24h timeout (backdated) -> free-charge, lock released ──
if [[ "$SCENARIO" == "c2" ]]; then
  echo ""
  echo "=== [6] Freeze network via toxiproxy (~4.5 min, long enough to clear the 3-min grace) ==="
  DROP_SECS=270 CSMS_PORT=4002 ./test-unstable-net.sh drop &
  TOXI_PID=$!

  echo "=== [7] Waiting for status=STUCK_AWAITING_REPORT (up to ~6 min)... ==="
  DEADLINE=$((SECONDS + 360))
  while [ $SECONDS -lt $DEADLINE ]; do
    ST=$(psql_val "SELECT status FROM panda_ev_mobile.charging_sessions WHERE id='${SESSION_ID}';")
    [ "$ST" = "STUCK_AWAITING_REPORT" ] && break
    sleep 10
  done
  wait $TOXI_PID 2>/dev/null || true
  if [ "$ST" != "STUCK_AWAITING_REPORT" ]; then
    echo "ERROR: never reached STUCK_AWAITING_REPORT (got '$ST')"; exit 1
  fi
  echo "STUCK_AWAITING_REPORT reached ✅"
  psql "$MOBILE_DB" -c "SELECT status, offline_held_at, offline_deadline_at, offline_last_meter_wh FROM panda_ev_mobile.charging_sessions WHERE id='${SESSION_ID}';"

  echo ""
  echo "=== [8] Backdate offline_deadline_at into the past (simulate the 24h having elapsed) ==="
  psql "$MOBILE_DB" -c "UPDATE panda_ev_mobile.charging_sessions SET offline_deadline_at = NOW() - INTERVAL '1 minute' WHERE id='${SESSION_ID}';" > /dev/null

  echo "=== [9] Waiting for resolveExpiredOfflineHolds (runs every 1 min)... ==="
  DEADLINE=$((SECONDS + 120))
  while [ $SECONDS -lt $DEADLINE ]; do
    ST=$(psql_val "SELECT status FROM panda_ev_mobile.charging_sessions WHERE id='${SESSION_ID}';")
    [ "$ST" = "COMPLETED" ] && break
    sleep 10
  done

  echo ""
  echo "======================================================"
  echo " RESULT — Scenario C2"
  echo "======================================================"
  psql "$MOBILE_DB" -c "SELECT status, amount, lock_released_at, estimated_cost FROM panda_ev_mobile.charging_sessions WHERE id='${SESSION_ID}';"
  echo "Wallet after:"; wallet_row
  echo ""
  echo "CHECKLIST:"
  echo "  [ ] status          = COMPLETED"
  echo "  [ ] amount           = 0  (free)"
  echo "  [ ] lock_released_at  IS NOT NULL"
  echo "  [ ] wallet.locked_balance back to baseline"
fi

# ── Scenario F1: ACTIVE >8h (via backdated started_at, charger left connected) -> checkStuckSessions -> FAILED, lock kept ──
if [[ "$SCENARIO" == "f" || "$SCENARIO" == "f1" ]]; then
  echo ""
  echo "=== [6] Backdate started_at to 9h ago (charger stays CONNECTED — this cron is a Redis-TTL-expiry backstop, independent of offline detection) ==="
  psql "$MOBILE_DB" -c "UPDATE panda_ev_mobile.charging_sessions SET started_at = NOW() - INTERVAL '9 hours' WHERE id='${SESSION_ID}' AND status='ACTIVE';" > /dev/null

  echo "=== [7] Waiting for checkStuckSessions (every 30 min, up to ~32 min)... ==="
  DEADLINE=$((SECONDS + 1920))
  while [ $SECONDS -lt $DEADLINE ]; do
    ST=$(psql_val "SELECT status FROM panda_ev_mobile.charging_sessions WHERE id='${SESSION_ID}';")
    [ "$ST" = "FAILED" ] && break
    echo "  $(date '+%H:%M:%S') — still $ST, waiting..."
    sleep 60
  done
  if [ "$ST" != "FAILED" ]; then
    echo "ERROR: never reached FAILED within ~32 min (got '$ST')"; exit 1
  fi

  echo ""
  echo "======================================================"
  echo " RESULT — Scenario F1"
  echo "======================================================"
  psql "$MOBILE_DB" -c "SELECT status, lock_released_at, estimated_cost FROM panda_ev_mobile.charging_sessions WHERE id='${SESSION_ID}';"
  echo "Wallet (locked_balance must be UNCHANGED — F1 deliberately does not release):"; wallet_row
fi

# ── Scenario F2: FAILED + endedAt older than the reap window -> releaseAbandonedLocks force-releases, then idempotency check ──
if [[ "$SCENARIO" == "f" || "$SCENARIO" == "f2" ]]; then
  REAP_HOURS=$(psql_val "SELECT value FROM panda_ev_mobile.app_configs WHERE key='offline_lock_reap_hours';")
  REAP_HOURS="${REAP_HOURS:-48}"
  BACKDATE_HOURS=$((REAP_HOURS + 1))
  echo ""
  echo "=== [f2-1] Reap window is ${REAP_HOURS}h — backdating ended_at to ${BACKDATE_HOURS}h ago ==="
  psql "$MOBILE_DB" -c "UPDATE panda_ev_mobile.charging_sessions SET ended_at = NOW() - INTERVAL '${BACKDATE_HOURS} hours' WHERE id='${SESSION_ID}' AND status='FAILED';" > /dev/null

  echo "=== [f2-2] Waiting for releaseAbandonedLocks (every 30 min, up to ~32 min)... ==="
  DEADLINE=$((SECONDS + 1920))
  while [ $SECONDS -lt $DEADLINE ]; do
    RELEASED=$(psql_val "SELECT lock_released_at FROM panda_ev_mobile.charging_sessions WHERE id='${SESSION_ID}';")
    [ -n "$RELEASED" ] && break
    echo "  $(date '+%H:%M:%S') — not released yet, waiting..."
    sleep 60
  done
  if [ -z "$RELEASED" ]; then
    echo "ERROR: lock never force-released within ~32 min"; exit 1
  fi

  echo ""
  echo "======================================================"
  echo " RESULT — Scenario F2"
  echo "======================================================"
  psql "$MOBILE_DB" -c "SELECT status, lock_released_at, estimated_cost FROM panda_ev_mobile.charging_sessions WHERE id='${SESSION_ID}';"
  echo "Wallet after force-release (locked_balance should have dropped by estimated_cost):"; wallet_row

  echo ""
  echo "=== [f2-3] Idempotency check — send a StopTransaction as if the charger finally reported back ==="
  if [ -n "$TX_ID" ] && [ "$TX_ID" != "None" ]; then
    TRANSACTION_ID=$TX_ID METER_STOP=12000 npx tsx admin/v16/Transaction/stopTransaction.ts || true
    sleep 3
    echo "Wallet after late StopTransaction (locked_balance must be UNCHANGED vs f2-2 — no double release):"
    wallet_row
  else
    echo "No ocpp_transaction_id on record — skipping idempotency check (start it manually if needed)"
  fi
fi

echo ""
echo "Done. If a VCP process is still running, stop it with: pkill -f index_16.ts"
