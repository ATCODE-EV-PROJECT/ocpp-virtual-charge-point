import { z } from "zod";
import { type OcppCall, OcppIncoming } from "../../ocppMessage";
import { vcpTimestamp } from "../../utils";
import type { VCP } from "../../vcp";
import {
  ChargingProfileSchema,
  ConnectorIdSchema,
  IdTokenSchema,
} from "./_common";
import { startTransactionOcppMessage } from "./startTransaction";
import { statusNotificationOcppMessage } from "./statusNotification";

const RemoteStartTransactionReqSchema = z.object({
  connectorId: ConnectorIdSchema.nullish(),
  idTag: IdTokenSchema,
  chargingProfile: ChargingProfileSchema.nullish(),
  // Not part of OCPP 1.6J — Offline Charging V2 sends this as an extra field
  // (see offline-panda-ev-ocpp/ocpp.gateway.ts sendRemoteStart). Declared here
  // so schema validation doesn't warn on it; ignored by real chargers.
  maxEnergyWh: z.number().int().positive().nullish(),
});
type RemoteStartTransactionReqType = typeof RemoteStartTransactionReqSchema;

const RemoteStartTransactionResSchema = z.object({
  status: z.enum(["Accepted", "Rejected"]),
});
type RemoteStartTransactionResType = typeof RemoteStartTransactionResSchema;

class RemoteStartTransactionOcppMessage extends OcppIncoming<
  RemoteStartTransactionReqType,
  RemoteStartTransactionResType
> {
  reqHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<RemoteStartTransactionReqType>>,
  ): Promise<void> => {
    if (!call.payload.connectorId) {
      vcp.respond(this.response(call, { status: "Rejected" }));
      return;
    }
    if (
      !vcp.transactionManager.canStartNewTransaction(call.payload.connectorId)
    ) {
      vcp.respond(this.response(call, { status: "Rejected" }));
      return;
    }
    vcp.respond(this.response(call, { status: "Accepted" }));
    vcp.setPendingMaxEnergyWh(
      call.payload.connectorId,
      call.payload.maxEnergyWh ?? undefined,
    );
    vcp.send(
      startTransactionOcppMessage.request({
        connectorId: call.payload.connectorId,
        idTag: call.payload.idTag,
        meterStart: 0,
        timestamp: vcpTimestamp(),
      }),
    );
    vcp.send(
      statusNotificationOcppMessage.request({
        connectorId: call.payload.connectorId,
        errorCode: "NoError",
        status: "Charging",
      }),
    );
  };
}

export const remoteStartTransactionOcppMessage =
  new RemoteStartTransactionOcppMessage(
    "RemoteStartTransaction",
    RemoteStartTransactionReqSchema,
    RemoteStartTransactionResSchema,
  );
