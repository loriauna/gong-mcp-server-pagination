console.log('🚀 Starting server initialization...');
console.log('📦 Node version:', process.version);
console.log('🔧 Platform:', process.platform);
console.log('📁 Current directory:', process.cwd());

import http from 'http';
import { URL } from 'url';

console.log('✅ HTTP and URL modules imported successfully');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RAILWAY_STATIC_URL || `https://gong-mcp-server-pagination-production.up.railway.app`;
const PROTOCOL = BASE_URL.startsWith('http') ? BASE_URL : `https://${BASE_URL}`;

console.log(`🌐 Port configured: ${PORT}`);
console.log(`🔗 Base URL: ${BASE_URL}`);
console.log(`📋 Environment variables: NODE_ENV=${process.env.NODE_ENV}, PORT=${process.env.PORT}`);

// Simple in-memory storage for OAuth clients and tokens
const clients = new Map();
const tokens = new Map();

console.log('🔨 Creating HTTP server...');

const server = http.createServer((req, res) => {
  console.log(`🔄 Request: ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
  
  try {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    const url = new URL(req.url, PROTOCOL);
    const path = url.pathname;
    
    if (path === '/health') {
      console.log('❤️  Health check requested');
      res.writeHead(200);
      const response = { 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        port: PORT,
        uptime: process.uptime(),
        nodeVersion: process.version
      };
      res.end(JSON.stringify(response));
      console.log('✅ Health check response sent');
    } 
    // OAuth Authorization Server Metadata (RFC 8414)
    else if (path === '/.well-known/oauth-authorization-server') {
      console.log('🔐 OAuth authorization server metadata requested');
      res.writeHead(200);
      res.end(JSON.stringify({
        issuer: PROTOCOL,
        authorization_endpoint: `${PROTOCOL}/authorize`,
        token_endpoint: `${PROTOCOL}/token`,
        registration_endpoint: `${PROTOCOL}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: ['gong:read'],
        code_challenge_methods_supported: ['S256']
      }));
      console.log('✅ OAuth metadata response sent');
    }
    // OAuth Protected Resource (RFC 6749)
    else if (path === '/.well-known/oauth-protected-resource') {
      console.log('🔐 OAuth protected resource metadata requested');
      res.writeHead(200);
      res.end(JSON.stringify({
        resource_server: PROTOCOL,
        authorization_servers: [PROTOCOL],
        scopes_supported: ['gong:read'],
        bearer_methods_supported: ['header', 'query']
      }));
      console.log('✅ OAuth protected resource response sent');
    }
    // Dynamic Client Registration (RFC 7591)
    else if (path === '/register' && req.method === 'POST') {
      console.log('🔐 OAuth client registration requested');
      let body = '';
      req.on('data', (chunk) => body += chunk);
      req.on('end', () => {
        try {
          const clientData = JSON.parse(body);
          const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          const clientSecret = `secret_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          
          clients.set(clientId, {
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uris: clientData.redirect_uris || [`${PROTOCOL}/callback`],
            grant_types: ['authorization_code'],
            response_types: ['code'],
            scope: 'gong:read'
          });
          
          res.writeHead(201);
          res.end(JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uris: [`${PROTOCOL}/callback`],
            grant_types: ['authorization_code'],
            response_types: ['code'],
            scope: 'gong:read'
          }));
          console.log('✅ OAuth client registered:', clientId);
        } catch (error) {
          console.error('❌ Error registering client:', error);
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'invalid_request' }));
        }
      });
    }
    // OAuth Authorization Endpoint
    else if (path === '/authorize' && req.method === 'GET') {
      console.log('🔐 OAuth authorization requested');
      const params = url.searchParams;
      const clientId = params.get('client_id');
      const redirectUri = params.get('redirect_uri');
      const state = params.get('state');
      
      if (!clientId || !clients.has(clientId)) {
        console.log('❌ Invalid client ID:', clientId);
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'invalid_client' }));
        return;
      }
      
      // Generate authorization code
      const authCode = `auth_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      tokens.set(authCode, {
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'gong:read',
        expires_at: Date.now() + 600000 // 10 minutes
      });
      
      // Redirect with authorization code
      const callback = new URL(redirectUri || `${PROTOCOL}/callback`);
      callback.searchParams.set('code', authCode);
      if (state) callback.searchParams.set('state', state);
      
      console.log('✅ Authorization code generated, redirecting to:', callback.toString());
      res.writeHead(302, { Location: callback.toString() });
      res.end();
    }
    // OAuth Token Endpoint
    else if (path === '/token' && req.method === 'POST') {
      console.log('🔐 OAuth token requested');
      let body = '';
      req.on('data', (chunk) => body += chunk);
      req.on('end', () => {
        try {
          const params = new URLSearchParams(body);
          const grantType = params.get('grant_type');
          const code = params.get('code');
          const clientId = params.get('client_id');
          const clientSecret = params.get('client_secret');
          
          if (grantType !== 'authorization_code' || !code || !tokens.has(code)) {
            console.log('❌ Invalid grant or code');
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }
          
          const tokenData = tokens.get(code);
          if (tokenData.expires_at < Date.now()) {
            tokens.delete(code);
            console.log('❌ Authorization code expired');
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }
          
          const client = clients.get(clientId);
          if (!client || client.client_secret !== clientSecret) {
            console.log('❌ Invalid client credentials');
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
          console.log('✅ Access token issued:', accessToken);
        } catch (error) {
          console.error('❌ Error processing token request:', error);
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'invalid_request' }));
        }
      });
    }
    else {
      console.log('🏠 Default route requested');
      res.writeHead(200);
      const response = { 
        message: 'Gong MCP OAuth Server is running',
        port: PORT,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        baseUrl: PROTOCOL,
        endpoints: {
          health: '/health',
          oauth_metadata: '/.well-known/oauth-authorization-server',
          protected_resource: '/.well-known/oauth-protected-resource',
          register: '/register',
          authorize: '/authorize',
          token: '/token'
        }
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