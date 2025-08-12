#!/bin/bash

# Test SSH tunnel connection script
# This script tests the SSH reverse tunnel connection to the tunnel broker

echo "Testing SSH tunnel connection..."
echo "Server should be running on localhost:2222"
echo "HTTP proxy should be available on localhost:8000"
echo ""

# Check if SSH server is listening
echo "1. Checking if SSH server is listening on port 2222:"
if netstat -ln | grep -q ":2222 "; then
    echo "✓ SSH server is listening on port 2222"
else
    echo "✗ SSH server is NOT listening on port 2222"
    exit 1
fi

# Check if HTTP server is listening
echo "\n2. Checking if HTTP server is listening on port 8000:"
if netstat -ln | grep -q ":8000 "; then
    echo "✓ HTTP server is listening on port 8000"
else
    echo "✗ HTTP server is NOT listening on port 8000"
    exit 1
fi

# Test SSH connection with verbose output
echo "\n3. Testing SSH connection with verbose output:"
echo "Command: ssh -v -R 0:localhost:3000 test@localhost -p 2222"
echo "Note: This will show detailed SSH handshake information"
echo "Press Ctrl+C to stop if it hangs"
echo ""

# Use timeout to prevent hanging
timeout 10s ssh -v -R 0:localhost:3000 test@localhost -p 2222 2>&1 | head -20

echo "\n4. Connection test completed."
echo "If you see 'parse packet: incomplete message', there's an issue with the SSH protocol implementation."
echo "Check the server logs for more details."