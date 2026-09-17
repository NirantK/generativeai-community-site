FROM golang:1.27.1-alpine AS build
RUN apk add --no-cache build-base git ca-certificates
RUN git clone --branch v0.18.2 --depth 1 https://github.com/openclaw/wacli.git /src
WORKDIR /src
RUN CGO_ENABLED=1 CGO_CFLAGS="-Wno-error=missing-braces" go build -tags sqlite_fts5 -trimpath -ldflags="-s -w" -o /wacli ./cmd/wacli
FROM python:3.14-alpine
RUN apk add --no-cache ca-certificates libstdc++ && adduser -D -u 10001 runner
WORKDIR /app
COPY --from=build /wacli /usr/local/bin/wacli
COPY scripts/export-community-chat.py scripts/import-chat-archive.py scripts/chat_privacy.py /app/scripts/
COPY scripts/tests/ /app/scripts/tests/
COPY admissions/migrations/0005_chat_archive.sql /app/admissions/migrations/0005_chat_archive.sql
COPY chat-sync/container/ /app/
RUN mkdir /data && chown runner /data
USER runner
ENV WACLI_BIN=/usr/local/bin/wacli WACLI_STORE=/data/store PYTHONDONTWRITEBYTECODE=1
EXPOSE 8080
CMD ["python3", "/app/server.py"]
