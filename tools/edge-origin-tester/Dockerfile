FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY server.js .
ENV NODE_ENV=production
EXPOSE 8080 8443 8520 8522 8525 8526 8527
USER node
CMD ["node", "server.js"]
