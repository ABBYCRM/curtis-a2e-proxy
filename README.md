# Curtis API Proxy

A constrained provider proxy for Curtis Image Studio. Adds CORS, SSRF
guard, rate limiting, and an `Album` asset store in front of the
upstream image and video providers (OpenAI, A2E, and Hedra).

The live deployment is at **<https://curtis-a2e-proxy.onrender.com>**.

## Routes

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/healthz` | Deployment health and version |
| POST   | `/openai/images` | GPT Image 2 (`gpt-image-2`) generation or face-locked edit |
| POST   | `/openai/videos` | Sora 2 (`sora-2`) submit (scheduled for removal 2026-09-24) |
| GET    | `/openai/videos/:id` | Sora 2 poll |
| GET    | `/openai/videos/:id/content` | Sora 2 bytes (proxied with the user's key) |
| POST   | `/a2e` | A2E image / video submit actions |
| GET/POST | `/a2e/status` | A2E polling |
| POST   | `/hedra/video` | Hedra image-to-video submit (uploads the frame, then starts the generation) |
| GET    | `/hedra/video/:id` | Hedra generation status poll |
| GET    | `/album` | List album items (newest first) |
| POST   | `/album/upload?kind=image\|video&…` | Raw bytes upload (front-end auto-save) |
| POST   | `/album/save-from-url` | Server-side fetch + SSRF guard + save (A2E clip URLs, Sora 2 bytes) |
| GET    | `/album/:id` | Stream bytes (`Vary: Origin`, `Content-Disposition: attachment`) |
| DELETE | `/album/:id` | Remove one item |
| DELETE | `/album` | Remove all items |

The proxy auto-saves successful `/openai/images` and `/openai/videos/:id/content`
responses to the album. The front-end also re-uploads the same bytes so
the album stays in sync even if the proxy miss was for any reason.

## Authentication

Users may supply provider keys per request:

- `x-openai-key` — OpenAI key (the front-end sends the user's localStorage value)
- `x-a2e-key` — A2E key
- `x-hedra-key` — Hedra key (from [hedra.com/api-profile](https://www.hedra.com/api-profile), Creator plan or above)
- `x-app-token` — only required when `APP_PROXY_TOKEN` is set on the proxy

Environment keys (`OPENAI_API_KEY`, `A2E_API_KEY`, `HEDRA_API_KEY`) are
optional and protected. To allow the proxy to use them, configure
`APP_PROXY_TOKEN` and have the caller send the same value in
`x-app-token`. Without that token, environment keys are never used.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `ALLOWED_ORIGINS` | `https://curtis-image-gen.onrender.com` | Comma-separated browser origins for CORS |
| `APP_PROXY_TOKEN` | unset | Token required to use env-stored provider keys |
| `OPENAI_API_KEY` | unset | Protected OpenAI key |
| `A2E_API_KEY` | unset | Protected A2E key |
| `HEDRA_API_KEY` | unset | Protected Hedra key |
| `OPENAI_BASE_URL` | `https://api.openai.com` | Override for OpenAI routing |
| `A2E_BASE_URL` | `https://video.a2e.ai` | A2E upstream |
| `HEDRA_BASE_URL` | `https://api.hedra.com/web-app/public` | Hedra upstream |
| `HEDRA_VIDEO_MODEL_SLUG` | `fal/grok-video-i2v` | Hedra model used for `/hedra/video` (image + text prompt, no audio asset) |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Provider timeout (AbortController on upstream) |
| `MAX_IMAGE_BYTES` | `10 MB` | Maximum reference image size |
| `ALBUM_DIR` | `data/album` | Where to store album assets |
| `ALBUM_MAX_BYTES` | `524288000` (500 MB) | Total album size cap |
| `ALBUM_MAX_ENTRIES` | `500` | Number of items cap |
| `RATE_LIMIT_MAX` | `60` | Per-IP request quota |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window |

## Security

- **SSRF guard** (`assertPublicHttpsUrl`) rejects private/loopback IPs
  on `/album/save-from-url` and on external image references.
- **Per-IP rate limiting** in the `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` window.
- **No `innerHTML` writes** in proxy responses; all errors are JSON.
- **Authorization forwarding** for `/album/save-from-url` so Sora 2
  content (which requires the user's `Authorization` header) can be
  saved via the user's localStorage key.

## Run

```bash
npm ci
npm start
```

The companion front-end repo is **<https://github.com/ABBYCRM/Curtis-Image-Gen>**
and the live static site is at **<https://curtis-image-gen.onrender.com>**.

## Deployment

The service is deployed as a Render web service. Render web services
have ephemeral disk — the album store is wiped on every redeploy. A
future change can move `saveAssetToAlbum` onto Postgres or S3 without
changing the front-end's contract.
