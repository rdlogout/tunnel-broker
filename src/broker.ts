import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import crypto from "crypto";
import { URL } from "url";
import type { Request, Response } from "express";

// Mirror of Cloudflare DO-based TunnelBroker adapted for Node.js + Express + ws
// Preserves message formats and routing semantics from working.ts

const WS_READY_STATE_OPEN = WebSocket.OPEN;

interface ProxyRequest {
  type: "request";
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: number[]; // Uint8Array as number array when small
  fetch_body?: boolean; // Signal for host to fetch body via /__request?id=
}

interface ProxyResponse {
  type: "response";
  id: string;
  status: number;
  headers: Record<string, string>;
  body: number[]; // Uint8Array serialized as number[]
}

interface StoredRequest {
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: number[]; // original request body
  timestamp: number;
  res: Response;
  timeout: NodeJS.Timeout;
}

interface Attachment {
  type: "host" | "client";
  id?: string;
  path?: string;
}

export class TunnelBroker {
  private hostConnection: WebSocket | null = null;
  private readonly RESPONSE_TIMEOUT = 45 * 1000; // keep parity with working.ts
  private readonly MAX_BODY_SIZE = 512 * 1024; // 512KB
  private pendingRequests = new Map<string, StoredRequest>();
  private clientSockets: Map<string, WebSocket> = new Map();
  private readonly MAX_CONCURRENT_CLIENTS = 500;
  private lastHostActivity = Date.now();
  private readonly CONNECTION_CHECK_INTERVAL = 50 * 1000;
  private connectionCheckInterval: NodeJS.Timeout | null = null;

  // Track attachments for ws objects
  private attachments = new WeakMap<WebSocket, Attachment>();

  constructor() {
    this.startConnectionMonitoring();
  }

  // Express HTTP handler for general proxy requests
  async handleHttpProxy(req: Request, res: Response) {
    if (!this.hostConnection || this.hostConnection.readyState !== WS_READY_STATE_OPEN) {
      res.status(503).send("No host connected");
      return;
    }

    try {
      const id = crypto.randomUUID();
      const url = new URL(req.url, `${req.protocol}://${req.headers.host}`);

      // Normalize headers to string map
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) headers[key] = value.join(", ");
        else if (typeof value === "string") headers[key] = value;
      }

      const bodyChunks: Buffer[] = [];
      let bodyLength = 0;

      const readBody = await new Promise<Buffer>((resolve, reject) => {
        req.on("data", (chunk: Buffer) => {
          bodyChunks.push(chunk);
          bodyLength += chunk.length;
        });
        req.on("end", () => resolve(Buffer.concat(bodyChunks)));
        req.on("error", (err) => reject(err));
      });

      let bodyArray: number[] = Array.from(readBody);
      let originalBodyArray = bodyArray;
      let fetchBody = false;
      let maxTimeout = this.RESPONSE_TIMEOUT;
      if (readBody.length > this.MAX_BODY_SIZE) {
        const mb = Math.ceil(readBody.length / 1024 / 1024);
        maxTimeout = 30 * 1000 * mb; // allow more time per MB
        fetchBody = true;
        bodyArray = []; // do not send large body
      }

      const proxyRequest: ProxyRequest = {
        type: "request",
        id,
        method: req.method,
        path: url.pathname + (url.search || ""),
        headers,
        body: fetchBody ? undefined : bodyArray,
        fetch_body: fetchBody,
      };

      // Set up timeout and store response binding
      const timeout = setTimeout(() => {
        const stored = this.pendingRequests.get(id);
        if (stored) {
          this.pendingRequests.delete(id);
          try { stored.res.status(504).send("Request timeout"); } catch {}
        }
      }, maxTimeout);

      this.pendingRequests.set(id, {
        id,
        method: req.method,
        path: url.pathname + (url.search || ""),
        headers,
        body: originalBodyArray,
        timestamp: Date.now(),
        res,
        timeout,
      });

      // Send to host
      try {
        this.hostConnection!.send(JSON.stringify(proxyRequest));
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        res.status(502).send("Host connection lost");
        return;
      }
    } catch (err) {
      res.status(502).send("Proxy Error");
    }
  }

  // Express handler for completion of large responses
  async handleCompletion(req: Request, res: Response) {
    const id = (req.query["id"] as string) || req.headers["x-request-id"]?.toString();
    if (!id || !this.pendingRequests.has(id)) {
      res.status(404).send("Request not found");
      return;
    }

    const stored = this.pendingRequests.get(id)!;

    try {
      const responseStatus = parseInt((req.headers["x-response-status"] as string) || "200", 10);
      const headersRaw = (req.headers["x-response-headers"] as string) || "{}";
      let headers: Record<string, string>;
      try { headers = JSON.parse(headersRaw); } catch { headers = {}; }

      const body = await this.collectRawBody(req);

      // Write response to original client
      for (const [k, v] of Object.entries(headers as Record<string, string>)) {
        try {
          (stored.res as any).set(k, v);
        } catch {}
      }
      stored.res.status(responseStatus);
      stored.res.send(body);

      clearTimeout(stored.timeout);
      this.pendingRequests.delete(id);
      res.status(200).send("OK");
    } catch (e) {
      clearTimeout(stored.timeout);
      this.pendingRequests.delete(id);
      try { stored.res.status(500).send("Completion Error"); } catch {}
      res.status(500).send("Completion Error");
    }
  }

  // Express handler for host fetching large request body
  async handleRequest(req: Request, res: Response) {
    const id = req.query["id"] as string;
    if (!id || !this.pendingRequests.has(id)) {
      res.status(404).send("Request not found");
      return;
    }
    const stored = this.pendingRequests.get(id)!;
    const buf = Buffer.from(stored.body);
    // propagate original headers if needed
    for (const [k, v] of Object.entries(stored.headers as Record<string, string>)) {
      try { (res as any).set(k, v); } catch {}
    }
    res.status(200).send(buf);
  }

  // WebSocket: handle host connection upgrade
  handleHostWebSocketConnection(ws: WebSocket, request: http.IncomingMessage) {
    this.attach(ws, { type: "host" });
    this.hostConnection = ws;
    this.lastHostActivity = Date.now();

    ws.on("message", (data: Buffer, isBinary) => this.onWebSocketMessage(ws, data));
    ws.on("close", (code, reason) => this.onWebSocketClose(ws, code, reason.toString(), true));
    ws.on("error", (err) => this.onWebSocketError(ws, err));
  }

  // WebSocket: handle client connection upgrade to be proxied through host
  handleClientWebSocketConnection(ws: WebSocket, request: http.IncomingMessage) {
    if (!this.hostConnection || this.hostConnection.readyState !== WS_READY_STATE_OPEN) {
      ws.close(1013, "No host connected");
      return;
    }

    if (this.clientSockets.size >= this.MAX_CONCURRENT_CLIENTS) {
      ws.close(1013, "Server busy");
      return;
    }

    const parsed = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const socket_id = crypto.randomUUID();

    this.attach(ws, { type: "client", id: socket_id, path: parsed.pathname });
    this.clientSockets.set(socket_id, ws);

    // Notify host to prepare WebSocket mode for this path
    const wsInitMessage = { type: "ws-init", path: parsed.pathname, id: socket_id };
    try { this.hostConnection!.send(JSON.stringify(wsInitMessage)); } catch {}

    // Forward client messages to host
    ws.on("message", (data) => {
      if (this.hostConnection && this.hostConnection.readyState === WS_READY_STATE_OPEN) {
        const msg = { type: "ws-message", data: data.toString(), id: socket_id };
        try { this.hostConnection.send(JSON.stringify(msg)); } catch {}
      }
    });

    ws.on("close", (code, reason) => {
      this.clientSockets.delete(socket_id);
      if (this.hostConnection && this.hostConnection.readyState === WS_READY_STATE_OPEN) {
        try { this.hostConnection.send(JSON.stringify({ type: "ws-close", id: socket_id, code, reason: reason.toString() })); } catch {}
      }
    });

    ws.on("error", (err) => {
      this.clientSockets.delete(socket_id);
      if (this.hostConnection && this.hostConnection.readyState === WS_READY_STATE_OPEN) {
        try { this.hostConnection.send(JSON.stringify({ type: "ws-error", id: socket_id, error: String(err) })); } catch {}
      }
    });
  }

  // Internal message handler mimicking working.ts semantics
  private onWebSocketMessage(ws: WebSocket, raw: Buffer) {
    const text = raw.toString();

    // Simple ping/pong as text messages (not WS control frames) for backward-compat
    if (text === "ping") {
      try { ws.send("pong"); } catch {}
      const att = this.attachments.get(ws);
      if (att?.type === "host") this.lastHostActivity = Date.now();
      return;
    }
    if (text === "pong") {
      const att = this.attachments.get(ws);
      if (att?.type === "host") this.lastHostActivity = Date.now();
      return;
    }

    const att = this.attachments.get(ws);
    if (!att) return;

    if (att.type === "host") {
      try {
        const data = JSON.parse(text);
        if (data && typeof data === "object") {
          if (data.type === "response" && data.id) {
            const stored = this.pendingRequests.get(data.id);
            if (stored) {
              // Small/normal response path: write immediately
              try {
                // Headers
                const responseHeaders = (data.headers ?? {}) as Record<string, string | number | string[]>;
                for (const [k, v] of Object.entries(responseHeaders)) {
                  try { (stored.res as any).set(k, v as any); } catch {}
                }
                stored.res.status(data.status);
                const responseBody = Array.isArray(data.body) && data.body.length > 0 ? Buffer.from(data.body) : Buffer.alloc(0);
                stored.res.send(responseBody);
              } finally {
                clearTimeout(stored.timeout);
                this.pendingRequests.delete(data.id);
              }
            }
          } else if (data.type === "ws-message" && data.id) {
            const target = this.clientSockets.get(data.id);
            if (target && target.readyState === WS_READY_STATE_OPEN) {
              try { target.send(data.data); } catch { this.clientSockets.delete(data.id); }
            }
          }
        }
      } catch (e) {
        // parsing error - ignore to keep connection alive
      }
      this.lastHostActivity = Date.now();
    } else if (att.type === "client") {
      // Should not receive here because client->host handled on client ws listener
    }
  }

  private onWebSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    const att = this.attachments.get(ws);
    if (!att) return;

    if (att.type === "host") {
      this.hostConnection = null;
      // Fail all pending requests
      for (const [id, stored] of this.pendingRequests) {
        try { stored.res.status(503).send("Host disconnected"); } catch {}
        clearTimeout(stored.timeout);
      }
      this.pendingRequests.clear();

      // Close all client sockets
      for (const [id, sock] of this.clientSockets) {
        try { sock.close(code || 1006, reason || "Host disconnected"); } catch {}
      }
      this.clientSockets.clear();
    } else if (att.type === "client") {
      if (att.id) this.clientSockets.delete(att.id);
      if (this.hostConnection && this.hostConnection.readyState === WS_READY_STATE_OPEN) {
        try { this.hostConnection.send(JSON.stringify({ type: "ws-close", id: att.id, code, reason })); } catch {}
      }
    }
  }

  private onWebSocketError(ws: WebSocket, error: unknown) {
    const att = this.attachments.get(ws);
    if (!att) return;

    if (att.type === "host") {
      this.hostConnection = null;
      for (const [id, sock] of this.clientSockets) {
        try { sock.close(1011, "Host error"); } catch {}
      }
      this.clientSockets.clear();
    } else if (att.type === "client") {
      if (att.id) this.clientSockets.delete(att.id);
      if (this.hostConnection && this.hostConnection.readyState === WS_READY_STATE_OPEN) {
        try { this.hostConnection.send(JSON.stringify({ type: "ws-error", id: att.id, error: String(error) })); } catch {}
      }
    }
  }

  private attach(ws: WebSocket, attachment: Attachment) {
    this.attachments.set(ws, attachment);
  }

  private startConnectionMonitoring() {
    if (!this.connectionCheckInterval) {
      this.connectionCheckInterval = setInterval(() => {
        // Clean host
        if (this.hostConnection && this.hostConnection.readyState !== WS_READY_STATE_OPEN) {
          this.hostConnection = null;
        }
        // Clean stale clients
        for (const [id, sock] of this.clientSockets) {
          if (sock.readyState !== WS_READY_STATE_OPEN) {
            this.clientSockets.delete(id);
          }
        }
      }, this.CONNECTION_CHECK_INTERVAL);
    }
  }

  public cleanup() {
    if (this.connectionCheckInterval) clearInterval(this.connectionCheckInterval);
    for (const [id, stored] of this.pendingRequests) {
      try { stored.res.status(503).end(); } catch {}
      clearTimeout(stored.timeout);
    }
    this.pendingRequests.clear();
    if (this.hostConnection) try { this.hostConnection.close(1000, "Shutdown"); } catch {}
    for (const [, ws] of this.clientSockets) { try { ws.close(1000, "Shutdown"); } catch {} }
    this.clientSockets.clear();
  }

  // Helper to collect raw body from Express Request
  private collectRawBody(req: Request): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }
}