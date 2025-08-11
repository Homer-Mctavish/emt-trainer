# ---------- Build stage ----------
FROM node:20-alpine AS build
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Cache deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Build
COPY . .
RUN pnpm build

# ---------- Runtime stage ----------
FROM nginx:1.27-alpine AS runtime

# Nginx config (adds wasm mime + SPA fallback + COOP/COEP headers)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Static files
COPY --from=build /app/dist /usr/share/nginx/html

# If you keep ORT WASM files outside Vite's public/ pipeline, copy them:
# COPY public/ort /usr/share/nginx/html/ort

# Expose the port Nginx listens on
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
