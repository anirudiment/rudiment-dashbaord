# syntax=docker/dockerfile:1

FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Only copy what we need at runtime
COPY package.json package-lock.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/dashboard ./dashboard

# Install prod deps only
RUN npm ci --omit=dev

# App Runner provides PORT; default to 8787.
ENV PORT=8787

EXPOSE 8787

CMD ["node", "dist/dashboard-server.js"]

