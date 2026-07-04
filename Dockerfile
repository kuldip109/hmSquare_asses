FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p uploads logs

EXPOSE 3000

CMD ["node", "src/server.js"]
