FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
COPY prisma ./prisma
RUN npm run db:generate && npm run build

FROM build AS migration
USER node
CMD ["./node_modules/.bin/prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"]

FROM build AS production-dependencies
RUN npm prune --omit=dev --omit=optional

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node docs/contracts/messages ./docs/contracts/messages
COPY --chown=node:node scripts/operations/recover-outbox.cjs ./scripts/operations/recover-outbox.cjs
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
