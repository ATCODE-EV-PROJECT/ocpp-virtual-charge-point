require("dotenv").config();

import { OcppVersion } from "./src/ocppVersion";
import { bootNotificationOcppMessage } from "./src/v16/messages/bootNotification";
import { statusNotificationOcppMessage } from "./src/v16/messages/statusNotification";
import { VCP } from "./src/vcp";

const vcp = new VCP({
  endpoint: process.env.WS_URL ?? "ws://localhost:3000",
  chargePointId: process.env.CP_ID ?? "123456",
  ocppVersion: OcppVersion.OCPP_1_6,
  basicAuthPassword: process.env.PASSWORD ?? undefined,
  adminPort: Number.parseInt(process.env.ADMIN_PORT ?? "9999"),
  reconnect: true,
  // Override to widen the reconnect gap for NOT_BOOTED reproduction testing
  // (CSMS's offline-notify/bootedIdentities-preserve window is 15s).
  reconnectBaseDelayMs: process.env.RECONNECT_BASE_DELAY_MS
    ? Number.parseInt(process.env.RECONNECT_BASE_DELAY_MS)
    : undefined,
  reconnectMaxDelayMs: process.env.RECONNECT_MAX_DELAY_MS
    ? Number.parseInt(process.env.RECONNECT_MAX_DELAY_MS)
    : undefined,
});

/**
 * Full boot sequence — sent once on initial startup.
 * BootNotification tells the CSMS the charger (re)booted its firmware.
 * The CSMS will force-stop any open transactions on BootNotification.
 */
function announce() {
  vcp.send(
    bootNotificationOcppMessage.request({
      chargePointVendor: "Solidstudio",
      chargePointModel: "VirtualChargePoint",
      chargePointSerialNumber: "S001",
      firmwareVersion: "1.0.0",
    }),
  );
  vcp.send(
    statusNotificationOcppMessage.request({
      connectorId: 1,
      errorCode: "NoError",
      status: "Available",
    }),
  );
}

/**
 * WebSocket-reconnect announce — sent when the WS drops and auto-reconnects
 * WITHOUT a firmware reboot (e.g. network blip, brief connectivity loss).
 * Does NOT send BootNotification so the CSMS does NOT force-stop open sessions.
 * The 90-second force-stop timer in the CSMS is already cancelled by the
 * reconnect, so an active session will continue as-is.
 *
 * SCENARIO 10: use the admin POST /disconnect endpoint to simulate a brief
 * WS drop — VCP auto-reconnects and only re-announces connector status.
 *
 * Genuine reboot (Reset(Hard) from CSMS, or vcp.simulateReboot()) sets
 * vcp.rebootPending — that case falls through to announce() below, sending
 * a fresh BootNotification, same as restarting the VCP process would.
 */
function announceOnReconnect() {
  if (vcp.rebootPending) {
    vcp.rebootPending = false;
    announce();
    return;
  }
  vcp.send(
    statusNotificationOcppMessage.request({
      connectorId: 1,
      errorCode: "NoError",
      status: "Available",
    }),
  );
}

vcp.setOnReconnect(announceOnReconnect);

(async () => {
  await vcp.connect();
  announce();
})();
