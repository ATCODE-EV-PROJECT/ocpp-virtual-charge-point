/**
 * TC-05: Charger Reconnect After STUCK_AWAITING_REPORT
 *
 * ທົດສອບ: ເມື່ອຫົວສາກ offline ດົນກວ່າ Mobile API's 3-stage grace window
 * (~105–120s: 15s offline-confirm + 90s Mobile grace + up to 15s cron jitter),
 * session ຈະຖືກຍ້າຍໄປ STUCK_AWAITING_REPORT. ເມື່ອຫົວສາກເຊື່ອມຕໍ່ຄືນ (ໂດຍບໍ່ສົ່ງ
 * BootNotification ໃໝ່ — ຄື network blip ແທ້ໆ, ບໍ່ແມ່ນ reboot) ແລະ ຍັງລາຍງານ
 * transactionId ດຽວກັນ, OcppConsumerService.recoverStuckAwaitingReportSession()
 * ຄວນກູ້ຄືນ session ກັບ ACTIVE ໂດຍອັດຕະໂນມັດ.
 *
 * ອ້າງອີງ: docs/2026-09-15/2026-09-15T19:02:42-STUCK_AWAITING_REPORT_Reconnect_Recovery_Fix.md
 * (ບັນຫາຈິງ: session STUCK ຄ້າງ, balance watchdog ຫາຍ, stopSession() 409,
 *  ບໍ່ກູ້ຄືນຈົນກວ່າຫົວສາກຈະສົ່ງ StopTransaction ເອງ)
 *
 * ກ່ອນ run:
 *   1. Start services: panda-ev-ocpp, panda-ev-client-mobile
 *   2. Start VCP: cd ocpp-virtual-charge-point && npm start index_16.ts
 *      (index_16.ts's onReconnect handler deliberately does NOT resend
 *      BootNotification — matches the "network blip, not reboot" scenario)
 *   3. Start ຫຼື qr-start session ຜ່ານ Mobile API, ເອົາ TRANSACTION_ID:
 *      SELECT ocpp_transaction_id, charger_identity, connector_id, status
 *      FROM panda_ev_core.charging_sessions ORDER BY created_at DESC LIMIT 1;
 *
 * ການ run:
 *   TRANSACTION_ID=<n> [CONNECTOR_ID=1] [METER_WH_BASE=1000] [ADMIN_PORT=9999] \
 *     npx tsx admin/v16/TestScenarios/tc05-reconnect-after-stuck-awaiting-report.ts
 *
 * ໃຊ້ເວລາທັງໝົດ ~4-5 ນາທີ.
 */

import * as uuid from "uuid";
import { sendAdminCommand } from "../../admin";

const TRANSACTION_ID = Number.parseInt(process.env.TRANSACTION_ID ?? "0");
const CONNECTOR_ID = Number.parseInt(process.env.CONNECTOR_ID ?? "1");
const METER_WH_BASE = Number.parseInt(process.env.METER_WH_BASE ?? "1000");
const ADMIN_PORT = process.env.ADMIN_PORT ?? "9999";

// Timing — deliberately well past the real STUCK_AWAITING_REPORT threshold:
//   15s   charger.offline confirmed  (OcppGateway.handleDisconnect, ocpp.gateway.ts)
// + 90s   Mobile offline-grace window (OcppConsumerService.handleChargerOffline)
// + ≤15s  cron jitter (ParkingMonitorService.checkChargerOfflineGrace runs every 15s)
// ≈ 105–120s until the session flips to STUCK_AWAITING_REPORT.
// Hold the VCP offline for longer than that before allowing it to reconnect,
// so this test exercises the NEW recovery path — not the older short-grace
// reconnect path (already covered by charger-reconnected-notification.spec.ts).
const OFFLINE_HOLD_MS = 150_000; // 150s — comfortably past the ~105-120s STUCK threshold
const DISCONNECT_POLL_MS = 8_000; // re-terminate the WS every 8s during the hold
const POST_HOLD_RECONNECT_WAIT_MS = 70_000; // VCP backoff caps at 60s — give it margin

if (!TRANSACTION_ID) {
  console.error(
    "❌ TRANSACTION_ID required. Get it from the DB after starting a session:",
  );
  console.error(
    "   SELECT ocpp_transaction_id FROM panda_ev_core.charging_sessions ORDER BY created_at DESC LIMIT 1;",
  );
  process.exit(1);
}

async function forceDisconnect(): Promise<void> {
  await fetch(`http://localhost:${ADMIN_PORT}/disconnect`, {
    method: "POST",
  }).catch(
    () => null, // VCP may be mid-reconnect-backoff with no live socket — /disconnect no-ops, that's fine
  );
}

async function sendMeterValue(meterWh: number, label: string): Promise<void> {
  console.log(
    `\n📡 MeterValues (${label}) — ${meterWh} Wh (${(meterWh / 1000).toFixed(3)} kWh), txId=${TRANSACTION_ID}`,
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
              value: "7000",
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  console.log("=".repeat(70));
  console.log("  TC-05: Charger Reconnect After STUCK_AWAITING_REPORT");
  console.log("=".repeat(70));
  console.log(`  TRANSACTION_ID = ${TRANSACTION_ID}`);
  console.log(`  CONNECTOR_ID   = ${CONNECTOR_ID}`);
  console.log(
    `  OFFLINE_HOLD   = ${OFFLINE_HOLD_MS / 1000}s (STUCK threshold ≈ 105-120s)`,
  );
  console.log("=".repeat(70));

  // Phase 0 — baseline meter reading while still online, so charging:live:*
  // and the session's meterStart are established before we drop the connection.
  await sendMeterValue(METER_WH_BASE, "baseline, still online");

  // Phase 1 — force-drop the WS and keep re-terminating it every
  // DISCONNECT_POLL_MS so VCP's own auto-reconnect (backoff caps at 60s) never
  // gets to stay connected long enough to matter, for the full hold duration.
  console.log(
    `\n🔌 Force-disconnecting VCP, re-terminating every ${DISCONNECT_POLL_MS / 1000}s ` +
      `for ${OFFLINE_HOLD_MS / 1000}s total...`,
  );
  console.log(
    `   ⚠️  ກວດ OCPP logs: "${"{identity}"} disconnected — offline event in 15s" ແລ້ວ Mobile logs: "went offline with active session ... 90s grace period started"`,
  );
  console.log(
    `   ⚠️  ກວດ Mobile logs ຫຼັງປະມານ 105-120s: "no StopTransaction after ... reconnect grace. ` +
      `Session ... held as STUCK_AWAITING_REPORT"`,
  );

  const holdStart = Date.now();
  await forceDisconnect();
  while (Date.now() - holdStart < OFFLINE_HOLD_MS) {
    await sleep(DISCONNECT_POLL_MS);
    await forceDisconnect();
    const elapsed = Math.round((Date.now() - holdStart) / 1000);
    console.log(`   ⏱  t=${elapsed}s — re-terminated WS`);
  }

  // Phase 2 — stop interfering and let VCP's built-in auto-reconnect
  // (exponential backoff, caps at 60s) settle. index_16.ts's onReconnect
  // handler sends StatusNotification only — NOT BootNotification — so OCPP
  // CSMS treats this as a genuine reconnect-without-reboot and fires
  // charger.reconnected (not charger.booted's force-stop path).
  console.log(
    `\n✅ Hold ${OFFLINE_HOLD_MS / 1000}s ຄົບແລ້ວ — ປ່ອຍໃຫ້ VCP auto-reconnect ຕາມປົກກະຕິ ` +
      `(ລໍ ${POST_HOLD_RECONNECT_WAIT_MS / 1000}s)...`,
  );
  await sleep(POST_HOLD_RECONNECT_WAIT_MS);

  // Phase 3 — the charger "resumes normal operation": same transactionId,
  // meter still climbing. This is the "OCPP ມີດາຕ້າໄຫລກັບມາ" moment from the
  // original bug report — the exact trigger recoverStuckAwaitingReportSession()
  // is meant to catch via the charger.reconnected event that should have
  // already fired during Phase 2 (independent of this MeterValues call).
  await sendMeterValue(
    METER_WH_BASE + 300,
    "resumed after reconnect, same txId",
  );

  console.log(`\n${"=".repeat(70)}`);
  console.log("✅ TC-05 script ສຳເລັດ — ກວດສອບຄືນ:");
  console.log("");
  console.log("  1. Mobile API logs ຄວນມີ:");
  console.log(
    `     [StuckRecovery] Charger ... reconnected — session ... (txId=${TRANSACTION_ID}) still live, recovered from STUCK_AWAITING_REPORT back to ACTIVE`,
  );
  console.log("");
  console.log(
    "  2. DB — session ຄວນເປັນ ACTIVE ຄືນ (ບໍ່ແມ່ນ STUCK_AWAITING_REPORT):",
  );
  console.log("     SELECT id, status, offline_held_at, offline_deadline_at");
  console.log(
    "     FROM panda_ev_core.charging_sessions ORDER BY created_at DESC LIMIT 1;",
  );
  console.log(
    "     ຄາດຫວັງ: status = 'ACTIVE', offline_held_at/offline_deadline_at = NULL",
  );
  console.log("");
  console.log("  3. stopSession() ຄວນສຳເລັດປົກກະຕິ (ບໍ່ແມ່ນ 409/503 ອີກຕໍ່ໄປ):");
  console.log(
    "     DELETE /api/mobile/v1/charging-sessions/<SESSION_UUID>  → ຄາດຫວັງ 200",
  );
  console.log("");
  console.log(
    "  4. Balance watchdog resubscribe ແລ້ວ — ສົ່ງ MeterValues ຄັ້ງຕໍ່ໄປ ບໍ່ຄວນ",
  );
  console.log(
    '     ຖືກ log ວ່າ "[BalanceCheck] Session ... is STUCK_AWAITING_REPORT — skipping"',
  );
  console.log("=".repeat(70));
})();
