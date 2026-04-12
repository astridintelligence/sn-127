# ---------- deps ----------
FROM node:23-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---------- build ----------
FROM node:23-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- runtime ----------
FROM node:23-slim AS runner
ENV NODE_ENV=production
WORKDIR /app

# Install only prod deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Add compiled output
COPY --from=build /app/dist ./dist

ENV APP_VERSION=0.1.2
CMD ["node", "dist/index.js"]
