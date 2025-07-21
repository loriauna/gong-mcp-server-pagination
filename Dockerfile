FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (this will also run postinstall which builds TypeScript)
RUN npm ci

# Copy source files
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript if not already built by postinstall
RUN npm run build

# Start the compiled server
CMD ["node", "dist/mcp-http-server.js"] 