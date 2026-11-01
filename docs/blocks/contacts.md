# Contacts

Search people and companies by name, email or linked company. Add and edit contacts, link people to companies, add notes, and read the contact history.

## Install

```sh
npx shadcn@4.23.0 add https://raw.githubusercontent.com/Pramaan-OSS/blocks/main/public/r/contacts.json
```

Load the Pramaan theme using the root README instructions. The install ships the original block implementation, the shared CRM data layer, existing Pramaan browser/session helpers, `postgres@3.4.7` and `server-only`. New CRM code is original to this repository; no implementation was copied from another project. Licence: MIT, as in the repository LICENSE.

## Connect your app

Set `DATABASE_URL` on the server to your app's Postgres connection string. Do not expose it or `PRAMAAN_API_KEY` to browser code. No Pramaan key is needed by this block: it makes no outside capability calls. Company enrichment is outside this scope.

Apply the numbered migration once before starting the app:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/db/migrations/crm_contacts_001.sql
```

Migrations do not run on page loads. Use your deployment's migration tracking; the create-table statements can safely run again. No database is provisioned by the block. Both blocks may be installed together: their migrations and tables have distinct names.

Wire `currentMemberId(request)` in `lib/pramaan/session.ts` to your trusted server sign-in. Its production default denies access. `crmScope` in `lib/pramaan/crm-data.ts` uses that signed-in member as the data boundary. Wire `canWrite(member, scope)` beside the sign-in hook using trusted membership data. It denies production writes until configured; the same hook enforces owner-only writes in the fake. To share data across a team, replace the scope lookup with an authorised workspace membership lookup and check write roles for that workspace in `canWrite`. Never use a workspace or role supplied by the browser. Reads and writes always use the server-derived boundary. Mutation requests require `application/json`. They accept a missing Origin for server clients; browsers must use the same origin. Set `CRM_APP_URL` to your public app URL when a proxy rewrites the internal host or protocol. Forwarded host headers are not trusted, and these routes do not approve cross-site CORS preflights.

Records live in the app-owned `crm_contacts` table as one document per data boundary. Writes lock that row inside a transaction so concurrent saves do not overwrite unrelated records. This small data layer suits modest workspaces; large datasets should move to normalised tables with paginated queries. Each record carries a revision number. Every edit, move, note change and deletion must send the revision that was read. A mismatch is rejected with a conflict response and a plain message; an old form cannot overwrite newer work. Old rows without revisions read as revision zero. Drafts stay open during other actions; after a conflict, explicitly replacing the draft loads the latest record. Only a move action changes an existing card’s stage. Opaque record references travel in requests but are never displayed on screen. Raw database errors are not returned or logged.

## Use

```tsx
import { ContactsPanel } from "@/components/pramaan/contacts/contacts-panel";

<ContactsPanel />
```

The screen calls only this app's `/api/pramaan/contacts` route. The installed `lib/pramaan/crm-data.ts` is server-only. No vendor SDK, enrichment, database provisioning or external API is used.

## Demo and checks

`PRAMAAN_FAKE=1 pnpm dev` opens the fake demo at `/contacts`. It uses an in-memory store that resets on restart and never opens Postgres. Set `PRAMAAN_FAKE` only for demos and tests; never use it for real customer data. The existing fake sign-in cookie selects the demo member. Screens start empty and support loading, empty and failure states.

Unit tests exercise the fake data layer and routes, including sign-in, isolation, validation and persistence across reads. The headless CRM walk covers both demo screens and reloads. Required repo checks: `pnpm registry:build`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `E2E_PORT=3305 pnpm e2e`. Tests never call outside capabilities. With `TEST_DATABASE_URL` unset, the Postgres suite is skipped and no database is contacted. To test real storage, point `TEST_DATABASE_URL` at a disposable Postgres database and run `pnpm exec vitest run tests/crm.postgres.test.ts`. It applies both migrations twice, checks 20 concurrent additions, transaction rollback, JSON round-trips and stale edits, then removes only its generated test scopes. The CRM CI job supplies a temporary Postgres service and runs the unit suite with this test enabled.

## Storage ceiling and deletion

Each block document has a hard 4 MiB JSON byte ceiling. These are small-workspace blocks; larger use needs normalised tables and paged database queries rather than raising these limits. Migration names are namespaced (`crm_contacts_001.sql`, `crm_pipeline_001.sql`) so they do not collide with an app's `001_users.sql`. Both migrations are idempotent; installations using the earlier filenames already have the same tables and need no data rewrite.

A workspace can hold at most 2,000 contacts, with at most 200 notes per contact, and only the latest 50 history entries are retained. These are ceilings, not targets; the overall byte ceiling can be reached first. Contact, company and note deletion require confirmation on screen. Deleting a company clears every linked person's company reference and records that change in the same transaction, advancing those people's revisions. A stale confirmation cannot delete a changed record or the wrong note.

While a contact's edit form is open, adding or deleting its notes and deleting that contact are disabled. Save or cancel the edit to use those actions again. Notes and history remain readable, and an unsent note draft is kept. A note added in another tab can still make the form stale; the revision check protects that newer information.
