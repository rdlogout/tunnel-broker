import * as http from "http";
import * as url from "url";
import * as crypto from "crypto";
import WebSocket, { WebSocketServer } from "ws";

// Configuration
const PORT = 8000; // Change to 443 for HTTPS
const WS_PATH = "/tunnel";
const MAX_PAYLOAD = 2 * 1024 * 1024; // 2MB per WS message

let clientWs: WebSocket | null = null;
const pendingResponses: Map<string, http.ServerResponse | any> = new Map();
const pendingWsConnections: Map<string, WebSocket> = new Map(); // Track browser WebSocket connections

const server = http.createServer((req, res) => {
	if (!clientWs || clientWs.readyState !== WebSocket.OPEN) {
		res.writeHead(503);
		res.end("Tunnel offline");
		return;
	}

	const isWebSocket = req.headers["upgrade"]?.toLowerCase() === "websocket" && req.headers["connection"]?.toLowerCase().includes("upgrade");

	const upgrade = req.headers["upgrade"] || req.headers.upgrade;
	if (req.url.includes("/ws"))
		console.log({
			isWebSocket,
			url: req.url,
			upgrade,
			header: req.headers,
			connection: req.headers.connection,
			"sec-websocket-key": req.headers["sec-websocket-key"],
		});

	const id = crypto.randomUUID();
	const metadata = {
		type: isWebSocket ? "ws_request" : "request",
		id,
		method: req.method,
		path: url.parse(req.url || "/").path,
		headers: req.headers as Record<string, string | string[]>,
	};

	if (isWebSocket) {
		// Handle WebSocket upgrade later in 'upgrade' event
		console.log(`🔌 WebSocket upgrade request detected - ID: ${id}, Path: ${metadata.path}, Headers:`, {
			upgrade: req.headers.upgrade,
			connection: req.headers.connection,
			"sec-websocket-key": req.headers["sec-websocket-key"],
		});
		pendingResponses.set(id, res); // Store res temporarily until upgrade
	} else {
		// Handle regular HTTP request
		sendFramedMessage(clientWs as any, metadata, Buffer.alloc(0));
		pendingResponses.set(id, res);

		req.on("data", (chunk: Buffer) => {
			sendFramedMessage(clientWs as any, { type: "body_chunk", id }, chunk);
		});

		req.on("end", () => {
			sendFramedMessage(clientWs as any, { type: "body_end", id }, Buffer.alloc(0));
		});

		req.on("error", (err) => {
			console.error(`Request error for ID ${id}:`, err);
			pendingResponses.delete(id);
		});
	}
});

const wss = new WebSocketServer({
	noServer: true,
	perMessageDeflate: false,
	maxPayload: MAX_PAYLOAD,
});

server.on("upgrade", (req, socket, head) => {
	const parsed = url.parse(req.url || "");
	console.log("Upgrade request:", parsed.pathname);

	if (parsed.pathname === WS_PATH) {
		// Tunnel WebSocket connection from client
		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit("connection", ws, req);
		});
		return;
	}

	// Handle all other WebSocket upgrade requests through proxy
	const id = crypto.randomUUID();

	console.log(`🔌 Browser WebSocket upgrade request - ID: ${id}, Path: ${parsed.pathname}`);
	// Handle browser WebSocket upgrade
	if (!clientWs || clientWs.readyState !== WebSocket.OPEN) {
		console.log("Browser WebSocket upgrade request - tunnel offline, Path:", parsed.pathname);
		socket.destroy();
		return;
	}

	console.log("Upgrading WebSocket immediately for ID:", id);

	const metadata = {
		type: "ws_request",
		id,
		method: req.method,
		path: parsed.pathname,
		headers: req.headers as Record<string, string | string[]>,
	};

	// Upgrade immediately and store the WebSocket connection
	wss.handleUpgrade(req, socket, head, (ws) => {
		console.log(`WebSocket upgraded successfully for ID: ${id}`);

		// Store the WebSocket connection
		pendingWsConnections.set(id, ws);

		// Set up message relay to tunnel client
		ws.on("message", (message) => {
			console.log(`Relaying message from browser WebSocket ID ${id} to tunnel`);
			if (clientWs && clientWs.readyState === WebSocket.OPEN) {
				sendFramedMessage(
					clientWs,
					{
						type: "ws_message",
						id,
					},
					Buffer.from(message.toString())
				);
			}
		});

		// Set up error handling
		ws.on("error", (error) => {
			console.error(`WebSocket error for ID ${id}:`, error);
			pendingWsConnections.delete(id);
		});

		ws.on("close", () => {
			console.log(`WebSocket closed for ID ${id}`);
			if (clientWs && clientWs.readyState === WebSocket.OPEN) {
				sendFramedMessage(
					clientWs,
					{
						type: "ws_close",
						id,
					},
					Buffer.alloc(0)
				);
			}
			pendingWsConnections.delete(id);
		});
	});

	sendFramedMessage(clientWs, metadata, head); // Send upgrade headers + head
});

wss.on("connection", (ws) => {
	console.log("Client connected");
	clientWs = ws;

	ws.on("message", (msg: Buffer) => {
		const { metadata, data } = parseFramedMessage(msg);
		if (!metadata) return;
		// console.log("Received message:", metadata);

		if (metadata.type.startsWith("ws_")) {
			switch (metadata.type) {
				case "ws_response":
					// WebSocket is already upgraded and stored, just log the response
					const existingWs = pendingWsConnections.get(metadata.id);
					if (!existingWs) {
						console.error(`No WebSocket connection found for ID: ${metadata.id}`);
						return;
					}

					console.log(`Received ws_response for already upgraded WebSocket ID: ${metadata.id}`);
					// The WebSocket is already connected and ready to use
					break;
				case "ws_message":
					const browserWs = pendingWsConnections.get(metadata.id);
					if (browserWs && browserWs.readyState === WebSocket.OPEN) {
						const string = data.toString();
						browserWs.send(string);
					}
					break;
				case "ws_close":
					const wsToClose = pendingWsConnections.get(metadata.id);
					if (wsToClose) {
						wsToClose.close();
						pendingWsConnections.delete(metadata.id);
					}
					break;
				default:
					console.warn(`Unknown WebSocket message type: ${metadata.type}`);
			}
		} else {
			const res = pendingResponses.get(metadata.id);
			if (!res) return;

			switch (metadata.type) {
				case "response":
					res.writeHead(metadata.status, metadata.headers);
					break;
				case "response_chunk":
					res.write(data);
					break;
				case "response_end":
					res.end();
					pendingResponses.delete(metadata.id);
					break;
				default:
					console.warn(`Unknown message type: ${metadata.type}`);
			}
		}
	});

	ws.on("close", () => {
		console.log("Client disconnected");
		clientWs = null;
		for (const res of pendingResponses.values()) {
			res.writeHead(503);
			res.end("Tunnel closed");
		}
		for (const ws of pendingWsConnections.values()) {
			ws.close();
		}
		pendingResponses.clear();
		pendingWsConnections.clear();
	});

	ws.on("error", (err) => {
		console.error("WebSocket error:", err);
	});
});

server.listen(PORT, () => {
	console.log(`Broker listening on port ${PORT}`);
});

// Helper: Send framed binary message
function sendFramedMessage(ws: WebSocket, metadata: any, data: Buffer) {
	const jsonBuf = Buffer.from(JSON.stringify(metadata), "utf-8");
	const lenBuf = Buffer.alloc(4);
	lenBuf.writeUInt32BE(jsonBuf.length, 0);
	ws.send(Buffer.concat([lenBuf, jsonBuf, data]));
}

// Helper: Parse framed binary message
function parseFramedMessage(msg: Buffer): { metadata: any; data: Buffer } | { metadata: null; data: Buffer } {
	if (msg.length < 4) return { metadata: null, data: Buffer.alloc(0) };
	const jsonLen = msg.readUInt32BE(0);
	if (msg.length < 4 + jsonLen) return { metadata: null, data: Buffer.alloc(0) };
	const jsonStr = msg.slice(4, 4 + jsonLen).toString("utf-8");
	let metadata;
	try {
		metadata = JSON.parse(jsonStr);
	} catch (e) {
		console.error("Invalid JSON in frame:", e);
		return { metadata: null, data: Buffer.alloc(0) };
	}
	const data = msg.slice(4 + jsonLen);
	return { metadata, data };
}
