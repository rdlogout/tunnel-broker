import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { TunnelBroker } from "./tunnel.js";
import { logger } from "hono/logger";
import { createNodeWebSocket } from "@hono/node-ws";
import { UpgradeWebSocket } from "hono/ws";
import { cache } from "hono/cache";
import { etag } from "hono/etag";

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// Custom logger that handles WebSocket upgrades properly
app.use(async (c, next) => {
	const start = Date.now();
	await next();
	const end = Date.now();
	
	// Skip logging for WebSocket upgrade responses to prevent status code errors
	if (c.res.status === 101) {
		return;
	}
	
	console.log(`${c.req.method} ${c.req.url} ${c.res.status} ${end - start}ms`);
});

// Add caching middleware for static assets
app.use('/static/*', cache({
	cacheName: 'tunnel-broker-static',
	cacheControl: 'max-age=31536000', // 1 year for static assets
}));

// Add ETag support for better caching
app.use('*', etag());

// Create a single global tunnel broker instance
const tunnelBroker = new TunnelBroker();

// Health check endpoint
app.get("/_health", (c) => {
	console.log("[Server] Health check requested");
	return c.text("OK");
});

// Static file serving with caching for common web assets
app.get('/favicon.ico', cache({ cacheName: 'favicon', cacheControl: 'max-age=86400' }), (c) => {
	return c.notFound();
});

// Handle common static file extensions with appropriate caching
const staticFileExtensions = ['.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot'];
app.use('*', async (c, next) => {
	const url = new URL(c.req.url);
	const pathname = url.pathname;
	
	// Check if this is a static file request
	const isStaticFile = staticFileExtensions.some(ext => pathname.endsWith(ext));
	
	if (isStaticFile) {
		// Add caching headers for static files
		c.header('Cache-Control', 'public, max-age=31536000, immutable'); // 1 year
		c.header('Vary', 'Accept-Encoding');
		
		// Set appropriate content type
		if (pathname.endsWith('.js')) {
			c.header('Content-Type', 'application/javascript');
		} else if (pathname.endsWith('.css')) {
			c.header('Content-Type', 'text/css');
		} else if (pathname.endsWith('.svg')) {
			c.header('Content-Type', 'image/svg+xml');
		} else if (pathname.endsWith('.png')) {
			c.header('Content-Type', 'image/png');
		} else if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) {
			c.header('Content-Type', 'image/jpeg');
		} else if (pathname.endsWith('.gif')) {
			c.header('Content-Type', 'image/gif');
		} else if (pathname.endsWith('.webp')) {
			c.header('Content-Type', 'image/webp');
		} else if (pathname.endsWith('.woff')) {
			c.header('Content-Type', 'font/woff');
		} else if (pathname.endsWith('.woff2')) {
			c.header('Content-Type', 'font/woff2');
		} else if (pathname.endsWith('.ttf')) {
			c.header('Content-Type', 'font/ttf');
		} else if (pathname.endsWith('.eot')) {
			c.header('Content-Type', 'application/vnd.ms-fontobject');
		}
	}
	
	await next();
});

// WebSocket endpoint for host connections
app.get("/__connect", upgradeWebSocket((c) => {
	return {
		onOpen: (evt, ws) => {
			console.log("[Server] Host WebSocket connection established");
			if (ws.raw) {
				tunnelBroker.handleHostWebSocketUpgrade(ws.raw);
			}
		},
		onMessage: (evt, ws) => {
			// Messages are handled by the tunnel broker
		},
		onClose: (evt, ws) => {
			console.log("[Server] Host WebSocket connection closed");
		},
		onError: (evt, ws) => {
			console.error("[Server] Host WebSocket error:", evt);
		}
	};
}));

// Route all other requests to the tunnel broker
app.all("*", async (c) => {
	try {
		const request = c.req.raw;
		const response = await tunnelBroker.handleRequest(request);
		return response;
	} catch (error) {
		console.error("[Server] Error handling request:", {
			url: c.req.url,
			method: c.req.method,
			error: error instanceof Error ? error.message : "Unknown error",
			stack: error instanceof Error ? error.stack : undefined,
		});
		
		// Return appropriate error response based on error type
		if (error instanceof Error) {
			if (error.message.includes("timeout")) {
				return c.text("Gateway Timeout", 504);
			} else if (error.message.includes("connection") || error.message.includes("host")) {
				return c.text("Bad Gateway", 502);
			} else if (error.message.includes("not available") || error.message.includes("not connected")) {
				return c.text("Service Unavailable", 503);
			}
		}
		
		return c.text("Internal Server Error", 500);
	}
});

const port = parseInt(process.env.PORT || "3000");

console.log(`[Server] Starting tunnel broker on port ${port}`);
console.log(`[Server] Health check available at http://localhost:${port}/_health`);

const server = serve(
	{
		fetch: app.fetch,
		port,
	},
	(info) => {
		console.log(`[Server] Tunnel broker is running on http://localhost:${info.port}`);
	}
);

// Inject WebSocket support
injectWebSocket(server);

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
	console.error('[Server] Uncaught Exception:', {
		error: error.message,
		stack: error.stack,
		timestamp: new Date().toISOString(),
	});
	// Don't exit on uncaught exceptions in production
	// Just log them and continue
});

process.on('unhandledRejection', (reason, promise) => {
	console.error('[Server] Unhandled Rejection at:', promise, 'reason:', reason);
	// Don't exit on unhandled rejections
});

// Graceful shutdown handling
process.on("SIGINT", () => {
	console.log("[Server] Received SIGINT, shutting down gracefully...");
	tunnelBroker.cleanup();
	process.exit(0);
});

process.on("SIGTERM", () => {
	console.log("[Server] Received SIGTERM, shutting down gracefully...");
	tunnelBroker.cleanup();
	process.exit(0);
});
