#!/usr/bin/env node

import http from 'http';
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 3000;

console.error('Starting server...');

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  
  console.error(`Request: ${req.method} ${req.url}`);
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  if (req.url === '/health') {
    console.error('Health check requested');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'healthy', 
      timestamp: new Date().toISOString(),
      port: PORT,
      env: process.env.NODE_ENV || 'production'
    }));
    return;
  }
  
  // OAuth Discovery endpoints that Claude expects
  if (req.url === '/.well-known/oauth-authorization-server') {
    console.error('OAuth authorization server metadata requested');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      issuer: `https://gong-mcp-server-pagination-production.up.railway.app`,
      authorization_endpoint: `https://gong-mcp-server-pagination-production.up.railway.app/authorize`,
      token_endpoint: `https://gong-mcp-server-pagination-production.up.railway.app/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      scopes_supported: ['gong:read']
    }));
    return;
  }
  
  if (req.url === '/.well-known/oauth-protected-resource') {
    console.error('OAuth protected resource metadata requested');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      resource_server: `https://gong-mcp-server-pagination-production.up.railway.app`,
      scopes_supported: ['gong:read']
    }));
    return;
  }
  
  // Simple authorize endpoint
  if (req.url?.startsWith('/authorize')) {
    console.error('OAuth authorize endpoint requested');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'OAuth authorize endpoint' }));
    return;
  }
  
  // Simple token endpoint
  if (req.url === '/token') {
    console.error('OAuth token endpoint requested');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      access_token: 'demo_token',
      token_type: 'Bearer',
      expires_in: 3600
    }));
    return;
  }
  
  // Default response
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ 
    message: 'Gong MCP OAuth Server is running',
    port: PORT,
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/health',
      oauth_metadata: '/.well-known/oauth-authorization-server',
      protected_resource: '/.well-known/oauth-protected-resource',
      authorize: '/authorize',
      token: '/token'
    }
  }));
});

server.listen(parseInt(PORT.toString()), '0.0.0.0', () => {
  console.error(`Server listening on port ${PORT}`);
  console.error(`Health check: http://0.0.0.0:${PORT}/health`);
});

server.on('error', (error) => {
  console.error('Server error:', error);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.error('Received SIGTERM, shutting down gracefully');
  server.close(() => {
    console.error('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.error('Received SIGINT, shutting down gracefully');
  server.close(() => {
    console.error('Server closed');
    process.exit(0);
  });
});