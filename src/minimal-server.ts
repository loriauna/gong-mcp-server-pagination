#!/usr/bin/env node

import http from 'http';

const PORT = process.env.PORT || 3000;

console.log(`🚀 Starting minimal server on port ${PORT}...`);
console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`Platform: ${process.platform}`);
console.log(`Node version: ${process.version}`);

const server = http.createServer((req: any, res: any) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  if (req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ 
      status: 'healthy', 
      timestamp: new Date().toISOString(),
      port: PORT,
      uptime: process.uptime()
    }));
  } else {
    res.writeHead(200);
    res.end(JSON.stringify({ 
      message: 'Minimal server is running', 
      timestamp: new Date().toISOString(),
      port: PORT,
      uptime: process.uptime()
    }));
  }
});

server.listen(parseInt(PORT.toString()), '0.0.0.0', () => {
  console.log(`✅ Minimal server running on port ${PORT}`);
  console.log(`✅ Listening on 0.0.0.0:${PORT}`);
  console.log(`✅ Health check: http://0.0.0.0:${PORT}/health`);
  console.log(`✅ Server startup complete at ${new Date().toISOString()}`);
});

server.on('error', (error: any) => {
  console.error('❌ Server error:', error);
  process.exit(1);
});

server.on('listening', () => {
  console.log(`🎉 Server is listening on port ${PORT}`);
});

// Keep the process alive and log status
setInterval(() => {
  console.log(`💓 Server alive at ${new Date().toISOString()}, uptime: ${process.uptime()}s`);
}, 30000);

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('📥 Received SIGTERM, shutting down gracefully');
  server.close(() => {
    console.log('🔥 Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('📥 Received SIGINT, shutting down gracefully');
  server.close(() => {
    console.log('🔥 Server closed');
    process.exit(0);
  });
});

console.log('🔧 Process handlers set up complete');