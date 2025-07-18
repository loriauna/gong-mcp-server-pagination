#!/usr/bin/env node

import http from 'http';
import { URL } from 'url';
import axios from 'axios';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RAILWAY_STATIC_URL || `http://localhost:${PORT}`;

console.log(`🚀 Starting Gong MCP OAuth server on port ${PORT}...`);
console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`Platform: ${process.platform}`);
console.log(`Node version: ${process.version}`);
console.log(`Base URL: ${BASE_URL}`);

// Gong API configuration
const GONG_API_URL = 'https://api.gong.io/v2';
const GONG_ACCESS_KEY = process.env.GONG_ACCESS_KEY;
const GONG_ACCESS_SECRET = process.env.GONG_ACCESS_SECRET;

// Simple in-memory storage for OAuth clients and tokens
const clients = new Map();
const tokens = new Map();

// Gong API Client
class GongClient {
  private accessKey: string;
  private accessSecret: string;

  constructor(accessKey: string, accessSecret: string) {
    this.accessKey = accessKey;
    this.accessSecret = accessSecret;
  }

  private async generateSignature(method: string, path: string, timestamp: string, params?: unknown): Promise<string> {
    const stringToSign = `${method}\n${path}\n${timestamp}\n${params ? JSON.stringify(params) : ''}`;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(this.accessSecret);
    const messageData = encoder.encode(stringToSign);
    
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    
    const signature = await crypto.subtle.sign(
      'HMAC',
      cryptoKey,
      messageData
    );
    
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  private async request<T>(method: string, path: string, params?: Record<string, string | number | undefined>, data?: Record<string, unknown>): Promise<T> {
    const timestamp = new Date().toISOString();
    const url = `${GONG_API_URL}${path}`;
    
    const response = await axios({
      method,
      url,
      params,
      data,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${Buffer.from(`${this.accessKey}:${this.accessSecret}`).toString('base64')}`,
        'X-Gong-AccessKey': this.accessKey,
        'X-Gong-Timestamp': timestamp,
        'X-Gong-Signature': await this.generateSignature(method, path, timestamp, data || params)
      }
    });

    return response.data as T;
  }

  async listCalls(fromDateTime?: string, toDateTime?: string, cursor?: string, limit?: number): Promise<any> {
    const params: any = {};
    if (fromDateTime) params.fromDateTime = fromDateTime;
    if (toDateTime) params.toDateTime = toDateTime;
    if (cursor) params.cursor = cursor;
    if (limit) params.limit = limit;

    return this.request<any>('GET', '/calls', params);
  }

  async retrieveTranscripts(callIds: string[], cursor?: string, limit?: number): Promise<any> {
    const requestData: any = {
      filter: {
        callIds,
        includeEntities: true,
        includeInteractionsSummary: true,
        includeTrackers: true
      }
    };

    if (cursor) requestData.cursor = cursor;
    if (limit) requestData.limit = limit;

    return this.request<any>('POST', '/calls/transcript', undefined, requestData);
  }
}

// Initialize Gong client if credentials are available
let gongClient: GongClient | null = null;
if (GONG_ACCESS_KEY && GONG_ACCESS_SECRET) {
  gongClient = new GongClient(GONG_ACCESS_KEY, GONG_ACCESS_SECRET);
  console.log('✅ Gong client initialized');
} else {
  console.log('⚠️  Gong credentials not found, API functionality will be limited');
}

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
  
  // MCP Tools endpoint
  if (path === '/tools' && req.method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({
      tools: [
        {
          name: "list_calls",
          description: "List Gong calls with optional date range filtering and pagination. Returns call details including ID, title, start/end times, participants, and duration. Supports pagination with cursor and limit parameters.",
          inputSchema: {
            type: "object",
            properties: {
              fromDateTime: {
                type: "string",
                description: "Start date/time in ISO format (e.g. 2024-03-01T00:00:00Z)"
              },
              toDateTime: {
                type: "string",
                description: "End date/time in ISO format (e.g. 2024-03-31T23:59:59Z)"
              },
              cursor: {
                type: "string",
                description: "Cursor for pagination. Use the cursor value from the previous response to get the next page of results."
              },
              limit: {
                type: "integer",
                description: "Maximum number of results to return (default: 100, max: 100)"
              }
            }
          }
        },
        {
          name: "retrieve_transcripts",
          description: "Retrieve transcripts for specified call IDs with pagination support. Returns detailed transcripts including speaker IDs, topics, and timestamped sentences.",
          inputSchema: {
            type: "object",
            properties: {
              callIds: {
                type: "array",
                items: { type: "string" },
                description: "Array of Gong call IDs to retrieve transcripts for"
              },
              cursor: {
                type: "string",
                description: "Cursor for pagination. Use the cursor value from the previous response to get the next page of results."
              },
              limit: {
                type: "integer",
                description: "Maximum number of results to return (default: 100, max: 100)"
              }
            },
            required: ["callIds"]
          }
        }
      ]
    }));
    return;
  }
  
  // MCP Call Tool endpoint
  if (path === '/call-tool' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk: any) => body += chunk);
    req.on('end', async () => {
      try {
        const { name, arguments: args } = JSON.parse(body);
        
        if (!gongClient) {
          res.writeHead(400);
          res.end(JSON.stringify({ 
            error: 'Gong API credentials not configured',
            content: [{ type: 'text', text: 'Gong API credentials not configured. Please set GONG_ACCESS_KEY and GONG_ACCESS_SECRET environment variables.' }],
            isError: true
          }));
          return;
        }
        
        switch (name) {
          case 'list_calls': {
            const { fromDateTime, toDateTime, cursor, limit } = args || {};
            const response = await gongClient.listCalls(fromDateTime, toDateTime, cursor, limit);
            res.writeHead(200);
            res.end(JSON.stringify({
              content: [{ 
                type: "text", 
                text: JSON.stringify(response, null, 2)
              }],
              isError: false,
            }));
            break;
          }
          
          case 'retrieve_transcripts': {
            const { callIds, cursor, limit } = args || {};
            if (!callIds || !Array.isArray(callIds)) {
              res.writeHead(400);
              res.end(JSON.stringify({
                error: 'callIds parameter is required and must be an array',
                content: [{ type: 'text', text: 'callIds parameter is required and must be an array' }],
                isError: true
              }));
              return;
            }
            const response = await gongClient.retrieveTranscripts(callIds, cursor, limit);
            res.writeHead(200);
            res.end(JSON.stringify({
              content: [{ 
                type: "text", 
                text: JSON.stringify(response, null, 2)
              }],
              isError: false,
            }));
            break;
          }
          
          default:
            res.writeHead(400);
            res.end(JSON.stringify({
              error: `Unknown tool: ${name}`,
              content: [{ type: 'text', text: `Unknown tool: ${name}` }],
              isError: true
            }));
        }
      } catch (error) {
        res.writeHead(500);
        res.end(JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true
        }));
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
    gongConfigured: !!gongClient,
    endpoints: {
      oauth_metadata: '/.well-known/oauth-authorization-server',
      protected_resource: '/.well-known/oauth-protected-resource',
      register: '/register',
      authorize: '/authorize',
      token: '/token',
      health: '/health',
      tools: '/tools',
      call_tool: '/call-tool'
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