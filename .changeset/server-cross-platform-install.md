---
"@whitestag/pii-proxy-server": minor
---

feat(server): cross-platform service install (macOS / Linux / Windows)

Replaces the Linux-only systemd shell scripts with a portable Node-based
installer so the server can run as a managed service on all three platforms:

- New `service:install` / `service:uninstall` / `service:smoke` /
  `service:keygen` npm scripts (`scripts/*.mjs`) replacing the old `.sh`
  variants. macOS uses `launchd`, Linux uses `systemd`, Windows uses
  `node-windows` (declared as an `optionalDependency` so non-Windows installs
  stay lean).
- The installer passes `PORT` / `BIND` / `CLASSIFIER` overrides through to the
  generated service definition, so a non-default port, bind address, or
  classifier endpoint survives a service install.
- Service-template and path-resolution logic is unit-tested
  (`scripts/lib/*.test.mjs`, run via `npm run test:scripts`).
