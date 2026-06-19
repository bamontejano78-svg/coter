FROM node:20-alpine AS builder

WORKDIR /app

# Dependencias
COPY package*.json ./
RUN npm install --no-audit --no-fund 2>&1

# Codigo fuente
COPY . .

# Production stage
FROM node:20-alpine

WORKDIR /app

# Instalar solo dependencias de produccion
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund 2>&1 && npm cache clean --force

# Copiar archivos necesarios
COPY --from=builder /app/server.js .
COPY --from=builder /app/database.js .
COPY --from=builder /app/config ./config
COPY --from=builder /app/middleware ./middleware
COPY --from=builder /app/routes ./routes
COPY --from=builder /app/utils ./utils
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/www ./www
COPY --from=builder /app/public ./public

# Usuario no-root
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
USER nodejs

EXPOSE 3000

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "server.js"]
