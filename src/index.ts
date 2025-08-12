import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { TunnelBroker } from "./tunnel.js";

const app = new Hono();

// Create a single global tunnel broker instance
const tunnelBroker = new TunnelBroker();

// Health check endpoint
app.get("/_health", (c) => {
	console.log("[Server] Health check requested");
	return c.text("OK");
});

// Route all other requests to the tunnel broker
app.all("*", async (c) => {
	try {
		const request = c.req.raw;
		const response = await tunnelBroker.handleRequest(request);
		return response;
	} catch (error) {
		console.error("[Server] Error handling request:", error);
		return c.text("Internal Server Error", 500);
	}
});

const port = parseInt(process.env.PORT || "3000");

console.log(`[Server] Starting tunnel broker on port ${port}`);
console.log(`[Server] Health check available at http://localhost:${port}/_health`);

serve(
	{
		fetch: app.fetch,
		port,
	},
	(info) => {
		console.log(`[Server] Tunnel broker is running on http://localhost:${info.port}`);
	}
);

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
