import WebSocket from "ws";

// Create WebSocket client
const ws = new WebSocket("ws://localhost:8000/ws");

// Connection opened
ws.on("open", function () {
	console.log("Connected to WebSocket server");

	// Send a test message
	ws.send("Hello Server!");
});

// Listen for messages
ws.on("message", function (data) {
	console.log("Received:", data.toString());
});

// Handle errors
ws.on("error", function (error) {
	console.error("WebSocket error:", error);
});

// Handle connection close
ws.on("close", function () {
	console.log("Disconnected from WebSocket server");
});
