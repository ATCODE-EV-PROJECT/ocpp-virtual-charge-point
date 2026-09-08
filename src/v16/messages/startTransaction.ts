import { z } from "zod";
import { logger } from "../../logger";
import {
  type OcppCall,
  type OcppCallResult,
  OcppOutgoing,
} from "../../ocppMessage";
import { vcpTimestamp } from "../../utils";
import type { VCP } from "../../vcp";
import { ConnectorIdSchema, IdTagInfoSchema, IdTokenSchema } from "./_common";
import { meterValuesOcppMessage } from "./meterValues";
import { statusNotificationOcppMessage } from "./statusNotification";
import { stopTransactionOcppMessage } from "./stopTransaction";

const StartTransactionReqSchema = z.object({
  connectorId: ConnectorIdSchema,
  idTag: IdTokenSchema,
  meterStart: z.number().int(),
  reservationId: z.number().int().nullish(),
  timestamp: z.string().datetime(),
});
type StartTransactionReqType = typeof StartTransactionReqSchema;

const StartTransactionResSchema = z.object({
  idTagInfo: IdTagInfoSchema,
  transactionId: z.number().int(),
});
type StartTransactionResType = typeof StartTransactionResSchema;

class StartTransactionOcppMessage extends OcppOutgoing<
  StartTransactionReqType,
  StartTransactionResType
> {
  resHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<StartTransactionReqType>>,
    result: OcppCallResult<z.infer<StartTransactionResType>>,
  ): Promise<void> => {
    const maxEnergyWh = vcp.consumePendingMaxEnergyWh(call.payload.connectorId);
    if (maxEnergyWh !== undefined) {
      logger.info(
        `Offline local-control ceiling active: maxEnergyWh=${maxEnergyWh} Wh for connector ${call.payload.connectorId} — VCP will self-stop if this is reached before a RemoteStop/StopTransaction`,
      );
    }
    vcp.transactionManager.startTransaction(vcp, {
      transactionId: result.payload.transactionId,
      idTag: call.payload.idTag,
      connectorId: call.payload.connectorId,
      maxEnergyWh,
      meterValuesCallback: async (transactionState) => {
        const elapsedMinutes =
          (Date.now() - transactionState.startedAt.getTime()) / 60000;
        // SoC rises from 80 % at 0.5 %/min, capped at vcp.targetSoc.
        // Default targetSoc=100; set via env TARGET_SOC or admin POST /config.
        // Examples: targetSoc=90 → stops at 90 % (~20 min); targetSoc=80 → stops immediately.
        const soc = Math.min(
          vcp.targetSoc,
          Math.round(80 + elapsedMinutes * 0.5),
        );
        vcp.send(
          meterValuesOcppMessage.request({
            connectorId: call.payload.connectorId,
            transactionId: result.payload.transactionId,
            meterValue: [
              {
                timestamp: vcpTimestamp(),
                sampledValue: [
                  {
                    value: (transactionState.meterValue / 1000).toString(),
                    measurand: "Energy.Active.Import.Register",
                    unit: "kWh",
                  },
                  {
                    value: "220.0",
                    measurand: "Voltage",
                    unit: "V",
                  },
                  {
                    value: "16.0",
                    measurand: "Current.Import",
                    unit: "A",
                  },
                  {
                    value: "6500.0",
                    measurand: "Power.Active.Import",
                    unit: "W",
                  },
                  {
                    value: soc.toString(),
                    measurand: "SoC",
                    unit: "Percent",
                    location: "EV",
                  },
                ],
              },
            ],
          }),
        );

        // Offline Charging V2 — the charger's own firmware enforces
        // maxEnergyWh locally and self-stops if the CSMS never reconnects to
        // send RemoteStopTransaction. reason="Local" matches what real V3.6
        // firmware reports for this case (see admin/v16/Transaction/stopTransaction.ts).
        // Checked ahead of the SoC/targetSoc stop below since it's the safety
        // ceiling — it can trip before or after the SoC target depending on
        // which limit the test scenario is exercising.
        if (
          transactionState.maxEnergyWh !== undefined &&
          transactionState.meterValue >= transactionState.maxEnergyWh
        ) {
          vcp.transactionManager.stopTransaction(result.payload.transactionId);
          vcp.send(
            stopTransactionOcppMessage.request({
              transactionId: result.payload.transactionId,
              meterStop: Math.round(transactionState.meterValue),
              reason: "Local",
              timestamp: vcpTimestamp(),
            }),
          );
          vcp.send(
            statusNotificationOcppMessage.request({
              connectorId: call.payload.connectorId,
              errorCode: "NoError",
              status: "Available",
            }),
          );
          return;
        }

        // When battery is full (SoC 100 %), send StopTransaction so OCPP can
        // finalise the session and publish transaction.stopped for billing.
        // stopTransaction() clears the meter-values interval first to prevent
        // a duplicate StopTransaction on the next tick.
        //
        // Sequence after battery full:
        //  1. StopTransaction  — billing finalised by server
        //  2. SuspendedEV      — cable still connected; server starts parking timer
        //  3. Available (30 s) — simulates user unplugging; server charges parking fee
        if (soc >= vcp.targetSoc) {
          vcp.transactionManager.stopTransaction(result.payload.transactionId);
          vcp.send(
            stopTransactionOcppMessage.request({
              transactionId: result.payload.transactionId,
              meterStop: Math.round(transactionState.meterValue),
              reason: "EVDisconnected",
              timestamp: vcpTimestamp(),
            }),
          );
          // SuspendedEV — cable is still plugged in after battery full
          vcp.send(
            statusNotificationOcppMessage.request({
              connectorId: call.payload.connectorId,
              errorCode: "NoError",
              status: "SuspendedEV",
            }),
          );
          // Simulate car unplug after 30 seconds so parking fee window is testable
          setTimeout(() => {
            vcp.send(
              statusNotificationOcppMessage.request({
                connectorId: call.payload.connectorId,
                errorCode: "NoError",
                status: "Available",
              }),
            );
          }, 30_000);
        }
      },
    });
    if (result.payload.idTagInfo.status !== "Accepted") {
      vcp.send(
        stopTransactionOcppMessage.request({
          transactionId: result.payload.transactionId,
          meterStop: 0,
          reason: "DeAuthorized",
          timestamp: vcpTimestamp(),
        }),
      );
      vcp.send(
        statusNotificationOcppMessage.request({
          connectorId: call.payload.connectorId,
          errorCode: "NoError",
          status: "Available",
        }),
      );
      return;
    }
  };
}

export const startTransactionOcppMessage = new StartTransactionOcppMessage(
  "StartTransaction",
  StartTransactionReqSchema,
  StartTransactionResSchema,
);
