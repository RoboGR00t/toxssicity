# Use a lightweight Node.js image
FROM node:18-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

RUN apk add --no-cache openssl

RUN mkdir -p /usr/src/app/certs && \
    openssl req -x509 -nodes -days 365 \
    -newkey rsa:4096 \
    -keyout /usr/src/app/certs/server.key \
    -out /usr/src/app/certs/server.crt \
    -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" && \
    chmod 600 /usr/src/app/certs/server.key

# Install native compilation tools (Required for sqlite3 and bcrypt on Alpine)
RUN apk add --no-cache python3 make g++ 

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application code
COPY . .

# Ensure the data directory exists for the SQLite database
RUN mkdir -p data

# Expose the port the app runs on
EXPOSE 8443

# Command to run the application
CMD ["node", "server.js"]
