# Use the slim Debian image for native Prisma compatibility
FROM node:22-slim

RUN apt-get update -y && apt-get install -y openssl

# Set an absolute working directory
WORKDIR /usr/src/app

# Copy package definitions and the Prisma schema first
# This leverages Docker caching so dependencies don't reinstall on every code change
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies and generate the Prisma engine for Linux
RUN npm ci
RUN npx prisma generate

# Copy the rest of the application code
COPY . .

# Build the NestJS application into the /dist folder
RUN npm run build

# Make startup script executable
RUN chmod +x start.sh

# Expose the standard port
EXPOSE 8080

# Run migrations then start the server
CMD ["sh", "start.sh"]