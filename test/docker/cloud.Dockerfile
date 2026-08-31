FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app
RUN apk add --no-cache openssl \
    && mkdir -p /data \
    && chown node:node /data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY test/docker/cloud.mjs test/docker/query.mjs test/docker/generate-certs.sh ./
USER node
CMD ["node", "/app/cloud.mjs"]
