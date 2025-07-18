#!/usr/bin/env node

import http from 'http';
import { URL } from 'url';

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RAILWAY_STATIC_URL || `http://localhost:${PORT}`;

console.log(`🚀 Starting MCP OAuth server on port ${PORT}...`);
console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`Platform: ${process.platform}`);
console.log(`Node version: ${process.version}`);
console.log(`Base URL: ${BASE_URL}`);

// Simple in-memory storage for OAuth clients and tokens
const clients = new Map();
const tokens = new Map();

const server = http.createServer((req: any, res: any) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  const url = new URL(req.url, BASE_URL);
  const path = url.pathname;
  
  // Health check endpoint
  if (path === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ 
      status: 'healthy', 
      timestamp: new Date().toISOString(),
      port: PORT,
      uptime: process.uptime()
    }));
    return;
  }
  
  // OAuth Authorization Server Metadata (RFC 8414)
  if (path === '/.well-known/oauth-authorization-server') {
    res.writeHead(200);
    res.end(JSON.stringify({
      issuer: BASE_URL,
      authorization_endpoint: `${BASE_URL}/authorize`,
      token_endpoint: `${BASE_URL}/token`,
      registration_endpoint: `${BASE_URL}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      scopes_supported: ['gong:read'],
      code_challenge_methods_supported: ['S256']
    }));
    return;
  }
  
  // OAuth Protected Resource (RFC 6749)
  if (path === '/.well-known/oauth-protected-resource') {
    res.writeHead(200);
    res.end(JSON.stringify({
      resource_server: BASE_URL,
      authorization_servers: [BASE_URL],
      scopes_supported: ['gong:read'],
      bearer_methods_supported: ['header', 'query']
    }));
    return;
  }
  
  // Dynamic Client Registration (RFC 7591)
  if (path === '/register' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk: any) => body += chunk);
    req.on('end', () => {
      try {
        const clientData = JSON.parse(body);
        const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const clientSecret = `secret_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        clients.set(clientId, {
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uris: clientData.redirect_uris || [`${BASE_URL}/callback`],
          grant_types: ['authorization_code'],
          response_types: ['code'],
          scope: 'gong:read'
        });
        
        res.writeHead(201);
        res.end(JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uris: [`${BASE_URL}/callback`],
          grant_types: ['authorization_code'],
          response_types: ['code'],
          scope: 'gong:read'
        }));
      } catch (error) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'invalid_request' }));
      }
    });
    return;
  }
  
  // OAuth Authorization Endpoint
  if (path === '/authorize' && req.method === 'GET') {
    const params = url.searchParams;
    const clientId = params.get('client_id');
    const redirectUri = params.get('redirect_uri');
    const responseType = params.get('response_type');
    const scope = params.get('scope');
    const state = params.get('state');
    
    if (!clientId || !clients.has(clientId)) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'invalid_client' }));
      return;
    }
    
    // Generate authorization code
    const authCode = `auth_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    tokens.set(authCode, {
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scope || 'gong:read',
      expires_at: Date.now() + 600000 // 10 minutes
    });
    
    // Redirect with authorization code
    const callback = new URL(redirectUri || `${BASE_URL}/callback`);
    callback.searchParams.set('code', authCode);
    if (state) callback.searchParams.set('state', state);
    
    res.writeHead(302, { Location: callback.toString() });
    res.end();
    return;
  }
  
  // OAuth Token Endpoint
  if (path === '/token' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk: any) => body += chunk);
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const grantType = params.get('grant_type');
        const code = params.get('code');
        const clientId = params.get('client_id');
        const clientSecret = params.get('client_secret');
        
        if (grantType !== 'authorization_code' || !code || !tokens.has(code)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        
        const tokenData = tokens.get(code);
        if (tokenData.expires_at < Date.now()) {
          tokens.delete(code);
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        
        const client = clients.get(clientId);
        if (!client || client.client_secret !== clientSecret) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'invalid_client' }));
          return;
        }
        
        // Generate access token
        const accessToken = `access_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        tokens.set(accessToken, {
          client_id: clientId,
          scope: tokenData.scope,
          expires_at: Date.now() + 3600000 // 1 hour
        });
        
        // Clean up authorization code
        tokens.delete(code);
        
        res.writeHead(200);
        res.end(JSON.stringify({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: tokenData.scope
        }));
      } catch (error) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'invalid_request' }));
      }
    });
    return;
  }
  
  // Default response
  res.writeHead(200);
  res.end(JSON.stringify({ 
    message: 'Gong MCP OAuth server is running', 
    timestamp: new Date().toISOString(),
    port: PORT,
    uptime: process.uptime(),
    endpoints: {
      oauth_metadata: '/.well-known/oauth-authorization-server',
      protected_resource: '/.well-known/oauth-protected-resource',
      register: '/register',
      authorize: '/authorize',
      token: '/token',
      health: '/health'
    }
  }));
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