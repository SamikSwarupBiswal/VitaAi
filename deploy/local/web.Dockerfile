FROM node:24.12.0-bookworm-slim AS build
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /opt/vitaai
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci
COPY apps/web ./apps/web
RUN npm run build && npm prune --omit=dev

FROM node:24.12.0-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /opt/vitaai/apps/web
COPY --from=build /opt/vitaai/package.json /opt/vitaai/package.json
COPY --from=build /opt/vitaai/node_modules /opt/vitaai/node_modules
COPY --from=build /opt/vitaai/apps/web/package.json ./package.json
COPY --from=build /opt/vitaai/apps/web/next.config.ts ./next.config.ts
COPY --from=build /opt/vitaai/apps/web/tsconfig.json ./tsconfig.json
COPY --from=build --chown=node:node /opt/vitaai/apps/web/.next ./.next
COPY --from=build /opt/vitaai/apps/web/public ./public
USER node

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/auth/session',{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "../../node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
