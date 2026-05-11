require("dotenv").config();

import * as fs from "fs";
import * as path from "path";
import { OcppVersion } from "./src/ocppVersion";
import { bootNotificationOcppMessage } from "./src/v16/messages/bootNotification";
import { statusNotificationOcppMessage } from "./src/v16/messages/statusNotification";
import { VCP } from "./src/vcp";

/**
 * Reads chargers from a CSV file and spins up a VCP for each one.
 * Uses the ocpp_identity column as the chargePointId.
 * Usage: npm start index_16_from_csv.ts
 * Optional env:
 *   CSV_PATH          (default: tohsamples/chargers.csv)
 *   CONNECTORS_PATH   (default: tohsamples/connectors.csv if it exists)
 *   ACTIVE_ONLY       (default: true)
 */

const csvPath = process.env.CSV_PATH ?? path.join(__dirname, "tohsamples/chargers.csv");
const connectorsPath =
  process.env.CONNECTORS_PATH ?? path.join(__dirname, "tohsamples/connectors.csv");
const activeOnly = (process.env.ACTIVE_ONLY ?? "true") !== "false";

function parseCSV(filePath: string): Record<string, string>[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n");
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    return Object.fromEntries(headers.map((h, i) => [h, (values[i] ?? "").trim()]));
  });
}

type OcppConnectorStatus =
  | "Available"
  | "Preparing"
  | "Charging"
  | "SuspendedEVSE"
  | "SuspendedEV"
  | "Finishing"
  | "Reserved"
  | "Unavailable"
  | "Faulted";

function mapChargerStatus(csvStatus: string): OcppConnectorStatus {
  switch (csvStatus) {
    case "ONLINE":
      return "Available";
    case "OFFLINE":
      return "Unavailable";
    case "MAINTENANCE":
      return "Faulted";
    case "COMING_SOON":
      return "Unavailable";
    default:
      return "Available";
  }
}

function mapConnectorStatus(csvStatus: string): OcppConnectorStatus {
  switch (csvStatus) {
    case "AVAILABLE":
      return "Available";
    case "UNAVAILABLE":
      return "Unavailable";
    case "CHARGING":
      return "Charging";
    case "FAULTED":
      return "Faulted";
    case "RESERVED":
      return "Reserved";
    default:
      return "Available";
  }
}

// Build a lookup: charger_id → sorted list of { connectorId, status }
function buildConnectorMap(
  filePath: string,
): Map<string, Array<{ connectorId: number; status: OcppConnectorStatus }>> {
  const map = new Map<string, Array<{ connectorId: number; status: OcppConnectorStatus }>>();
  if (!fs.existsSync(filePath)) return map;
  const rows = parseCSV(filePath);
  for (const row of rows) {
    if (row.is_active === "false") continue;
    const chargerId = row.charger_id;
    if (!chargerId) continue;
    if (!map.has(chargerId)) map.set(chargerId, []);
    map.get(chargerId)!.push({
      connectorId: Number.parseInt(row.connector_id),
      status: mapConnectorStatus(row.status),
    });
  }
  // sort by connector_id ascending
  for (const connectors of map.values()) {
    connectors.sort((a, b) => a.connectorId - b.connectorId);
  }
  return map;
}

(async () => {
  const chargers = parseCSV(csvPath);
  const filtered = activeOnly ? chargers.filter((c) => c.is_active === "true") : chargers;
  const connectorMap = buildConnectorMap(connectorsPath);

  const hasConnectors = connectorMap.size > 0;
  console.log(`Loaded ${filtered.length} chargers from ${csvPath}`);
  if (hasConnectors) {
    console.log(`Loaded connector data from ${connectorsPath}`);
  }

  for (const charger of filtered) {
    const ocppIdentity = charger.ocpp_identity;
    if (!ocppIdentity) continue;

    const vcp = new VCP({
      endpoint: process.env.WS_URL ?? "ws://localhost:3000",
      chargePointId: ocppIdentity,
      ocppVersion: OcppVersion.OCPP_1_6,
      basicAuthPassword: process.env.PASSWORD ?? undefined,
      reconnect: true,
    });

    const connectors = connectorMap.get(charger.id);

    function announce() {
      vcp.send(
        bootNotificationOcppMessage.request({
          chargePointVendor: "PandaEV",
          chargePointModel: "VirtualChargePoint",
          firmwareVersion: charger.firmware_version || "1.0.0",
        }),
      );

      if (connectors && connectors.length > 0) {
        for (const connector of connectors) {
          vcp.send(
            statusNotificationOcppMessage.request({
              connectorId: connector.connectorId,
              errorCode: "NoError",
              status: connector.status,
            }),
          );
        }
      } else {
        vcp.send(
          statusNotificationOcppMessage.request({
            connectorId: 1,
            errorCode: "NoError",
            status: mapChargerStatus(charger.status),
          }),
        );
      }
    }

    vcp.setOnReconnect(announce);
    vcp.connect().then(announce);

    await new Promise((r) => setTimeout(r, 100));
  }
})();
