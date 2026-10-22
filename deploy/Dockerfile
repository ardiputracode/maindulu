# Image ini membangun aplikasi statis maindulu (npm run build = tsc + vite build)
# lalu menyajikan hasilnya dengan Nginx tanpa backend.

# --- tahap build: dependensi + build Vite ------------------------------------
FROM node:24-alpine AS build
WORKDIR /app

# Nyatakan manifest dan lockfile lebih dulu agar npm ci tetap tercache
# selama keduanya tidak berubah antar rebuild.
COPY package.json package-lock.json ./
RUN npm ci

# Sumber dan aset yang dibutuhkan `npm run build` hanya berikut ini;
# sisanya dikeluarkan dari konteks build lewat .dockerignore di akar repo.
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY src ./src
COPY public ./public

RUN npm run build

# --- tahap runtime: Nginx melayani dist/ secara statis ------------------------
FROM nginx:1.29-alpine

COPY deploy/nginx.docker.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
