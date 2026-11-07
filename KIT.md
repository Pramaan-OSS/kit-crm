# CRM and team workspace

## Where things live

One Next.js App Router app. Use pnpm 11.15.1 with Node 24.18.0. Accounts in lib/accounts.ts are the starter's exact bytes, including owner-pass checks and private tasks used by platform probes. Do not provision database or auth services at startup.

lib/workspace.ts owns organisations and membership. Each account belongs to at most one organisation. The creator is its manager; public signup grants no team access. A global app owner has no bypass of workspace membership. Workspace managers add existing accounts as editor or viewer, never by trusting client role claims. App owner settings remain under /owner.

Contacts and pipeline are adapted MIT registry blocks in lib/pramaan and components/pramaan. lib/pramaan/crm-data.ts is the shared server storage boundary: derive scope from the session's membership, lock the organisation row, recheck membership, then lock the document. Membership changes acquire the same organisation lock. No fake storage path exists. All SQL values are parameters. Caller-supplied organisation and user identifiers cannot select data.

src/db/migrations contains unchanged starter migrations and numbered kit migrations from 0100. Apply in one transaction as a non-superuser database owner. Never edit an applied migration. scripts/migrate.mjs detects edits and out-of-order additions. 0105-release-member.sql gives every key on app_users an ON DELETE rule: deleting an account removes the workspace it created, with that workspace's access and its three documents, and its access to any other workspace. The contacts and pipeline registry migrations were renamed; block source hashes retain their original bytes.

Each organisation has up to 2,000 contacts, 200 notes per contact, 50 history items per contact, 500 cards, 500 internal records and 50 people. Each document is bounded to 4 MiB, so each organisation can hold at most 12 MiB across the three documents. Requests are streamed with a 20,000-byte cap. Collection and size checks execute inside the locked transaction. Delete unused entries to make room. These are logical data limits, not a promise about total database disk usage or the number of organisations.

The server uses one pg pool capped at six connections. No remote fonts, SDK or provider connections. Email goes only through lib/email.ts and the local platform module door. PRAMAAN_FAKE does not bypass membership or database writes.

## Add a field

Add validation to the appropriate block update function and its screen. Keep size and collection bounds and revision checks. Add an additive migration if relational schema changes. Never return private account tables through internal records. blocks.lock.json records adapted upstream files; update adaptation notes when changing them.

## Add a page

Use app/<page>/page.tsx and a pramaan.feature.json with routes and nav lists. Run pnpm generate. All shared data APIs use crmRoute and the storage guard, including exports. Keep plain on-screen wording. Protected starter layout loads local fonts and theme on every page.

## Add a role

Workspace permissions are manager, editor and viewer. Only a workspace creator is manager. Only a manager may add, change or remove access. Member is the public app account role, separate from workspace access. A viewer can read but every server write refuses them. Change the database constraint in a new migration, lib/workspace.ts (who may grant it) and permit in lib/pramaan/crm-data.ts (what it may write) together, and test revocation while a write waits for the organisation lock. Never grant owner from public signup.

## Journeys that ship working

- create-workspace: creates a shared workspace.
- manage-contacts: adds people, company links, notes, history and edits.
- run-sprint-board: adds tasks or deals, moves and edits cards.
- manage-records: searches, adds, edits and exports internal notes.
- team-access: adds an existing account with read-only access.
- account-signin: signs in to the shared team.
- owner-settings: opens owner sign-in settings with the platform pass.
- password-reset-off: explains the email requirement plainly.

Each checklist under journeys prepares its own accounts and workspace on a fresh database. The headless walk uses port 3307 and Chromium only. Additional browser checks cover independent team sessions, forbidden writes, isolation, exports and used/forged/expired/foreign owner passes. Tests require real DATABASE_URL and fail rather than skip without it.

## Capability gaps

Password reset and verification links need the email module and configured sender. Attachments, scheduled reminders, external connections, imports, outbound messages and billing are not built: there is no code for them, so no journey claims them. Going live with data needs the platform's live database, off by default. The owner can recover through Pramaan's owner pass when email is off. Member signed-in password changes are not included.

## Checks and limits

pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile; pnpm check; pnpm walk. scripts/check-contract.mjs calls the platform's actual contract, licence, secrets and packages gates. The local Postgres tests are part of pnpm test, which the platform runs inside its test gate. scripts/check-blocks.mjs verifies source hashes and migration adaptations against the recorded local repositories.

Measurements and gate verdicts belong in kit-ci.json. A local run without the platform's verified install network and hosted run address cannot make this kit available in the catalogue. Never mark that record green on partial evidence. Docker is shared; remove only this lane's named test database and never prune.
