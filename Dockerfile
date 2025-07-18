FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install 2>&1

# Copy source code
COPY . .

# Build TypeScript code
RUN npm run build 2>&1

# Start the server
CMD ["sh", "-c", "node dist/minimal-server.js 2>&1"] 