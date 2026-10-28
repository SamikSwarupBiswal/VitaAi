FROM python:3.13.9-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    DATABASE_URL=sqlite:////var/lib/vitaai/vitaai.db AUTH_MODE=session

WORKDIR /opt/vitaai/services/api
COPY services/api/requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir -r requirements.txt \
    && groupadd --gid 10001 vitaai \
    && useradd --uid 10001 --gid 10001 --no-create-home vitaai \
    && mkdir -p /var/lib/vitaai \
    && chown 10001:10001 /var/lib/vitaai \
    && chmod 700 /var/lib/vitaai

COPY services/api/vita_api ./vita_api
COPY services/api/migrations ./migrations
USER 10001:10001

# Migrations and explicitly synthetic initialization occur only at runtime.
# The web container shares this network namespace; the API stays on loopback.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health/ready', timeout=3).close()"]
CMD ["python", "-m", "uvicorn", "vita_api.app:app", "--host", "127.0.0.1", "--port", "8000", "--no-proxy-headers"]
