# Curtis API Proxy

A constrained provider proxy for Curtis Image Studio.

## Routes

- `GET /healthz` — deployment health and API version
- `POST /openai/images` — GPT Image 2 generation or reference-image editing
- `POST /a2e` — A2E image/video submit actions
- `GET|POST /a2e/status` — A2E polling

OpenAI video routes return `410 Gone`. The old Sora integration was deprecated and used an invalid reference-image request format.

## Authentication

Users may supply provider keys per request:

- `x-openai-key`
- `x-a2e-key`

Environment keys are optional and protected. To allow the proxy to use `OPENAI_API_KEY` or `A2E_API_KEY`, configure `APP_PROXY_TOKEN` and send the same value in `x-app-token`. Without that token, environment keys are never used.

## Environment variables

| Variable | Purpose |
|---|---|
| `ALLOWED_ORIGINS` | Comma-separated browser origins |
| `APP_PROXY_TOKEN` | Protects environment-held provider keys |
| `OPENAI_API_KEY` | Optional protected OpenAI key |
| `A2E_API_KEY` | Optional protected A2E key |
| `OPENAI_BASE_URL` | Defaults to `https://api.openai.com` |
| `A2E_BASE_URL` | Defaults to `https://video.a2e.ai` |
| `UPSTREAM_TIMEOUT_MS` | Provider timeout, default 120 seconds |
| `MAX_IMAGE_BYTES` | Maximum reference image size, default 10 MB |
| `PORT` | HTTP port, default 3000 |

## Run

```bash
npm ci
npm start
```
