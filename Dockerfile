FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.mjs migrate.mjs ./
COPY lib ./lib
COPY migrations ./migrations
COPY public ./public

USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
