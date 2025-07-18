console.log('🚀 Starting server initialization...');
console.log('📦 Node version:', process.version);
console.log('🔧 Platform:', process.platform);
console.log('📁 Current directory:', process.cwd());

import http from 'http';

console.log('✅ HTTP module imported successfully');

const PORT = process.env.PORT || 3000;

console.log(`🌐 Port configured: ${PORT}`);
console.log(`📋 Environment variables: NODE_ENV=${process.env.NODE_ENV}, PORT=${process.env.PORT}`);

console.log('🔨 Creating HTTP server...');

const server = http.createServer((req, res) => {
  console.log(`🔄 Request: ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
  
  try {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(200);
    
    if (req.url === '/health') {
      console.log('❤️  Health check requested');
      const response = { 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        port: PORT,
        uptime: process.uptime(),
        nodeVersion: process.version
      };
      res.end(JSON.stringify(response));
      console.log('✅ Health check response sent');
    } else {
      console.log('🏠 Default route requested');
      const response = { 
        message: 'Server running',
        port: PORT,
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      };
      res.end(JSON.stringify(response));
      console.log('✅ Default response sent');
    }
  } catch (error) {
    console.error('❌ Error handling request:', error);
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

console.log('📡 HTTP server created, attempting to listen...');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎉 SUCCESS: Server listening on 0.0.0.0:${PORT}`);
  console.log(`🔗 Health check URL: http://0.0.0.0:${PORT}/health`);
  console.log(`⏰ Server started at: ${new Date().toISOString()}`);
});

server.on('error', (error) => {
  console.error('💥 CRITICAL SERVER ERROR:', error);
  console.error('💥 Error details:', {
    code: error.code,
    errno: error.errno,
    syscall: error.syscall,
    address: error.address,
    port: error.port
  });
  process.exit(1);
});

server.on('listening', () => {
  console.log('🎯 Server is now listening for connections');
});

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

process.on('uncaughtException', (error) => {
  console.error('💥 UNCAUGHT EXCEPTION:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION at:', promise, 'reason:', reason);
  process.exit(1);
});

console.log('🔧 All event handlers registered');
console.log('⚡ Server initialization complete - waiting for connections...');