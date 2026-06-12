#!/bin/bash
# ============================================================
# V3.6 Offline Fee Waiver Test — Quick Script
# ຄູ່ມືລະອຽດ: docs/2026-06-10/2026-06-10T18:30:00-Offline_Scenario_Test_Guide.md
# ============================================================
set -e

CHARGER="PANDA-PHONSAY-01"
STATION_ID="3a3944e2-25f4-4344-a27c-f830cc02f65b"
MOBILE_DB="postgresql://postgresuser:postgrespassword@localhost:5432/panda_ev_mobile"
OCPP_DB="postgresql://postgresuser:postgrespassword@localhost:5432/panda_ev_ocpp"

echo "======================================================"
echo " V3.6 Offline Fee Waiver Test"
echo "======================================================"
echo ""

echo "=== [1] Kill VCP + clear stale Redis keys ==="
pkill -f "index_16.ts" 2>/dev/null && echo "Old VCP killed" || echo "No VCP running"
sleep 2
toxiproxy-cli toxic remove -n drop_downstream ocpp 2>/dev/null && echo "Old toxic removed" || true
docker exec redis redis-cli DEL \
  "charging:live:${CHARGER}:1" \
  "charging:charger:${CHARGER}:1" \
  "charger:offline:grace:${CHARGER}:1" > /dev/null
echo "Redis cleaned"
echo ""

echo "=== [2] Start VCP (BootNotification) ==="
WS_URL=ws://localhost:3001/ocpp CP_ID=${CHARGER} npm start index_16.ts > /tmp/vcp_offline_test.log 2>&1 &
VCP_PID=$!
echo "VCP starting PID=$VCP_PID..."
until grep -q "status.*Available\|Available.*status" /tmp/vcp_offline_test.log 2>/dev/null; do
  sleep 1
done
echo "VCP ready at $(date '+%H:%M:%S') ✅"
echo ""

echo "=== [3] Login Mobile API ==="
TOKEN=$(curl -s -X POST http://localhost:4001/api/mobile/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"countryCode":"856","mobilePhone":"2055553333","password":"Test@123456"}' | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['data']['accessToken'])")
echo "Login OK ✅"
echo ""

echo "=== [4] Start charging session ==="
START_TIME=$(date '+%H:%M:%S')
RESP=$(curl -s -X POST http://localhost:4001/api/mobile/v1/charging-sessions/start \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"chargerIdentity\":\"${CHARGER}\",\"connectorId\":1,\"stationId\":\"${STATION_ID}\",\"stationName\":\"Panda EV — Phonsay\"}")
SESSION_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
SESSION_STATUS=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['status'])")

if [ "$SESSION_STATUS" != "ACTIVE" ]; then
  echo "ERROR: Session status = $SESSION_STATUS (expected ACTIVE)"
  echo "Response: $RESP"
  kill $VCP_PID 2>/dev/null
  exit 1
fi
echo "Session: $SESSION_ID"
echo "Status:  $SESSION_STATUS  ✅"
echo ""

echo "=== [5] Wait for txId + MeterValues > 0 ==="
echo "ລໍ VCP ສົ່ງ StartTransaction + MeterValues (ສູງສຸດ 60s)..."
until docker exec redis redis-cli GET "charging:live:${CHARGER}:1" 2>/dev/null | grep -q '"meterWh":[1-9]'; do
  sleep 3
done
LIVE_DATA=$(docker exec redis redis-cli GET "charging:live:${CHARGER}:1" 2>/dev/null)
TX_ID=$(psql "$MOBILE_DB" -t -c "SELECT ocpp_transaction_id FROM panda_ev_mobile.charging_sessions WHERE id='${SESSION_ID}';" 2>/dev/null | tr -d ' \n')
echo "Live meter: $LIVE_DATA"
echo "txId: $TX_ID  ✅"
echo ""

echo "=== [6] ✂️  Freeze network at $(date '+%H:%M:%S') ==="
toxiproxy-cli toxic add -t bandwidth -n drop_downstream -a rate=0 ocpp
FREEZE_TIME=$(date '+%H:%M:%S')
echo "Network frozen at $FREEZE_TIME ✅"
echo ""
echo "Timeline:"
echo "  ~2 min  → OCPP detect disconnect (ping timeout)"
echo "  +15s    → charger OFFLINE"
echo "  +90s    → grace billing → session COMPLETED (fees WAIVED)"
echo "  +5 min  → force-stop PowerLoss (session already done)"
echo ""

echo "=== [7] Waiting for session COMPLETED (ລໍ ~8 min)... ==="
PREV_STATUS=""
while true; do
  CURR_STATUS=$(psql "$MOBILE_DB" -t -c "SELECT status FROM panda_ev_mobile.charging_sessions WHERE id='${SESSION_ID}';" 2>/dev/null | tr -d ' \n')
  if [ "$CURR_STATUS" != "$PREV_STATUS" ]; then
    echo "$(date '+%H:%M:%S') — status: $CURR_STATUS"
    PREV_STATUS=$CURR_STATUS
  fi
  if [ "$CURR_STATUS" = "COMPLETED" ]; then
    break
  fi
  sleep 15
done
echo ""

echo "======================================================"
echo " BILLING RESULT"
echo "======================================================"
psql "$MOBILE_DB" -c "
  SELECT
    status,
    energy_kwh,
    energy_cost,
    charging_parking_fee   AS parking_fee,
    unplug_fee,
    vat_amount,
    amount,
    ocpp_transaction_id    AS tx_id,
    ended_at AT TIME ZONE 'Asia/Vientiane' AS ended_local
  FROM panda_ev_mobile.charging_sessions
  WHERE id='${SESSION_ID}';"

echo ""
echo "OCPP stop_reason:"
FINAL_TX=$(psql "$MOBILE_DB" -t -c "SELECT ocpp_transaction_id FROM panda_ev_mobile.charging_sessions WHERE id='${SESSION_ID}';" | tr -d ' \n')
psql "$OCPP_DB" -c "SELECT ocpp_transaction_id, stop_reason, status, meter_start, meter_stop FROM panda_ev_ocpp.transactions WHERE ocpp_transaction_id=${FINAL_TX};"

echo ""
echo "=== [8] Restore network ==="
toxiproxy-cli toxic remove -n drop_downstream ocpp
kill $VCP_PID 2>/dev/null || true
echo "Done! ✅"
echo ""
echo "======================================================"
echo " CHECKLIST (ກວດດ້ວຍຕົວເອງ)"
echo "======================================================"
echo "  [ ] status               = COMPLETED"
echo "  [ ] energy_kwh           > 0"
echo "  [ ] energy_cost          > 0"
echo "  [ ] parking_fee          = 0   ← ຕ້ອງ 0 (ຍົກເວັ້ນ)"
echo "  [ ] unplug_fee           = NULL ← ຕ້ອງ NULL/0 (ຍົກເວັ້ນ)"
echo "  [ ] amount               = energy_cost + vat"
echo "  [ ] stop_reason (OCPP)   = PowerLoss"
