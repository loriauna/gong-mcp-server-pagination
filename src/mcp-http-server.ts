#!/usr/bin/env node

import {
  Tool,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios';
import dotenv from 'dotenv';
import crypto from 'crypto';
import http from 'http';
import { randomUUID } from 'crypto';

// Redirect all console output to stderr
const originalConsole = { ...console };
console.log = (...args) => originalConsole.error(...args);
console.info = (...args) => originalConsole.error(...args);
console.warn = (...args) => originalConsole.error(...args);

dotenv.config();

const GONG_API_URL = 'https://api.gong.io/v2';
const GONG_ACCESS_KEY = process.env.GONG_ACCESS_KEY;
const GONG_ACCESS_SECRET = process.env.GONG_ACCESS_SECRET;

// Session management for MCP connections
const activeSessions = new Map<string, { lastActivity: Date; initialized: boolean; sseResponse?: http.ServerResponse }>();
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// OAuth storage (simple in-memory for now)
const oauthClients = new Map();
const oauthTokens = new Map();
const BASE_URL = process.env.RAILWAY_STATIC_URL || `https://gong-mcp-server-pagination-production.up.railway.app`;
const PROTOCOL = BASE_URL.startsWith('http') ? BASE_URL : `https://${BASE_URL}`;

// Debug counters
let mcpRequestCount = 0;
let connectionAttempts = 0;

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

const gongClient = GONG_ACCESS_KEY && GONG_ACCESS_SECRET ? 
  new GongClient(GONG_ACCESS_KEY, GONG_ACCESS_SECRET) : 
  null;

// Resource definitions
const GONG_CALL_RESOURCE = {
  uri: "gong://calls",
  name: "Gong Calls",
  description: "Access to Gong call data including recordings, transcripts, and metadata",
  mimeType: "application/json"
};

// Prompt definitions  
const ANALYZE_CALLS_PROMPT = {
  name: "analyze_calls",
  description: "Analyze Gong calls for insights, patterns, and action items",
  arguments: [
    {
      name: "date_range",
      description: "Date range to analyze (e.g., 'last 7 days', 'this month')",
      required: false
    },
    {
      name: "focus_area", 
      description: "Specific area to focus analysis on (e.g., 'objections', 'next steps', 'sentiment')",
      required: false
    }
  ]
};

const SUMMARIZE_TRANSCRIPT_PROMPT = {
  name: "summarize_transcript", 
  description: "Summarize a call transcript with key points, decisions, and action items",
  arguments: [
    {
      name: "call_id",
      description: "The Gong call ID to summarize",
      required: true
    },
    {
      name: "summary_type",
      description: "Type of summary needed (brief, detailed, action_items, sentiment)",
      required: false
    }
  ]
};

// Tool definitions
const LIST_CALLS_TOOL: Tool = {
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
        description: "Maximum number of results to return (default: 100, max: 100)",
        minimum: 1,
        maximum: 100
      }
    },
    additionalProperties: false
  }
};

const RETRIEVE_TRANSCRIPTS_TOOL: Tool = {
  name: "retrieve_transcripts", 
  description: "Retrieve transcripts for specified call IDs with pagination support. Returns detailed transcripts including speaker IDs, topics, and timestamped sentences.",
  inputSchema: {
    type: "object",
    properties: {
      callIds: {
        type: "array",
        items: { type: "string" },
        description: "Array of Gong call IDs to retrieve transcripts for",
        minItems: 1
      },
      cursor: {
        type: "string",
        description: "Cursor for pagination. Use the cursor value from the previous response to get the next page of results."
      },
      limit: {
        type: "integer",
        description: "Maximum number of results to return (default: 100, max: 100)",
        minimum: 1,
        maximum: 100
      }
    },
    required: ["callIds"],
    additionalProperties: false
  }
};

// MCP Protocol Handler Functions
function handleInitialize(request: any) {
  console.error('🎉 Handling initialize request');
  return {
    jsonrpc: '2.0',
    id: request.id,
    result: {
      protocolVersion: '2025-06-18',
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: false, listChanged: true },
        prompts: { listChanged: true }
      },
      serverInfo: {
        name: 'gong-mcp-server',
        version: '0.1.0'
      }
    }
  };
}

function handleToolsList(request: any) {
  console.error('🔧 Handling tools/list request');
  return {
    jsonrpc: '2.0',
    id: request.id,
    result: {
      tools: [LIST_CALLS_TOOL, RETRIEVE_TRANSCRIPTS_TOOL],
      nextCursor: null // No pagination for now
    }
  };
}

function handleResourcesList(request: any) {
  console.error('📚 Handling resources/list request');
  return {
    jsonrpc: '2.0',
    id: request.id,
    result: {
      resources: [GONG_CALL_RESOURCE]
    }
  };
}

function handleResourceRead(request: any) {
  console.error('📖 Handling resource read request');
  return {
    jsonrpc: '2.0',
    id: request.id,
    result: {
      contents: [{
        uri: request.params.uri,
        mimeType: 'application/json',
        text: JSON.stringify({
          message: 'Gong resource access',
          uri: request.params.uri,
          available_calls: 'Use list_calls tool to retrieve'
        })
      }]
    }
  };
}

function handlePromptsList(request: any) {
  console.error('💭 Handling prompts/list request');
  return {
    jsonrpc: '2.0',
    id: request.id,
    result: {
      prompts: [ANALYZE_CALLS_PROMPT, SUMMARIZE_TRANSCRIPT_PROMPT]
    }
  };
}

function handlePromptGet(request: any) {
  console.error('📝 Handling prompt get request');
  const promptName = request.params?.name;
  let prompt = null;
  
  if (promptName === 'analyze_calls') {
    prompt = ANALYZE_CALLS_PROMPT;
  } else if (promptName === 'summarize_transcript') {
    prompt = SUMMARIZE_TRANSCRIPT_PROMPT;
  }
  
  if (!prompt) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32602, message: 'Prompt not found' }
    };
  }
  
  return {
    jsonrpc: '2.0',
    id: request.id,
    result: {
      description: prompt.description,
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Execute ${prompt.name}: ${prompt.description}`
        }
      }]
    }
  };
}

function handleInitialized(request: any) {
  console.error('✅ Handling initialized notification - no response needed');
  return null; // Notifications don't need responses
}

function handlePing(request: any) {
  return {
    jsonrpc: '2.0',
    id: request.id,
    result: {}
  };
}

async function handleToolCall(request: any) {
  console.error('🛠️ Handling tool call:', request.params?.name);
  try {
    const { name, arguments: args } = request.params;

    if (!gongClient) {
      throw new Error("Gong API credentials not configured");
    }

    if (!args) {
      throw new Error("No arguments provided");
    }

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

    switch (name) {
      case "list_calls": {
        if (!isGongListCallsArgs(args)) {
          throw new Error("Invalid arguments for list_calls");
        }
        const { fromDateTime, toDateTime, cursor, limit } = args;
        const response = await gongClient.listCalls(fromDateTime, toDateTime, cursor, limit);
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            content: [{ 
              type: "text", 
              text: JSON.stringify(response, null, 2)
            }],
            isError: false
          }
        };
      }

      case "retrieve_transcripts": {
        if (!isGongRetrieveTranscriptsArgs(args)) {
          throw new Error("Invalid arguments for retrieve_transcripts");
        }
        const { callIds, cursor, limit } = args;
        const response = await gongClient.retrieveTranscripts(callIds, cursor, limit);
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            content: [{ 
              type: "text", 
              text: JSON.stringify(response, null, 2)
            }],
            isError: false
          }
        };
      }

      default:
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32601,
            message: `Unknown tool: ${name}`
          }
        };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32603,
        message: `Error occurred while making the request: ${errorMessage}`
      }
    };
  }
}

// MCP Request/Response handlers
function createMCPHandlers() {
  // MCP Protocol handlers
  const handlers = {
    'initialize': handleInitialize,
    'tools/list': handleToolsList,
    'tools/call': handleToolCall,
    'resources/list': handleResourcesList,
    'resources/read': handleResourceRead,
    'prompts/list': handlePromptsList,
    'prompts/get': handlePromptGet,
    'notifications/initialized': handleInitialized,
    'ping': handlePing
  };

  return handlers;
}

// HTTP MCP Transport Implementation
async function createHTTPMCPServer() {
  const PORT = process.env.PORT;
  
  if (!PORT) {
    console.error('No PORT environment variable set - cannot start HTTP server');
    process.exit(1);
  }

  // HTTP server for MCP transport
  const mcpHandlers = createMCPHandlers();
  
  const httpServer = http.createServer(async (req, res) => {
    console.error(`\n=== INCOMING REQUEST ===`);
    console.error(`${req.method} ${req.url}`);
    console.error('Headers:', JSON.stringify(req.headers, null, 2));
    console.error('User-Agent:', req.headers['user-agent']);
    console.error('========================\n');
    
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Mcp-Session-Id');
    
    if (req.method === 'OPTIONS') {
      console.error('CORS preflight request handled');
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url || '', `http://localhost:${PORT}`);
    const path = url.pathname;

    // MCP Manifest endpoint
    if (path === '/mcp.json' || path === '/.well-known/mcp.json' || path === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'mcp-server',
        version: '0.1.0',
        protocol_version: '2025-06-18',
        name: 'Gong MCP Server',
        description: 'Access Gong call data through MCP',
        vendor: 'gong-mcp',
        capabilities: {
          tools: true,
          resources: true,
          prompts: true,
          oauth: true
        },
        endpoints: {
          sse: '/sse',
          mcp: '/mcp',
          messages: '/messages',
          oauth: {
            authorize: '/authorize',
            token: '/token',
            register: '/register'
          }
        },
        tools: [
          {
            name: 'list_calls',
            description: 'List Gong calls with filtering'
          },
          {
            name: 'retrieve_transcripts',
            description: 'Get call transcripts'
          }
        ]
      }));
      return;
    }

    // Health check endpoint
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        type: 'mcp-server',
        capabilities: ['oauth', 'mcp']
      }));
      return;
    }

    // OAuth endpoints
    if (path === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        issuer: PROTOCOL,
        authorization_endpoint: `${PROTOCOL}/authorize`,
        token_endpoint: `${PROTOCOL}/token`,
        registration_endpoint: `${PROTOCOL}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: ['gong:read'],
        code_challenge_methods_supported: ['S256'],
        // MCP-specific extensions
        mcp_endpoint: `${PROTOCOL}/sse`,
        mcp_sse_endpoint: `${PROTOCOL}/sse`,
        mcp_protocol_version: '2025-06-18',
        mcp_capabilities: ['tools', 'resources', 'prompts'],
        mcp_transport: 'sse',
        // Alternative MCP discovery methods
        mcp_server_url: `${PROTOCOL}/sse`,
        modelcontextprotocol_endpoint: `${PROTOCOL}/sse`
      }));
      return;
    }

    if (path === '/.well-known/oauth-protected-resource') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        resource_server: PROTOCOL,
        authorization_servers: [PROTOCOL],
        scopes_supported: ['gong:read'],
        bearer_methods_supported: ['header', 'query'],
        // MCP-specific extensions  
        mcp_endpoint: `${PROTOCOL}/sse`,
        mcp_sse_endpoint: `${PROTOCOL}/sse`,
        mcp_protocol_version: '2025-06-18',
        mcp_capabilities: ['tools', 'resources', 'prompts'],
        mcp_transport: 'sse',
        // Alternative MCP discovery methods
        mcp_server_url: `${PROTOCOL}/sse`,
        modelcontextprotocol_endpoint: `${PROTOCOL}/sse`
      }));
      return;
    }

    if (path === '/register' && req.method === 'POST') {
      await handleOAuthRegistration(req, res);
      return;
    }

    if (path === '/authorize' && req.method === 'GET') {
      await handleOAuthAuthorization(req, res, url);
      return;
    }

    if (path === '/token' && req.method === 'POST') {
      await handleOAuthToken(req, res);
      return;
    }

    // SSE endpoint for MCP (this is what remote MCP servers typically use)
    if (path === '/sse' && req.method === 'GET') {
      console.error('SSE endpoint accessed for MCP streaming:', req.headers);
      await handleSSEConnection(req, res);
      return;
    }

    // MCP endpoints (try multiple paths)
    if (path === '/mcp' || path === '/api/mcp' || path === '/rpc' || path === '/jsonrpc' || path === '/claude' || path === '/v1/mcp') {
      console.error(`MCP endpoint accessed at ${path}:`, req.method, req.headers);
      await handleMCPRequest(req, res);
      return;
    }

    // Handle messages endpoint for legacy clients
    if (path === '/messages' && req.method === 'POST') {
      console.error('Messages endpoint accessed (legacy MCP):', req.headers);
      await handleMCPRequest(req, res);
      return;
    }

    // Try handling MCP at root for some clients
    if (path === '/' && req.method === 'POST') {
      console.error('Root POST request (possible MCP):', req.headers);
      await handleMCPRequest(req, res);
      return;
    }

    // Test endpoint to see if Claude can reach us with auth
    if (path === '/test' || path === '/api/test') {
      console.error('Test endpoint accessed:', req.method, req.headers);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        message: 'Test endpoint works',
        headers: req.headers,
        timestamp: new Date().toISOString()
      }));
      return;
    }

    // Debug page to test MCP functionality
    if (path === '/debug' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>MCP Server Debug</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    .test-section { margin: 20px 0; padding: 15px; border: 1px solid #ccc; }
    button { padding: 10px; margin: 5px; }
    pre { background: #f5f5f5; padding: 10px; overflow-x: auto; }
  </style>
</head>
<body>
  <h1>MCP Server Debug Interface</h1>
  
  <div class="test-section">
    <h3>Test Initialize</h3>
    <button onclick="testInitialize()">Test Initialize</button>
    <pre id="initResult"></pre>
  </div>

  <div class="test-section">
    <h3>Test Tools List</h3>
    <button onclick="testToolsList()">Test Tools/List</button>
    <pre id="toolsResult"></pre>
  </div>

  <div class="test-section">
    <h3>Test SSE Connection</h3>
    <button onclick="testSSE()">Connect to SSE</button>
    <button onclick="stopSSE()">Stop SSE</button>
    <pre id="sseResult"></pre>
  </div>

  <script>
    let eventSource = null;

    async function testInitialize() {
      try {
        const response = await fetch('/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: { roots: { listChanged: true }, sampling: {} },
              clientInfo: { name: 'debug-client', version: '1.0' }
            }
          })
        });
        const result = await response.json();
        document.getElementById('initResult').textContent = JSON.stringify(result, null, 2);
      } catch (error) {
        document.getElementById('initResult').textContent = 'Error: ' + error.message;
      }
    }

    async function testToolsList() {
      try {
        const response = await fetch('/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {}
          })
        });
        const result = await response.json();
        document.getElementById('toolsResult').textContent = JSON.stringify(result, null, 2);
      } catch (error) {
        document.getElementById('toolsResult').textContent = 'Error: ' + error.message;
      }
    }

    function testSSE() {
      if (eventSource) stopSSE();
      
      eventSource = new EventSource('/sse');
      const resultDiv = document.getElementById('sseResult');
      resultDiv.textContent = 'Connecting to SSE...\\n';
      
      eventSource.onopen = function() {
        resultDiv.textContent += 'SSE Connected!\\n';
      };
      
      eventSource.onmessage = function(event) {
        resultDiv.textContent += 'Data: ' + event.data + '\\n';
      };
      
      eventSource.onerror = function(error) {
        resultDiv.textContent += 'SSE Error: ' + JSON.stringify(error) + '\\n';
      };
    }

    function stopSSE() {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
        document.getElementById('sseResult').textContent += 'SSE Disconnected.\\n';
      }
    }
  </script>
</body>
</html>
      `);
      return;
    }

    // Default response
    res.writeHead(200, { 
      'Content-Type': 'application/json',
      'X-MCP-Server': 'true'
    });
    res.end(JSON.stringify({ 
      type: 'mcp-server',
      name: 'Gong MCP Server', 
      version: '0.1.0',
      description: 'MCP server for Gong API with OAuth support',
      mcp_manifest: `${PROTOCOL}/mcp.json`,
      endpoints: {
        health: '/health',
        mcp: '/mcp',
        manifest: '/mcp.json',
        oauth_metadata: '/.well-known/oauth-authorization-server',
        protected_resource: '/.well-known/oauth-protected-resource',
        register: '/register',
        authorize: '/authorize',
        token: '/token'
      },
      mcp: {
        endpoint: '/mcp',
        protocol_version: '2025-06-18',
        transport: 'http',
        capabilities: ['tools', 'resources', 'prompts'],
        tools_available: ['list_calls', 'retrieve_transcripts']
      }
    }));
  });

  // Clean up expired sessions
  setInterval(() => {
    const now = new Date();
    for (const [sessionId, session] of activeSessions.entries()) {
      if (now.getTime() - session.lastActivity.getTime() > SESSION_TIMEOUT) {
        activeSessions.delete(sessionId);
      }
    }
  }, 5 * 60 * 1000); // Every 5 minutes

  httpServer.listen(parseInt(PORT), '0.0.0.0', () => {
    console.error(`MCP server running on port ${PORT}`);
    console.error(`Health check: http://0.0.0.0:${PORT}/health`);
    console.error(`MCP endpoint: http://0.0.0.0:${PORT}/mcp`);
  });
}

async function handleMCPRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    mcpRequestCount++;
    console.error(`=== MCP REQUEST #${mcpRequestCount} START ===`);
    console.error('Method:', req.method);
    console.error('URL:', req.url);
    console.error('Headers:', JSON.stringify(req.headers, null, 2));
    
    // Check for OAuth authorization
    const authHeader = req.headers['authorization'] as string;
    console.error('OAuth token present:', !!authHeader);
    
    // Get or create session
    const sessionId = req.headers['mcp-session-id'] as string || randomUUID();
    let session = activeSessions.get(sessionId);
    
    if (!session) {
      connectionAttempts++;
      console.error(`Creating new MCP session #${connectionAttempts} with ID:`, sessionId);
      session = { lastActivity: new Date(), initialized: false };
      activeSessions.set(sessionId, session);
    } else {
      console.error('Using existing session:', sessionId);
    }
    
    session.lastActivity = new Date();
    res.setHeader('Mcp-Session-Id', sessionId);

    const mcpHandlers = createMCPHandlers();

    if (req.method === 'POST') {
      console.error('Handling POST request - expecting JSON-RPC');
      // Handle JSON-RPC request
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', async () => {
        try {
          console.error('Raw request body:', body);
          const request = JSON.parse(body);
          console.error('🎯 PARSED MCP REQUEST:', JSON.stringify(request, null, 2));
          console.error('🎯 Method:', request.method);
          console.error('🎯 ID:', request.id);
          console.error('🎯 Params:', JSON.stringify(request.params || {}, null, 2));
          
          if (request.method === 'initialize') {
            console.error('🎉 INITIALIZE method called - MCP handshake starting!');
          } else if (request.method === 'tools/list') {
            console.error('🔧 TOOLS/LIST called - this should show our tools!');
            console.error('Session initialized?', !!session);
          } else if (request.method === 'prompts/list') {
            console.error('💭 PROMPTS/LIST called');
          } else if (request.method === 'resources/list') {
            console.error('📚 RESOURCES/LIST called');
          } else if (request.method === 'notifications/initialized') {
            console.error('✅ INITIALIZED notification - handshake complete!');
          } else {
            console.error('❓ Other method:', request.method, '- this might be why tools dont show');
          }
          
          // Handle the request using our handlers
          const handler = mcpHandlers[request.method as keyof typeof mcpHandlers];
          let response;
          
          if (handler) {
            if (request.method === 'initialize') {
              session.initialized = true;
            }
            response = await handler(request);
            
            // Skip response for notifications
            if (response === null) {
              console.error('No response needed for notification:', request.method);
              res.writeHead(200);
              res.end();
              return;
            }
          } else {
            console.error('❌ Unknown method:', request.method);
            response = {
              jsonrpc: '2.0',
              id: request.id,
              error: {
                code: -32601,
                message: 'Method not found'
              }
            };
          }

          console.error('🚀 SENDING MCP RESPONSE:', JSON.stringify(response, null, 2));
          
          // Check if this session has an active SSE connection
          if (session && session.sseResponse && !session.sseResponse.destroyed) {
            console.error('📡 Sending response via SSE for session:', sessionId);
            session.sseResponse.write(`data: ${JSON.stringify(response)}\n\n`);
            // Send acknowledgment to the POST request
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'sent_via_sse', sessionId }));
          } else {
            console.error('📮 Sending response via HTTP POST response');
            res.writeHead(200, { 
              'Content-Type': 'application/json',
              'X-MCP-Version': '2025-06-18',
              'X-MCP-Implementation': 'gong-mcp-server'
            });
            const responseStr = JSON.stringify(response);
            console.error('🚀 Response length:', responseStr.length, 'bytes');
            res.end(responseStr);
          }
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32700,
              message: 'Parse error'
            }
          }));
        }
      });
    } else if (req.method === 'GET') {
      console.error('Handling GET request to MCP endpoint');
      // Handle SSE connection (optional)
      const acceptHeader = req.headers.accept || '';
      console.error('Accept header:', acceptHeader);
      if (acceptHeader.includes('text/event-stream')) {
        console.error('Setting up SSE connection');
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        res.write('data: {"type":"connection","sessionId":"' + sessionId + '"}\n\n');
        
        // Keep connection alive
        const keepAlive = setInterval(() => {
          res.write('data: {"type":"ping"}\n\n');
        }, 30000);

        req.on('close', () => {
          clearInterval(keepAlive);
        });
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          sessionId,
          status: 'ready',
          capabilities: {
            tools: {}
          }
        }));
      }
    } else {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
    }
  } catch (error) {
    console.error('Error handling MCP request:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

// OAuth handler functions
async function handleOAuthRegistration(req: http.IncomingMessage, res: http.ServerResponse) {
  let body = '';
  req.on('data', (chunk) => body += chunk);
  req.on('end', () => {
    try {
      const clientData = JSON.parse(body);
      const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const clientSecret = `secret_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      oauthClients.set(clientId, {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: clientData.redirect_uris || [`${PROTOCOL}/callback`],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'gong:read'
      });
      
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: [`${PROTOCOL}/callback`],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'gong:read'
      }));
      console.error('OAuth client registered:', clientId);
    } catch (error) {
      console.error('Error registering client:', error);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_request' }));
    }
  });
}

async function handleOAuthAuthorization(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const params = url.searchParams;
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const state = params.get('state');
  
  if (!clientId) {
    console.error('No client ID provided');
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_request' }));
    return;
  }
  
  // Auto-register unknown clients for MCP compatibility
  if (!oauthClients.has(clientId)) {
    console.error('Auto-registering unknown client:', clientId);
    oauthClients.set(clientId, {
      client_id: clientId,
      client_secret: `secret_${clientId}`,
      redirect_uris: [redirectUri || `${PROTOCOL}/callback`],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: 'gong:read'
    });
  }
  
  // Generate authorization code
  const authCode = `auth_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  oauthTokens.set(authCode, {
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'gong:read',
    expires_at: Date.now() + 600000 // 10 minutes
  });
  
  // Redirect with authorization code
  const callback = new URL(redirectUri || `${PROTOCOL}/callback`);
  callback.searchParams.set('code', authCode);
  if (state) callback.searchParams.set('state', state);
  
  console.error('Authorization code generated, redirecting to:', callback.toString());
  res.writeHead(302, { Location: callback.toString() });
  res.end();
}

async function handleOAuthToken(req: http.IncomingMessage, res: http.ServerResponse) {
  let body = '';
  req.on('data', (chunk) => body += chunk);
  req.on('end', () => {
    try {
      const params = new URLSearchParams(body);
      const grantType = params.get('grant_type');
      const code = params.get('code');
      const clientId = params.get('client_id');
      const clientSecret = params.get('client_secret');
      
      if (grantType !== 'authorization_code' || !code || !oauthTokens.has(code)) {
        console.error('Invalid grant or code');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      
      const tokenData = oauthTokens.get(code);
      if (tokenData.expires_at < Date.now()) {
        oauthTokens.delete(code);
        console.error('Authorization code expired');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      
      // Auto-register unknown clients if needed
      if (!oauthClients.has(clientId)) {
        console.error('Auto-registering client in token endpoint:', clientId);
        oauthClients.set(clientId, {
          client_id: clientId,
          client_secret: clientSecret || `secret_${clientId}`,
          redirect_uris: [`${PROTOCOL}/callback`],
          grant_types: ['authorization_code'],
          response_types: ['code'],
          scope: 'gong:read'
        });
      }
      
      const client = oauthClients.get(clientId);
      // For MCP, accept any client secret or no secret
      if (!client) {
        console.error('Failed to get/create client');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_client' }));
        return;
      }
      
      // Generate access token
      const accessToken = `access_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      oauthTokens.set(accessToken, {
        client_id: clientId,
        scope: tokenData.scope,
        expires_at: Date.now() + 3600000 // 1 hour
      });
      
      // Clean up authorization code
      oauthTokens.delete(code);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: tokenData.scope
      }));
      console.error('Access token issued:', accessToken);
    } catch (error) {
      console.error('Error processing token request:', error);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_request' }));
    }
  });
}

// SSE Connection Handler for Remote MCP
async function handleSSEConnection(req: http.IncomingMessage, res: http.ServerResponse) {
  console.error('=== SSE CONNECTION START ===');
  
  // Check for OAuth authorization
  const authHeader = req.headers['authorization'] as string;
  console.error('SSE OAuth token present:', !!authHeader);
  
  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control, Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });

  // Create session for this SSE connection
  const sessionId = randomUUID();
  connectionAttempts++;
  console.error(`🔌 Creating SSE session #${connectionAttempts} with ID:`, sessionId);
  
  const session = { lastActivity: new Date(), initialized: true, sseResponse: res };
  activeSessions.set(sessionId, session);

  // For SSE connections, we need to handle JSON-RPC over SSE
  // Claude Code expects to send JSON-RPC messages via POST and receive responses via SSE
  
  console.error('🔌 SSE connection established for session:', sessionId);
  console.error('🔌 Sending connection acknowledgment...');
  
  // Send connection acknowledgment
  res.write(`data: ${JSON.stringify({
    type: 'connection',
    sessionId: sessionId,
    timestamp: new Date().toISOString()
  })}\n\n`);

  // Send server capabilities via SSE
  res.write(`data: ${JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/capabilities',
    params: {
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: false, listChanged: true },
        prompts: { listChanged: true }
      }
    }
  })}\n\n`);

  // Keep connection alive with heartbeat
  const keepAlive = setInterval(() => {
    if (!res.destroyed) {
      res.write(`data: ${JSON.stringify({
        type: 'heartbeat',
        timestamp: new Date().toISOString()
      })}\n\n`);
      console.error('💗 SSE heartbeat sent for session:', sessionId);
    }
  }, 15000); // Every 15 seconds

  // Clean up on disconnect
  const cleanup = () => {
    console.error('🔌 Cleaning up SSE session:', sessionId);
    clearInterval(keepAlive);
    const session = activeSessions.get(sessionId);
    if (session) {
      session.sseResponse = undefined; // Clear the SSE reference but keep session
      console.error('🔌 Cleared SSE reference for session:', sessionId);
    }
  };

  req.on('close', () => {
    console.error('🔌 SSE connection closed:', sessionId);
    cleanup();
  });

  req.on('error', (error) => {
    console.error('🔌 SSE connection error:', sessionId, error);
    cleanup();
  });

  // Handle client disconnect
  req.on('aborted', () => {
    console.error('🔌 SSE connection aborted:', sessionId);
    cleanup();
  });
}

// Start the server
createHTTPMCPServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});