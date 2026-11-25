# The command center: Node, the app, and a data folder that survives restarts.
FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Handoffs, logs, approvals, shared context and the kill flag live here.
ENV CC_HOME=/data \
    PORT=8080 \
    HOST=0.0.0.0
RUN mkdir -p /data && chown -R node:node /app /data
USER node
VOLUME ["/data"]
EXPOSE 8080

CMD ["node", "src/cli.mjs", "serve"]
