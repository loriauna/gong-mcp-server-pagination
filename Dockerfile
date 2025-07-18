FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install 2>&1

# Copy source code
COPY . .

# Start the server directly with JavaScript
CMD ["node", "server.js"] 