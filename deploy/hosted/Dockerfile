FROM node:24.12.0-bookworm-slim AS web-build
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /opt/vitaai
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci
COPY apps/web ./apps/web
RUN npm run build && npm prune --omit=dev

FROM python:3.13.9-slim-bookworm AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
    PYTHONPATH=/opt/vitaai/services/api AUTH_MODE=session SESSION_COOKIE_SECURE=true PORT=10000
WORKDIR /opt/vitaai
COPY LICENSE /opt/vitaai/LICENSE
COPY services/api/requirements.txt ./services/api/requirements.txt
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && python -m pip install --no-cache-dir -r services/api/requirements.txt \
    && groupadd --gid 10001 vitaai \
    && useradd --uid 10001 --gid 10001 --no-create-home vitaai
COPY --from=web-build /usr/local/bin/node /usr/local/bin/node
COPY --from=web-build /opt/vitaai/package.json ./package.json
COPY --from=web-build /opt/vitaai/node_modules ./node_modules
COPY --from=web-build /opt/vitaai/apps/web/package.json ./apps/web/package.json
COPY --from=web-build /opt/vitaai/apps/web/next.config.ts ./apps/web/next.config.ts
COPY --from=web-build /opt/vitaai/apps/web/tsconfig.json ./apps/web/tsconfig.json
COPY --from=web-build --chown=10001:10001 /opt/vitaai/apps/web/.next ./apps/web/.next
COPY --from=web-build /opt/vitaai/apps/web/public ./apps/web/public
COPY services/api/vita_api ./services/api/vita_api
COPY services/api/migrations ./services/api/migrations
COPY deploy/hosted/launch.py ./deploy/hosted/launch.py
USER 10001:10001
EXPOSE 10000
HEALTHCHECK --interval=15s --timeout=6s --start-period=90s --retries=4 \
    CMD ["python", "/opt/vitaai/deploy/hosted/launch.py", "--check"]
CMD ["python", "/opt/vitaai/deploy/hosted/launch.py"]
