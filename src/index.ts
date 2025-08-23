import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { TunnelBroker } from "./broker.js";
import { URL } from "url";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8000;

const app = express();
// Do not use body parsers; we need raw bodies for proxying

const server = http.createServer(app);
const broker = new TunnelBroker();

// WebSocket handling via manual upgrade to maintain CF DO semantics
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
	try {
		const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
		wss.handleUpgrade(req, socket, head, (ws) => {
			if (url.pathname === "/__connect") {
				// Host connection
				broker.handleHostWebSocketConnection(ws, req);
			} else {
				// Client connection to be proxied
				broker.handleClientWebSocketConnection(ws, req);
			}
		});
	} catch (e) {
		socket.destroy();
	}
});

// Routes matching working.ts control APIs
app.post("/__complete", (req, res) => broker.handleCompletion(req, res));
app.get("/__request", (req, res) => broker.handleRequest(req, res));

// All other HTTP requests proxied through host (Express 5 safe fallback)
app.use((req, res) => broker.handleHttpProxy(req, res));

server.listen(PORT, () => {
	console.log(`Tunnel Broker (Express) listening on port ${PORT}`);
});

process.on("SIGINT", () => {
	broker.cleanup();
	process.exit(0);
});
process.on("SIGTERM", () => {
	broker.cleanup();
	process.exit(0);
});
