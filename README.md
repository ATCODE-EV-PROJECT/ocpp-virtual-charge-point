# OCPP Virtual Charge Point

Simple, configurable, terminal-based OCPP Charging Station simulator written in Node.js with Schema validation.

## Watch our video introduction

[![VCP Video](https://img.youtube.com/vi/YsXjnk0mhfA/0.jpg)](https://www.youtube.com/watch?v=YsXjnk0mhfA)

## Prerequisites

- Node.js 12+

Run:

```bash
npm install
```

## Running VCP

Configure env variables in `.env`:

```
WS_URL=ws://localhost:4002        # WebSocket endpoint of the OCPP CSMS
CP_ID=123456                      # Charge point identity registered in the system
PASSWORD=                         # Basic-auth password (leave blank if unused)
ADMIN_PORT=9999                   # Admin HTTP API port (default: 9999)
TARGET_SOC=100                    # Auto-stop SoC % (default: 100)
```

When testing different configurations, create multiple `.env` files and pass the suffix as an argument:

```bash
npm start index_16.ts             # uses .env
npm start production index_16.ts  # uses .env.production
npm start .env.staging index_16.ts
```

### Entry points

| Command | Description |
|---|---|
| `npm start index_16.ts` | OCPP 1.6 — single connector |
| `npm start index_16_2_connectors.ts` | OCPP 1.6 — two connectors |
| `npm start index_16_stress.ts` | OCPP 1.6 — stress test (many sessions) |
| `npm start index_16_from_csv.ts` | OCPP 1.6 — sessions driven from CSV |
| `npm start index_201.ts` | OCPP 2.0.1 |
| `npm start index_21.ts` | OCPP 2.1 |

---

## Testing Commands (OCPP 1.6)

All admin commands require the VCP to be running. Run them in a separate terminal.

### Transaction flow

```bash
# Start a transaction (connector 1, idTag MOBILE_APP, meterStart 0 Wh)
npx tsx admin/v16/Transaction/startTransaction.ts

# Override connector, meter start, or idTag
CONNECTOR_ID=2 METER_START=5000 ID_TAG=RFID_CARD npx tsx admin/v16/Transaction/startTransaction.ts

# Send meter values mid-session (3 kWh delivered, 22 kW instantaneous)
npx tsx admin/v16/Transaction/meterValues.ts

# Override transaction id and meter reading
TRANSACTION_ID=42 METER_WH=6000 POWER_KW=11 npx tsx admin/v16/Transaction/meterValues.ts

# Stop a transaction (transactionId=1, meterStop=15000 Wh = 15 kWh)
npx tsx admin/v16/Transaction/stopTransaction.ts

# Override transaction id and final meter reading
TRANSACTION_ID=42 METER_STOP=20000 npx tsx admin/v16/Transaction/stopTransaction.ts

# Start a transaction on a reserved connector
npx tsx admin/v16/Transaction/startTransaction-reserved.ts
```

### Connector status

```bash
npx tsx admin/v16/StatusNotification/available.ts    # connector ready
npx tsx admin/v16/StatusNotification/preparing.ts    # cable plugged, waiting auth
npx tsx admin/v16/StatusNotification/charging.ts     # actively charging
npx tsx admin/v16/StatusNotification/suspendedEV.ts  # car paused charging (full/paused)
npx tsx admin/v16/StatusNotification/suspendedEVSE.ts
npx tsx admin/v16/StatusNotification/finishing.ts    # transaction ended, cable still in
npx tsx admin/v16/StatusNotification/reserved.ts
npx tsx admin/v16/StatusNotification/faulted.ts
npx tsx admin/v16/StatusNotification/unavailable.ts
npx tsx admin/v16/StatusNotification/second.ts       # connector 2 status
```

### Authorization

```bash
npx tsx admin/v16/Authorize/authorize.ts              # known idTag → Accepted
npx tsx admin/v16/Authorize/authorize-non-existing.ts # unknown idTag → Invalid
```

### Other messages

```bash
npx tsx admin/v16/DataTransfer/dataTransfer.ts
npx tsx admin/v16/Firmware/firmware-status-notification.ts
```

---

## Common Test Scenarios

### Normal charging session

```bash
# 1. Start VCP
npm start index_16.ts

# 2. Trigger a session from the mobile app (QR scan or remote start)

# 3. Send meter values while charging
npx tsx admin/v16/Transaction/meterValues.ts

# 4. Stop the transaction
npx tsx admin/v16/Transaction/stopTransaction.ts

# 5. Return connector to Available
npx tsx admin/v16/StatusNotification/available.ts
```

### Parking overstay fee

This tests the parking fee that accrues when a car stays plugged in after charging ends.
Requires `enable_parking_fee = true` in the station's pricing tier.

```bash
# 1. Complete a charging session (steps above through stopTransaction)

# 2. Put connector in Finishing (cable still plugged — parking timer starts)
npx tsx admin/v16/StatusNotification/finishing.ts

# 3. Wait for parkingFreeMinutes to elapse (set to 1 in pricing tier for fast testing)
#    The parking monitor cron fires every minute and sends push notifications.

# 4. Simulate car going idle while still plugged (optional — triggers SSE idle warning)
npx tsx admin/v16/StatusNotification/suspendedEV.ts

# 5. Simulate physical unplug — this triggers immediate billing
npx tsx admin/v16/StatusNotification/available.ts
#    → wallet deducted: billableMinutes × parkingFeePerMinute LAK
#    → chargingSession.overstayMinutes / overstayFee updated in DB
```

### Unplug fee (cable removed before charging)

```bash
# Plug in and immediately unplug within the grace window configured in pricing
npx tsx admin/v16/StatusNotification/preparing.ts
npx tsx admin/v16/StatusNotification/available.ts
```

### Two-connector charger

```bash
# Start VCP with two connectors
npm start index_16_2_connectors.ts

# Send status for connector 2
npx tsx admin/v16/StatusNotification/second.ts

# Start transaction on connector 2
CONNECTOR_ID=2 npx tsx admin/v16/Transaction/startTransaction.ts
```

### Reserved connector

```bash
# Reserve connector via Admin API, then simulate the EV arriving
npx tsx admin/v16/StatusNotification/reserved.ts
npx tsx admin/v16/Transaction/startTransaction-reserved.ts
```

### Faulted / Unavailable

```bash
# Simulate a hardware fault
npx tsx admin/v16/StatusNotification/faulted.ts

# Take charger offline for maintenance
npx tsx admin/v16/StatusNotification/unavailable.ts

# Restore
npx tsx admin/v16/StatusNotification/available.ts
```

### Lost internet / unstable connection

The VCP has built-in reconnect support. `index_16.ts` and `index_16_from_csv.ts` both set `reconnect: true`. When the WebSocket drops for any reason, the VCP will:

- Reconnect with **exponential backoff** (starts at 2 s, doubles each attempt, caps at 60 s, ±20% jitter)
- Re-send `BootNotification` + `StatusNotification` automatically after every successful reconnect

There are two ways to trigger a disconnect: a lightweight **admin API call** for quick checks, and the **Toxiproxy script** for realistic OS-level network simulation.

---

#### Option A — Quick disconnect via admin API

```bash
# Force-drop the WebSocket — VCP reconnects automatically
curl -X POST http://localhost:9999/disconnect
```

Use this to verify the CSMS grace-period behaviour without extra tooling.

```bash
# Repeated flapping — drop every 10 s, 5 times
for i in {1..5}; do
  curl -X POST http://localhost:9999/disconnect
  sleep 10
done
```

---

#### Option B — Realistic network simulation with `test-unstable-net.sh`

`test-unstable-net.sh` wraps [Toxiproxy](https://github.com/Shopify/toxiproxy) to inject real OS-level network faults between the VCP and the CSMS. It starts `toxiproxy-server` automatically, creates the proxy on first run, and handles all toxic lifecycle management.

```
VCP (index_16.ts)
      │  ws://localhost:3001
      ▼
[Toxiproxy :3001]  ← faults injected here
      │  ws://localhost:4002
      ▼
CSMS (panda-ev-ocpp)
```

**Prerequisites (one-time install)**

```bash
brew install toxiproxy
```

**Step 1 — Start the VCP via the proxy**

```bash
# Terminal 1
WS_URL=ws://localhost:3001 npm start index_16.ts
```

The script auto-creates the proxy `ocpp` (`:3001 → localhost:4002`) on first use.

**Step 2 — Inject a fault**

```bash
# Terminal 2 — pick any scenario
./test-unstable-net.sh latency   # add 500 ms delay ± 100 ms jitter
./test-unstable-net.sh slow      # throttle bandwidth to 10 KB/s
./test-unstable-net.sh drop      # freeze connection for 10 s, then auto-restore
./test-unstable-net.sh flap      # 5 cycles of freeze / restore (fully automated)
./test-unstable-net.sh loss      # silent packet loss (timeout toxic, 3 s)
```

**Step 3 — Check what is active**

```bash
./test-unstable-net.sh status
```

Output shows the proxy table with the active toxic count:
```
Proxies:
ocpp    [::]:3001    localhost:4002    enabled    1
```

**Step 4 — Remove all faults**

```bash
./test-unstable-net.sh clean
```

**Step 5 — Teardown when done**

```bash
./test-unstable-net.sh teardown   # deletes proxy + stops toxiproxy-server
```

---

**Scenario reference**

| Scenario | What it does | Auto-restores? |
|---|---|---|
| `latency` | Adds a fixed delay + jitter to every frame | No — run `clean` |
| `slow` | Caps throughput at N KB/s | No — run `clean` |
| `drop` | Freezes the connection entirely for N seconds, then removes itself | **Yes** |
| `flap` | Runs N automated cycles of freeze → restore | **Yes** |
| `loss` | Closes the connection after N ms of silence (dead-path simulation) | No — run `clean` |
| `clean` | Removes all active toxics immediately | — |
| `status` | Prints proxy table and active toxic count | — |
| `teardown` | Deletes the proxy and stops `toxiproxy-server` | — |

---

**Tuning via environment variables**

All defaults can be overridden inline:

```bash
# Heavier latency
LATENCY_MS=1000 JITTER_MS=300 ./test-unstable-net.sh latency

# Very slow link
BANDWIDTH_KB=1 ./test-unstable-net.sh slow

# Long drop — test the CSMS 3-minute grace period
DROP_SECS=200 ./test-unstable-net.sh drop

# Aggressive flap — 10 short cycles
FLAP_COUNT=10 FLAP_DOWN_SECS=3 FLAP_UP_SECS=2 ./test-unstable-net.sh flap

# Tighter packet-loss timeout
LOSS_TIMEOUT=1000 ./test-unstable-net.sh loss

# Different CSMS or proxy port
CSMS_PORT=3000 PROXY_PORT=4000 ./test-unstable-net.sh status
```

Full variable reference:

| Variable | Default | Applies to |
|---|---|---|
| `CSMS_PORT` | `4002` | all |
| `PROXY_PORT` | `3001` | all |
| `LATENCY_MS` | `500` | `latency` |
| `JITTER_MS` | `100` | `latency` |
| `BANDWIDTH_KB` | `10` | `slow` |
| `DROP_SECS` | `10` | `drop` |
| `FLAP_COUNT` | `5` | `flap` |
| `FLAP_DOWN_SECS` | `8` | `flap` |
| `FLAP_UP_SECS` | `5` | `flap` |
| `LOSS_TIMEOUT` | `3000` | `loss` |

---

**VCP reconnect behaviour**

| Variable | Default | Meaning |
|---|---|---|
| `reconnect` | `true` (set in each entry point) | Set to `false` to disable auto-reconnect |
| `reconnectBaseDelayMs` | `2000` ms | Initial backoff delay |
| `reconnectMaxDelayMs` | `60000` ms | Maximum backoff cap |

---

**What to verify on the CSMS side**

- Session stays `ACTIVE` during the offline grace period (3 minutes by default)
- `StopTransaction` arriving after reconnect closes the session normally
- If the grace period expires without `StopTransaction`, the session is marked `FAILED` and the charger lock is released
- `BootNotification` + `StatusNotification` are re-sent after every reconnect and accepted without creating duplicate records

---

## Example startup output

```
> WS_URL=ws://localhost:4002 CP_ID=vcp_16_test npm start index_16.ts

2023-03-27 13:09:17 info: Connecting... | {
  endpoint: 'ws://localhost:4002',
  chargePointId: 'vcp_16_test',
  ocppVersion: 'OCPP_1.6',
  adminWsPort: 9999
}
2023-03-27 13:09:17 info: Sending ➡️  BootNotification
2023-03-27 13:09:17 info: Sending ➡️  StatusNotification { status: Available }
2023-03-27 13:09:17 info: Receive ⬅️  BootNotification response { status: Accepted }
```

---

## Contributing

### Bug Reports & Feature Requests

Please use the [issue tracker](https://github.com/solidstudiosh/ocpp-virtual-charge-point/issues) to report any bugs or file feature requests.

### Developing

We encourage contributions through pull requests and follow the standard "fork-and-pull" git workflow.

1. Fork the repository on GitHub.
2. Clone the forked repository to your local machine.
3. Create a new branch for your changes.
4. Make your changes to the code and commit them to your local branch.
5. Push the changes to your forked repository on GitHub.
6. Create a new pull request on the original repository.
7. Wait for feedback and make any necessary changes.
8. Once your pull request has been reviewed and accepted, it will be merged into the original repository.

When creating your pull request, please include a clear description of the changes you have made, and any relevant context or reasoning behind those changes.
