import * as util from "node:util";
import { WebSocket } from "ws";

import { serve } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { logger } from "./logger";
import { call } from "./messageFactory";
import type { OcppCall, OcppCallError, OcppCallResult } from "./ocppMessage";
import {
  type OcppMessageHandler,
  resolveMessageHandler,
} from "./ocppMessageHandler";
import { ocppOutbox } from "./ocppOutbox";
import { type OcppVersion, toProtocolVersion } from "./ocppVersion";
import {
  validateOcppIncomingRequest,
  validateOcppIncomingResponse,
  validateOcppOutgoingRequest,
  validateOcppOutgoingResponse,
} from "./schemaValidator";
import { TransactionManager } from "./transactionManager";
import { heartbeatOcppMessage } from "./v16/messages/heartbeat";

interface VCPOptions {
  ocppVersion: OcppVersion;
  endpoint: string;
  chargePointId: string;
  basicAuthPassword?: string;
  adminPort?: number;
  reconnect?: boolean;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
}

interface LogEntry {
  type: "Application";
  timestamp: string;
  level: string;
  message: string;
  metadata: Record<string, unknown>;
}

export class VCP {
  private ws?: WebSocket;
  private messageHandler: OcppMessageHandler;

  private isFinishing = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private onReconnect?: () => void;

  transactionManager = new TransactionManager();

  /**
   * Target State-of-Charge (%) at which the VCP stops charging and sends
   * StopTransaction.  Range: 1–100.
   *
   * Set via:
   *   1. Environment variable TARGET_SOC (applied at startup)
   *   2. Admin API  POST http://localhost:<adminPort>/config  { "targetSoc": 90 }
   */
  targetSoc: number = Math.min(
    100,
    Math.max(1, Number.parseInt(process.env.TARGET_SOC ?? "100", 10) || 100),
  );

  /**
   * Offline Charging V2 — bridges `maxEnergyWh` from RemoteStartTransaction
   * (a non-standard extra field the CSMS sends, see remoteStartTransaction.ts)
   * to the StartTransaction resHandler that creates the TransactionManager
   * entry, keyed by connectorId since that's all RemoteStartTransaction has
   * to correlate with — the real transactionId doesn't exist yet at that point.
   * Deliberately NOT sent back out over the wire on StartTransaction itself,
   * to avoid polluting the real OCPP 1.6 payload with a non-spec field.
   */
  private pendingMaxEnergyWh: Map<number, number> = new Map();

  setPendingMaxEnergyWh(connectorId: number, maxEnergyWh: number | undefined) {
    if (maxEnergyWh === undefined) return;
    this.pendingMaxEnergyWh.set(connectorId, maxEnergyWh);
  }

  consumePendingMaxEnergyWh(connectorId: number): number | undefined {
    const value = this.pendingMaxEnergyWh.get(connectorId);
    this.pendingMaxEnergyWh.delete(connectorId);
    return value;
  }

  constructor(private vcpOptions: VCPOptions) {
    this.messageHandler = resolveMessageHandler(vcpOptions.ocppVersion);
    if (vcpOptions.adminPort) {
      const adminApi = new Hono();
      adminApi.get("/health", (c) => c.text("OK"));

      // Forward an OCPP message to the Central System
      adminApi.post(
        "/execute",
        zValidator(
          "json",
          z.object({
            action: z.string(),
            payload: z.any(),
          }),
        ),
        (c) => {
          const validated = c.req.valid("json");
          this.send(call(validated.action, validated.payload));
          return c.text("OK");
        },
      );

      // Change VCP runtime config without restarting
      // Example: POST /config  { "targetSoc": 85 }
      adminApi.post(
        "/config",
        zValidator(
          "json",
          z.object({
            targetSoc: z.number().int().min(1).max(100).optional(),
          }),
        ),
        (c) => {
          const body = c.req.valid("json");
          if (body.targetSoc !== undefined) {
            this.targetSoc = body.targetSoc;
            logger.info(`VCP config updated: targetSoc=${this.targetSoc}%`);
          }
          return c.json({ targetSoc: this.targetSoc });
        },
      );

      // Read current VCP config
      adminApi.get("/config", (c) => {
        return c.json({ targetSoc: this.targetSoc });
      });

      // Force-drop the WebSocket connection (VCP will auto-reconnect if enabled)
      adminApi.post("/disconnect", (c) => {
        if (this.ws) {
          logger.info("Forced disconnect via admin API");
          this.ws.terminate();
        }
        return c.text("OK");
      });

      serve({
        fetch: adminApi.fetch,
        port: vcpOptions.adminPort,
      });
    }
  }

  async connect(): Promise<void> {
    logger.info(`Connecting... | ${util.inspect(this.vcpOptions)}`);
    this.isFinishing = false;
    return new Promise((resolve) => {
      const websocketUrl = `${this.vcpOptions.endpoint}/${this.vcpOptions.chargePointId}`;
      const protocol = toProtocolVersion(this.vcpOptions.ocppVersion);
      this.ws = new WebSocket(websocketUrl, [protocol], {
        rejectUnauthorized: false,
        followRedirects: true,
        headers: {
          ...(this.vcpOptions.basicAuthPassword && {
            Authorization: `Basic ${Buffer.from(
              `${this.vcpOptions.chargePointId}:${this.vcpOptions.basicAuthPassword}`,
            ).toString("base64")}`,
          }),
        },
      });

      this.ws.on("open", () => resolve());
      this.ws.on("message", (message: string) => this._onMessage(message));
      this.ws.on("ping", () => {
        logger.info("Received PING");
      });
      this.ws.on("pong", () => {
        logger.info("Received PONG");
      });
      this.ws.on("close", (code: number, reason: string) =>
        this._onClose(code, reason),
      );
    });
  }

  // biome-ignore lint/suspicious/noExplicitAny: ocpp types
  send(ocppCall: OcppCall<any>) {
    if (!this.ws) {
      throw new Error("Websocket not initialized. Call connect() first");
    }
    ocppOutbox.enqueue(ocppCall);
    const jsonMessage = JSON.stringify([
      2,
      ocppCall.messageId,
      ocppCall.action,
      ocppCall.payload,
    ]);
    logger.info(`Sending message ➡️  ${jsonMessage}`);
    validateOcppOutgoingRequest(
      this.vcpOptions.ocppVersion,
      ocppCall.action,
      JSON.parse(JSON.stringify(ocppCall.payload)),
    );
    this.ws.send(jsonMessage);
  }

  // biome-ignore lint/suspicious/noExplicitAny: ocpp types
  respond(result: OcppCallResult<any>) {
    if (!this.ws) {
      throw new Error("Websocket not initialized. Call connect() first");
    }
    const jsonMessage = JSON.stringify([3, result.messageId, result.payload]);
    logger.info(`Responding with ➡️  ${jsonMessage}`);
    validateOcppIncomingResponse(
      this.vcpOptions.ocppVersion,
      result.action,
      JSON.parse(JSON.stringify(result.payload)),
    );
    this.ws.send(jsonMessage);
  }

  // biome-ignore lint/suspicious/noExplicitAny: ocpp types
  respondError(error: OcppCallError<any>) {
    if (!this.ws) {
      throw new Error("Websocket not initialized. Call connect() first");
    }
    const jsonMessage = JSON.stringify([
      4,
      error.messageId,
      error.errorCode,
      error.errorDescription,
      error.errorDetails,
    ]);
    logger.info(`Responding with ➡️  ${jsonMessage}`);
    this.ws.send(jsonMessage);
  }

  configureHeartbeat(interval: number) {
    setInterval(() => {
      this.send(heartbeatOcppMessage.request({}));
    }, interval);
  }

  /**
   * Register a callback invoked after every successful reconnect.
   * Use it to re-send BootNotification + StatusNotification, exactly like
   * the initial connect flow in your entry point.
   */
  setOnReconnect(fn: () => void) {
    this.onReconnect = fn;
  }

  close() {
    if (!this.ws) {
      throw new Error(
        "Trying to close a Websocket that was not opened. Call connect() first",
      );
    }
    this.isFinishing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.ws.close();
    this.ws = undefined;
    process.exit(1);
  }

  async getDiagnosticData(): Promise<LogEntry[]> {
    try {
      // Get logs from Winston logger's memory
      const transport = logger.transports[0];

      // Create a promise that resolves with collected logs
      const logStream = new Promise<LogEntry[]>((resolve) => {
        const entries: LogEntry[] = [];

        // Listen for new logs
        transport.on(
          "logged",
          (info: {
            timestamp: string;
            level: string;
            message: string;
            [key: string]: unknown;
          }) => {
            entries.push({
              type: "Application",
              timestamp: info.timestamp || new Date().toISOString(),
              level: info.level,
              message: info.message,
              metadata: Object.fromEntries(
                Object.entries(info).filter(
                  ([key]) => !["timestamp", "level", "message"].includes(key),
                ),
              ),
            });
          },
        );

        // Resolve after a short delay to collect recent logs
        setTimeout(() => resolve(entries), 10000);
      });

      return await logStream;
    } catch (err) {
      logger.error("Failed to read application logs:", err);
      return [];
    }
  }

  private _onMessage(message: string) {
    logger.info(`Receive message ⬅️  ${message}`);
    const data = JSON.parse(message);
    const [type, ...rest] = data;
    if (type === 2) {
      const [messageId, action, payload] = rest;
      validateOcppIncomingRequest(this.vcpOptions.ocppVersion, action, payload);
      this.messageHandler.handleCall(this, { messageId, action, payload });
    } else if (type === 3) {
      const [messageId, payload] = rest;
      const enqueuedCall = ocppOutbox.get(messageId);
      if (!enqueuedCall) {
        throw new Error(
          `Received CallResult for unknown messageId=${messageId}`,
        );
      }
      validateOcppOutgoingResponse(
        this.vcpOptions.ocppVersion,
        enqueuedCall.action,
        payload,
      );
      this.messageHandler.handleCallResult(this, enqueuedCall, {
        messageId,
        payload,
        action: enqueuedCall.action,
      });
    } else if (type === 4) {
      const [messageId, errorCode, errorDescription, errorDetails] = rest;
      this.messageHandler.handleCallError(this, {
        messageId,
        errorCode,
        errorDescription,
        errorDetails,
      });
    } else {
      throw new Error(`Unrecognized message type ${type}`);
    }
  }

  private _onClose(code: number, reason: string) {
    if (this.isFinishing) {
      return;
    }
    logger.info(`Connection closed. code=${code}, reason=${reason}`);

    if (!this.vcpOptions.reconnect) {
      process.exit();
    }

    const baseDelay = this.vcpOptions.reconnectBaseDelayMs ?? 2000;
    const maxDelay = this.vcpOptions.reconnectMaxDelayMs ?? 60000;
    // exponential backoff with jitter: delay = min(base * 2^attempt, max) ± 20%
    const exp = Math.min(baseDelay * 2 ** this.reconnectAttempt, maxDelay);
    const jitter = exp * 0.2 * (Math.random() * 2 - 1);
    const delay = Math.round(exp + jitter);
    this.reconnectAttempt += 1;

    logger.info(
      `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})...`,
    );
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        this.reconnectAttempt = 0;
        logger.info("Reconnected successfully");
        this.onReconnect?.();
      } catch (err) {
        logger.error(`Reconnect failed: ${err}`);
      }
    }, delay);
  }
}
