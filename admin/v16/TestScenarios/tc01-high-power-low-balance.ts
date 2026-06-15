/**
 * TC-01 / TC-03 / TC-04: 120 kW DC — Balance Overshoot Test
 *
 * ທົດສອບ: ລະບົບ stop session ໄດ້ທັນ ຫຼື ບໍ່ ເມື່ອ balance ໜ້ອຍ @ high power
 *
 * ການ run:
 *   TRANSACTION_ID=<n> [BALANCE=30000] [RATE=5000] [MIN_RESERVE=15000] [CONNECTOR_ID=1] \
 *   npx tsx admin/v16/TestScenarios/tc01-high-power-low-balance.ts
 *
 * Scenarios (ເປີ່ຍນ BALANCE ເທົ່ານັ້ນ):
 *   BALANCE=30000 → TC-01 (mid balance, ຄາດ platform loss ~5,000 LAK)
 *   BALANCE=16000 → TC-03 (edge case — grace ທັນທີ MV#1, ຄາດ loss ~7,000 LAK)
 *   BALANCE=50000 → TC-04 (sufficient — detect ຊ້າ, ຄາດ loss ໜ້ອຍ)
 *
 * ກ່ອນ run:
 *   1. ຕັ້ງ wallet balance ຜ່ານ SQL:
 *      UPDATE panda_ev_core.wallets SET balance = <BALANCE> WHERE user_id = '<USER_ID>';
 *   2. Start session ຜ່ານ mobile API (QR ຫຼື regular)
 *   3. ເອົາ TRANSACTION_ID ຈາກ OCPP logs ຫຼື DB:
 *      SELECT ocpp_transaction_id FROM panda_ev_core.charging_sessions ORDER BY created_at DESC LIMIT 1;
 */

import * as uuid from "uuid";
import { sendAdminCommand } from "../../admin";

const TRANSACTION_ID = Number.parseInt(process.env.TRANSACTION_ID ?? "0");
const RATE_PER_KWH = Number.parseInt(process.env.RATE ?? "5000"); // LAK/kWh
const BALANCE = Number.parseInt(process.env.BALANCE ?? "30000"); // LAK
const MIN_RESERVE = Number.parseInt(process.env.MIN_RESERVE ?? "15000"); // LAK
const CONNECTOR_ID = Number.parseInt(process.env.CONNECTOR_ID ?? "1");

const POWER_KW = 120;
const INTERVAL_WH = Math.round(POWER_KW * 1000 * (60 / 3600)); // 2000 Wh per 60s
const INTERVAL_MS = 60_000;

if (!TRANSACTION_ID) {
  console.error("❌ TRANSACTION_ID required. Get it from OCPP logs after session start.");
  console.error(
    "   SELECT ocpp_transaction_id FROM panda_ev_core.charging_sessions ORDER BY created_at DESC LIMIT 1;",
  );
  process.exit(1);
}

// Detect which interval grace starts:
// grace when BALANCE <= cost + MIN_RESERVE → cost >= BALANCE - MIN_RESERVE
const detectionCostLak = BALANCE - MIN_RESERVE;
const detectionInterval = Math.max(
  1,
  Math.ceil(detectionCostLak / (RATE_PER_KWH * (INTERVAL_WH / 1000))),
);
const graceStopInterval = detectionInterval + 1;

async function sendMeterValue(intervalNum: number): Promise<void> {
  const meterWh = intervalNum * INTERVAL_WH;
  const costLak = Math.round((meterWh / 1000) * RATE_PER_KWH);
  const threshold = costLak + MIN_RESERVE;
  const pass = BALANCE > threshold;

  console.log(`\n📡 MeterValues #${intervalNum} — t=${intervalNum * 60}s`);
  console.log(`   Energy : ${meterWh} Wh (${(meterWh / 1000).toFixed(2)} kWh)`);
  console.log(`   Power  : ${POWER_KW} kW = ${POWER_KW * 1000} W`);
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
              value: String(POWER_KW * 1000),
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
  // Estimate: charger stops ~30s after RemoteStop → overshoot kWh
  const overshootWh =
    graceStopInterval * INTERVAL_WH + Math.round(POWER_KW * 1000 * (30 / 3600));
  const overshootCost = Math.round((overshootWh / 1000) * RATE_PER_KWH);
  const estimatedPlatformLoss = Math.max(0, overshootCost - BALANCE);

  console.log("=".repeat(62));
  console.log("  TC-01 / TC-03 / TC-04: 120 kW DC — Balance Overshoot Test");
  console.log("=".repeat(62));
  console.log(`  TRANSACTION_ID = ${TRANSACTION_ID}`);
  console.log(`  CONNECTOR_ID   = ${CONNECTOR_ID}`);
  console.log(`  BALANCE        = ${BALANCE.toLocaleString()} LAK`);
  console.log(`  RATE           = ${RATE_PER_KWH.toLocaleString()} LAK/kWh`);
  console.log(`  MIN_RESERVE    = ${MIN_RESERVE.toLocaleString()} LAK`);
  console.log(`  POWER          = ${POWER_KW} kW → ${INTERVAL_WH} Wh per 60s`);
  console.log("-".repeat(62));
  console.log(
    `  [t=${detectionInterval * 60}s] MV #${detectionInterval}: Grace period ເລີ່ມ`,
  );
  console.log(
    `  [t=${graceStopInterval * 60 + 5}s] MV #${graceStopInterval}: elapsed ≥ 60s → RemoteStop`,
  );
  console.log(`  [t=${graceStopInterval * 60 + 35}s] ຄາດ StopTransaction`);
  console.log(`  Estimated meterStop cost : ~${overshootCost.toLocaleString()} LAK`);
  console.log(
    `  Estimated platform loss  : ~${estimatedPlatformLoss.toLocaleString()} LAK ${estimatedPlatformLoss > 0 ? "❌" : "✅"}`,
  );
  console.log("=".repeat(62));
  console.log(
    `\n⚠️  ກວດ Mobile API logs: 'grace period started' ແລະ 'sending auto-stop'\n`,
  );

  for (let i = 1; i <= graceStopInterval; i++) {
    await sendMeterValue(i);

    if (i < graceStopInterval) {
      // After grace starts, wait 65s (5s buffer) so elapsed ≥ GRACE_PERIOD (60s)
      const waitMs = i === detectionInterval ? INTERVAL_MS + 5_000 : INTERVAL_MS;
      console.log(
        `   ⏱  ລໍ ${waitMs / 1000}s → MeterValues #${i + 1}...`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  // Wait for VCP to receive RemoteStop and send StopTransaction
  console.log(`\n   ⏱  ລໍ 35s ຮອດ VCP ຮັບ RemoteStop ແລະ ສົ່ງ StopTransaction...`);
  await new Promise((r) => setTimeout(r, 35_000));

  console.log("\n" + "=".repeat(62));
  console.log("✅ TC-01 ສຳເລັດ — ກວດສອບ:");
  console.log("");
  console.log("  Redis:");
  console.log("    redis-cli GET 'charging:grace_start:<SESSION_UUID>'");
  console.log("    redis-cli GET 'charging:balance_stop:<SESSION_UUID>'");
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
  console.log("=".repeat(62));
})();
