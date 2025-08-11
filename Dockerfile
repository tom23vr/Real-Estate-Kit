FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm i --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 5173
CMD ["node","server.js"]