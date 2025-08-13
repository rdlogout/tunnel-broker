import * as http from "http";
import * as url from "url";
import * as crypto from "crypto";
import WebSocket, { WebSocketServer } from "ws";

// Configuration
const PORT = 8000; // Change to 443 for HTTPS
const WS_PATH = "/tunnel";
const SECRET = "abc123"; // Change this!
const MAX_PAYLOAD = 2 * 1024 * 1024; // 2MB per WS message

let clientWs: WebSocket | null = null;
const pendingResponses: Map<string, http.ServerResponse> = new Map();

const server = http.createServer((req, res) => {
	if (!clientWs || clientWs.readyState !== WebSocket.OPEN) {
		res.writeHead(503);
		res.end("Tunnel offline");
		return;
	}

	const id = crypto.randomUUID();
	const metadata = {
		type: "request",
		id,
		method: req.method,
		path: url.parse(req.url || "/").path,
		headers: req.headers as Record<string, string | string[]>,
	};

	sendFramedMessage(clientWs, metadata, Buffer.alloc(0)); // Send request metadata (no initial data)
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
});

const wss = new WebSocketServer({
	noServer: true,
	perMessageDeflate: false,
	maxPayload: MAX_PAYLOAD,
});

server.on("upgrade", (req, socket, head) => {
	const parsed = url.parse(req.url || "");
	if (parsed.pathname !== WS_PATH) {
		socket.destroy();
		return;
	}

	const queryParams = new URLSearchParams(parsed.query || "");
	// if (queryParams.get("secret") !== SECRET) {
	// 	socket.destroy();
	// 	return;
	// }

	wss.handleUpgrade(req, socket, head, (ws) => {
		wss.emit("connection", ws, req);
	});
});

wss.on("connection", (ws) => {
	console.log("Client connected");
	clientWs = ws;

	ws.on("message", (msg: Buffer) => {
		const { metadata, data } = parseFramedMessage(msg);
		if (!metadata) return;

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
	});

	ws.on("close", () => {
		console.log("Client disconnected");
		clientWs = null;
		for (const res of pendingResponses.values()) {
			res.writeHead(503);
			res.end("Tunnel closed");
		}
		pendingResponses.clear();
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
