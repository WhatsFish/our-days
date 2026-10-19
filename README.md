# Our Days / 拾光

A private photo-letter application. One reviewed photograph and caption per day,
with optional WeChat notification. No personal content is included in this repository.

## What works

- Separate administrator/reader pairing codes, expiring revocable sessions,
  same-origin write protection, rate-limited login, authenticated image delivery.
- Single/multiple image uploads and ZIP imports, EXIF extraction, deduplication,
  storage quotas, stripped display images and per-file import errors.
- Reviewable facts and captions, optional text-only AI drafts with explicit
  per-request consent, token/cost records and a monthly reservation budget.
- One edition per local date, immutable published snapshots, cancellation,
  favorites and a reader archive. Future photos cannot be accessed by the reader.
- A database-locked, restart-safe worker; publication and delivery are separate.
  No automatic resend after ambiguous network failures.
- **WeChat test account direct API** (the default configured channel) and
  **PushPlus** as an alternative. Both are disabled until explicitly enabled.
- Optional Open-Meteo city weather and locally calculated lunar calendar.
  The daily encouragement is editorial text, not an invented horoscope.

## Deliberate limits

- No production deployment or real-account delivery is implied by local tests.
  A test account is not a formally certified service account.
- Only static JPEG, PNG and WebP are decoded. Convert HEIC/Live Photos before
  upload. Embedded EXIF capture time and descriptive IPTC/XMP places are prefilled;
  GPS can be resolved to a city only after explicit administrator consent.
  Coordinates are never published in the reader page.
- Prefilled date/place descriptions must still be reviewed. Missing EXIF is never replaced
  with file modification time. AI cannot approve or publish its own output.
- No automatic catch-up after a missed local date, and no automatic photo
  selection. Explicit scheduling avoids accidentally selecting a sensitive photo.
- The current archive shows the newest 366 editions; the photo list shows
  at most 1,000 records. This is a single-recipient application.
- AI conversations, video, map lookup, multi-recipient delivery and automated
  cloud backups are not implemented.

## Runtime

Node.js 22+, Next.js 15.5, React 19, PostgreSQL 16, Tailwind, Sharp and ExifTool.
The older fleet Next.js 14 version was not used because published advisories
affect it. The Next.js PostCSS dependency has a compatible patched override.
Only this project's dependency manifest is affected.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Copy `.env.example` to a **private**, gitignored `.env` only after deployment
approval. All secret placeholders are intentionally empty. Do not reuse demo
codes, test credentials or another project's database role.

`npm run credentials` generates independent random administrator/reader codes
and their scrypt hashes in an interactive terminal. Store only the hashes in the
environment; share the reader code privately. Do not send it inside a push
notification or a URL. Codes can be rotated by changing the hashes and deleting
that role's existing rows from `sessions`.

For local commands, export the environment before running the migration or worker.
Next loads `.env` itself; standalone worker scripts expect exported variables.

```sh
npm run migrate
npm run dev
npm run tick
```

Default path: `/our-days`, host port: `3016`. Verify that the port remains free
before deployment. The database and `MEDIA_ROOT` must already be configured.

For the existing shared-Postgres VM layout, `scripts/bootstrap.mjs` can create
fresh dedicated roles, a database, scrypt-hashed pairing credentials and the
read-only status configuration. It requires an explicit `--approve-new-secrets`
flag and an HTTPS `OUR_DAYS_PUBLIC_URL`. It refuses to overwrite existing project
secrets or claim existing roles. Pairing codes are saved privately under
`~/.config/our-days-access.json`, never printed to logs or committed.

## Storage and deployment gates

Never assume that `/data` is a mounted data disk. Check `findmnt -T /data` and
free capacity first. Keep original photos and encrypted backups on verified
persistent storage, not the OS disk or an Azure temporary disk.

Set `OUR_DAYS_DATA_DIR` (Compose interpolation) to an existing private directory
owned by UID/GID `10001`; Compose deliberately refuses to create an absent host
directory. In containers, `MEDIA_ROOT` is `/media`. `MEDIA_QUOTA_MB` counts uploads,
originals and derivatives; the default is 200 MB. The administrator AI settings
are stored separately under `/data/our-days-config` (UID/GID 10001, mode 700),
mounted at `/config`; `ai.json` has mode 600. Create that directory before
starting Compose. It is included in the encrypted application backup, not Git.

Use a new `our_days` database owned by a new, non-superuser `our_days` role.
The shared database's bootstrap superuser is `umami`, not `postgres`.
Supply a newly approved password through a private mechanism; never interpolate
it into checked-in SQL. Then run the schema migration as the application owner.
The migration is idempotent for schema version 1.

```sh
docker compose build web worker
docker compose --profile jobs run --rm worker node_modules/.bin/tsx scripts/migrate.ts
docker compose up -d web
docker compose --profile jobs run --rm worker
```

`deploy/nginx.conf`, `deploy/nginx-proxy.conf` and `deploy/cron.example` are
**templates, not installed configuration**. After inspecting current state:

1. Install the two nginx snippets as `our-days.conf` and `our-days-proxy.conf`,
   include the former in the existing TLS server, validate nginx and reload.
2. Add a neutral, sign-in-only `/our-days` entry to site-index.
3. Add a status HTTP check for `/our-days/api/health`, a read-only DB role and
   freshness checks using the content-free `service_health` view. The monitor
   role is granted access only to this view, not the photo/story tables. Add the status group label and
   order, then rebuild the status web container.
4. Merge the sample cron entry; do not replace crontab. Register the `our-days`
   heartbeat (warn after 5 minutes, fail after 15) in the status cron checks.
5. Configure the existing central cost sink if enabling AI. Every attempted
   model call also has a local `ai_events` record; sink failures are logged.
6. Create the analytics website manually, then optionally set the two Umami
   variables. Automatic tracking is disabled to prevent private content URLs
   from entering analytics. Do not enable raw URL/event collection.

These changes affect other services and require deployment approval. No
production config or secret is modified by installing or building this repository.

## Direct WeChat test account setup

This channel calls `api.weixin.qq.com` directly and does **not** use PushPlus.

1. Sign in at <https://mp.weixin.qq.com/debug/cgi-bin/sandbox?t=sandbox/login>.
2. Configure the callback URL
   `https://YOUR_HOST/our-days/api/wechat/callback` and a new secret verification
   token. This implementation supports the plain-text callback mode over HTTPS,
   not encrypted callback mode.
3. Have the **operator's test account first** follow the test account. Record its
   OpenID. Do not configure the actual recipient until the test is accepted.
4. Create a test template using these exact variable names:

   ```text
   日期：{{date.DATA}}
   提醒：{{note.DATA}}
   ```

5. Configure `WECHAT_APP_ID`, `WECHAT_APP_SECRET`, `WECHAT_OPEN_ID`,
   `WECHAT_TEMPLATE_ID`, `WECHAT_VERIFY_TOKEN`, `PUSH_CHANNEL=wechat-test`.
   Set any IP allowlist required by the account.
6. Only after permissions and intended usage are confirmed, set
   `PUSH_ENABLED=true`, unpause publication and schedule a reviewed edition
   with its notification checkbox enabled.

Notifications contain only a neutral update message and a private-page link.
The photograph is displayed on our authenticated website, not inside the
template. A shared link without a session does not reveal the picture.

The sender saves the returned 64-bit message ID without numeric truncation.
Signed `TEMPLATESENDJOBFINISH` callbacks update delivery state. Early callbacks
are retained and reconciled by the next worker tick. No callback means
**accepted / not confirmed**, never silently "delivered".

Account permission, template appearance, mobile-browser login and delivery after
72 hours without user interaction still require real-device testing. Do not
repurpose an unrelated production service template or use a test account as a
promise of permanent production availability.

## Direct image presentation probe

`scripts/wechat-image-demo.mjs` renders an explicitly labelled illustrative
card, not a real photograph or live weather report. By default it only renders
and reports dimensions; `--output PATH` optionally saves the PNG. It needs
Chinese fonts and a working Fontconfig configuration.

An explicit `--send-once` uploads temporary image material and calls
`/cgi-bin/message/custom/send` exactly once for the configured operator OpenID.
Global `PUSH_ENABLED` must remain false during this manual probe. It is a
customer-service message, **not** the template channel and **not** a daily
proactive-image solution. WeChat error `45015` means the current recipient is
outside the allowed reply window; do not automatically retry or bypass it.
The recipient can initiate a conversation to test the in-window presentation.
API acceptance must still be confirmed on the recipient's phone.

### Proactive mass-image probe

`scripts/wechat-mass-probe.mjs IMAGE.png` validates a previously rendered
synthetic PNG without sending. With `--send-once`, it uses the separate official
`/cgi-bin/message/mass/sendall` API, never the customer-service API.

Set `PROBE_STATE_FILE` to a new private, writable file path for each explicitly
approved attempt. The script refuses to reuse an existing state file. It creates
a temporary tag, verifies that the tag contains exactly the configured operator
OpenID (including pagination), and sends only to that tag with `is_to_all=false`.
It saves a 32-character idempotency key before submission and polls the returned
task ID. It removes the tag after a terminal result; interrupted or still-pending
tasks retain their tag and state for manual reconciliation, never automatic
resubmission.

For an explicitly approved burst test, `--send-five` sends at most five numbered
cards to the **same** single-recipient tag, waits at least 60 seconds after each
successful task before starting the next, and stops on any rejection or
unconfirmed result. It neither retries failed submissions nor rotates recipient
tags to work around a limit. It records every message ID and timestamp and exits
after the bounded batch; it does not install a recurring schedule.

Status-query quotas are independent of sending quotas. The default probe waits
30 seconds before querying and makes at most two status queries per message.
`--submission-only` explicitly disables result polling; accepted tasks must not
be labelled delivered. If polling was throttled **after a recorded acceptance**,
`--send-five --resume-accepted --submission-only` can continue only the unsent
remainder of that same five-message state file and same recipient tag. It
refuses unknown/rejected submissions and does not resend previously accepted
messages. Tags remain until pending results are reconciled or phone receipt is
confirmed. This mode does not reset, evade or increase any platform quota.

A successful mass-image probe establishes availability of that API and message
format. It does **not** establish an unlimited daily entitlement: API invocation
quota and a recipient's possible monthly delivery limit are different rules.
Formal service accounts normally allow four mass messages per recipient per
month. Test-account exceptions must be verified for the actual account rather
than inferred from a daily quota of 100 calls. Do not use preview endpoints,
multiple accounts or rotating tags to bypass delivery limits.

The signed callback handler separately stores `MASSSENDJOBFINISH` events from
`mphelper` in `wechat_mass_receipts`, including `TotalCount`, `FilterCount`,
`SentCount` and `ErrorCount`. A `send success` status with zero sent recipients
must never be described as delivery. These counters are diagnostic, not human
read receipts. Events received before this handler was deployed cannot be
reconstructed from submission IDs. Tag-targeted broadcasts (`is_to_all=false`)
do not enter the account's public historical-post list; that list is distinct
from a recipient's chat history.

## Alternative under evaluation: WeCom application via WeChat plugin

Official WeCom documentation supports proactive image application messages to
active **internal members** in the application's visible/licensed scope:
<https://developer.work.weixin.qq.com/document/90000/90135/90236>.
The ordinary-WeChat plugin can receive application messages:
<https://open.work.weixin.qq.com/help2/pc/18121>.
This is not external-customer messaging or a customer-service reply window.

This candidate is **not yet verified for this operator's account**. Account
registration/verification, application permissions, trusted IP requirements and
member activation must be established with truthful information before adopting
it. The recipient must be an application member and follow the WeChat plugin;
being a personal WeChat friend or external customer is not sufficient. Do not
use an employer's workspace, fabricate an organization or assume unverified
personal registrations will be accepted.

If setting a trusted IP requires a trusted domain **or a receiving server URL**,
use the application's receiving server configuration:
`https://YOUR_HOST/our-days/api/wecom/callback`. This endpoint implements the
signed AES-256-CBC URL handshake and validates receiver CorpID, padding and
timestamp. POST messages are authenticated, decrypted and acknowledged without
logging, storing or responding to their content; this does not enable chat.

Run `node scripts/prepare-wecom-callback.mjs` on the host to generate missing
callback keys in `~/.config/our-days-wecom.env`. Existing values are preserved.
New EncodingAESKey values are canonical 32-byte Base64 keys restricted to 43
alphanumeric characters for compatibility with the administration UI. If an
existing key containing `+` or `/` is rejected by the UI, explicitly run
`node scripts/prepare-wecom-callback.mjs --rotate-aes-key`, recreate the web
container, and replace EncodingAESKey in the UI with the newly stored value.
Never remove characters manually; rotation must update both endpoints.
Fill `WECOM_CORP_ID` and run the preparation script again. It copies only CorpID
and the two callback keys to a UID-10001, mode-600 runtime file at
`/data/our-days-callback.env`; the application Secret is never copied to the web.
After each sync, recreate the web container so its file bind mount sees the new
inode: `docker compose up -d --no-build --force-recreate web`. Configure the
matching `WECOM_CALLBACK_TOKEN` and `WECOM_CALLBACK_AES_KEY` as Token and
EncodingAESKey in the WeCom administration UI, then save that callback before
retrying trusted IP configuration. This is not a workaround for a separate
identity verification or domain ownership requirement.

`scripts/wecom-image-probe.mjs DEMO.png --send-once` is a minimal manual probe.
It expects exported private `WECOM_CORP_ID`, `WECOM_APP_SECRET`,
`WECOM_AGENT_ID`, `WECOM_USER_ID` variables and `PUSH_ENABLED=false`. No credentials
have been created for this route and it is not wired into the worker. It verifies
an enabled application and active member, uploads a demo, and submits exactly
one image to one member, without a fallback or automatic retry. Invalid or
unlicensed recipient results fail explicitly even if `errcode` is zero.
Acceptance is not receipt: verify the picture in **ordinary WeChat**, not only in
the WeCom client, before changing the daily sender. Mock-only tests run with
`node --test tests/wecom-probe.test.mjs`; they do not establish real eligibility.

## PushPlus alternative

Set `PUSH_CHANNEL=pushplus`. Configure `PUSHPLUS_TOKEN`, the single recipient's
`PUSHPLUS_TO` friend token, and `PUSHPLUS_SECRET_KEY`. Enable the platform's
Open API, set its safe IP list and confirm that its terms permit the intended
notification. The SecretKey is needed to query delivery results.

Only a neutral reminder and protected page URL are sent to PushPlus. No original
photo, caption, private facts, pairing code or GPS data is sent. Platform success
means accepted first; the worker subsequently polls the documented result API.

The selected channel is saved with each delivery. Changing the environment
does not redirect an already-created delivery to a different provider.

## Scheduling and failures

- `settings.paused` starts true; `PUSH_ENABLED` starts false; per-edition
  notifications start false. All three conditions must allow sending.
- A changed timezone/time affects newly saved schedules, not existing UTC
  instants. Re-save future editions to move them.
- Only today's due editions publish. Missed older schedules remain visible
  and are flagged by the monitoring query.
- Approval is checked again at publication. Published captions and date/place
  descriptions are snapshots and never change with later photo edits.
- Weather failures are labelled; no stale forecast is shown as today's.
- The cron heartbeat records a successful worker tick, not receipt on a phone.
- Interrupted submissions become `unknown`. Explicit provider rejections can
  be manually retried up to three attempts on the same local date. An unknown
  result is never blindly retried.
- API `accepted`, provider `delivered`, and human reading are separate concepts;
  no read tracking is implemented.

## AI privacy and costs

Administrators can open **Settings / AI service configuration** to save a
DeepSeek or OpenAI API key, model ID, USD-per-million input/output rates and a
monthly budget, without editing environment files. Only the official fixed
HTTPS endpoints are available; arbitrary client-supplied URLs are not accepted.
Keys are write-only in the UI: a blank field preserves an existing key, deletion
is explicit, and changing providers requires a matching new key. Saving does not
call the provider or enable messaging. The explicit connection test only fetches
the provider's model list, without any photo or caption.

DeepSeek's official key portal is <https://platform.deepseek.com/api_keys>.
Use the provider's current model and pricing documentation rather than stale
model aliases or assumed exchange rates. A nonzero token rate is required before
enabling generation. New installations default to disabled; dashboard settings
take priority once saved. Environment-only configuration remains available if
no dashboard settings file exists.

GPS lookup is a separate opt-in operation: the administrator confirms sending
coordinates rounded to three decimal places to Nominatim (OpenStreetMap).
It returns a city candidate, caches the result and leaves saved place/approval
unchanged until the administrator saves it. No original image is transmitted.
Without GPS or an embedded textual place the system explicitly asks for manual
input; it does not guess a city from a photograph.

AI is off by default. For legacy environment configuration, `AI_URL` is a server-configured HTTPS
OpenAI-compatible chat-completions endpoint, not a user-supplied URL.
Only the explicitly consented, saved facts are transmitted; image bytes,
EXIF and unsaved form text are not sent. Confirm that the configured provider
is approved for any personal text before enabling it.

Set input/output USD-per-million rates and a monthly budget before enabling.
Budget is reserved transactionally before submission; failures or missing usage
retain a conservative estimate rather than hiding possible charges. Candidates
are shown to the administrator and must be manually copied/edited into a caption.
They are not automatically approved or scheduled.

## Integration checks

Use **only** an isolated, disposable PostgreSQL database on port 54326 named
`our_days_test`. The integration runner rejects other settings. It starts and
stops a production Next.js server on loopback port 3316, uses synthetic pictures,
and removes its temporary images. It never sends real messages or AI requests.

```sh
PG_HOST=127.0.0.1 PG_PORT=54326 PG_USER=postgres PG_DB=our_days_test \
  npm run test:integration
```

  To exercise the actual non-root Docker web and worker images (including native
  image/EXIF dependencies), build them as `our-days-web:local` and
  `our-days-worker:local`, then set `OUR_DAYS_CONTAINER_TEST=true` on the same test
  command. Both test containers are transient, share only synthetic fixtures and
  connect to the guarded loopback test database.

The runner clears only its named fixture tables in that guarded test database.
For example, start an existing
`postgres:16-alpine` image with a temporary in-memory data directory, trust auth,
and **only** `127.0.0.1:54326:5432`; remove that test container after the run.
Never enable trust authentication for a production database.

## Backup and recovery

`scripts/backup.mjs --run`, executed on the host under the same `flock` as the
publication worker, creates an authenticated AES-256-GCM archive containing the
database dump, private media and private AI configuration. It briefly stops and then restarts the web
container to prevent writes during the snapshot. It refuses to run with less
than 1.6GiB free, validates decryption before accepting a backup, and retains
the latest two snapshots under `/data/our-days-backups`.

The encryption key is stored separately in `~/.config/our-days-backup.key`.
Keep a separate secure copy of the key and original photos: **same-disk backups
do not protect against disk or VM loss**. `decryptBackup` is exported from the
script for supervised restores; do not extract unauthenticated partial output.
This is an additional encrypted application backup; the shared host's existing
database backup job also automatically includes the new database.

Before real photos: take a database dump and an encrypted backup of the entire
media directory while publication/uploads are paused, retain the original
photos elsewhere, and restore both into an isolated environment. Preserve
original file permissions and the same schema version. In a restored test
environment keep `PUSH_ENABLED=false`, `AI_ENABLED=false` and publication paused.
Invalidate restored sessions. Validate a restore into an isolated database before
relying on the backup, and repeat the drill after importing real photographs.
