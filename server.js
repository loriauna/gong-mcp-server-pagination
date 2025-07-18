import http from 'http';

const PORT = process.env.PORT || 3000;

console.log(`Starting server on port ${PORT}`);

const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  
  if (req.url === '/health') {
    res.end(JSON.stringify({ 
      status: 'healthy',
      timestamp: new Date().toISOString(),
      port: PORT 
    }));
  } else {
    res.end(JSON.stringify({ 
      message: 'Server running',
      port: PORT,
      timestamp: new Date().toISOString()
    }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on 0.0.0.0:${PORT}`);
  console.log(`✅ Health check: http://0.0.0.0:${PORT}/health`);
});

server.on('error', (error) => {
  console.error('❌ Server error:', error);
  process.exit(1);
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