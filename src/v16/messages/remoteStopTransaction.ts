import { z } from "zod";
import { generateOCMF, getOCMFPublicKey } from "../../ocmfGenerator";
import { type OcppCall, OcppIncoming } from "../../ocppMessage";
import { vcpTimestamp } from "../../utils";
import type { VCP } from "../../vcp";
import { statusNotificationOcppMessage } from "./statusNotification";
import { stopTransactionOcppMessage } from "./stopTransaction";

const RemoteStopTransactionReqSchema = z.object({
  transactionId: z.number().int(),
});
type RemoteStopTransactionReqType = typeof RemoteStopTransactionReqSchema;

const RemoteStopTransactionResSchema = z.object({
  status: z.enum(["Accepted", "Rejected"]),
});
type RemoteStopTransactionResType = typeof RemoteStopTransactionResSchema;

class RemoteStopTransactionOcppMessage extends OcppIncoming<
  RemoteStopTransactionReqType,
  RemoteStopTransactionResType
> {
  reqHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<RemoteStopTransactionReqType>>,
  ): Promise<void> => {
    const transactionId = call.payload.transactionId;
    const transaction = vcp.transactionManager.transactions.get(transactionId);
    if (!transaction) {
      vcp.respond(this.response(call, { status: "Rejected" }));
      return;
    }
    vcp.respond(this.response(call, { status: "Accepted" }));

    // Capture meter value BEFORE stopTransaction() — it deletes the transaction
    // from the map, causing getMeterValue() to return 0 afterwards.
    const meterStop = Math.floor(
      vcp.transactionManager.getMeterValue(transactionId),
    );

    const ocmf = generateOCMF({
      startTime: transaction.startedAt,
      startEnergy: 0,
      endTime: new Date(),
      endEnergy: meterStop / 1000,
      idTag: transaction.idTag,
    });

    // Stop the meter-values interval so no further MeterValues fire after stop
    vcp.transactionManager.stopTransaction(transactionId);

    vcp.send(
      stopTransactionOcppMessage.request({
        transactionId: transactionId,
        meterStop,
        timestamp: vcpTimestamp(),
        transactionData: [
          {
            timestamp: vcpTimestamp(),
            sampledValue: [
              {
                value: JSON.stringify({
                  signedMeterData: Buffer.from(ocmf).toString("base64"),
                  encodingMethod: "OCMF",
                  publicKey: getOCMFPublicKey().toString("base64"),
                }),
                format: "SignedData",
                context: "Transaction.End",
              },
            ],
          },
        ],
      }),
    );

    // SuspendedEV — cable still connected after remote stop.
    // Allows the server to start the parking timer and push an idle warning to
    // the App. Available is sent after 30 s to simulate the user unplugging,
    // which triggers the actual parking fee deduction on the server side.
    vcp.send(
      statusNotificationOcppMessage.request({
        connectorId: transaction.connectorId,
        errorCode: "NoError",
        status: "SuspendedEV",
      }),
    );
    setTimeout(() => {
      vcp.send(
        statusNotificationOcppMessage.request({
          connectorId: transaction.connectorId,
          errorCode: "NoError",
          status: "Available",
        }),
      );
    }, 30_000);
  };
}

export const remoteStopTransactionOcppMessage =
  new RemoteStopTransactionOcppMessage(
    "RemoteStopTransaction",
    RemoteStopTransactionReqSchema,
    RemoteStopTransactionResSchema,
  );
