// src/relay-server.ts
import express, { Request, Response } from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Store the currently connected PC A client (assuming single connection for simplicity)
let connectedClient: WebSocket | null = null;

// Store pending requests (mapping Request ID to original req/res and metadata)
interface PendingRequest {
	req: Request;
	res: Response;
	timeoutHandle: NodeJS.Timeout; // Handle for the timeout
	uploadStarted: boolean; // Flag to indicate if the upload stream has started
}

const pendingRequests = new Map<string, PendingRequest>();
const REQUEST_TIMEOUT_MS = 120000; // 2 minutes total timeout

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
			// console.log('Received message from PC A:', msg); // Less verbose logging

			if (msg.type === "http_response_init") {
				const { requestId, statusCode, headers } = msg;
				const pending = pendingRequests.get(requestId);
				if (pending) {
					console.log(`[WS] Initializing response for request ${requestId} (Status: ${statusCode})`);

					// Clear the initial timeout as we received the init
					clearTimeout(pending.timeoutHandle);

					if (pending.res.writableEnded) {
						console.warn(`[WS] Original response for ${requestId} already ended. Ignoring init.`);
						return; // Nothing more to do
					}

					if (pending.res.headersSent) {
						console.warn(`[WS] Headers already sent for ${requestId}. Cannot write status/headers. Upload expected.`);
					} else {
						console.log(`[WS] Writing headers for ${requestId}`);
						pending.res.writeHead(statusCode, headers);
					}

					// Mark that we are expecting the upload stream to start
					pending.uploadStarted = true;

					// Set a new, shorter timeout specifically for the data stream to start arriving
					pending.timeoutHandle = setTimeout(() => {
						if (!pending.res.writableEnded) {
							console.error(`[Timeout] Data stream did not start for request ${requestId} after init. Ending response with 504.`);
							pending.res.status(504).end("Gateway Timeout: Data stream did not start.");
							pendingRequests.delete(requestId);
						}
					}, REQUEST_TIMEOUT_MS / 2); // 1 minute timeout for data after headers/init
				} else {
					console.warn(`[WS] Received init for unknown request ID: ${requestId}`);
				}
			}
			// Handle other message types if needed in the future
		} catch (err) {
			console.error("[WS] Error processing WebSocket message:", err);
		}
	});

	ws.on("close", (code, reason) => {
		console.log(`[WS] PC A client disconnected. Code: ${code}, Reason: ${reason?.toString() || "N/A"}`);
		// Note: Pending requests might timeout or error if the client is gone.
		connectedClient = null;
	});

	ws.on("error", (err) => {
		console.error("[WS] WebSocket error on server:", err);
		connectedClient = null;
	});
});

// --- HTTP Handling ---

// New endpoint for PC A Client to stream large data back
app.post("/upload-stream/:requestId", (req: Request, res: Response) => {
	const requestId = req.params.requestId;
	console.log(`[HTTP Upload] Received data stream start for request ${requestId} from PC A`);

	const pending = pendingRequests.get(requestId);
	if (!pending) {
		console.error(`[HTTP Upload] Data stream for unknown request ID: ${requestId}`);
		return res.status(404).send("Request ID not found");
	}

	// Clear the timeout waiting for the data stream to start
	clearTimeout(pending.timeoutHandle);

	if (pending.res.writableEnded) {
		console.warn(`[HTTP Upload] Original response for ${requestId} already ended. Draining incoming stream.`);
		req.resume(); // Drain incoming data to prevent backpressure
		return res.status(409).send("Response already ended");
	}

	// Defensive check: Ensure headers are sent before piping data
	if (!pending.res.headersSent) {
		// This ideally shouldn't happen if http_response_init worked, but be safe
		console.warn(`[HTTP Upload] Headers not sent for ${requestId} before data stream. Sending default 200.`);
		pending.res.writeHead(200); // Default success if not already done
	}

	console.log(`[HTTP Upload] Piping data stream for ${requestId} to original client response.`);

	// --- Crucial Step: Pipe ---
	// Pipe the incoming stream directly to the original client's response
	// This efficiently streams data without loading it all into the relay's memory
	const pipeStream = req.pipe(pending.res);

	// --- Error Handling for the Pipe ---
	pipeStream.on("error", (err) => {
		console.error(`[Pipe Error] Error piping stream for request ${requestId}:`, err);
		// Ensure the original response is ended on pipe error
		if (!pending.res.writableEnded) {
			console.log(`[Pipe Error] Ending original response for ${requestId} due to pipe error.`);
			pending.res.status(500).end("Internal Server Error during data piping");
		}
		pendingRequests.delete(requestId); // Cleanup
		// Still acknowledge the upload attempt to the PC A client if possible
		if (!res.headersSent) {
			console.log(`[Pipe Error] Sending 500 to PC A client for request ${requestId}'s upload.`);
			res.status(500).send("Error during pipe");
		}
	});

	// --- Success Handling ---
	req.on("end", () => {
		console.log(`[HTTP Upload] Data stream ended successfully for request ${requestId}`);
		// Ensure the original response is ended (it might already be if pipe ended cleanly)
		if (!pending.res.writableEnded) {
			console.log(`[HTTP Upload] Ending original response for ${requestId} as stream ended.`);
			pending.res.end();
		}
		pendingRequests.delete(requestId); // Cleanup
		if (!res.headersSent) {
			console.log(`[HTTP Upload] Sending 200 OK to PC A client for request ${requestId}'s upload.`);
			res.status(200).send("OK - Stream received and forwarded");
		}
	});

	// --- Error Handling for Incoming Stream (req) ---
	req.on("error", (err) => {
		console.error(`[Req Error] Error receiving data stream for ${requestId} from PC A:`, err);
		// Ensure the original response is ended even on error receiving data
		if (!pending.res.writableEnded) {
			console.log(`[Req Error] Ending original response for ${requestId} due to req error.`);
			pending.res.status(500).end("Internal Server Error during streaming from PC A");
		}
		pendingRequests.delete(requestId); // Cleanup
		if (!res.headersSent) {
			console.log(`[Req Error] Sending 500 to PC A client for request ${requestId}'s upload (req error).`);
			res.status(500).send("Error receiving stream from PC A");
		}
	});

	// --- Error Handling for Outgoing Stream (original client res) ---
	// This handles cases like the original client disconnecting abruptly
	pending.res.on("error", (err) => {
		console.error(`[Res Error] Error on original client response stream for ${requestId}:`, err);
		// The incoming stream (req) should ideally stop/pause automatically if destination errors
		// Cleanup state
		pendingRequests.delete(requestId);
		// The upload response (res) to PC A might be closed already, check before sending
		if (!res.headersSent) {
			console.log(`[Res Error] Sending 500 to PC A client for request ${requestId}'s upload (res error).`);
			res.status(500).send("Error on client response stream");
		}
	});
});

// Handle incoming public HTTP requests (catch-all)
// You might want specific routes instead of app.use
app.use((req: Request, res: Response) => {
	console.log(`[HTTP In] Received request: ${req.method} ${req.url} from ${req.ip || req.connection.remoteAddress}`);

	if (!connectedClient || connectedClient.readyState !== WebSocket.OPEN) {
		console.log(`[HTTP In] Rejecting request, PC A client not connected.`);
		return res.status(503).send("PC A is not connected or ready");
	}

	const requestId = generateUniqueId();
	console.log(`[HTTP In] Generated Request ID: ${requestId}. Forwarding to PC A.`);

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
	const message = JSON.stringify({ type: "http_request", requestId, requestData });
	connectedClient.send(message);
	console.log(`[WS Out] Sent http_request message (${requestId}) to PC A.`);

	// --- Set Initial Timeout ---
	// This timeout covers the entire request lifecycle: waiting for init AND data
	const timeoutHandle = setTimeout(() => {
		const pending = pendingRequests.get(requestId);
		if (pending && !pending.res.writableEnded) {
			console.log(`[Timeout] Full request ${requestId} timed out (${REQUEST_TIMEOUT_MS}ms).`);
			if (!pending.res.headersSent) {
				pending.res.status(504).send("Gateway Timeout: No response received from PC A service.");
			} else if (!pending.uploadStarted) {
				pending.res.status(504).end("Gateway Timeout: Response headers sent, but data stream never started.");
			} else {
				pending.res.status(504).end("Gateway Timeout: Data stream started, but did not complete.");
			}
			pendingRequests.delete(requestId); // Cleanup
		} else if (pending) {
			// It was pending but is now ended, just cleanup
			pendingRequests.delete(requestId);
		}
		// If not pending, it was already handled/cleaned up
	}, REQUEST_TIMEOUT_MS);

	// Store the pending request with its metadata
	pendingRequests.set(requestId, { req, res, timeoutHandle, uploadStarted: false });
});

// --- Server Startup ---
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const HOST = "0.0.0.0"; // Listen on all interfaces

server.listen(PORT, HOST, () => {
	console.log(`[Server] Relay server listening on http://${HOST}:${PORT}`);
});

// --- Graceful Shutdown ---
process.on("SIGINT", () => {
	console.log("[Server] Received SIGINT. Shutting down gracefully...");
	server.close(() => {
		console.log("[Server] HTTP server closed.");
		wss.close(() => {
			console.log("[Server] WebSocket server closed.");
			process.exit(0);
		});
	});
});

process.on("SIGTERM", () => {
	console.log("[Server] Received SIGTERM. Shutting down gracefully...");
	server.close(() => {
		console.log("[Server] HTTP server closed.");
		wss.close(() => {
			console.log("[Server] WebSocket server closed.");
			process.exit(0);
		});
	});
});
