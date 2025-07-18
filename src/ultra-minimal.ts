#!/usr/bin/env node

import http from 'http';

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  
  if (req.url === '/health') {
    res.end(JSON.stringify({ status: 'healthy' }));
  } else {
    res.end(JSON.stringify({ message: 'Server running' }));
  }
});

server.listen(parseInt(PORT.toString()), '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});