# Gong MCP Server with Pagination

A Model Context Protocol (MCP) server and HTTP API for accessing Gong's API with pagination support. This project provides two ways to use the Gong API:

1. **MCP Server** (`index.ts`) - For local use with Claude Desktop
2. **HTTP API Server** (`http-server.ts`) - For Railway deployment and web access

## Features

- ✅ **Pagination Support** - Handle large datasets with cursor-based pagination
- ✅ **List Calls** - Retrieve Gong calls with date range filtering
- ✅ **Retrieve Transcripts** - Get detailed transcripts for specific calls
- ✅ **Railway Deployment** - Ready for cloud deployment
- ✅ **Local MCP Usage** - Compatible with Claude Desktop

## Setup

### Environment Variables

Create a `.env` file:

```bash
GONG_ACCESS_KEY=your_gong_access_key
GONG_ACCESS_SECRET=your_gong_access_secret
PORT=3000  # Optional, defaults to 3000
```

### Installation

```bash
npm install
npm run build
```

## Usage

### Option 1: HTTP API Server (For Railway/Web)

Start the HTTP server:

```bash
npm start
```

#### API Endpoints

**Health Check:**
```
GET /health
```

**List Calls:**
```
GET /api/calls?fromDateTime=2024-01-01T00:00:00Z&toDateTime=2024-12-31T23:59:59Z&limit=50
POST /api/calls
Content-Type: application/json

{
  "fromDateTime": "2024-01-01T00:00:00Z",
  "toDateTime": "2024-12-31T23:59:59Z",
  "cursor": "optional_cursor_for_pagination",
  "limit": 50
}
```

**Retrieve Transcripts:**
```
GET /api/transcripts?callIds=123,456,789&limit=50
POST /api/transcripts
Content-Type: application/json

{
  "callIds": ["123", "456", "789"],
  "cursor": "optional_cursor_for_pagination",
  "limit": 50
}
```

**API Documentation:**
```
GET /api
```

### Option 2: MCP Server (For Local Claude Desktop)

Start the MCP server:

```bash
npm run start:mcp
```

Configure in Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gong": {
      "command": "node",
      "args": ["path/to/your/project/dist/index.js"],
      "env": {
        "GONG_ACCESS_KEY": "your_access_key",
        "GONG_ACCESS_SECRET": "your_access_secret"
      }
    }
  }
}
```

## Pagination

Both servers support Gong's cursor-based pagination:

1. **First Request**: Don't include `cursor` parameter
2. **Subsequent Requests**: Use the `cursor` value from the previous response's `records.cursor` field
3. **Page Size**: Use `limit` parameter (default: 100, max: 100)

Example pagination workflow:

```javascript
// First request
const response1 = await fetch('/api/calls?limit=50');
const data1 = await response1.json();

// Check if there are more pages
if (data1.records?.cursor) {
  // Get next page
  const response2 = await fetch(`/api/calls?limit=50&cursor=${data1.records.cursor}`);
  const data2 = await response2.json();
}
```

## Railway Deployment

1. **Connect your GitHub repository** to Railway
2. **Set environment variables** in Railway dashboard:
   - `GONG_ACCESS_KEY`
   - `GONG_ACCESS_SECRET`
3. **Deploy** - Railway will automatically detect and use the Dockerfile

The server will be available at: `https://your-app-name.railway.app`

## Local Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Start HTTP server
npm run dev

# Start MCP server
npm run start:mcp
```

## Project Structure

```
├── src/
│   ├── index.ts          # MCP server (stdio transport)
│   ├── http-server.ts    # HTTP API server
│   └── simple-server.ts  # Basic HTTP server for testing
├── Dockerfile            # Railway deployment config
├── package.json
├── tsconfig.json
└── README.md
```

## API Response Format

All API responses include pagination information:

```json
{
  "calls": [...],  // or "transcripts": [...]
  "records": {
    "totalRecords": 150,
    "currentPageSize": 50,
    "currentPageNumber": 1,
    "cursor": "eyJhbGciOiJIUzI1NiJ9..."
  }
}
```

## Error Handling

The server provides detailed error messages:

```json
{
  "error": "Invalid parameters for list_calls"
}
```

## License

MIT License