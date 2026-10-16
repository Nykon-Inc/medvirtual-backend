FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
# Retries absorb transient registry ECONNRESETs seen on GitHub-hosted runners.
RUN npm ci --no-audit --no-fund \
    --fetch-retries=5 \
    --fetch-retry-mintimeout=20000 \
    --fetch-retry-maxtimeout=120000
COPY . .
RUN npm run prisma:generate
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/main"]

