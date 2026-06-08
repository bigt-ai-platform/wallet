FROM node:20-bookworm-slim

ARG PACKAGE_TGZ
COPY ${PACKAGE_TGZ} /tmp/bigtangle-ts.tgz

WORKDIR /package-smoke
COPY test/docker-e2e/package-smoke.mjs ./package-smoke.mjs
RUN npm init -y \
  && npm install /tmp/bigtangle-ts.tgz

WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json vitest.config.ts ./
COPY scripts ./scripts
COPY src ./src
COPY test ./test

CMD ["sh", "-c", "cd /package-smoke && node package-smoke.mjs && cd /workspace && node test/docker-e2e/wait-for-bigtangle.mjs && npm run test:integration"]