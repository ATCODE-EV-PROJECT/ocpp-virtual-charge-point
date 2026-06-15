/**
 * TC-02: 7.4 kW AC + Balance 30,000 LAK — Slow Charger (ຄວນ ✅ ບໍ່ເສຍ)
 *
 * ທົດສອບ: ທີ power ຕ່ຳ minReserve ຄ້ວ overshoot window ໄດ້ → platform loss = 0
 *
 * ການ run:
 *   TRANSACTION_ID=<n> [BALANCE=30000] [RATE=5000] [MIN_RESERVE=15000] [CONNECTOR_ID=1] \
 *   npx tsx admin/v16/TestScenarios/tc02-slow-charger-low-balance.ts
 *
 * ໝາຍເຫດ: script ນີ້ສົ່ງ MeterValues ທຸກ 60s ດ້ວຍ power=7,400W (7.4kW)
 *         ໃຊ້ເວລາ ~25-30 ນາທີ ຈຶ່ງເຫັນ grace trigger
 *
 * ກ່ອນ run:
 *   1. ຕັ້ງ wallet balance ຜ່ານ SQL:
 *      UPDATE panda_ev_core.wallets SET balance = <BALANCE> WHERE user_id = '<USER_ID>';
 *   2. Start session ຜ່ານ mobile API
 *   3. ເອົາ TRANSACTION_ID ຈາກ DB:
 *      SELECT ocpp_transaction_id FROM panda_ev_core.charging_sessions ORDER BY created_at DESC LIMIT 1;
 */

import * as uuid from "uuid";
import { sendAdminCommand } from "../../admin";

const TRANSACTION_ID = Number.parseInt(process.env.TRANSACTION_ID ?? "0");
const RATE_PER_KWH = Number.parseInt(process.env.RATE ?? "5000"); // LAK/kWh
const BALANCE = Number.parseInt(process.env.BALANCE ?? "30000"); // LAK
const MIN_RESERVE = Number.parseInt(process.env.MIN_RESERVE ?? "15000"); // LAK
const CONNECTOR_ID = Number.parseInt(process.env.CONNECTOR_ID ?? "1");

const POWER_W = 7_400; // 7.4 kW AC
const POWER_KW = POWER_W / 1000;
const INTERVAL_WH = Math.round(POWER_W * (60 / 3600)); // ~123 Wh per 60s
const INTERVAL_MS = 60_000;

if (!TRANSACTION_ID) {
  console.error("❌ TRANSACTION_ID required. Get it from OCPP logs after session start.");
  console.error(
    "   SELECT ocpp_transaction_id FROM panda_ev_core.charging_sessions ORDER BY created_at DESC LIMIT 1;",
  );
  process.exit(1);
}

// Detect which interval grace starts
const detectionCostLak = BALANCE - MIN_RESERVE;
const detectionInterval = Math.max(
  1,
  Math.ceil(detectionCostLak / (RATE_PER_KWH * (INTERVAL_WH / 1000))),
);
const graceStopInterval = detectionInterval + 1;
// Send a few extra intervals beyond grace stop to confirm session ended
const totalIntervals = graceStopInterval + 2;

async function sendMeterValue(intervalNum: number): Promise<void> {
  const meterWh = intervalNum * INTERVAL_WH;
  const costLak = Math.round((meterWh / 1000) * RATE_PER_KWH);
  const threshold = costLak + MIN_RESERVE;
  const pass = BALANCE > threshold;

  console.log(`\n📡 MeterValues #${intervalNum} — t=${intervalNum * 60}s`);
  console.log(`   Energy : ${meterWh} Wh (${(meterWh / 1000).toFixed(3)} kWh)`);
  console.log(`   Power  : ${POWER_KW} kW = ${POWER_W} W`);
  console.log(`   Cost   : ${costLak.toLocaleString()} LAK`);
  console.log(
    `   ${BALANCE.toLocaleString()} > ${costLak.toLocaleString()} + ${MIN_RESERVE.toLocaleString()} = ${threshold.toLocaleString()}? → ${pass ? "✅ PASS" : "❌ GRACE/STOP"}`,
  );

  await sendAdminCommand({
    action: "MeterValues",
    messageId: uuid.v4(),
    payload: {
      connectorId: CONNECTOR_ID,
      transactionId: TRANSACTION_ID,
      meterValue: [
        {
          timestamp: new Date(),
          sampledValue: [
            {
              value: String(POWER_W),
              measurand: "Power.Active.Import",
              unit: "W",
              context: "Sample.Periodic",
            },
            {
              value: String(meterWh),
              measurand: "Energy.Active.Import.Register",
              unit: "Wh",
              context: "Sample.Periodic",
            },
          ],
        },
      ],
    },
  });
}

(async () => {
  // At low power, overshoot during grace+stop window is small
  const graceBurnWh = Math.round(POWER_W * (60 / 3600)); // 1 interval worth
  const stopLatencyBurnWh = Math.round(POWER_W * (30 / 3600)); // 30s stop latency
  const estimatedStopWh =
    graceStopInterval * INTERVAL_WH + graceBurnWh + stopLatencyBurnWh;
  const estimatedStopCost = Math.round((estimatedStopWh / 1000) * RATE_PER_KWH);
  const estimatedPlatformLoss = Math.max(0, estimatedStopCost - BALANCE);
  const totalRuntimeMin = Math.ceil((totalIntervals * 60 + 90) / 60);

  console.log("=".repeat(62));
  console.log("  TC-02: 7.4 kW AC — Slow Charger Low Balance Test");
  console.log("=".repeat(62));
  console.log(`  TRANSACTION_ID = ${TRANSACTION_ID}`);
  console.log(`  CONNECTOR_ID   = ${CONNECTOR_ID}`);
  console.log(`  BALANCE        = ${BALANCE.toLocaleString()} LAK`);
  console.log(`  RATE           = ${RATE_PER_KWH.toLocaleString()} LAK/kWh`);
  console.log(`  MIN_RESERVE    = ${MIN_RESERVE.toLocaleString()} LAK`);
  console.log(`  POWER          = ${POWER_KW} kW → ${INTERVAL_WH} Wh per 60s`);
  console.log("-".repeat(62));
  console.log(
    `  [t=${detectionInterval * 60}s / ~${Math.ceil(detectionInterval / 1)} min] MV #${detectionInterval}: Grace period ເລີ່ມ`,
  );
  console.log(
    `  [t=${graceStopInterval * 60 + 5}s] MV #${graceStopInterval}: elapsed ≥ 60s → RemoteStop`,
  );
  console.log(`  Estimated meterStop cost : ~${estimatedStopCost.toLocaleString()} LAK`);
  console.log(
    `  Estimated platform loss  : ~${estimatedPlatformLoss.toLocaleString()} LAK ${estimatedPlatformLoss > 0 ? "❌" : "✅ (ລະບົບ OK)"}`,
  );
  console.log(`  Total runtime            : ~${totalRuntimeMin} ນາທີ`);
  console.log("=".repeat(62));
  console.log(
    `\n⏳ ເລີ່ມ loop — ສົ່ງ MeterValues ທຸກ 60s (${totalIntervals} ຄັ້ງ)\n`,
  );

  for (let i = 1; i <= totalIntervals; i++) {
    await sendMeterValue(i);

    if (i < totalIntervals) {
      // After detection interval, add 5s buffer before next MV
      const waitMs = i === detectionInterval ? INTERVAL_MS + 5_000 : INTERVAL_MS;
      const label = i === detectionInterval ? "⚡ (grace active — ລໍ 65s)" : "";
      console.log(
        `   ⏱  ລໍ ${waitMs / 1000}s → MeterValues #${i + 1}... ${label}`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  // Final wait for StopTransaction response
  console.log(`\n   ⏱  ລໍ 35s ຮອດ VCP ສົ່ງ StopTransaction...`);
  await new Promise((r) => setTimeout(r, 35_000));

  console.log("\n" + "=".repeat(62));
  console.log("✅ TC-02 ສຳເລັດ — ກວດສອບ:");
  console.log("");
  console.log("  DB — session result:");
  console.log(
    "    SELECT meter_stop, energy_kwh, actual_cost, status",
  );
  console.log(
    "    FROM panda_ev_core.charging_sessions ORDER BY created_at DESC LIMIT 1;",
  );
  console.log("");
  console.log("  DB — wallet balance:");
  console.log(
    `    SELECT balance FROM panda_ev_core.wallets WHERE user_id = '<USER_ID>';`,
  );
  console.log("");
  console.log(
    `  Platform loss = (meter_stop / 1000 × ${RATE_PER_KWH}) − actual_cost`,
  );
  console.log(`  ຄາດ: loss ≈ 0 (ລະບົບ 7.4kW ຄວນ ✅)`);
  console.log("=".repeat(62));
})();
