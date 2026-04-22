# @whitestag-ai/pii-proxy-server

## 0.1.0

### Minor Changes

- Initial public release.
  - Fastify 4 HTTP gate on configurable port (default 4711)
  - Endpoints: `POST /anonymize`, `POST /deanonymize`, `POST /safe-call`, `GET /health`
  - `X-PII-Proxy-Key` shared-secret auth with `timingSafeEqual`
  - Monitor loop with Telegram alerts for Art. 9 blocks, classifier-down streaks, and error-rate bursts
  - Deploy assets: macOS launchd plist, Linux systemd unit, Dockerfile
