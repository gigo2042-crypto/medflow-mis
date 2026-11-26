# syntax=docker/dockerfile:1.7
# MedFlow — многоэтапная сборка.
#   production: docker build -t medflow .                       (демо-код физически удалён)
#   demo:       docker build -t medflow-demo --build-arg APP_MODE=demo .
# Цели (target):
#   runner — веб-приложение (Next.js standalone) + планировщик
#   tools  — миграции, CLI (create-admin и т. п.), демо-сид

ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

FROM ${NODE_IMAGE} AS source
ARG APP_MODE=production
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Production: вырезаем всё демо — маршруты /api/demo/*, сид, моки
RUN if [ "$APP_MODE" != "demo" ]; then \
      rm -rf src/app/api/demo src/demo prisma/seed.ts mini-services .env.demo.example src/app/api/integrations/email ; \
    fi

FROM source AS builder
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate && npx next build

# ---------- runtime: приложение ----------
FROM ${NODE_IMAGE} AS runner
ARG APP_MODE=production
WORKDIR /app
RUN apk add --no-cache openssl tini && addgroup -S medflow && adduser -S medflow -G medflow
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 \
    MEDFLOW_BUILD=${APP_MODE} APP_MODE=${APP_MODE}
COPY --from=builder --chown=medflow:medflow /app/.next/standalone ./
COPY --from=builder --chown=medflow:medflow /app/.next/static ./.next/static
COPY --from=builder --chown=medflow:medflow /app/public ./public
COPY --from=builder --chown=medflow:medflow /app/scripts/env-rules.mjs /app/scripts/check-env.mjs /app/scripts/scheduler.mjs ./scripts/
USER medflow
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "node scripts/check-env.mjs && exec node server.js"]

# ---------- tools: миграции и CLI ----------
FROM source AS tools
ARG APP_MODE=production
ENV NODE_ENV=production MEDFLOW_BUILD=${APP_MODE} APP_MODE=${APP_MODE}
RUN npx prisma generate
CMD ["npx", "prisma", "migrate", "deploy"]
