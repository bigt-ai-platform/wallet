FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json yarn.lock ./

COPY expo-app/package.json ./expo-app/package.json
COPY packages/ packages/
RUN yarn install --frozen-lockfile --network-timeout 300000

COPY expo-app/ ./expo-app/
RUN cd expo-app && npx expo export --platform web --output-dir /app/web-build

FROM nginx:alpine
COPY --from=builder /app/web-build /usr/share/nginx/html
COPY e2e/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8081
CMD ["nginx", "-g", "daemon off;"]
