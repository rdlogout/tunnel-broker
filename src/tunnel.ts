import { WebSocket, WebSocketServer } from "ws";
import { IncomingMessage } from "http";
import { URL } from "url";

// TypeScript interfaces for request/response messages
interface ProxyRequest {
	type: "request";
	method: string;
	path: string;
	headers: Record<string, string>;
	body: number[]; // Uint8Array serialized as array
}

interface ProxyResponse {
	type: "response";
	status: number;
	headers: Record<string, string>;
	body: number[]; // Uint8Array serialized as array
}

interface WebSocketInit {
	type: "ws-init";
}

interface WebSocketMessage {
	type: "ws-message";
	data: string | ArrayBuffer;
}

interface WebSocketClose {
	type: "ws-close";
}

// Connection state management types
interface ConnectionState {
	hostConnection: WebSocket | null;
	isConnected: boolean;
	connectedAt?: Date;
}

export class TunnelBroker {
	private hostConnection: WebSocket | null = null;
	private readonly RESPONSE_TIMEOUT = 30000; // 30 seconds
	private pendingRequests = new Map<
		string,
		{
			resolve: (response: ProxyResponse) => void;
			reject: (error: Error) => void;
			timeout: NodeJS.Timeout;
		}
	>();
	private requestIdCounter = 0;

	constructor() {
		// Constructor for Node.js implementation
	}

	// Main request handler - entry point for all requests
	async handleRequest(request: Request): Promise<Response> {
		try {
			// Validate request and route to appropriate handler
			return await this.routeRequest(request);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			const errorStack = error instanceof Error ? error.stack : undefined;

			this.logConnectionEvent("Unexpected error in handleRequest", {
				error: errorMessage,
				stack: errorStack,
				url: request.url,
				method: request.method,
			});

			return this.createErrorResponse(500, "Internal Server Error", {
				"Content-Type": "text/plain",
			});
		}
	}

	// Private method to route requests to appropriate handlers
	private async routeRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Validate request format
		const validationError = this.validateRequest(request);
		if (validationError) {
			return validationError;
		}

		// Handle host connection requests
		if (url.pathname === "/__connect") {
			return this.handleHostConnection(request);
		}

		// Route other requests based on type detection
		const requestType = this.detectRequestType(request);

		switch (requestType) {
			case "websocket":
				return this.handleWebSocketProxy(request);
			case "http":
				return this.handleHttpProxy(request);
			default:
				const headersObj: Record<string, string> = {};
				request.headers.forEach((value, key) => {
					headersObj[key] = value;
				});
				this.logConnectionEvent("Unknown request type detected", {
					method: request.method,
					path: url.pathname,
					headers: headersObj,
				});
				return this.createErrorResponse(400, "Bad Request: Unsupported request type");
		}
	}

	// Private method to handle host connections
	private async handleHostConnection(request: Request): Promise<Response> {
		// Check if this is a WebSocket upgrade request for host connection
		if (!this.isWebSocketRequest(request)) {
			this.logConnectionEvent("Host connection rejected - not a WebSocket upgrade request");
			return this.createErrorResponse(426, "WebSocket upgrade required for host connection", {
				Upgrade: "websocket",
			});
		}

		// For Node.js, we need to handle WebSocket upgrade differently
		// This will be handled by the WebSocket server in the upgrade event
		return new Response(null, {
			status: 101,
			headers: {
				Upgrade: "websocket",
				Connection: "Upgrade",
			},
		});
	}

	// Method to handle WebSocket upgrade for host connections
	handleHostWebSocketUpgrade(ws: WebSocket): void {
		// Store the WebSocket as our host connection
		this.hostConnection = ws;

		// Set up connection event handlers
		this.setupHostConnectionHandlers(ws);

		// Log successful connection
		this.logConnectionEvent("Host connected successfully via WebSocket");
	}

	// Private method to handle HTTP proxy requests
	private async handleHttpProxy(request: Request): Promise<Response> {
		// Validate host connection exists
		if (!this.validateHostConnection()) {
			this.logConnectionEvent("HTTP proxy request rejected - no host connected", {
				method: request.method,
				url: request.url,
			});
			return this.createErrorResponse(503, "No host connected");
		}

		try {
			// Serialize the request
			const proxyRequest = await this.serializeRequest(request);

			// Send request to host and wait for response
			const proxyResponse = await this.sendRequestAndWaitForResponse(proxyRequest);

			// Deserialize and return response to client
			const response = this.deserializeResponse(proxyResponse);

			this.logConnectionEvent("HTTP proxy request completed successfully", {
				method: request.method,
				url: request.url,
				responseStatus: response.status,
			});

			return response;
		} catch (error) {
			if (error instanceof Error) {
				await this.handleGracefulRecovery(error, "HTTP proxy");
				return this.handleConnectionError(error, "HTTP proxy");
			} else {
				this.logConnectionEvent("HTTP proxy error - unknown error type", {
					method: request.method,
					url: request.url,
					error: String(error),
				});
				return this.createErrorResponse(500, "Internal Server Error");
			}
		}
	}

	// Private method to handle WebSocket proxy requests
	private async handleWebSocketProxy(request: Request): Promise<Response> {
		// Validate host connection exists
		if (!this.validateHostConnection()) {
			this.logConnectionEvent("WebSocket proxy request rejected - no host connected", {
				url: request.url,
			});
			return this.createErrorResponse(503, "No host connected");
		}

		// For Node.js WebSocket proxy, we need to return upgrade response
		// The actual WebSocket handling will be done in the upgrade event
		return new Response(null, {
			status: 101,
			headers: {
				Upgrade: "websocket",
				Connection: "Upgrade",
			},
		});
	}

	// Method to handle WebSocket upgrade for client connections
	handleClientWebSocketUpgrade(ws: WebSocket): void {
		try {
			// Validate host connection is still available
			if (!this.hostConnection || this.hostConnection.readyState !== WebSocket.OPEN) {
				ws.close(1011, "Host connection not available");
				return;
			}

			// Notify host to enter WebSocket mode
			const wsInitMessage: WebSocketInit = { type: "ws-init" };
			this.hostConnection.send(JSON.stringify(wsInitMessage));

			// Set up bidirectional message bridging
			this.setupWebSocketBridge(ws, this.hostConnection);

			this.logConnectionEvent("WebSocket proxy established successfully");
		} catch (error) {
			if (error instanceof Error) {
				this.handleGracefulRecovery(error, "WebSocket proxy");

				this.logError(error, "WebSocket proxy", {
					hostConnectionState: this.hostConnection?.readyState,
				});

				ws.close(1011, "Failed to establish WebSocket connection");
			}
		}
	}

	// Private method to detect WebSocket upgrade requests
	private isWebSocketRequest(request: Request): boolean {
		const upgrade = request.headers.get("upgrade");
		const connection = request.headers.get("connection");

		return upgrade?.toLowerCase() === "websocket" && connection?.toLowerCase().includes("upgrade") === true;
	}

	// Private method to detect request type with enhanced validation
	private detectRequestType(request: Request): "websocket" | "http" | "unknown" {
		// Check for WebSocket upgrade request
		if (this.isWebSocketRequest(request)) {
			return "websocket";
		}

		// Check for valid HTTP methods
		const validHttpMethods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
		if (validHttpMethods.includes(request.method.toUpperCase())) {
			return "http";
		}

		return "unknown";
	}

	// Private method to validate incoming requests
	private validateRequest(request: Request): Response | null {
		const url = new URL(request.url);

		// Check for valid URL format
		if (!url.pathname) {
			this.logConnectionEvent("Invalid request: missing pathname");
			return this.createErrorResponse(400, "Bad Request: Invalid URL format");
		}

		// Check for excessively long paths (security measure)
		if (url.pathname.length > 2048) {
			this.logConnectionEvent("Invalid request: path too long", { pathLength: url.pathname.length });
			return this.createErrorResponse(414, "Bad Request: Path too long");
		}

		// Validate WebSocket upgrade requests have required headers
		if (this.isWebSocketRequest(request)) {
			const requiredHeaders = ["sec-websocket-key", "sec-websocket-version"];
			const missingHeaders = requiredHeaders.filter((header) => !request.headers.get(header));

			if (missingHeaders.length > 0) {
				this.logConnectionEvent("Invalid WebSocket request: missing headers", { missingHeaders });
				return this.createErrorResponse(400, "Bad Request: Missing required WebSocket headers");
			}

			// Validate WebSocket version
			const wsVersion = request.headers.get("sec-websocket-version");
			if (wsVersion !== "13") {
				this.logConnectionEvent("Invalid WebSocket request: unsupported version", { version: wsVersion });
				return this.createErrorResponse(400, "Bad Request: Unsupported WebSocket version");
			}
		}

		// Check for unsupported HTTP methods
		const requestType = this.detectRequestType(request);
		if (requestType === "unknown") {
			this.logConnectionEvent("Invalid request: unsupported method", { method: request.method });
			return this.createErrorResponse(405, "Method Not Allowed", {
				Allow: "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
			});
		}

		return null; // No validation errors
	}

	// Private method to get current connection state
	private getConnectionState(): ConnectionState {
		return {
			hostConnection: this.hostConnection,
			isConnected: this.hostConnection !== null,
			connectedAt: this.hostConnection ? new Date() : undefined,
		};
	}

	// Private method to validate host connection exists
	private validateHostConnection(): boolean {
		return this.hostConnection !== null && this.hostConnection.readyState === WebSocket.OPEN;
	}

	// Private method to log connection events
	private logConnectionEvent(event: string, details?: any): void {
		console.log(`[TunnelBroker] ${event}`, details ? JSON.stringify(details) : "");
	}

	// Private method to handle connection cleanup
	private cleanupHostConnection(): void {
		if (this.hostConnection) {
			this.logConnectionEvent("Cleaning up host connection");
			this.hostConnection = null;
		}
	}

	// Private method to set up host connection event handlers
	private setupHostConnectionHandlers(webSocket: WebSocket): void {
		// Handle connection close events
		webSocket.on("close", (code: number, reason: Buffer) => {
			this.logConnectionEvent("Host disconnected", {
				code,
				reason: reason.toString(),
			});
			this.cleanupHostConnection();
		});

		// Handle connection errors
		webSocket.on("error", (error: Error) => {
			this.logConnectionEvent("Host connection error", {
				error: error.message,
				readyState: webSocket.readyState,
				timestamp: new Date().toISOString(),
			});
			this.cleanupHostConnection();
		});

		// Handle incoming messages
		webSocket.on("message", (data: Buffer) => {
			try {
				const message = JSON.parse(data.toString());
				if (message.type === "response") {
					this.handleProxyResponse(message as ProxyResponse);
				}
			} catch (error) {
				this.logConnectionEvent("Error parsing host message", {
					error: error instanceof Error ? error.message : "Unknown error",
				});
			}
		});
	}

	// Private method to handle proxy responses
	private handleProxyResponse(response: ProxyResponse): void {
		// For now, we'll use a simple approach without request IDs
		// In a production system, you'd want to implement proper request/response correlation
		const pendingRequest = Array.from(this.pendingRequests.values())[0];
		if (pendingRequest) {
			clearTimeout(pendingRequest.timeout);
			this.pendingRequests.clear();
			pendingRequest.resolve(response);
		}
	}

	// Private method to serialize HTTP request for transmission to host
	private async serializeRequest(request: Request): Promise<ProxyRequest> {
		const url = new URL(request.url);

		// Extract headers as a plain object
		const headers: Record<string, string> = {};
		request.headers.forEach((value, key) => {
			headers[key] = value;
		});

		// Read and serialize body
		let bodyArray: number[] = [];
		if (request.body) {
			const bodyBuffer = await request.arrayBuffer();
			bodyArray = Array.from(new Uint8Array(bodyBuffer));
		}

		return {
			type: "request",
			method: request.method,
			path: url.pathname + url.search,
			headers,
			body: bodyArray,
		};
	}

	// Private method to send request to host and wait for response
	private async sendRequestAndWaitForResponse(proxyRequest: ProxyRequest): Promise<ProxyResponse> {
		if (!this.hostConnection) {
			throw new Error("No host connection available");
		}

		return new Promise((resolve, reject) => {
			const requestId = (++this.requestIdCounter).toString();

			const timeoutId = setTimeout(() => {
				this.logConnectionEvent("Request timeout", {
					method: proxyRequest.method,
					path: proxyRequest.path,
					timeout: this.RESPONSE_TIMEOUT,
				});
				this.pendingRequests.delete(requestId);
				reject(new Error("Request timeout"));
			}, this.RESPONSE_TIMEOUT);

			// Store the pending request
			this.pendingRequests.set(requestId, {
				resolve,
				reject,
				timeout: timeoutId,
			});

			// Check connection state before sending
			if (!this.hostConnection || this.hostConnection.readyState !== WebSocket.OPEN) {
				clearTimeout(timeoutId);
				this.pendingRequests.delete(requestId);
				reject(new Error("Host connection not available"));
				return;
			}

			// Send the request
			try {
				this.hostConnection.send(JSON.stringify(proxyRequest));
				this.logConnectionEvent("Request sent to host", {
					method: proxyRequest.method,
					path: proxyRequest.path,
					bodySize: proxyRequest.body.length,
				});
			} catch (error) {
				clearTimeout(timeoutId);
				this.pendingRequests.delete(requestId);
				const errorMessage = error instanceof Error ? error.message : "Unknown error";
				this.logConnectionEvent("Failed to send request to host", {
					error: errorMessage,
					connectionState: this.hostConnection?.readyState,
				});
				reject(new Error(`Failed to send request to host: ${errorMessage}`));
			}
		});
	}

	// Private method to deserialize response and create Response object
	private deserializeResponse(proxyResponse: ProxyResponse): Response {
		// Convert body array back to Uint8Array
		const bodyBuffer = proxyResponse.body.length > 0 ? new Uint8Array(proxyResponse.body).buffer : null;

		// Create headers object
		const headers = new Headers(proxyResponse.headers);

		// Validate status code is within valid range (200-599)
		let status = proxyResponse.status;
		if (status < 200 || status > 599) {
			this.logConnectionEvent("Invalid status code received from host, defaulting to 502", {
				originalStatus: status,
				correctedStatus: 502,
			});
			status = 502; // Bad Gateway
		}

		return new Response(bodyBuffer, {
			status,
			headers,
		});
	}

	// Private method to set up bidirectional WebSocket message bridging
	private setupWebSocketBridge(clientWebSocket: WebSocket, hostWebSocket: WebSocket): void {
		// Set up client -> host message forwarding
		clientWebSocket.on("message", (data: Buffer) => {
			try {
				if (hostWebSocket.readyState === WebSocket.OPEN) {
					const wsMessage: WebSocketMessage = {
						type: "ws-message",
						data: data.toString(),
					};
					hostWebSocket.send(JSON.stringify(wsMessage));
				}
			} catch (error) {
				this.logConnectionEvent("Error forwarding client message to host", {
					error: error instanceof Error ? error.message : "Unknown error",
				});
				this.cleanupWebSocketConnection(clientWebSocket, hostWebSocket);
			}
		});

		// Set up host -> client message forwarding
		const hostMessageHandler = (data: Buffer) => {
			try {
				const message = JSON.parse(data.toString());

				if (message.type === "ws-message" && clientWebSocket.readyState === WebSocket.OPEN) {
					clientWebSocket.send(message.data);
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error";
				this.logConnectionEvent("Error parsing host WebSocket message", {
					error: errorMessage,
				});
				// Continue processing - don't break the connection for parsing errors
			}
		};

		hostWebSocket.on("message", hostMessageHandler);

		// Set up connection cleanup handlers
		clientWebSocket.on("close", (code: number, reason: Buffer) => {
			this.logConnectionEvent("Client WebSocket disconnected", {
				code,
				reason: reason.toString(),
			});
			hostWebSocket.off("message", hostMessageHandler);
			this.cleanupWebSocketConnection(clientWebSocket, hostWebSocket);
		});

		clientWebSocket.on("error", (error: Error) => {
			this.logConnectionEvent("Client WebSocket error", {
				error: error.message,
				readyState: clientWebSocket.readyState,
				timestamp: new Date().toISOString(),
			});
			hostWebSocket.off("message", hostMessageHandler);
			this.cleanupWebSocketConnection(clientWebSocket, hostWebSocket);
		});
	}

	// Private method to clean up WebSocket connections
	private cleanupWebSocketConnection(clientWebSocket: WebSocket, hostWebSocket: WebSocket): void {
		try {
			if (clientWebSocket.readyState === WebSocket.OPEN) {
				clientWebSocket.close(1000, "Connection closed by proxy");
			}

			// Don't close the host connection here as it might be used by other clients
			// Only notify the host that this WebSocket session ended
			if (hostWebSocket.readyState === WebSocket.OPEN) {
				const wsCloseMessage: WebSocketClose = {
					type: "ws-close",
				};
				hostWebSocket.send(JSON.stringify(wsCloseMessage));
			}
		} catch (error) {
			this.logConnectionEvent("Error during WebSocket cleanup", {
				error: error instanceof Error ? error.message : "Unknown error",
			});
		}
	}

	// Private method to create standardized error responses
	private createErrorResponse(status: number, message: string, headers?: Record<string, string>): Response {
		const defaultHeaders = {
			"Content-Type": "text/plain",
			"Cache-Control": "no-cache",
		};

		return new Response(message, {
			status,
			headers: { ...defaultHeaders, ...headers },
		});
	}

	// Private method to validate proxy response structure
	private validateProxyResponse(response: any): boolean {
		if (!response || typeof response !== "object") {
			return false;
		}

		// Check required fields
		if (response.type !== "response") {
			return false;
		}

		if (typeof response.status !== "number" || response.status < 200 || response.status > 599) {
			return false;
		}

		if (!response.headers || typeof response.headers !== "object") {
			return false;
		}

		if (!Array.isArray(response.body)) {
			return false;
		}

		return true;
	}

	// Private method to handle connection state errors
	private handleConnectionError(error: Error, context: string): Response {
		const errorMessage = error.message;

		this.logConnectionEvent(`Connection error in ${context}`, {
			error: errorMessage,
			stack: error.stack,
			context,
		});

		// Determine appropriate error response based on error type
		if (errorMessage.includes("timeout")) {
			return this.createErrorResponse(504, "Gateway Timeout");
		} else if (errorMessage.includes("connection") || errorMessage.includes("host")) {
			return this.createErrorResponse(502, "Bad Gateway");
		} else if (errorMessage.includes("not available") || errorMessage.includes("not connected")) {
			return this.createErrorResponse(503, "Service Unavailable");
		} else {
			return this.createErrorResponse(500, "Internal Server Error");
		}
	}

	// Private method to log errors with enhanced context
	private logError(error: Error, context: string, additionalInfo?: Record<string, any>): void {
		const errorInfo = {
			message: error.message,
			stack: error.stack,
			name: error.name,
			context,
			timestamp: new Date().toISOString(),
			...additionalInfo,
		};

		this.logConnectionEvent(`Error in ${context}`, errorInfo);
	}

	// Private method to handle graceful error recovery
	private async handleGracefulRecovery(error: Error, context: string): Promise<void> {
		this.logError(error, context, {
			hostConnectionState: this.hostConnection?.readyState,
			recoveryAction: "cleanup_connections",
		});

		// Perform cleanup based on error context
		if (context.includes("host") || context.includes("connection")) {
			this.cleanupHostConnection();
		}

		// Additional recovery actions could be added here
		// For example: retry logic, circuit breaker patterns, etc.
	}

	// Public method to cleanup resources
	public cleanup(): void {
		this.logConnectionEvent("Cleaning up tunnel broker resources");

		// Clear all pending requests
		for (const [requestId, pendingRequest] of this.pendingRequests) {
			clearTimeout(pendingRequest.timeout);
			pendingRequest.reject(new Error("Server shutting down"));
		}
		this.pendingRequests.clear();

		// Close host connection
		if (this.hostConnection) {
			this.hostConnection.close(1001, "Server shutting down");
			this.hostConnection = null;
		}
	}
}
