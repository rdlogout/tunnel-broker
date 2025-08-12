import WebSocket from 'ws';

// Test WebSocket connection to the host endpoint
function testHostConnection() {
    console.log('Testing WebSocket connection to /__connect endpoint...');
    
    const ws = new WebSocket('ws://localhost:3000/__connect');
    
    ws.on('open', function open() {
        console.log('✅ WebSocket connection established successfully!');
        console.log('Host connection is working properly.');
        
        // Send a test message
        ws.send(JSON.stringify({
            type: 'test',
            message: 'Hello from test client'
        }));
    });
    
    ws.on('message', function message(data) {
        console.log('📨 Received message:', data.toString());
    });
    
    ws.on('error', function error(err) {
        console.error('❌ WebSocket error:', err.message);
    });
    
    ws.on('close', function close(code, reason) {
        console.log(`🔌 WebSocket connection closed. Code: ${code}, Reason: ${reason}`);
    });
    
    // Close connection after 5 seconds
    setTimeout(() => {
        console.log('Closing test connection...');
        ws.close();
    }, 5000);
}

// Wait a moment for server to start, then test
setTimeout(testHostConnection, 2000);

console.log('WebSocket test client starting...');
console.log('Will attempt to connect to ws://localhost:3000/__connect in 2 seconds');