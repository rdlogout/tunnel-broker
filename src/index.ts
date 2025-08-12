import { createServer, request as httpRequest } from "http";
import { createServer as createTcpServer, createConnection } from "net";
import ssh2 from "ssh2";
import { generateKeyPairSync } from "crypto";
import type { Connection, AcceptConnection, RejectConnection, TcpipRequestInfo, AuthContext } from "ssh2";
const { Server } = ssh2;

// Generate a temporary host key for the SSH server in the correct format
const { privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	publicKeyEncoding: { type: "spki", format: "pem" },
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

const sshServer = new Server({
	hostKeys: [privateKey],
});
const httpServer = createServer();

// SSH Server Configuration
sshServer
	.on("connection", (client: Connection) => {
		console.log("SSH client connected");

		client.on("authentication", (ctx: AuthContext) => {
			if (ctx.method === "password" && ctx.username === "proxyuser" && ctx.password === "secret") {
				ctx.accept();
			} else {
				ctx.reject();
			}
		});

		client.on("ready", () => {
			console.log("SSH client authenticated");

			client.on("request", (accept: AcceptConnection<any> | undefined, reject: RejectConnection | undefined, name: string, info: any) => {
				if (name === "tcpip-forward") {
					console.log(`Setting up port forwarding for ${info.bindAddr}:${info.bindPort}`);

					// Create a TCP server to listen on the requested port
					const tcpServer = createTcpServer((socket) => {
						console.log(`Incoming connection to tunnel port ${info.bindPort}`);

						// For reverse tunnel, directly connect to the local service
						const targetSocket = createConnection(3000, "127.0.0.1", () => {
							console.log("Connected to target service on port 3000");
							// Pipe data between the tunnel socket and target socket
							socket.pipe(targetSocket);
							targetSocket.pipe(socket);
						});

						targetSocket.on("error", (err: any) => {
							console.error("Target socket error:", err);
							socket.end();
						});

						socket.on("error", (err: any) => {
							console.error("Tunnel socket error:", err);
							targetSocket.end();
						});

						socket.on("close", () => {
							targetSocket.end();
						});

						targetSocket.on("close", () => {
							socket.end();
						});
					});

					tcpServer.listen(info.bindPort, info.bindAddr, () => {
						console.log(`TCP server listening on ${info.bindAddr}:${info.bindPort}`);
						accept?.();
					});

					tcpServer.on("error", (err) => {
						console.error("TCP server error:", err);
						reject?.();
					});
				} else if (name === "cancel-tcpip-forward") {
					console.log(`Canceling port forwarding for ${info.bindAddr}:${info.bindPort}`);
					accept?.();
				} else {
					reject?.();
				}
			});

			client.on("tcpip", (accept: AcceptConnection<any>, reject: RejectConnection, info: TcpipRequestInfo) => {
				const stream = accept();
				console.log(`Forwarding connection from ${info.srcIP}:${info.srcPort} to ${info.destIP}:${info.destPort}`);

				// Proxy HTTP requests to tunnel
				httpServer.emit("proxy-request", stream);
			});
		});
	})
	.listen(2222, () => {
		console.log("SSH server listening on port 2222");
	});

// Store active tunnel connections
let tunnelStream: any = null;

// HTTP Server Configuration
httpServer.on("request", (req, res) => {
	console.log(`Proxying request: ${req.method} ${req.url}`);

	// Try to connect through the SSH tunnel to the forwarded port
	const proxyReq = httpRequest(
		{
			host: "127.0.0.1",
			port: 3000, // This should connect through the SSH tunnel to host:3000
			method: req.method,
			path: req.url,
			headers: req.headers,
		},
		(proxyRes) => {
			console.log(`Received response: ${proxyRes.statusCode}`);
			res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
			proxyRes.pipe(res);
		}
	);

	proxyReq.on("error", (err) => {
		console.error("Proxy request error:", err);
		res.writeHead(502, { "Content-Type": "text/plain" });
		res.end("Bad Gateway - SSH tunnel not available");
	});

	req.pipe(proxyReq);
});

httpServer.on("proxy-request", (stream) => {
	// Store the tunnel stream for HTTP proxying
	tunnelStream = stream;
	console.log("Tunnel stream established");

	// Handle stream close
	stream.on("close", () => {
		tunnelStream = null;
		console.log("Tunnel stream closed");
	});
});

httpServer.listen(8000, () => {
	console.log("HTTP server listening on port 8000");
});
