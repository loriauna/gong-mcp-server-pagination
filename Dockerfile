FROM node:20-alpine

WORKDIR /app

# Copy package.json and server file
COPY package.json server.js ./

# Start the server directly with JavaScript
CMD ["node", "server.js"] 