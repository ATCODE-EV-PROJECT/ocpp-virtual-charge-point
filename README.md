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

`index_16.ts` and `index_16_from_csv.ts` have `reconnect: true` by default. When the WebSocket drops the VCP will reconnect with exponential backoff (starts at 2 s, doubles each attempt, caps at 60 s, ±20% jitter) and re-announce with `BootNotification` + `StatusNotification` automatically.

**Drop the connection on demand**

```bash
# Force-disconnect — VCP reconnects automatically
curl -X POST http://localhost:9999/disconnect
```

Use this to simulate a charger losing connectivity mid-session and verify the CSMS's 3-minute grace period behaviour.

**Simulate repeated flapping**

```bash
# Drop every 10 seconds, 5 times
for i in {1..5}; do
  curl -X POST http://localhost:9999/disconnect
  sleep 10
done
```

**OS-level network simulation with Toxiproxy (most realistic)**

```bash
# Install
brew install toxiproxy

# Start the proxy server
toxiproxy-server &

# Create a proxy in front of the CSMS (adjust ports to match your setup)
toxiproxy-cli create ocpp --listen 0.0.0.0:3001 --upstream localhost:4002

# Point VCP at the proxy instead of the CSMS directly
WS_URL=ws://localhost:3001 npm start index_16.ts

# --- Inject faults ---

# Add 500 ms latency ± 100 ms
toxiproxy-cli toxic add ocpp -t latency -a latency=500 -a jitter=100

# Simulate total packet loss (rate=0 = bandwidth 0 KB/s)
toxiproxy-cli toxic add ocpp -t bandwidth -a rate=0

# Remove all toxics (restore normal connection)
toxiproxy-cli toxic remove ocpp --toxicName latency_downstream
toxiproxy-cli toxic remove ocpp --toxicName bandwidth_downstream
```

**Env vars that control reconnect behaviour**

| Variable | Default | Meaning |
|---|---|---|
| `RECONNECT` | `true` (in entry points) | Set to `false` to disable auto-reconnect |
| `reconnectBaseDelayMs` | `2000` ms | Starting backoff delay |
| `reconnectMaxDelayMs` | `60000` ms | Maximum backoff cap |

**What to verify on the CSMS side**

- Session stays `ACTIVE` during the 3-minute offline grace period
- `StopTransaction` arriving after reconnect completes the session normally
- If the grace period expires without `StopTransaction`, session is marked `FAILED` and the charger lock is released

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
