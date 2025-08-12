// src/relay-server.ts
import express, { Request, Response } from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Store connected clients (assuming one for simplicity, adapt for multiple)
let connectedClient: WebSocket | null = null;

// Store pending requests (mapping Request ID to original req/res)
interface PendingRequest {
	req: Request;
	res: Response;
}
const pendingRequests = new Map<string, PendingRequest>();

// Utility to generate unique IDs
function generateUniqueId(): string {
	return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

// --- WebSocket Handling ---

wss.on("connection", (ws: WebSocket) => {
	console.log("PC A client connected");
	connectedClient = ws; // Store the latest client connection

	ws.on("message", (message: WebSocket.RawData) => {
		try {
			const msgString = message.toString();
			const msg = JSON.parse(msgString);
			console.log("Received message from PC A:", msg);

			if (msg.type === "http_response_init") {
				const { requestId, statusCode, headers } = msg;
				const pending = pendingRequests.get(requestId);
				if (pending) {
					console.log(`Initializing response for request ${requestId}`);
					pending.res.writeHead(statusCode, headers);
					// Don't end the response yet, data is coming via HTTP POST
				} else {
					console.warn(`Received init for unknown request ID: ${requestId}`);
				}
			}
			// Handle other message types if needed in the future
		} catch (err) {
			console.error("Error processing WebSocket message:", err);
		}
	});

	ws.on("close", () => {
		console.log("PC A client disconnected");
		if (connectedClient === ws) {
			connectedClient = null;
		}
	});

	ws.on("error", (err) => {
		console.error("WebSocket error on server:", err);
		if (connectedClient === ws) {
			connectedClient = null;
		}
	});
});

// --- HTTP Handling ---

// New endpoint for PC A Client to stream large data back
app.post("/upload-stream/:requestId", (req: Request, res: Response) => {
	const requestId = req.params.requestId;
	console.log(`Received data stream for request ${requestId}`);

	const pending = pendingRequests.get(requestId);
	if (!pending) {
		console.error(`Data stream for unknown request ID: ${requestId}`);
		return res.status(404).send("Request ID not found");
	}

	// Pipe the incoming stream directly to the original client's response
	// This efficiently streams data without loading it all into memory
	req.pipe(pending.res);

	req.on("end", () => {
		console.log(`Data stream ended for request ${requestId}`);
		pending.res.end(); // Close the original response to the public user
		pendingRequests.delete(requestId); // Cleanup
		res.status(200).send("OK"); // Acknowledge receipt to PC A Client
	});

	req.on("error", (err) => {
		console.error(`Error receiving data stream for ${requestId}:`, err);
		// Ensure the original response is ended even on error
		if (!pending.res.writableEnded) {
			pending.res.status(500).end("Internal Server Error during streaming");
		}
		pendingRequests.delete(requestId); // Cleanup
		// Don't send response on `res` if the pipe already started, but acknowledging is good practice if possible early
		// Here, we just log the error for the upload response
		console.error(`Error acknowledged to PC A for ${requestId}`); // Adjust based on when error occurs
	});
});

// Handle incoming public HTTP requests (catch-all)
// You might want specific routes instead of app.use
app.use((req: Request, res: Response) => {
	if (!connectedClient || connectedClient.readyState !== WebSocket.OPEN) {
		return res.status(503).send("PC A is not connected or ready");
	}

	const requestId = generateUniqueId();
	pendingRequests.set(requestId, { req, res }); // Store for later use

	// Package the HTTP request details
	const requestData = {
		method: req.method,
		url: req.url,
		headers: req.headers,
		// Note: req.body handling requires middleware like express.json() etc.
		// Streaming the original request body is more complex and might require
		// capturing it before this handler or using a reverse proxy approach.
		// For simplicity, assuming no body or it's handled by middleware if needed.
	};

	// Send request details to PC A via WebSocket
	const message = JSON.stringify({ type: "http_request", requestId, data: requestData });
	connectedClient.send(message);

	console.log(`Forwarded request ${requestId} (${req.method} ${req.url}) to PC A`);

	// Optional: Set a timeout to cleanup if no init/data arrives
	const timeout = setTimeout(() => {
		if (pendingRequests.has(requestId) && !res.headersSent) {
			console.log(`Request ${requestId} timed out`);
			res.status(504).send("Gateway Timeout");
			pendingRequests.delete(requestId);
		}
	}, 120000); // 2 minutes timeout

	// Clear timeout if response processing starts or ends
	const clearTimer = () => clearTimeout(timeout);
	res.on("headers", clearTimer); // Headers sent
	res.on("finish", clearTimer); // Response finished
	res.on("close", clearTimer); // Client disconnected
});

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
server.listen(PORT, "0.0.0.0", () => {
	// Listen on all interfaces
	console.log(`Relay server listening on port ${PORT}`);
});
