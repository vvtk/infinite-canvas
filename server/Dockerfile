FROM node:22-alpine
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY server/migrations ./migrations
USER node
EXPOSE 3001
CMD ["npm", "start"]
