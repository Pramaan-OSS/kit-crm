# Password reset (`password-reset`)

Request an emailed reset link, choose a new password, or change a password while signed in.
Licence: MIT.

## Install

```bash
npx shadcn@4.23.0 add https://raw.githubusercontent.com/Pramaan-OSS/blocks/main/public/r/password-reset.json
```

Install the shared theme as described in the repo README. Render:

```tsx
import { PasswordPanel } from "@/components/pramaan/password-reset/password-panel";

<PasswordPanel />
```

Routes use Next.js’s default Node.js runtime, including when Cache Components is enabled.

Put that panel at `/password-reset`, the path used by emailed links. The registry includes the POST
handler at `/api/pramaan/password-reset`, the server helpers and the database migration. The demo
page and sample mailbox are repository examples, not installed public routes.

## Connect local accounts

The default live handler refuses requests until the app supplies its database and verified session
lookup. This block owns no sign-up or sign-in system. It supports the kits' local accounts, not a
remote managed auth password. Pramaan does not yet offer password resets for remotely managed accounts.

Apply `migrations/001-password-reset.sql` after the account tables. The supplied Postgres adapter
expects `app_users(id uuid, email text, password_hash text)` and `app_sessions(user_id uuid)`.
Existing three-part scrypt hashes remain readable. New hashes include their cost parameters:
`scrypt$N=131072,r=8,p=1$salt$key`, with a 256 MiB memory ceiling per operation. **Update the
host app's password verifier before enabling resets.** An older verifier that only understands
the three-part format cannot sign in after a reset. Use `hashResetPassword` for new passwords,
`verifyResetPassword` to read both formats, and `verifyAndUpgradeResetPassword` in sign-in to
upgrade an older hash after successful verification. Password changes always write the stronger
format. The latter helper compares the old hash before replacement and ends existing sessions;
create the new signed-in session only after it returns true. For example, in the host's sign-in:

```ts
const account = await resetStore.find(email);
if (!account || !await verifyAndUpgradeResetPassword(resetStore, account, password)) {
  // Use the host's existing generic sign-in refusal.
  return refuseSignIn();
}
return startSession(account.id);
```

Pramaan does not update your app's password verifier for you. Use the helpers above in your
app's sign-in flow before enabling resets.
The migration adds only `app_password_resets`; it provisions nothing. Adapt the `ResetStore` interface if the
host app uses different tables. Preserve its atomic operations and session invalidation.

Replace the installed route's POST wiring with the app's own imports, for example:

```ts
import { createPasswordReset } from "@/lib/pramaan/password-reset";
import { postgresResetStore } from "@/lib/pramaan/password-reset-store";
import { configuredResetSender } from "@/lib/pramaan/password-reset-sender";
import { pool } from "@/lib/db";
import { accounts } from "@/lib/accounts-runtime";

const passwords = createPasswordReset({
  store: postgresResetStore(pool),
  sender: configuredResetSender(),
  origin: process.env.PRAMAAN_PASSWORD_RESET_ORIGIN!,
  currentUser: async (request) => {
    try { return (await accounts.requireUser(request)).id; }
    catch { return undefined; }
  },
});
export const POST = passwords.handle;
```

`pool` and `accounts` above are the host app's existing database pool and local account helper,
not files installed by this block. The session lookup must verify the server session; never trust
a submitted user id. `configurePasswordReset(options)` is also available for apps that initialize
shared server configuration before calling the default route.

Set `PRAMAAN_PASSWORD_RESET_ORIGIN` to the exact public HTTPS origin, without a trailing slash or
path. Only localhost may use HTTP. The handler requires the same Origin on POST requests. Links
never use a submitted Host header. Passwords must be 12 to 1,024 characters.

## Choose the email sender

Both adapters implement `ResetSender.send(message, eventKey)`. There is no automatic fallback
between senders, no vendor client, and no automatic resend after an uncertain outcome.

**Reset links must stay private.** A normal capability email can put its entire message in the
approvals inbox. That would let another person change the account's password. Cancelling after
the message is held is too late to prevent someone reading it. This block therefore sends reset
links only through the private app email module by default. Choosing `capability` refuses the
send before any message reaches Pramaan and removes its reset proof. It does not attempt a
capability call or bypass approval. Standalone apps need the module mount or a private sender
implementing this interface; a safe private capability dispatch is a documented gap.

| Setting | Transport | Required setup |
|---|---|---|
| `PRAMAAN_PASSWORD_EMAIL_TRANSPORT=module` (default) | Local `/pramaan-modules/modules.sock`, `POST /v1/email` | Kit runtime mounts its module socket and token and configures its own sender. No capability key is needed for this adapter. |
| `PRAMAAN_PASSWORD_EMAIL_TRANSPORT=capability` | Refused before a capability call | Reset secrets cannot be put into approval-visible inputs. `PRAMAAN_PASSWORD_EMAIL_FROM` does not override this refusal. |

The module adapter follows product-loop's email-notices contract: `{ to, subject, text }`, bearer
token read from the module mount, and the same event key on `Idempotency-Key`. The token stays on
the server. The capability adapter remains as a refusal for existing configurations, so an old
setting cannot silently disclose a new reset link. A failed or uncertain send invalidates its
proof. Only outcome names and counts are logged; addresses, bodies, links and upstream errors
are never logged.

Pramaan does not yet offer private capability delivery for password-reset emails. Use the
private app email module so reset links stay out of approval requests.

## Reset safeguards and limits

- The public request answer is identical for existing and missing email addresses, and also when
  account storage or delivery fails. Both addresses schedule the same work through Next's
  `after()` and answer before any account lookup, proof storage or email round trip. Slow or
  failing delivery cannot delay the known-address response. This requires Next's Node runtime
  and its post-response task support; arbitrary network jitter is not controlled. The answer
  never returns a reset link. Check delivery setup before publishing; a public success answer
  is not delivery confirmation.
- Reset proofs are 32 random bytes, valid for 30 minutes, stored only as SHA-256 hashes. The
  emailed proof is in the URL fragment, which browsers do not send in HTTP requests. The panel
  removes the fragment from the current address after reading it. A link is not consumed on GET.
- A new request replaces the previous proof. Redeeming a proof locks the account and atomically
  checks expiry and the password version, consumes all its proofs, changes the password and
  removes all its sessions. Concurrent redemption succeeds once. A signed-in change requires
  the current password and invalidates the same proofs and sessions. Neither action signs in
  the person automatically.
- Shared `pramaan-core` limits: ten actions per IP and three reset requests per normalized email
  in 15 minutes; signed-in changes also have five attempts per account. Missing client IPs share
  the shared fallback bucket of 100 actions per 15 minutes and warn once on the server.
  Configure the trusted proxy settings documented by the shared public
  guard, and ensure direct app access cannot bypass that proxy.
- The reused limiter is per process. Before running several app instances, replace its counters
  with a shared atomic store. Password derivation is capped at four concurrent operations per
  process. No passwords, proof values, email bodies or upstream errors are logged.
- When `PRAMAAN_BOT_CHECK_SECRET` is set, both the request and reset endpoints require a fresh
  `botCheckToken`, verified with `auth.bot-check.verify` through the neutral `verifyPublicBot`
  guard. Supply `<PasswordPanel getBotCheckToken={...} />` with the site's existing widget
  callback, as the booking block does. Missing or failed checks stop before account lookup,
  email or password work. No widget vendor is called by this block directly.
- Request bodies are capped at 4 KiB, responses are not cached, and origin checks protect changes
  from forms on other sites. Expired rows can be pruned with
  `DELETE FROM app_password_resets WHERE expires_at <= now()`; each account has at most one row
  after a request. Run maintenance from the host app's existing job runner.

## Demo and checks

With `PRAMAAN_FAKE=1`, `/password-reset` uses an in-memory sample account (`sam@example.com`,
initial password `Starting password 42`) and a private in-memory mailbox. Choose **Check sample
mail** to open its messages; no reset secret goes into the shared approvals fake. No real email is sent. The
sample mailbox and sign-in test endpoint return 404 outside fake mode; they are not registry
files and must not be deployed with fake mode enabled. Production rejects sample accounts and
these endpoints even if `PRAMAAN_FAKE=1` was left on. The production-build browser tests use an
explicit `PRAMAAN_PASSWORD_RESET_TEST_MODE=1` exception, accepted only with a loopback configured
origin and matching loopback request origin. Never set it on a deployed app. The mailbox checks the browser-controlled same-origin marker on GET and the Origin on POST; sample sign-in is rate limited and uses Secure cookies on
HTTPS.

Unit tests cover single use, concurrent use, expiry, replaced links, storage and delivery
failures, current-password checks, session removal, origin checks, request limits and both
sender adapters. Statement-order tests check user-row locking, proof re-check and rollback.
The opt-in local Postgres test exercises concurrent redemption, mixed-case emails, password
version binding and rollback after a session-deletion error. It accepts only a loopback database,
creates a unique test schema, and drops that schema afterward. Enable it explicitly with
`PRAMAAN_PASSWORD_RESET_PG_TEST=1` and set `PRAMAAN_PASSWORD_RESET_PG_URL` to a disposable local
database URL. It never provisions a remote database. The headless browser walk requests an email, follows its link, rejects a
reused proof, signs in with the changed password, changes it again and checks the session ended.

```bash
pnpm registry:build
pnpm typecheck && pnpm test && pnpm build && E2E_PORT=3304 pnpm e2e
```
