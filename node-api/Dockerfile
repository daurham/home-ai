FROM node:18-alpine

# Frozen v1.3.1 registration/detection helpers are Python/OpenCV.
RUN apk add --no-cache python3 py3-opencv py3-numpy

# Create app directory
WORKDIR /usr/src/app

# Copy package files first (for caching)
COPY package*.json ./

# Install deps
RUN npm install --production

# Copy rest of app
COPY . .

# Expose port
EXPOSE 3000

# Run server
CMD ["node", "server.js"]
