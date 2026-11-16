FROM node:22-alpine
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY shared /app/shared
COPY server/src ./src
COPY server/migrations ./migrations
USER node
EXPOSE 3001
CMD ["npm", "start"]
