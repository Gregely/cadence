# Cadence: one container, one process. Works on x86-64 and on a Raspberry Pi
# (arm64). Build:  docker build -t cadence .
# Run:            docker run -d --name cadence -p 127.0.0.1:8765:8765 -v cadence-data:/data cadence

# ---- build the frontend
FROM node:22-bookworm-slim AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- runtime
FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CADENCE_DB=/data/cadence.sqlite3 \
    CADENCE_BACKUP_DIR=/data/backups \
    CADENCE_HOST=0.0.0.0 \
    CADENCE_PORT=8765
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY cadence/ ./cadence/
COPY --from=frontend /src/frontend/dist ./frontend/dist
RUN useradd --system --uid 10001 --home /data cadence && mkdir -p /data && chown cadence /data
USER cadence
VOLUME ["/data"]
EXPOSE 8765
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8765/api/kinds', timeout=4).status == 200 else 1)"
CMD ["python", "-m", "cadence"]
