import type { ProxyRequest, ProxyResponse, StoredRequest, WebSocketInitMessage, WebSocketDataMessage, CloudflareResponseInit } from "./types";

// Cloudflare Workers types
declare global {
	interface WebSocket {
		readyState: number;
		READY_STATE_OPEN: number;
		send(data: string | ArrayBuffer): void;
		close(code?: number, reason?: string): void;
		addEventListener(type: string, listener: (event: any) => void): void;
		serializeAttachment(attachment: any): void;
		deserializeAttachment(): any;
	}

	interface WebSocketPair {
		0: WebSocket;
		1: WebSocket;
	}

	var WebSocketPair: {
		new (): WebSocketPair;
	};

	interface DurableObjectState {
		getWebSockets(tag?: string): WebSocket[];
		acceptWebSocket(webSocket: WebSocket, tags?: string[]): void;
		setWebSocketAutoResponse(requestResponsePair?: WebSocketRequestResponsePair): void;
	}

	interface WebSocketRequestResponsePair {
		new (request: string, response: string): WebSocketRequestResponsePair;
	}

	var WebSocketRequestResponsePair: {
		new (request: string, response: string): WebSocketRequestResponsePair;
	};
}

// WebSocket ready states
const WS_READY_STATE_OPEN = 1;

export class TunnelBroker {
	private hostConnection: WebSocket | null = null;
	private readonly RESPONSE_TIMEOUT = 45 * 1000; // 30 seconds
	private readonly MAX_BODY_SIZE = 512 * 1024; // 512KB
	private pendingRequests = new Map<string, StoredRequest>();
	// Replace single client socket with a map for multiple concurrent client connections
	private clientSockets: Map<string, WebSocket> = new Map();
	private readonly MAX_CONCURRENT_CLIENTS = 500; // Prevent resource exhaustion
	private state: DurableObjectState;
	private env: any;

	// Heartbeat and connection management - Optimized: Host drives pings, DO auto-responds
	private readonly CONNECTION_CHECK_INTERVAL = 50 * 1000; // 5 seconds
	private lastHostActivity = Date.now();
	private connectionCheckInterval: number | null = null;

	constructor(state: DurableObjectState, env: any) {
		// Starting hibernation recovery
		this.state = state;
		this.env = env;

		// Restore WebSocket connections after hibernation
		const existingWebSockets = this.state.getWebSockets();
		// Found existing WebSocket connections

		existingWebSockets.forEach((ws: WebSocket) => {
			const attachment = ws.deserializeAttachment();
			if (attachment) {
				// Validate connection is still alive before restoring
				if (ws.readyState === WS_READY_STATE_OPEN) {
					if (attachment.type === "host") {
						this.hostConnection = ws;
						this.lastHostActivity = Date.now();
						// Host connection restored from hibernation
					} else if (attachment.type === "client") {
						// Restore client socket by its id
						if (attachment.id) {
							this.clientSockets.set(attachment.id, ws);
							// Client connection restored from hibernation
						}
					}
				} else {
					// Discarding stale connection
					try {
						ws.close();
					} catch (e) {
						const errorMsg = e instanceof Error ? e.message : String(e);
						console.error("Error closing stale connection:", errorMsg);
					}
				}
			}
		});

		// Set up auto-response for ping-pong to avoid unnecessary wake-ups
		this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

		// Start connection monitoring (optimized, no DO-initiated pings)
		this.startConnectionMonitoring();
	}

	// Main fetch method - entry point for all requests
	async fetch(request: Request): Promise<Response> {
		// Start timing for performance tracking
		const startTime = Date.now();
		const requestId = Math.random().toString(36).substring(2, 15);

		// Get client information
		const clientIP = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || request.headers.get("X-Real-IP") || "unknown";
		const userAgent = request.headers.get("User-Agent") || "unknown";
		const host = request.headers.get("Host") || "unknown";
		const url = new URL(request.url);

		// Request started - tracking in headers

		try {
			let response: Response;

			// Handle host connection
			if (url.pathname === "/__connect") {
				response = await this.handleHostConnection(request);
			} else if (url.pathname === "/__complete") {
				// Handle completion endpoint
				response = await this.handleCompletion(request);
			} else if (url.pathname === "/__request") {
				response = await this.handleRequest(request);
			} else if (this.isWebSocketRequest(request)) {
				// Handle WebSocket requests
				response = await this.handleWebSocketProxy(request);
			} else {
				// Handle HTTP requests
				response = await this.handleHttpProxy(request);
			}

			// Calculate processing time and add headers
			const processingTime = Date.now() - startTime;

			// Add timing and client info to response headers
			response.headers.set("X-Request-ID", requestId);
			response.headers.set("X-Processing-Time-Ms", processingTime.toString());
			response.headers.set("X-Client-IP", clientIP);
			response.headers.set("X-Request-Host", host);
			response.headers.set("X-Timestamp", new Date().toISOString());
			response.headers.set("X-Server-Info", `Tunnel-Broker-${this.env?.CF_RAY || "unknown"}`);
			response.headers.set("X-Host-Connected", this.hostConnection ? "true" : "false");
			response.headers.set("X-Active-Clients", this.clientSockets.size.toString());

			// Request completed - details in headers

			return response;
		} catch (error) {
			const processingTime = Date.now() - startTime;
			// Request failed - error details in headers

			const errorResponse = new Response("Internal Server Error", { status: 500 });

			// Add error info to headers
			errorResponse.headers.set("X-Request-ID", requestId);
			errorResponse.headers.set("X-Processing-Time-Ms", processingTime.toString());
			errorResponse.headers.set("X-Client-IP", clientIP);
			errorResponse.headers.set("X-Request-Host", host);
			errorResponse.headers.set("X-Error", "true");
			errorResponse.headers.set("X-Timestamp", new Date().toISOString());

			return errorResponse;
		}
	}

	// Handle host connection
	async handleHostConnection(request: Request): Promise<Response> {
		if (!this.isWebSocketRequest(request)) {
			return new Response("WebSocket upgrade required", { status: 426 });
		}

		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		// Use hibernation API instead of standard WebSocket API
		this.state.acceptWebSocket(server, ["host"]);

		// Serialize connection type for hibernation recovery
		server.serializeAttachment({ type: "host", connectedAt: Date.now() });

		this.hostConnection = server;

		// Host connected with hibernation support
		return new Response(null, { status: 101, webSocket: client } as CloudflareResponseInit);
	}

	// Handle HTTP proxy requests
	private async handleHttpProxy(request: Request): Promise<Response> {
		// Step 1: Check if host is connected
		if (!this.hostConnection || this.hostConnection.readyState !== WS_READY_STATE_OPEN) {
			return new Response("No host connected", { status: 503 });
		}

		try {
			// Step 2: Generate id and store data
			const id = crypto.randomUUID();
			const url = new URL(request.url);
			const headers: Record<string, string> = {};
			request.headers.forEach((value, key) => {
				headers[key] = value;
			});

			let bodyArray: number[] = [];
			let originalBodyArray: number[] = [];
			let fetchBody = false;
			let maxTimeout = this.RESPONSE_TIMEOUT;
			if (request.body) {
				const clonedRequest = request.clone();
				const bodyBuffer = await clonedRequest.arrayBuffer();
				bodyArray = Array.from(new Uint8Array(bodyBuffer));
				originalBodyArray = bodyArray;

				// Step 3: Check body size - if > 10KB, don't send body
				if (bodyArray.length > this.MAX_BODY_SIZE) {
					//allow per mb 30 sec
					const mb = Math.ceil(bodyArray.length / 1024 / 1024);
					maxTimeout = 30 * 1000 * mb;
					fetchBody = true;
					bodyArray = []; // Don't send body in WebSocket message
				}
			}

			const proxyRequest: ProxyRequest = {
				type: "request",
				id,
				method: request.method,
				path: url.pathname + url.search,
				headers,
				body: fetchBody ? undefined : bodyArray,
				fetch_body: fetchBody,
			};

			// Step 4: Send data to host via WebSocket
			return new Promise((resolve, reject) => {
				const timeoutId = setTimeout(() => {
					this.pendingRequests.delete(id);
					reject(new Error("Request timeout"));
				}, maxTimeout);

				// Store request for response handling
				const storedRequest: StoredRequest = {
					id,
					method: request.method,
					path: url.pathname + url.search,
					headers,
					body: originalBodyArray, // Store original body, not the cleared one
					timestamp: Date.now(),
					resolve: (response: ProxyResponse) => {
						clearTimeout(timeoutId);
						this.pendingRequests.delete(id);
						const responseBody = response.body.length > 0 ? new Uint8Array(response.body).buffer : null;
						// Create response with caching for static assets
						const responseHeaders = new Headers(response.headers);

						// // Add caching headers for static assets
						// const contentType = responseHeaders.get("content-type") || "";
						// const isStaticAsset =
						// 	/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|webp|avif)$/i.test(url.pathname) ||
						// 	contentType.includes("javascript") ||
						// 	contentType.includes("css") ||
						// 	contentType.startsWith("image/") ||
						// 	contentType.startsWith("font/");

						// if (isStaticAsset) {
						// 	// Cache static assets for 1 year
						// 	responseHeaders.set("Cache-Control", "public, max-age=31536000, immutable");
						// 	responseHeaders.set("Expires", new Date(Date.now() + 31536000000).toUTCString());
						// }

						resolve(
							new Response(responseBody, {
								status: response.status,
								headers: responseHeaders,
							})
						);
					},
					reject: (error: Error) => {
						clearTimeout(timeoutId);
						this.pendingRequests.delete(id);
						reject(error);
					},
				};

				this.pendingRequests.set(id, storedRequest);

				// Send request to host
				if (this.hostConnection) {
					this.hostConnection.send(JSON.stringify(proxyRequest));
				} else {
					clearTimeout(timeoutId);
					this.pendingRequests.delete(id);
					reject(new Error("Host connection lost"));
				}
			});
		} catch (error) {
			// HTTP proxy error handled
			return new Response("Proxy Error", { status: 502 });
		}
	}

	// Handle WebSocket proxy requests
	private async handleWebSocketProxy(request: Request): Promise<Response> {
		if (!this.hostConnection || this.hostConnection.readyState !== WS_READY_STATE_OPEN) {
			return new Response("No host connected", { status: 503 });
		}

		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		// Use hibernation API for client socket too
		const socket_id = crypto.randomUUID();
		this.state.acceptWebSocket(server, ["client", socket_id]);
		server.serializeAttachment({ type: "client", id: socket_id, path: new URL(request.url).pathname });

		// Track this client by id with limit check
		if (this.clientSockets.size >= this.MAX_CONCURRENT_CLIENTS) {
			// Max concurrent clients reached
			server.close(1013, "Server busy");
			return new Response("Too many connections", { status: 503 });
		}
		this.clientSockets.set(socket_id, server);

		// Notify host to enter WebSocket mode
		const wsInitMessage: WebSocketInitMessage = { type: "ws-init", path: new URL(request.url).pathname, id: socket_id };
		this.hostConnection.send(JSON.stringify(wsInitMessage));

		return new Response(null, { status: 101, webSocket: client } as CloudflareResponseInit);
	}

	// Handle completion endpoint for large responses
	private async handleCompletion(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const id = url.searchParams.get("id");

		if (!id || !this.pendingRequests.has(id)) {
			return new Response("Request not found", { status: 404 });
		}

		const storedRequest = this.pendingRequests.get(id)!;
		const headers = JSON.parse(request.headers.get("X-Response-Headers") || "{}");

		try {
			// Extract response data from request
			const responseStatus = parseInt(request.headers.get("X-Response-Status") || "200");
			// const responseHeaders: Record<string, string> = {};
			// request.headers.forEach((value, key) => {
			// 	if (!key.startsWith("X-Response-") && key !== "content-length") {
			// 		responseHeaders[key] = value;
			// 	}
			// });

			const responseBodyBuffer = await request.arrayBuffer();
			const responseBodyArray = Array.from(new Uint8Array(responseBodyBuffer));

			const responseData: ProxyResponse = {
				type: "response",
				id,
				status: responseStatus,
				headers: headers,
				body: responseBodyArray,
			};

			// Add caching headers for static assets in completion response
			// const contentType = responseHeaders["content-type"] || "";
			// const requestPath = storedRequest.path;
			// const isStaticAsset =
			// 	/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|webp|avif)$/i.test(requestPath) ||
			// 	contentType.includes("javascript") ||
			// 	contentType.includes("css") ||
			// 	contentType.startsWith("image/") ||
			// 	contentType.startsWith("font/");

			// if (isStaticAsset) {
			// 	// Cache static assets for 1 year
			// 	responseHeaders["Cache-Control"] = "public, max-age=31536000, immutable";
			// 	responseHeaders["Expires"] = new Date(Date.now() + 31536000000).toUTCString();
			// 	responseData.headers = responseHeaders;
			// }

			// Resolve the stored request
			storedRequest.resolve(responseData);
			return new Response("OK", { status: 200 });
		} catch (error) {
			// Completion error handled
			storedRequest.reject(new Error("Completion failed"));
			return new Response("Completion Error", { status: 500 });
		}
	}

	private async handleRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const id = url.searchParams.get("id");

		if (!id || !this.pendingRequests.has(id)) {
			return new Response("Request not found", { status: 404 });
		}

		const storedRequest = this.pendingRequests.get(id)!;

		return new Response(Buffer.from(storedRequest.body), {
			headers: storedRequest.headers,
		});
	}

	// WebSocket hibernation handler methods
	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		try {
			const attachment = ws.deserializeAttachment();
			if (!attachment) return;

			// Normalize message to string when possible
			let text: string | null = null;
			if (typeof message === "string") text = message;
			else if (message instanceof ArrayBuffer) text = new TextDecoder().decode(message);

			// Handle text heartbeat without JSON.parse
			if (text === "ping") {
				// Reply to host ping to keep connection alive
				try {
					ws.send("pong");
				} catch {}
				if (attachment.type === "host") this.lastHostActivity = Date.now();
				return;
			}
			if (text === "pong") {
				if (attachment.type === "host") this.lastHostActivity = Date.now();
				return;
			}

			// Update last activity on any message from host
			if (attachment.type === "host") {
				this.lastHostActivity = Date.now();
			}

			if (attachment.type === "host") {
				try {
					const data = JSON.parse(text ?? (message as string));
					if (!data || typeof data !== "object") {
						console.error(`Invalid message format from host: ${text}`);
						return;
					}

					// Handle WebSocket response messages
					if (data.type === "response" && data.id) {
						const storedRequest = this.pendingRequests.get(data.id);
						if (storedRequest) {
							storedRequest.resolve(data as ProxyResponse);
						} else {
							// No pending request for response
						}
					} else if (data.type === "ws-message") {
						const target = data.id ? this.clientSockets.get(data.id) : null;
						if (target && target.readyState === WS_READY_STATE_OPEN) {
							try {
								target.send(data.data);
							} catch (e) {
								const errorMsg = e instanceof Error ? e.message : String(e);
								console.error(`Failed to forward ws-message to client ${data.id}: ${errorMsg}`);
								this.clientSockets.delete(data.id);
							}
						} else {
							// No client socket found/open
						}
					} else {
						// Unknown host message type
					}
				} catch (parseError) {
					const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
					console.error(`Error parsing host message: ${errorMsg} - Data: ${text}`);
				}
			} else if (attachment.type === "client") {
				// Handle client messages - forward to host
				if (this.hostConnection?.readyState === WS_READY_STATE_OPEN) {
					const wsMessage = {
						type: "ws-message",
						data: typeof message === "string" ? message : text ?? new TextDecoder().decode(message as ArrayBuffer),
						id: attachment.id,
					};
					try {
						this.hostConnection.send(JSON.stringify(wsMessage));
					} catch (sendError) {
						const errorMsg = sendError instanceof Error ? sendError.message : String(sendError);
						console.error(`Error forwarding message from client ${attachment.id}: ${errorMsg}`);
					}
				} else {
					// Host not connected, dropping message
				}
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			console.error(`WebSocket message parsing error: ${errorMsg}`);
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
		const attachment = ws.deserializeAttachment();
		if (!attachment) return;

		if (attachment.type === "host") {
			// Host disconnected
			this.hostConnection = null;
			// Reject all pending requests
			this.pendingRequests.forEach((request) => {
				request.reject(new Error("Host disconnected"));
			});
			// Close all client sockets
			for (const [id, sock] of this.clientSockets.entries()) {
				try {
					sock.close(code || 1006, reason || "Host disconnected");
				} catch (err) {
					const errorMsg = err instanceof Error ? err.message : String(err);
					console.error(`Error closing client ${id}: ${errorMsg}`);
				}
				this.clientSockets.delete(id);
			}
			this.pendingRequests.clear();
		} else if (attachment.type === "client") {
			// Client disconnected
			if (attachment.id) this.clientSockets.delete(attachment.id);
			if (this.hostConnection && this.hostConnection.readyState === WS_READY_STATE_OPEN) {
				try {
					this.hostConnection.send(JSON.stringify({ type: "ws-close", id: attachment.id, code, reason }));
				} catch (err) {
					const errorMsg = err instanceof Error ? err.message : String(err);
					console.error(`Error sending close to host for client ${attachment.id}: ${errorMsg}`);
				}
			}
		}
	}

	async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		const attachment = ws.deserializeAttachment();
		if (!attachment) return;

		if (attachment.type === "host") {
			// Host connection error
			this.hostConnection = null;
			// Close all client sockets on host error
			for (const [id, sock] of this.clientSockets.entries()) {
				try {
					sock.close(1011, "Host error");
				} catch (err) {
					const errorMsg = err instanceof Error ? err.message : String(err);
					console.error(`Error closing client ${id}: ${errorMsg}`);
				}
				this.clientSockets.delete(id);
			}
		} else if (attachment.type === "client") {
			// Client error
			if (attachment.id) this.clientSockets.delete(attachment.id);
			if (this.hostConnection && this.hostConnection.readyState === WS_READY_STATE_OPEN) {
				try {
					this.hostConnection.send(JSON.stringify({ type: "ws-error", id: attachment.id, error: String(error) }));
				} catch (err) {
					const errorMsg = err instanceof Error ? err.message : String(err);
					console.error(`Error sending error to host for client ${attachment.id}: ${errorMsg}`);
				}
			}
		}
	}

	// Heartbeat and connection monitoring
	private startConnectionMonitoring() {
		// Optimized: Rely on host-initiated pings with auto-response to minimize DO wake-ups
		// Periodically clear stale references
		if (!this.connectionCheckInterval) {
			this.connectionCheckInterval = setInterval(() => {
				// Clean host
				if (this.hostConnection && this.hostConnection.readyState !== WS_READY_STATE_OPEN) {
					this.hostConnection = null;
				}
				// Clean stale client sockets
				for (const [id, sock] of this.clientSockets.entries()) {
					if (sock.readyState !== WS_READY_STATE_OPEN) {
						this.clientSockets.delete(id);
					}
				}
			}, this.CONNECTION_CHECK_INTERVAL) as unknown as number;
		}
	}

	// Check if request is WebSocket upgrade
	private isWebSocketRequest(request: Request): boolean {
		const upgrade = request.headers.get("upgrade");
		const connection = request.headers.get("connection");
		const isWebSocket = upgrade?.toLowerCase() === "websocket" && connection?.toLowerCase().includes("upgrade") === true;
		// WebSocket request detected
		return isWebSocket;
	}
}

export { TunnelBroker as default };
