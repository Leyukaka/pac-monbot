FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY server ./server
COPY site ./site
COPY migrations ./migrations
RUN mkdir -p /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=8787 DB_PATH=/data/pac.db
EXPOSE 8787
CMD ["node", "server/node.mjs"]
