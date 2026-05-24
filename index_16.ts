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
 * To simulate a full charger reboot (force-stop sessions), restart the
 * VCP process (Ctrl-C + npm start), which sends a fresh BootNotification.
 */
function announceOnReconnect() {
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
