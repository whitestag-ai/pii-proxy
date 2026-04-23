---
"@whitestag/pii-proxy-core": patch
"@whitestag/pii-proxy-server": patch
---

Re-trigger release pipeline with corrected `publishedPackages` gate so
that the GHCR Docker image and PyPI artefact are produced alongside the
npm publish. Package contents are functionally identical to 0.2.0.
