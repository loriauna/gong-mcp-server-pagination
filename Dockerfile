FROM node:20-alpine

WORKDIR /app

# Copy only the server file - no package.json or dependencies
COPY server.js .

# Start the server directly with JavaScript
CMD ["node", "server.js"] 