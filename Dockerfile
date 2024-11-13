FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN mkdir -p sessions && \
    chown -R node:node /app

USER node

EXPOSE 8000

CMD ["node", "app.js"] 