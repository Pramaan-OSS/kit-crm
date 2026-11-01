# CRM and team workspace

MIT · Copyright (c) 2026 Sudo Sapient.

A single Next.js app for shared contacts, companies, notes, deals, sprint tasks and team access. Read KIT.md before extending it; its Capability gaps section lists what is not included.

Use Node 24.18.0 and pnpm 11.15.1. Install with `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile`. Set DATABASE_URL, SESSION_SECRET (at least 32 characters), PRAMAAN_PROJECT_ID and APP_ORIGIN in the runtime environment, without committing them. For local HTTP only, set APP_COOKIE_SECURE=false. Apply `pnpm db:migrate`, then `pnpm dev --port 3307`. Use `pnpm build` and `pnpm start --port 3307` for production checks.

Sign up at /. Create a workspace under Team, or ask its owner to add your sign-in email. A workspace owner can add editors and read-only members. The app owner enters through Pramaan's owner pass at /api/account/owner-pass and manages their own sign-in at /owner; workspace access is still checked separately.

`pnpm test` requires real Postgres; it never skips database tests. `pnpm check` runs generation, lint, types, tests and build. `pnpm walk` runs every shipping checklist on a local production server on port 3307 using headless Chromium. See scripts/local-server.mjs for local test startup; it writes disposable runtime configuration only under ignored .evidence.

Source notices are in NOTICE.md. The app uses the product-loop MIT starter and adapted roles/admin-table blocks, plus the pinned OSS contacts, pipeline, password-reset and theme registry blocks. Block sources, hashes and adaptations are in blocks.lock.json. No original CRM application source is used.
