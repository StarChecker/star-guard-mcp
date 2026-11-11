FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production

USER node
ENTRYPOINT ["node", "src/index.js"]
