FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production DATABASE_PATH=/var/data/blogger-ai-publisher.sqlite PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
