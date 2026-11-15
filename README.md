# Forma AI Backend

This repository currently contains the Forma AI backend, located in `server/`. It is a Node.js and Express 5 API with AI-assisted intake routing through LangChain/OpenAI and Zod.

The local Docker workflow starts only the existing backend. It does not start a database, frontend, or other service because none is currently part of this backend.

## Prerequisites

- Docker Desktop, including Docker Compose (`docker compose version`).
- Node.js 22+ and npm only if you want to run or lint the backend directly outside Docker.

## Environment setup

The backend reads its configuration from environment variables. `server/.env.example` is the source of truth for the available variable names.

Docker Compose reads a root-level `.env` file for variable interpolation. Create it from the example:

**PowerShell:**

```powershell
Copy-Item server/.env.example .env
```

**macOS/Linux:**

```bash
cp server/.env.example .env
```

Then edit `.env` and set `OPENAI_API_KEY` to your own key. Do not commit `.env`; it is ignored by the repository’s `.gitignore`.

The main variables are:

| Variable | Purpose |
|---|---|
| `PORT` | Host and container port. Defaults to `3000`. |
| `NODE_ENV` | Runtime mode. Defaults to `development` in Compose. |
| `OPENAI_API_KEY` | Required for AI intake endpoints. `/health` works without it. |
| `INTAKE_ROUTING_MODEL` | Model used for form routing. |
| `INTAKE_EXTRACTION_MODEL` | Model configured for extraction. |
| `LLM_TIMEOUT_MS` | LLM request timeout. |
| `LLM_MAX_RETRIES` | LLM retry count. |

`server/.env` is the separate configuration file used when running the backend directly with npm. Compose uses the root `.env` because it performs variable interpolation there.

## Start the backend with Docker Compose

Build the image:

```bash
docker compose build
```

Start the backend in the background:

```bash
docker compose up -d
```

View running services and their health status:

```bash
docker compose ps
```

View backend logs:

```bash
docker compose logs --tail=100 backend
```

Stop the backend and remove its container:

```bash
docker compose down
```

The service is published on loopback at `http://localhost:3000` by default. If you change `PORT` in the root `.env`, change it before starting Compose and use the same port in the URLs below.

## Verify health

The existing lightweight health endpoint is:

```text
GET /health
```

With the default port:

```bash
curl http://localhost:3000/health
```

PowerShell alternative:

```powershell
Invoke-RestMethod http://localhost:3000/health
```

A healthy response contains:

```json
{
  "status": "ok",
  "service": "ai-intake-backend",
  "timestamp": "..."
}
```

`docker compose ps` also shows the container health status reported by the Dockerfile health check. That check uses `/health`.

Do not use `/api/intake/health` for routine container health checks. That endpoint verifies the AI provider path and may make an external OpenAI request. `/health` is local and inexpensive.

## Troubleshooting

### Docker Desktop is not running

Start Docker Desktop and wait for it to finish starting. Verify the daemon with:

```bash
docker info
```

### The host port is already in use

Change `PORT` in the root `.env` to another value, then recreate the service:

```bash
docker compose up -d
```

The Compose file uses the same value for the host and container port.

### Required environment variables are missing

Confirm that a root `.env` exists and that `OPENAI_API_KEY` is set if you need AI intake routes. The backend can start without a key and `/health` can still respond, but AI-dependent requests will fail.

### The container is unhealthy

Inspect the service status and logs:

```bash
docker compose ps
docker compose logs --tail=100 backend
```

Then verify the `/health` endpoint directly. If configuration changed, rebuild and recreate the service:

```bash
docker compose build
docker compose up -d
```

### Review backend logs

Use:

```bash
docker compose logs --tail=100 backend
```
