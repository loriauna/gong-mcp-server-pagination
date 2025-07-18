#!/usr/bin/env node

import http from 'http';
import dotenv from 'dotenv';
import axios from 'axios';
import crypto from 'crypto';
import { URL } from 'url';

dotenv.config();

const GONG_API_URL = 'https://api.gong.io/v2';
const GONG_ACCESS_KEY = process.env.GONG_ACCESS_KEY;
const GONG_ACCESS_SECRET = process.env.GONG_ACCESS_SECRET;
const PORT = process.env.PORT || 3000;

// Check for required environment variables
if (!GONG_ACCESS_KEY || !GONG_ACCESS_SECRET) {
  console.error("Error: GONG_ACCESS_KEY and GONG_ACCESS_SECRET environment variables are required");
  process.exit(1);
}

// Type definitions
interface GongCall {
  id: string;
  title: string;
  scheduled?: string;
  started?: string;
  duration?: number;
  direction?: string;
  system?: string;
  scope?: string;
  media?: string;
  language?: string;
  url?: string;
}

interface GongTranscript {
  speakerId: string;
  topic?: string;
  sentences: Array<{
    start: number;
    text: string;
  }>;
}

interface GongPaginationInfo {
  totalRecords: number;
  currentPageSize: number;
  currentPageNumber: number;
  cursor?: string;
}

interface GongListCallsResponse {
  calls: GongCall[];
  records?: GongPaginationInfo;
}

interface GongRetrieveTranscriptsResponse {
  transcripts: GongTranscript[];
  records?: GongPaginationInfo;
}

interface GongListCallsArgs {
  [key: string]: string | number | undefined;
  fromDateTime?: string;
  toDateTime?: string;
  cursor?: string;
  limit?: number;
}

interface GongRetrieveTranscriptsArgs {
  callIds: string[];
  cursor?: string;
  limit?: number;
}

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

  async listCalls(fromDateTime?: string, toDateTime?: string, cursor?: string, limit?: number): Promise<GongListCallsResponse> {
    const params: GongListCallsArgs = {};
    if (fromDateTime) params.fromDateTime = fromDateTime;
    if (toDateTime) params.toDateTime = toDateTime;
    if (cursor) params.cursor = cursor;
    if (limit) params.limit = limit;

    return this.request<GongListCallsResponse>('GET', '/calls', params);
  }

  async retrieveTranscripts(callIds: string[], cursor?: string, limit?: number): Promise<GongRetrieveTranscriptsResponse> {
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

    return this.request<GongRetrieveTranscriptsResponse>('POST', '/calls/transcript', undefined, requestData);
  }
}

const gongClient = new GongClient(GONG_ACCESS_KEY, GONG_ACCESS_SECRET);

// Type guards
function isGongListCallsArgs(args: unknown): args is GongListCallsArgs {
  return (
    typeof args === "object" &&
    args !== null &&
    (!("fromDateTime" in args) || typeof (args as GongListCallsArgs).fromDateTime === "string") &&
    (!("toDateTime" in args) || typeof (args as GongListCallsArgs).toDateTime === "string") &&
    (!("cursor" in args) || typeof (args as GongListCallsArgs).cursor === "string") &&
    (!("limit" in args) || typeof (args as GongListCallsArgs).limit === "number")
  );
}

function isGongRetrieveTranscriptsArgs(args: unknown): args is GongRetrieveTranscriptsArgs {
  return (
    typeof args === "object" &&
    args !== null &&
    "callIds" in args &&
    Array.isArray((args as GongRetrieveTranscriptsArgs).callIds) &&
    (args as GongRetrieveTranscriptsArgs).callIds.every(id => typeof id === "string") &&
    (!("cursor" in args) || typeof (args as GongRetrieveTranscriptsArgs).cursor === "string") &&
    (!("limit" in args) || typeof (args as GongRetrieveTranscriptsArgs).limit === "number")
  );
}

// Tool handlers
async function handleListCalls(args: GongListCallsArgs) {
  const { fromDateTime, toDateTime, cursor, limit } = args;
  const response = await gongClient.listCalls(fromDateTime, toDateTime, cursor, limit);
  return response;
}

async function handleRetrieveTranscripts(args: GongRetrieveTranscriptsArgs) {
  const { callIds, cursor, limit } = args;
  const response = await gongClient.retrieveTranscripts(callIds, cursor, limit);
  return response;
}

// Parse URL query parameters
function parseQueryParams(url: string): Record<string, any> {
  const urlObj = new URL(url, 'http://localhost');
  const params: Record<string, any> = {};
  
  for (const [key, value] of urlObj.searchParams) {
    // Handle special cases
    if (key === 'limit') {
      params[key] = parseInt(value, 10);
    } else if (key === 'callIds') {
      // Handle comma-separated call IDs
      params[key] = value.split(',').map(id => id.trim());
    } else {
      params[key] = value;
    }
  }
  
  return params;
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  console.error(`${new Date().toISOString()} - ${req.method} ${req.url}`);

  try {
    // Health check
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        service: 'gong-mcp-server'
      }));
      return;
    }

    // API endpoints
    if (req.url?.startsWith('/api/calls') && req.method === 'GET') {
      const params = parseQueryParams(req.url);
      
      if (!isGongListCallsArgs(params)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid parameters for list_calls' }));
        return;
      }

      const result = await handleListCalls(params);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.url?.startsWith('/api/transcripts') && req.method === 'GET') {
      const params = parseQueryParams(req.url);
      
      if (!isGongRetrieveTranscriptsArgs(params)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid parameters for retrieve_transcripts' }));
        return;
      }

      const result = await handleRetrieveTranscripts(params);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // POST endpoints for more complex requests
    if (req.url === '/api/calls' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', async () => {
        try {
          const params = JSON.parse(body);
          
          if (!isGongListCallsArgs(params)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid parameters for list_calls' }));
            return;
          }

          const result = await handleListCalls(params);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
      return;
    }

    if (req.url === '/api/transcripts' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', async () => {
        try {
          const params = JSON.parse(body);
          
          if (!isGongRetrieveTranscriptsArgs(params)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid parameters for retrieve_transcripts' }));
            return;
          }

          const result = await handleRetrieveTranscripts(params);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
      return;
    }

    // API documentation
    if (req.url === '/api' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: 'Gong MCP HTTP Server',
        version: '1.0.0',
        description: 'HTTP API for Gong MCP functionality with pagination support',
        endpoints: {
          health: {
            path: '/health',
            method: 'GET',
            description: 'Health check endpoint'
          },
          listCalls: {
            path: '/api/calls',
            methods: ['GET', 'POST'],
            description: 'List Gong calls with optional date range filtering and pagination',
            parameters: {
              fromDateTime: 'Start date/time in ISO format (optional)',
              toDateTime: 'End date/time in ISO format (optional)',
              cursor: 'Cursor for pagination (optional)',
              limit: 'Maximum number of results (optional, default: 100, max: 100)'
            },
            examples: {
              get: '/api/calls?fromDateTime=2024-01-01T00:00:00Z&toDateTime=2024-12-31T23:59:59Z&limit=50',
              post: 'POST /api/calls with JSON body: {"fromDateTime": "2024-01-01T00:00:00Z", "limit": 50}'
            }
          },
          retrieveTranscripts: {
            path: '/api/transcripts',
            methods: ['GET', 'POST'],
            description: 'Retrieve transcripts for specified call IDs with pagination',
            parameters: {
              callIds: 'Array of call IDs (required)',
              cursor: 'Cursor for pagination (optional)',
              limit: 'Maximum number of results (optional, default: 100, max: 100)'
            },
            examples: {
              get: '/api/transcripts?callIds=123,456,789&limit=50',
              post: 'POST /api/transcripts with JSON body: {"callIds": ["123", "456"], "limit": 50}'
            }
          }
        }
      }));
      return;
    }

    // 404 for unknown endpoints
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));

  } catch (error) {
    console.error('Server error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

// Start server
server.listen(parseInt(PORT.toString()), '0.0.0.0', () => {
  console.error(`Gong MCP HTTP Server running on port ${PORT}`);
  console.error(`Health check: http://0.0.0.0:${PORT}/health`);
  console.error(`API documentation: http://0.0.0.0:${PORT}/api`);
  console.error(`List calls: http://0.0.0.0:${PORT}/api/calls`);
  console.error(`Retrieve transcripts: http://0.0.0.0:${PORT}/api/transcripts`);
});

// Graceful shutdown
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

server.on('error', (error) => {
  console.error('Server error:', error);
  process.exit(1);
});