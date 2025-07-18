#!/usr/bin/env node

import http from 'http';

const PORT = process.env.PORT || 3000;

console.log(`Starting minimal server on port ${PORT}...`);

const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  
  res.setHeader('Content-Type', 'application/json');
  
  if (req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }));
  } else {
    res.writeHead(200);
    res.end(JSON.stringify({ message: 'Minimal server is running', timestamp: new Date().toISOString() }));
  }
});

server.listen(parseInt(PORT.toString()), '0.0.0.0', () => {
  console.log(`✅ Minimal server running on port ${PORT}`);
  console.log(`Health check: http://0.0.0.0:${PORT}/health`);
});

server.on('error', (error) => {
  console.error('Server error:', error);
  process.exit(1);
});

// Keep the process alive
setInterval(() => {
  console.log(`Server alive at ${new Date().toISOString()}`);
}, 30000);