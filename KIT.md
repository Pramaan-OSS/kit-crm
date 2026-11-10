# CRM and team workspace

## Where things live

One Next.js App Router app. Use pnpm 11.15.1 with Node 24.18.0. Accounts in lib/accounts.ts are the starter's exact bytes, including owner-pass checks and private tasks used by platform probes. Do not provision database or auth services at startup.

lib/workspace.ts owns organisations and membership. Each account belongs to at most one organisation. The creator is its manager; public signup grants no team access. A global app owner has no bypass of workspace membership. Workspace managers add existing accounts as editor or viewer, never by trusting client role claims. App owner settings remain under /owner.

Contacts and pipeline are adapted MIT registry blocks in lib/pramaan and components/pramaan. lib/pramaan/crm-data.ts is the shared server storage boundary: derive scope from the session's membership, lock the organisation row, recheck membership, then run the row queries in that transaction (withScope). Membership changes acquire the same organisation lock. No fake storage path exists. All SQL values are parameters. Caller-supplied organisation and user identifiers cannot select data.

Stages are data: each workspace's ordered list is the crm_stages table (0106), seeded with New, In progress and Won for every workspace. The board's columns, totals, card stage choices and the list view's stage filter all read it; owners and editors change it in the board's Stage settings (stage actions in lib/pramaan/pipeline.ts). Never hard-code stage names. A stage that still has cards cannot be removed, and its cards never move on their own.

Records are rows scoped by org_id: crm_contact_rows (people and companies; a person's company_id points at a company in the same workspace), crm_deals (stage_id, optional company_id, contact_id and renewal_on), crm_stages. Each row has owner_id, the account that added it. Internal notes stay one crm_records document per workspace.

One-person mode (crm_organisations.one_person, 0107, set by the workspace owner on /team, off by default): a member sees and changes only rows they own; the owner sees all. Access.only in crm-data.ts carries it; every contacts and pipeline query filters by it, including search, export, joins and totals. A new query on these tables must too.

src/db/migrations contains unchanged starter migrations and numbered kit migrations from 0100. Apply in one transaction as a non-superuser database owner. Never edit an applied migration. scripts/migrate.mjs detects edits and out-of-order additions. 0105-release-member.sql gives every key on app_users an ON DELETE rule: deleting an account removes the workspace it created, with that workspace's access and documents, and its access to any other workspace. Every row table's org_id key cascades (0106), so that workspace's rows go too. A member who leaves another workspace (removed or released) hands their rows to its owner (crm_hand_over_rows). 0106 moved each workspace's old contacts and pipeline documents into rows and emptied them; nothing reads crm_contacts or crm_pipeline now. The contacts and pipeline registry migrations were renamed; block source hashes retain their original bytes.

Each organisation has up to 2,000 contacts and companies, 200 notes and 50 history items per contact, 4 MiB of notes and history per contact row, 16 MiB of notes and history across its contacts, 500 cards, 1 to 20 stages, 500 internal records in a 4 MiB document and 50 people. Requests are streamed with a 20,000-byte cap. Collection and size checks execute inside the locked transaction. Delete unused entries to make room. These are logical data limits, not a promise about total database disk usage or the number of organisations.

The server uses one pg pool capped at six connections. No remote fonts, SDK or provider connections. Email goes only through lib/email.ts and the local platform module door. PRAMAAN_FAKE does not bypass membership or database writes.

## Add a field

Example: the deal renewal date. Add a new numbered migration (0107 adds crm_deals.renewal_on); never edit an applied one. Then read and write the column in lib/pramaan/pipeline.ts (the SELECT in getPipeline, the validated value in updatePipeline's save), add the input to the card form in components/pramaan/pipeline/pipeline-panel.tsx, and test it on real Postgres in lib/crm-rows.spec.ts. Contacts work the same way in lib/pramaan/contacts.ts and contacts-panel.tsx. Keep size and collection bounds, revision checks and the one-person filter. Never return private account tables through internal records. blocks.lock.json records adapted upstream files; update adaptation notes when changing them.

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
