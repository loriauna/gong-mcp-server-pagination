#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
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

// Session management
const sessions = new Map<string, { server: Server; lastActivity: Date }>();
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

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
        description: "Maximum number of results to return (default: 100, max: 100)"
      }
    }
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
};

// Create MCP Server
function createMCPServer(): Server {
  const server = new Server(
    {
      name: "gong-mcp-server",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

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
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [LIST_CALLS_TOOL, RETRIEVE_TRANSCRIPTS_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: unknown } }) => {
    try {
      const { name, arguments: args } = request.params;

      if (!gongClient) {
        throw new Error("Gong API credentials not configured");
      }

      if (!args) {
        throw new Error("No arguments provided");
      }

      switch (name) {
        case "list_calls": {
          if (!isGongListCallsArgs(args)) {
            throw new Error("Invalid arguments for list_calls");
          }
          const { fromDateTime, toDateTime, cursor, limit } = args;
          const response = await gongClient.listCalls(fromDateTime, toDateTime, cursor, limit);
          return {
            content: [{ 
              type: "text", 
              text: JSON.stringify(response, null, 2)
            }],
            isError: false,
          };
        }

        case "retrieve_transcripts": {
          if (!isGongRetrieveTranscriptsArgs(args)) {
            throw new Error("Invalid arguments for retrieve_transcripts");
          }
          const { callIds, cursor, limit } = args;
          const response = await gongClient.retrieveTranscripts(callIds, cursor, limit);
          return {
            content: [{ 
              type: "text", 
              text: JSON.stringify(response, null, 2)
            }],
            isError: false,
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error occurred while making the request. Please try again. Error details: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// HTTP MCP Transport Implementation
async function createHTTPMCPServer() {
  const PORT = process.env.PORT;
  
  if (!PORT) {
    // Running locally - use stdio transport
    const server = createMCPServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  // HTTP server for MCP transport
  const httpServer = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Mcp-Session-Id');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Health check endpoint
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }));
      return;
    }

    // MCP endpoint
    if (req.url === '/mcp') {
      await handleMCPRequest(req, res);
      return;
    }

    // Default response
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      name: 'Gong MCP Server', 
      version: '0.1.0',
      description: 'MCP server for Gong API with pagination support',
      endpoints: {
        health: '/health',
        mcp: '/mcp'
      }
    }));
  });

  // Clean up expired sessions
  setInterval(() => {
    const now = new Date();
    for (const [sessionId, session] of sessions.entries()) {
      if (now.getTime() - session.lastActivity.getTime() > SESSION_TIMEOUT) {
        sessions.delete(sessionId);
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
    // Get or create session
    const sessionId = req.headers['mcp-session-id'] as string || randomUUID();
    let session = sessions.get(sessionId);
    
    if (!session) {
      const server = createMCPServer();
      session = { server, lastActivity: new Date() };
      sessions.set(sessionId, session);
    }
    
    session.lastActivity = new Date();
    res.setHeader('Mcp-Session-Id', sessionId);

    if (req.method === 'POST') {
      // Handle JSON-RPC request
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', async () => {
        try {
          const request = JSON.parse(body);
          
          // Handle the request based on JSON-RPC method
          let response;
          
          if (request.method === 'tools/list') {
            response = {
              jsonrpc: '2.0',
              id: request.id,
              result: {
                tools: [LIST_CALLS_TOOL, RETRIEVE_TRANSCRIPTS_TOOL]
              }
            };
          } else if (request.method === 'tools/call') {
            const result = await handleToolCall(request.params);
            response = {
              jsonrpc: '2.0',
              id: request.id,
              result
            };
          } else if (request.method === 'initialize') {
            response = {
              jsonrpc: '2.0',
              id: request.id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: {
                  tools: {}
                },
                serverInfo: {
                  name: 'gong-mcp-server',
                  version: '0.1.0'
                }
              }
            };
          } else {
            response = {
              jsonrpc: '2.0',
              id: request.id,
              error: {
                code: -32601,
                message: 'Method not found'
              }
            };
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
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
      // Handle SSE connection (optional)
      const acceptHeader = req.headers.accept || '';
      if (acceptHeader.includes('text/event-stream')) {
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

// Handle tool calls
async function handleToolCall(params: { name: string; arguments?: unknown }) {
  try {
    const { name, arguments: args } = params;

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
          content: [{ 
            type: "text", 
            text: JSON.stringify(response, null, 2)
          }],
          isError: false,
        };
      }

      case "retrieve_transcripts": {
        if (!isGongRetrieveTranscriptsArgs(args)) {
          throw new Error("Invalid arguments for retrieve_transcripts");
        }
        const { callIds, cursor, limit } = args;
        const response = await gongClient.retrieveTranscripts(callIds, cursor, limit);
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify(response, null, 2)
          }],
          isError: false,
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Error occurred while making the request. Please try again. Error details: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
}

// Start the server
createHTTPMCPServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});