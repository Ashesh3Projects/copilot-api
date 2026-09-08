# Copilot API

A self-hosted compatibility gateway and operator console for using GitHub
Copilot through OpenAI-, Anthropic-, and Google-style API surfaces.

Copilot API translates requests, selects an eligible Copilot account and
upstream protocol, and normalizes the response for the calling client. It also
provides a local control plane for inspecting requests, managing models and
providers, monitoring usage, and supporting Claude Code and Codex Desktop
workflows.

> [!WARNING]
> This is an unofficial, reverse-engineered project. It is not supported by or
> affiliated with GitHub, OpenAI, Anthropic, or Google, and upstream changes can
> break compatibility without notice. Use it only with accounts and systems you
> are authorized to operate.

> [!IMPORTANT]
> Automated or high-volume Copilot traffic can trigger abuse controls or account
> restrictions. Follow [GitHub's Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies)
> and [GitHub's terms for Copilot](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features),
> respect upstream service policies, and do not use this project to evade
> upstream restrictions.

## Contents

- [Compatibility](#compatibility)
- [Features](#features)
- [Quick start](#quick-start)
- [Client configuration](#client-configuration)
- [Authentication and network exposure](#authentication-and-network-exposure)
- [Models, routing, and providers](#models-routing-and-providers)
- [Multiple Copilot accounts](#multiple-copilot-accounts)
- [Operator dashboard](#operator-dashboard)
- [Claude Code and Codex integrations](#claude-code-and-codex-integrations)
- [CLI reference](#cli-reference)
- [Configuration and persistent data](#configuration-and-persistent-data)
- [Docker](#docker)
- [Reverse proxy deployment](#reverse-proxy-deployment)
- [Security and privacy](#security-and-privacy)
- [Security policy and remediation record](SECURITY.md)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Attribution and license](#attribution-and-license)

## Compatibility

These are compatibility endpoints and translation layers, not claims of complete
parity with every feature of the upstream APIs.

See the [detailed Copilot API compatibility contract](docs/copilot-api-compatibility.md)
for field handling, endpoint precedence, streaming, affinity, and current
feature-flag limitations.

> [!WARNING]
> Authenticated inference clients can direct attachment/file recovery to any
> runtime-valid absolute HTTP(S) destination, including internal and
> metadata-style targets, and final non-empty upstream failure bodies are
> delivered to normal clients and ordinary logs/Sentry. Grant inference access
> and network reach only where that authority is acceptable.

| API family | Method and path | Support |
| --- | --- | --- |
| OpenAI Models | `GET /v1/models` | Live model discovery plus configured aliases, reasoning variants, redirect sources, and custom-provider models |
| OpenAI Chat Completions | `POST /v1/chat/completions` | Streaming and non-streaming chat, tools, and supported attachments |
| OpenAI Responses | `POST /v1/responses` | Streaming and non-streaming Responses requests, with protocol fallback when a model lacks native Responses support |
| Responses compaction | `POST /v1/responses/compact` | Compatibility compaction that returns a proxy-generated `response.compaction` item |
| Responses WebSocket | WebSocket upgrade on `/v1/responses` or `/responses` | Stateful Responses-style streaming over WebSocket; this is not the OpenAI Realtime API |
| OpenAI Embeddings | `POST /v1/embeddings` | Copilot embeddings or a configured custom embedding provider |
| OpenAI Audio Transcriptions | `POST /v1/audio/transcriptions` | OpenAI-compatible multipart transcription backed by Groq; `whisper-1` maps to the configured Groq Whisper model |
| Anthropic Messages | `POST /v1/messages` | Streaming and non-streaming Messages translation, including native routing where available |
| Anthropic token count | `POST /v1/messages/count_tokens` | Compatibility token counting |
| Google Generative AI | `POST /v1/models/:model:generateContent` | Non-streaming Google request and response translation |
| Google Generative AI streaming | `POST /v1/models/:model:streamGenerateContent` | Streaming Google translation |

Most OpenAI inference routes also work without the `/v1` prefix. Audio
transcriptions use only the canonical `/v1/audio/transcriptions` route. Google
routes are available under `/v1/models`, `/v1beta/models`, and `/models`.

Model availability is account-specific and changes upstream. Query
`GET /v1/models` instead of relying on a hardcoded model list.

## Features

### Protocol translation

- Selects native Chat Completions, Responses, or Messages upstream paths based
  on model capabilities and request content.
- Translates streaming events, tool calls, usage, errors, images, and supported
  file attachments between client formats.
- Uses model- and request-specific fallback paths where implemented, such as
  Responses-to-Chat-Completions translation for non-native models and native
  Messages handling for supported PDF flows.
- Supports Responses over HTTP and WebSocket, including continuation requests
  and compatibility compaction.

Compaction preserves the final summary across multiple output blocks and
reports incomplete or empty summaries as failures, so clients can retain their
original history. Models advertising only Messages use that endpoint for
compaction. When native Chat would lose an attachment, routing prefers an
advertised endpoint that can carry it; text fallback remains available when no
compatible representation exists. Translated signed Anthropic reasoning uses
an opaque round-trip representation in `reasoning_opaque`; clients should echo
it unchanged with the assistant message.

### Model control

- Builds discovery results from the live models available to the authenticated
  Copilot account or accounts.
- Exposes supported reasoning-effort variants as `model:effort` virtual IDs.
- Normalizes supported Claude dotted/dashed names and eligible `[1m]` aliases.
- Applies ordered, exact-match model redirects with optional source and target
  reasoning efforts, chaining, loop detection, and priority control.
- Stores per-model settings for supported/default reasoning efforts, virtual
  model visibility, implicit defaults, assistant-prefill behavior, selected
  unsupported request parameters, and Sentry model names.
- Applies literal or regular-expression replacements to message text on Chat
  Completions and the translated Messages and Google paths. Replacements do not
  rewrite arbitrary request fields or direct Responses payloads.

Redirects apply to Chat Completions, Messages, Responses HTTP/WebSocket, Google
translation, and Messages token counting. They do not apply to embeddings or
Responses compaction.

### Provider and account routing

- Adds OpenAI-compatible custom chat and embedding providers without changing
  the client-facing base URL.
- Routes by model ID or alias with deterministic collision behavior.
- Uses multiple GitHub accounts only when at least two tokens are configured.
- Builds a per-model eligible-account index, supports per-account model
  enablement, keeps Claude Code sessions on a stable account, and performs one
  same-instance alternate-account failover for quota and transient failures.

### Operations

- Integrated dashboard for usage, sessions, environments, request inspection,
  replay, model redirects/settings/routing, custom providers, replacements,
  feature flags, IP allowlists, and configuration export.
- Current GitHub Copilot quota reporting through both the CLI and `GET /usage`.
- Durable minute/model request and token aggregates plus lifetime totals, with
  collection-gap indicators for lost or uncertain telemetry.
- Manual approval for primary generation endpoints.
- Optional Sentry tracing.

### Client compatibility

- Claude Code Messages, scoped OAuth, authenticated Remote Control,
  environments, sessions, feature flags, and opt-in Direct Connect stubs.
- Codex Desktop dictation, transcript cleanup, and Statsig override support.
- Groq-backed speech-to-text for voice and dictation endpoints.

## Quick start

### Requirements

- A GitHub account with an active Copilot subscription.
- Bun for package and source usage. Docker is an alternative.

From this checkout, install dependencies, issue a one-use setup code, and start
on loopback. Both commands must select the same database:

```sh
bun install
bun src/main.ts admin --setup-code
bun src/main.ts start --host 127.0.0.1
```

Without the optional Turso pair, this uses `copilot-api.sqlite` in `DATA_DIR`
(default `~/.local/share/copilot-api`). Open
`http://127.0.0.1:4141/dashboard` and enter the printed setup code, a new long
random gateway key, and an administrator password. The code expires after 15
minutes and can be used once. No GitHub account is needed to open setup.

Add GitHub.com or GitHub Enterprise Cloud accounts through the dashboard. The
account registry and credentials are stored in the selected database. Existing
JSON files and environment credentials are imported only through an explicit
migration command; see the [storage runbook](docs/turso-storage.md).

List the models available to that account:

```sh
curl http://127.0.0.1:4141/v1/models \
  -H "Authorization: Bearer replace-with-a-long-random-key"
```

Choose an ID returned by that endpoint and make a request:

```sh
curl http://127.0.0.1:4141/v1/chat/completions \
  -H "Authorization: Bearer replace-with-a-long-random-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL_ID_FROM_V1_MODELS","messages":[{"role":"user","content":"Hello"}],"stream":false}'
```

Use the gateway key chosen during setup for the requests above.

> [!CAUTION]
> Always pass `--host 127.0.0.1` for a local-only server. If `--host` is
> omitted, Bun's default is to listen on all interfaces even though the startup
> message uses `localhost`.

## Client configuration

### OpenAI-compatible clients

Use the `/v1` base URL and a stored gateway or scoped inference credential.

```dotenv
OPENAI_BASE_URL=http://127.0.0.1:4141/v1
OPENAI_API_KEY=replace-with-gateway-key
```

Ordinary inference routes require credentials even on loopback.

Audio transcription uses the same `/v1` base URL and gateway key. It requires
a Groq API key stored through the dashboard:

```sh
curl http://127.0.0.1:4141/v1/audio/transcriptions \
  -H "Authorization: Bearer replace-with-gateway-key" \
  -F "file=@recording.webm" \
  -F "model=whisper-1" \
  -F "response_format=json"
```

The `whisper-1` compatibility name maps to `groqModel`, which defaults to
`whisper-large-v3-turbo`. Groq-native `whisper-large-v3` and
`whisper-large-v3-turbo` model IDs are also accepted. OpenAI-only GPT
transcription and diarization models are rejected with an OpenAI-shaped `400`
because Groq cannot serve those model contracts. The Whisper-compatible
`json`, `text`, `verbose_json`, `srt`, and `vtt` response formats are supported;
SRT and VTT are rendered from Groq's verbose segment timestamps. Other
multipart fields are forwarded unchanged.

### Anthropic-compatible clients and Claude Code

The Anthropic base URL does not include `/v1`:

```dotenv
ANTHROPIC_BASE_URL=http://127.0.0.1:4141
ANTHROPIC_AUTH_TOKEN=replace-with-gateway-key
```

Select current primary and small-model IDs from `GET /v1/models`. Set
`ANTHROPIC_AUTH_TOKEN` to the stored gateway or inference credential.

The interactive helper can generate a Claude Code launch command after loading
the current model list:

```sh
bunx --bun @ashsec/copilot-api@latest start --host 127.0.0.1 --claude-code
```

The generated command always uses `dummy`. Before running it, replace that value
with a stored gateway or inference credential.

### Google-compatible clients

Use the Google-compatible route and provide the gateway key through
`x-goog-api-key`:

```sh
curl "http://127.0.0.1:4141/v1beta/models/MODEL_ID_FROM_V1_MODELS:generateContent" \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: replace-with-gateway-key" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Hello"}]}]}'
```

Use the `streamGenerateContent` action for streaming. Google Search,
code-execution tools, cached content, labels, and safety settings are not
currently translated.

## Authentication and network exposure

Copilot API separates these credential boundaries:

1. **GitHub credentials** authenticate the server to GitHub Copilot. Manage
   accounts through the dashboard or the database-backed `config` CLI. `auth`
   runs browser/device authentication, validates the account, and saves it in
   the selected database without printing the credential. `start` never runs
   a first-use device flow.
2. **Gateway credentials** authenticate trusted data-plane clients and OAuth
   authorization. Initial setup stores the chosen key as a digest; subsequent
   keys are managed in the dashboard. Environment variables and the obsolete
   `--api-key-auth` flag are not runtime credential sources.
3. **OAuth and inference credentials** are independent, scoped database records.
   The OAuth flow never returns the gateway key. Operators can register the
   SHA-256 hex digest of a trimmed client-held secret in the dashboard. The
   digest text itself is rejected. Such secrets receive `user:inference` only
   and cannot bootstrap OAuth or access administrator routes.
4. **Administrator sessions** are established with a stored gateway key and an
   administrator password. The browser stores a Secure, HttpOnly session cookie
   and a separate SameSite-strict CSRF cookie, not the gateway key. First setup
   also requires a one-use code issued by `admin --setup-code`.

For non-loopback access, configure the exact external dashboard origin and
trusted proxy peers, complete setup, and keep the API behind the intended
private listener or reverse proxy.

Clients can send the key in any of these forms:

```http
Authorization: Bearer replace-with-gateway-key
```

```http
x-api-key: replace-with-gateway-key
```

```http
x-goog-api-key: replace-with-gateway-key
```

Missing, invalid, expired, and blocked data-plane credentials receive a uniform
`401` response with `Cache-Control: no-store`. Failed protected credential
checks are recorded by normalized client IP. The third failure in a rolling
24-hour window bans that IP for 24 hours; banned requests still receive `401`.
Two denials are never recorded: a credential that resolves to a known principal
but lacks the required kind or scope, and the Claude Code compatibility stubs
that clients poll unprompted (telemetry, bootstrap, settings). Both still return
`401`, and a ban earned on another surface still applies to them. Successful
authoritative inference authentication clears prior failures, creates a
process-local ban exemption, and persists an enabled allowlist entry for
`/transcribe`. A new entry uses `source: "authenticated"`; an existing
operator-created `manual` or `dashboard` entry is re-enabled and retains its
source and transparent-proxy permission. Later missing or wrong credentials
still return `401` but cannot re-ban that IP during the session. Newly automatic
entries do not authorize credential-free transparent proxy inference.

Authentication reads the selected database. Missing database credentials do
not enable anonymous inference. An unavailable database fails closed rather
than accepting a cached environment or JSON credential.

OAuth authorization accepts Claude Code's registered production client, exact
manual or localhost callback URI, requested scopes, and S256 PKCE parameters.
After the gateway key is entered in the browser, the server issues a random,
one-use, two-minute authorization code bound to the client, redirect URI, state,
scope, and PKCE challenge. Access, refresh, authorization-code, and generated
inference secrets are persisted only as SHA-256 digests in the database.
Issued access and refresh credentials do not expire;
refresh is repeatable and race-safe, while explicit revocation remains
available at `POST /v1/oauth/revoke`.

The dashboard shell can be loaded before login, but every dashboard API requires
an administrator session. Administrator passwords must be at least 4 characters
and have no other content rules; numeric-only passwords are accepted. First-time
setup requires the CLI-issued code, chosen gateway key, and password. Normal
login requires the gateway key and password. Sessions have a 30-day absolute
lifetime; mutations require a CSRF token and an approved `Origin`. Password
changes and the local `admin --reset` command revoke dashboard sessions.
`COPILOT_ADMIN_PASSWORD_HASH` is accepted only by explicit legacy import.

Keep the application bound to loopback or a private container network even with
these controls. Publish only the exact hostname/path set required by the clients
you use. Public liveness is available at `GET /health` and `GET /health/health`;
`GET /health/ready` separately reports database readiness. No session router is
mounted below `/health`. Direct Connect is disabled unless
`COPILOT_API_ENABLE_DIRECT_CONNECT=true`, and remains authenticated when enabled.

## Models, routing, and providers

### Discovery and reasoning variants

Copilot clients that send `Copilot-Integration-Id` or `Copilot-Harness-Id`
receive picker-hidden utility models as well, so background operations such as
session naming retain the upstream catalog. Generic pickers keep their existing
visibility rules. Google discovery includes a `models` projection with callable
`models/<id>` resource names alongside the existing OpenAI `data` list.

`GET /v1/models` combines:

- live models visible to healthy Copilot accounts;
- configured reasoning-effort variants such as `model:high`;
- supported naming and long-context aliases;
- enabled redirect-source aliases whose resolved targets have discoverable
  metadata; and
- custom-provider models and aliases.

Supported efforts are derived from live model metadata and local settings. The
recognized effort vocabulary is `none`, `minimal`, `low`, `medium`, `high`,
`xhigh`, and `max`; not every model supports every value. Recognized effort
values may be coerced to a supported/default effort for the model. An
unrecognized `:suffix` is treated as part of the model ID.

### Redirects, settings, and replacements

The dashboard is the recommended interface for these controls:

- **Redirects** map an exact source model/effort to a target model/effort. Rules
  are ordered and can chain only through later rules.
- **Fallbacks** switch models only after upstream HTTP 422, with up to three
  hops and loop prevention. Conversation routes and old-thinking fingerprints
  stay in memory; optional client notices are configurable. See the
  [fallback configuration guide](docs/model-fallbacks.md).
- **Model settings** override capability assumptions and discovery behavior for
  a model.
- **Replacements** transform matching message text with literal or regular-
  expression rules on Chat Completions and translated Messages/Google requests.
- **Model routing** enables or disables a model for an individual Copilot
  account.

These settings persist in the selected database and can be inspected through
the dashboard and sanitized configuration export.

### Custom OpenAI-compatible providers

Manage provider metadata, models, API keys, and custom headers through the
dashboard. Credentials are stored in database secret records and remain
write-only in dashboard listings. `apiKeyEnv` is a legacy import input, not a
runtime reference; `storage import-legacy --from-env` resolves only the selected
credential names referenced by imported providers.

Provider coverage is intentionally scoped:

| Provider model kind | Client-facing routes |
| --- | --- |
| `chat` | Chat Completions, Anthropic Messages, Responses HTTP, and Google generation/streaming |
| `embedding` | Embeddings only |

Custom providers do not handle Responses WebSocket or compaction. Embedding
responses preserve float or base64 encoding and validate the effective request
dimensions when a dimension count is configured.

A configured custom alias wins provider resolution and is the safest way to
force custom-provider routing; the first configured matching provider wins. If
a custom model's exact ID collides with a live Copilot model, the Copilot model
wins. `passReasoningEffort` opts the provider or model into forwarding the
normalized requested effort; without opt-in, `reasoning_effort` is removed.

## Multiple Copilot accounts

Auto Mode session tokens are bound to the authenticated account tracking ID
returned by Copilot user discovery. This supports direct OAuth credentials
without exchanging them for a legacy token or persisting session-token maps.
Model-session acquisition preserves caller-supplied model hints; refresh remains
token-only.

All accounts are stored in the database, including a single account.
Multi-account selection activates when at least two accounts are available.
Manage them through the dashboard or interactively:

```sh
bun src/main.ts config
```

Choose GitHub.com or the account's GitHub Enterprise Cloud instance during
admission. Legacy comma-separated `GITHUB_TOKENS` entries are supported only by
explicit import with `--from-env`; setting them on the running server does not
replace the durable account registry.

Use **Refresh models** on an account to fetch its current catalog, or
**Refresh all models** to process every account and show individual outcomes.
Refresh preserves account enablement and model-routing settings. Disabled
accounts can refresh without becoming enabled; a failed refresh retains the
last catalog and does not stop the other accounts in a bulk refresh.

Account admission and refresh validate GitHub.com and GHE Cloud OAuth
tokens through `/copilot_internal/user`, resolve the returned Copilot endpoint,
and use that same bearer for model discovery and inference. Each healthy account
contributes its models to a shared eligibility index. Dashboard model-routing
overrides can disable a model on a specific account.

Requests carrying `X-Claude-Code-Session-Id` select an eligible account
deterministically so a session stays on the same account. Without that header,
the first eligible account is used. Authentication rejections remain on the
selected account and are not retried with another identity. A `421` response
refreshes that account's advertised Copilot endpoint and model catalog, then
retries once on the same identity. Other eligible failover stays within the same
GitHub instance, so GHE tenant boundaries are never crossed. Accounts that fail
validation are marked unhealthy, while a runtime `429` does not change
account health. A known model disabled for every account returns a local `403`;
an unknown model falls back to the first healthy account. Multi-account mode is
for availability, model coverage, and session affinity, not unrestricted load
balancing.

## Operator dashboard

Open `/dashboard` on the same host as the API. The dashboard includes:

- overview and local request/token utilization;
- active Claude Code sessions and registered environments;
- outbound Copilot request/response attempts with structured/raw views;
- replay for logged Chat Completions and Responses attempts;
- GrowthBook feature flags and Codex/ChatGPT Statsig overrides;
- request replacements and ordered model redirects;
- HTTP 422 model fallback chains and conversation cache controls;
- per-model settings and per-account model routing;
- custom provider configuration;
- managed IP allowlists and managed inference-only Codex JWT digests; and
- settings inspection and ZIP export.

On first use, the dashboard prompts for a CLI-issued setup code, a new gateway
key, and an administrator password. Later logins require the key and password. The browser receives a Secure, HttpOnly,
SameSite-strict session cookie plus a separate SameSite-strict CSRF cookie; it
does not persist either login credential in `localStorage`. Set
`COPILOT_ADMIN_ORIGIN` to the exact external dashboard origin before serving
the dashboard through a reverse proxy.

If the administrator password is lost, run `admin --reset` from the trusted
host console against the same database. It prompts twice with hidden input,
replaces the password, and revokes every dashboard session. The gateway key
remains required for login. There is no public password-reset endpoint.

With the tracked Compose service, use:

```sh
docker compose stop copilot-api
docker compose run --rm --no-deps copilot-api admin --reset
docker compose up -d copilot-api
```

LLM Debug stores bounded, sanitized outbound attempts in the database. URLs,
headers, body fields, and recognized credential values are scrubbed before
capture is queued. Successful captures expire after ten minutes; failed or
interrupted captures after one hour. Capacity limits can evict entries sooner.
Replay supports complete replayable Chat Completions and Responses captures,
obtains fresh server-side credentials, and rejects redacted, omitted, expired,
or interrupted captures and removed or changed providers.

`GET /usage` returns current Copilot quota data. Dashboard utilization instead
uses committed minute/model usage buckets and lifetime counters; committed old
usage is retained. Diagnostic and routing detail has bounded retention. Pending
telemetry is bounded to 2,000 records, 16 MiB, and five minutes; pressure and
outages may omit diagnostic bodies or lose records. Collection-gap indicators
report known loss and uncertainty instead of claiming complete history.

Sanitized ZIP export excludes credential and history tables and replaces
secret-like configuration values with `[REDACTED]`. It cannot restore secrets.
For recovery or moving between SQLite and Turso, use the separate
password-encrypted logical backup and restore commands in the
[storage runbook](docs/turso-storage.md).

## Claude Code and Codex integrations

These are compatibility implementations, not hosted identity or cloud services.

### Claude Code

- The Anthropic Messages endpoint supports normal Claude Code model traffic.
- The local OAuth facade implements opaque, scoped Claude Code credentials with
  one-use authorization codes, S256 PKCE, reusable refresh, and revocation. It
  is local gateway identity, not GitHub or Anthropic identity.
- Code-session creation, bridge setup, session APIs, and user actions require an
  OAuth credential with the Claude Code session scope.
- Worker endpoints and SSE use random, expiring capabilities bound to one
  session and worker epoch. Environment poll, acknowledgement, heartbeat, and
  reconnect calls use separate expiring capabilities bound to one environment.
- `/remote` uses the administrator session plus a one-use, short-lived,
  session-bound WebSocket ticket; a session ID is not authorization.
- Direct Connect compatibility stubs are disabled by default. When explicitly
  enabled for private development, `/sessions` and `/ws/direct/:sessionId`
  require an inference-capable credential.
- Callback URLs use a valid `COPILOT_PUBLIC_BASE_URL` first, otherwise a
  complete forwarded protocol/host pair from a trusted socket peer, otherwise
  the direct request origin. A configured path prefix must be stripped by the
  reverse proxy before Bun's internal `/ws/direct/:sessionId` upgrade route.
- GrowthBook feature evaluation and the feature-flag UI support client behavior
  overrides on private networks where the client source address is preserved.

The OAuth and bridge credentials above are the primary authorization boundary.
After a gateway, inference-client, or correctly scoped OAuth credential
authorizes a data-plane request, the resolved client IP is exempt from the
process-local failure ban and is persisted as an enabled allowlist entry for
`/transcribe`. New entries use the `authenticated` source; existing
operator-created entries are re-enabled without changing their source or
transparent-proxy permission. Missing or wrong credentials still return `401`;
a newly automatic entry does not authorize credential-free transparent proxy
inference.

### Codex Desktop

- `POST /transcribe` provides dictation through Groq speech-to-text.
- `POST /v1/audio/transcriptions` provides the separately authenticated
  OpenAI-compatible transcription API.
- `POST /codex/responses` provides configurable transcript cleanup.
- `GET /ps/plugins/home`, strict public plugin-detail reads, and category reads
  derived from `/home` provide public Codex browsing without forwarding the
  local synthetic credential to ChatGPT.
- Read-only `/ps/plugins/list`, `/search`, `/installed`, `/suggested/codex`,
  and workspace directory compatibility responses keep Codex's configured
  local and Git marketplaces usable when the ChatGPT identity is synthetic.
- Statsig overrides can be managed in the dashboard and applied through the
  Statsig proxy middleware. The dedicated nginx template publishes only
  `/v1/initialize`, `/v1/download`, and `/v1/check`; every other path remains
  default-denied.

From a repository checkout on Windows, generate the local ChatGPT-shaped
compatibility identity with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\enable-codex-desktop-chatgpt-auth.ps1
```

The script backs up an existing `%USERPROFILE%\.codex\auth.json` before writing
the replacement. The new file is a local compatibility identity, not a real
OpenAI or ChatGPT login. It discovers the Windows account display name and
email/UPN when available and accepts optional `-FullName` and `-Email` values.
Interactive runs ask for values Windows could not discover. Pressing Enter
uses the discovered or entered first name for `<firstname>@copilot-api.local`,
with `copilot-api@copilot-api.local` as the final fallback; PowerShell
`-NonInteractive` runs never prompt. `-PromptForIdentity` remains available to
force prompts in redirected-input automation.
The script prints and attempts to copy a 64-character
SHA-256 digest; paste only that digest plus a device label into **Settings →
Trusted JWT Digests** on your gateway's `/dashboard#settings` page, or send
those values to an administrator.

Configure these root-level keys in `%USERPROFILE%\.codex\config.toml` before
starting Codex Desktop:

```toml
openai_base_url = "https://gateway.example.com/v1"
chatgpt_base_url = "https://codex-gateway.openai.com"
cli_auth_credentials_store = "file"
```

`codex-gateway.openai.com` is a replaceable, locally spoofed example hostname,
not the public gateway hostname. Map it to the gateway in the Windows hosts
file, issue a trusted TLS certificate for that exact name, and render the
exact-route/default-deny Codex Desktop Nginx template for it. The template's
Computer Use URL-policy route is optional and intentionally permissive; omit it
from managed-auth-only deployments as described in the canonical guide. Missing
the base-URL setting can cause rapid, repeated successful refresh requests while
inference never begins. See the canonical guide below for the complete hosts,
certificate, and Nginx steps.

The plugin compatibility surface restores browsing, searching, installing,
removing, and upgrading plugins from configured local or Git marketplaces. The
public directory, its nine-card category previews, and public card details are
browse-only in this mode. A synthetic local JWT is not a real ChatGPT session,
so account/workspace cloud catalogs, remote connector installation, and remote
plugin mutations remain unavailable. The gateway
returns empty JSON contracts for those account-scoped reads and never forwards
the synthetic bearer to `chatgpt.com`.

Current Codex builds proactively refresh ChatGPT-shaped credentials. Set the
following user environment variable before fully quitting and reopening Codex
Desktop:

```powershell
[Environment]::SetEnvironmentVariable(
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
  'https://gateway.example.com/v1/codex/auth/refresh',
  'User'
)
```

Replace `gateway.example.com` with your gateway's public hostname.

The script deliberately does not configure `config.toml`, certificates,
hosts/DNS, environment variables, networking, or any other deployment
prerequisite. The canonical setup, gateway rollout, verification, rollback, and
troubleshooting procedure is in
[docs/codex-desktop-managed-auth.md](docs/codex-desktop-managed-auth.md).

Set `GROQ_API_KEY` or the equivalent `groqApiKey` config field to enable speech
transcription. Set `groqModel` in the database-backed application settings to
change the model used for
`whisper-1` and the Codex/voice paths. The voice WebSocket endpoint is
`/api/ws/speech_to_text/voice_stream`. It authenticates the upgrade with an
OAuth `voice:transcribe` entitlement (derived for Claude Code from
`user:inference`) before allocating audio state. It also validates any supplied
Origin. The gateway does not impose voice frame, audio, duration, idle,
connection, or hourly traffic caps.

Codex Desktop dictation at `POST /transcribe` accepts a valid inference-capable
bearer or API key. Successful credential authentication also persists the
resolved client IP for older Desktop builds that omit credentials on later
dictation requests. An operator can add an IP manually in the dashboard, and
active session leases remain valid fallbacks. An invalid supplied credential
fails closed instead of falling through to IP authorization. Automatic
authenticated entries do not permit credential-free transparent proxy calls;
those still require credentials unless an operator-created allowlist entry or
session lease applies. Transcript cleanup at `/codex/responses` remains
credential-authenticated.

Advanced TLS and proxy templates live under `nginx/`, including WebSocket
upgrade headers and disabled response buffering without project-defined
request pacing, body caps, or proxy timeouts.

## CLI reference

### Commands

| Command | Purpose |
| --- | --- |
| `auth` | Authenticate with GitHub.com or GHE Cloud and save the validated account in the selected database without starting the server or printing its credential |
| `start` | Open the selected database and start the gateway without account setup |
| `admin` | Issue setup codes, replace the administrator password, or hash a legacy verifier |
| `storage` | Preview/apply legacy import and create or restore encrypted logical backups |
| `check-usage` | Print current GitHub Copilot quota information |
| `debug` | Print version, runtime, storage kind, and stored-account presence |
| `config` | Interactively manage replacements, stored accounts, and custom providers |

Run a command with `--help` to inspect the installed version's current options.

### `start` options

| Option | Alias | Default | Description |
| --- | --- | --- | --- |
| `--port <port>` | `-p` | `4141` | Listening port |
| `--host <host>` |  | Bun default | Listening hostname or IP; use `127.0.0.1` for local-only access |
| `--verbose` | `-v` | off | Enable verbose logging |
| `--account-type <type>` | `-a` | `individual` | `individual`, `business`, or `enterprise` Copilot routing |
| `--manual` |  | off | Prompt before forwarding Chat Completions, Messages, Responses HTTP, and Google requests |
| `--github-token <entry>` | `-g` | unset | Rejected; admit accounts through the dashboard or explicit import |
| `--claude-code` | `-c` | off | Generate a Claude Code launch command from the current model list |
| `--show-token` |  | off | Print the full GitHub/Copilot OAuth credential; sensitive troubleshooting only |
| `--proxy-env` |  | off | Reserved proxy initializer; currently ineffective because the supported Bun server path skips it |
| `--insecure` |  | off | Disable TLS certificate verification; unsafe outside controlled debugging |
| `--debug` | `-d` | off | Log raw incoming URLs, headers, and most top-level JSON fields; sensitive troubleshooting only |
| `--api-key-auth <key>` |  | unset | Rejected; use database-backed setup and credential management |

### Other command options

| Command | Option | Description |
| --- | --- | --- |
| `auth` | `--verbose`, `-v` | Enable verbose authentication logs |
| `auth` | `--host <host>` | Skip the account picker and authenticate with GitHub.com or a `*.ghe.com` host |
| `auth` | `--device-code` | Use the device-code flow |
| `auth` | `--web-flow` | Use browser OAuth with a loopback callback |
| `admin` | `--setup-code` | Issue a one-use 15-minute code for an unconfigured database |
| `admin` | `--reset` | Interactively replace the administrator password and revoke every dashboard session |
| `admin` | `--hash-password` | Prompt twice with hidden input and print an Argon2id verifier for explicit legacy import |
| `debug` | `--json` | Emit diagnostic information as JSON |

## Configuration and persistent data

The default database is `copilot-api.sqlite` under `DATA_DIR`, which defaults
to `~/.local/share/copilot-api` (`/app/data` in Docker). Mount the whole directory
for SQLite's database, WAL, and SHM files. Setting both `TURSO_DATABASE_URL` and
`TURSO_AUTH_TOKEN` selects remote Turso; setting just one is a configuration
error. A remote outage never falls back to local SQLite.

Accounts, upstream/provider secrets, administrator and gateway/OAuth records,
settings, IP policy, usage, and bounded diagnostic history share the selected
database. Runtime JSON files are no longer read or written. Existing JSON
files and selected environment credentials require `storage import-legacy`;
source files remain untouched. See the [storage runbook](docs/turso-storage.md)
for preview, apply, backup, restore, readiness, and storage-switch procedures.

### Environment variables

| Variable | Scope | Purpose |
| --- | --- | --- |
| `COPILOT_INTEGRATION_ID` | Direct and Docker | Copilot integration identifier; defaults to `copilot-developer-cli` for the stable Copilot CLI model catalog. Override it when the deployment has its own assigned integration ID. |
| `DATA_DIR` | Direct and Docker | Local SQLite directory; unused for persistence in Turso mode |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Direct and Docker | Optional pair selecting remote Turso; neither selects local SQLite |
| `COPILOT_ADMIN_ORIGIN` | Direct and Docker | Exact browser origin allowed for dashboard mutations; set this explicitly for a proxied deployment |
| `COPILOT_TRUSTED_PROXY_CIDRS` | Direct and Docker | Comma-separated socket-peer CIDRs allowed to supply forwarding headers; defaults to loopback only |
| `COPILOT_PUBLIC_BASE_URL` | Direct and Docker | Optional externally reachable absolute HTTP(S) base for bridge and Direct Connect callback URLs; may include a deployment path prefix |
| `COPILOT_API_ENABLE_DIRECT_CONNECT` | Direct and Docker | Set to `true` only to enable the authenticated experimental Direct Connect routes; disabled by default |
| `COPILOT_INFERENCE_CORS_ORIGINS` | Direct and Docker | Optional comma-separated exact browser origins for inference-only CORS; disabled by default |
| `COPILOT_VOICE_ORIGIN` | Direct and Docker | Optional exact browser Origin for the Claude voice WebSocket; supplied Origins must match |
| `SENTRY_DSN` | Direct and Docker | Enable Sentry tracing and error reporting |
| `SENTRY_TRACES_SAMPLE_RATE` | Direct and Docker | Sentry trace sample rate |
| `SENTRY_AI_RECORD_INPUTS` | Direct and Docker | Set to `false` to stop recording AI inputs/outputs in Sentry spans |
| `COPILOT_HOST` | Docker entrypoint | Set the container listening host |
| `COPILOT_VERBOSE` | Docker entrypoint | Add `--verbose` when set to `true` |
| `COPILOT_DEBUG` | Docker entrypoint | Add `--debug` when set to `true` |
| `OP_TOKEN`, `OP_ENV_ID` | Docker entrypoint | Optionally resolve container secrets through the bundled 1Password/Varlock integration |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Direct and Docker | Setting `0` disables outbound TLS verification process-wide; unsafe outside controlled debugging |
| `CERT_DIR` | HTTPS proxy helper | Certificate directory used by `scripts/https-proxy.mjs` |

Legacy credential environment names, including provider `apiKeyEnv` references,
are read only by explicit import with `--from-env`. Although `--proxy-env` is present in the CLI, it is currently a
no-op in the supported Bun runtime; do not rely on it for outbound proxying.

Use `--port` and update the container port mapping when changing the port.

## Docker

The image defaults to local SQLite in `/app/data`. Its entrypoint accepts
`admin`, `storage`, `config`, `auth`, `debug`, and `check-usage` directly; other
arguments start the server. No runtime GitHub or gateway environment credential
is required.

### Docker Compose

The tracked Compose file creates the named `copilot-api_copilot-data` volume
for new installations and preserves that name for existing data. `.env` is
optional. For an existing JSON deployment, follow the explicit import procedure
before starting the new server against the target database.

```sh
docker compose build
docker compose run --rm --no-deps copilot-api admin --setup-code
docker compose up -d
```

Use the code in `/dashboard` to choose the initial gateway key and password,
then add accounts and provider credentials. The host port is bound to loopback.
Configure `COPILOT_ADMIN_ORIGIN` and exact `COPILOT_TRUSTED_PROXY_CIDRS` for an
external reverse proxy. Optional `OP_TOKEN` and `OP_ENV_ID` preserve the bundled
1Password/Varlock delivery path for deployment settings and the Turso pair.

```dotenv
COPILOT_HOST=0.0.0.0
COPILOT_ADMIN_ORIGIN=https://your-domain.example
# Replace with the actual reverse-proxy socket peer ranges.
COPILOT_TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128
# Leave both unset for local SQLite.
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=
```

Image and Compose healthchecks use `/health/ready`: `200` means the selected
database is available and no incomplete transfer blocks service; `503` means
unavailable. `/health` and `/health/health` remain metadata-free liveness
routes. A healthy container does not prove an upstream account is usable.

### Optional remote mode and read-only root filesystem

With both Turso variables set, the application does not use `/app/data` for
persistence and needs no data volume. The default Compose volume may remain
mounted unused. A direct-container example is:

```sh
docker run -d --name copilot-api --read-only --restart unless-stopped \
  -p 127.0.0.1:4141:4141 --env-file ../copilot-api.env copilot-api
```

Build the image first with `docker build -t copilot-api .`; include the paired
Turso settings and `COPILOT_HOST=0.0.0.0` in that operator-owned environment
file. Use the same pair when issuing the setup code. The storage runbook covers
empty-target restore and migration. These examples describe this checkout;
validate the image and deployment configuration in your environment.

### Updating a Compose checkout

Run the checked-in updater only from a clean `master` checkout:

```sh
./update.sh
```

It performs a fast-forward-only pull, validates the resolved Compose file,
rebuilds/recreates the service, waits for the exact healthcheck to become
healthy, and only then prunes dangling images. It does not migrate or rotate
credentials. When the invoking shell omits the external admin origin or trusted
proxy CIDRs, the updater preserves those two non-secret values from the running
container. Review upstream changes before running it; do not use it to erase
local deployment edits.

`update.sh` updates only the repository checkout and Compose application. It
does not render, install, validate, or reload the host Nginx configuration. If
an update changes anything under `nginx/`, deploy the matching rendered vhost
separately, confirm the active configuration with `nginx -T`, run `nginx -t`,
and reload Nginx. A healthy rebuilt container does not prove that a new edge
route is active.

On Windows, `start.bat` starts the development server on `127.0.0.1` and opens
the same-origin operator dashboard. Run `bun src/main.ts admin --setup-code`
for first setup. The launcher does not require runtime credential environment
variables.

## Reverse proxy deployment

Keep the application bound to loopback or a private container network and put
TLS at the reverse proxy. A client base URL can then be
`https://your-domain.example/v1`, but do not expose the full route tree. Use a
strict allowlist containing only the API and compatibility paths the deployment
actually needs.

The proxy must:

- preserve the request `Host` as required by the selected deployment mode;
- overwrite `X-Real-IP`, `X-Forwarded-For`, and `X-Forwarded-Proto` rather than
  appending or preserving client-supplied values;
- have its exact socket-peer address or CIDR listed in
  `COPILOT_TRUSTED_PROXY_CIDRS`;
- support WebSocket upgrades, including authenticated `GET` upgrades on
  `/responses` and `/v1/responses` while retaining normal `POST` handling;
- disable request/response buffering for streaming;
- allow long-lived SSE and WebSocket connections;
- avoid local request pacing, connection caps, finite body caps, and
  client/proxy/send timeouts; and
- forward `x-copilot-gateway-key` to the application without logging it for
  transparent redirected provider traffic, while preserving provider
  `Authorization`, `x-api-key`, and `x-goog-api-key` headers end-to-end.

The application reads forwarding headers only when the actual Bun socket peer
falls within a configured trusted CIDR. Direct clients are identified by their
socket address and cannot gain allowlist status by supplying `X-Real-IP` or
`X-Forwarded-For`. Keep the trusted list exact: do not use a broad private range
when only one local proxy address is required.

For transparent redirected Anthropic hosts, gateway authentication is a
separate `x-copilot-gateway-key` channel. The application removes that header
before upstream forwarding. Provider credentials are not gateway credentials.
An explicit invalid dedicated key is denied and cannot fall back to managed or
leased-IP authorization; an absent key may use that existing IP policy.

An exact trusted peer is insufficient when an upstream TCP load balancer
source-NATs every client to that peer: every caller then shares the load
balancer's authorization identity. GrowthBook `/api/eval/*` remains
unpublished. The dedicated Statsig template can be deployed through that
topology only when the operator explicitly accepts that callers reaching the
listener can share or spoof access to the three published Statsig endpoints.
Use authenticated source-address transport such as PROXY protocol when that
risk is not acceptable.

Use hostname-specific, default-deny locations. Publish the inference routes,
the exact OAuth/Claude compatibility paths required by your clients, the
dashboard only on its intended administrator hostname, and exact
`GET /health/health`. Leave unused code stubs and Direct Connect unpublished;
setting `COPILOT_API_ENABLE_DIRECT_CONNECT=true` does not make it appropriate
for a public hostname.

Templates are provided in `nginx/sites-available/`. Replace every template
placeholder, configure stored gateway credentials, and validate the generated server
configuration before exposing it. See [nginx/README.md](nginx/README.md) for
the template matrix, installation checks, Cloudflare CIDR maintenance, and
WebSocket probes.

For Codex Desktop dictation, every public or spoof hostname used by the client
must publish exact `POST /transcribe`. An empty diagnostic POST should reach the
application and return JSON with `x-request-id` rather than an Nginx HTML 404;
the end-to-end acceptance check is an authenticated multipart audio upload that
returns `200` with `{ "text": "..." }`.

## Security and privacy

- **Bind explicitly.** Use `--host 127.0.0.1` for local-only use. Bun otherwise
  listens on all interfaces by default.
- **Layer remote controls.** Use stored gateway credentials for the data plane
  and OAuth bootstrap. Use scoped OAuth, administrator sessions, WebSocket
  tickets, and bridge capabilities for their respective routes.
- **Trust IP headers only from exact proxy peers.** Configure
  `COPILOT_TRUSTED_PROXY_CIDRS` with the actual socket peers. Forwarding headers
  from every other peer are ignored. Successful authoritative inference auth
  persists the safely resolved IP for `/transcribe` and exempts it from the
  process-local ban; it does not authorize credential-free inference.
- **Protect the data directory.** It can contain GitHub tokens, gateway/provider
  keys, OAuth/admin digests, custom headers, routing policy, allowlists, and
  request history. Sensitive files and the directory are created with
  restrictive permissions where the platform supports them.
- **Exports are sanitized, not backups.** Dashboard ZIP exports redact
  secret-like configuration and require an authenticated administrator session.
  Use the password-encrypted logical backup for full recovery; protect the
  backup password and operator-owned output.
- **Restrict attachment network authority.** Authenticated callers can cause
  attachment/file recovery to fetch any runtime-valid HTTP(S) destination and
  redirect, including internal and metadata-style targets. Only abort, timeout,
  byte, redirect, parsing, and media limits remain; restrict inference
  credentials and runtime network reachability accordingly.
- **Treat final upstream failure bodies as raw.** A non-empty final upstream
  failure body can contain payload or credential material and is copied exactly
  to the client, ordinary logs, and Sentry with its status and content type.
  Protect their transport, retention, and access, and rotate credentials exposed
  through those channels.
- **Protect diagnostic history.** LLM Debug stores bounded, sanitized captures
  in the database. Prompts and non-secret response content can still be
  sensitive. Access requires an administrator session; capture retention and
  replay eligibility are limited.
- **Use Sentry deliberately.** When `SENTRY_DSN` is set, AI prompt and completion
  content is recorded by default. Set `SENTRY_AI_RECORD_INPUTS=false` before
  handling sensitive data.
- **Avoid sensitive logging.** `--show-token` prints complete tokens. Debug
  request logging redacts authorization, cookie, API-key, token, and secret
  headers plus secret-like structured body fields, but it still prints the full
  request URL and can expose other prompt or operational content. Do not place
  credentials in query parameters, and keep debug logs private.
- **Keep TLS verification enabled.** Use `--insecure` only for controlled,
  temporary diagnosis of a trusted interception proxy.
- **Protect database credentials.** Upstream/provider secrets are recoverable
  database values; restrict access to the database and its backups.
- **Rotate exposed credentials and endpoints.** Removing a value from current
  documentation does not remove it from Git history, forks, caches, or logs.

## Troubleshooting

### Requests return `401`

Check whether the route expects the gateway key, a scoped OAuth/inference
credential, an administrator session, or a worker/environment capability.
OAuth refresh is reusable and race-safe; it issues an access token while
retaining the same refresh credential. Check explicit revocation and required
scopes when a stored credential is denied.

### Responses WebSocket gets an nginx `403`

A WebSocket handshake is an authenticated `GET`, not a `POST`. Do not place
`/responses` or `/v1/responses` behind a POST-only `limit_except` block. Render
the current `nginx/sites-available/public-domain.conf.template`, which allows
normal Responses POSTs and allows GET only when `Upgrade: websocket` is
present. Expected probes are application `401` without a credential and `101`
with a valid inference-capable credential.

### Claude Code reports `Connection closed mid-response`

Check the Nginx error log for `upstream timed out` on `POST /v1/messages`.
The templates use Nginx's maximum accepted client/read/send durations to avoid
its 60-second defaults. If that message appears, verify that the rendered
configuration inherited those maximum-duration directives and reload Nginx.

### The dashboard asks for the administrator password again

Current builds require the gateway key and administrator password only when
creating or signing into the dashboard session. LLM Debug, sanitized
configuration export, provider management, and IP policy then use that session
without a second password prompt. Hard-refresh the dashboard if an older
bundled script is still cached. A current bundle contains no
`/dashboard/auth/reauth` request.

### A model is missing or rejected

Run `GET /v1/models` with the same gateway credential as the client. In
multi-account mode, confirm at least one healthy account advertises the model
and that dashboard routing has not disabled it for every account.

### A custom model routes to Copilot

Use a unique alias. An exact live Copilot ID wins a collision with a custom
provider's exact ID, while a custom alias takes priority.

### A custom provider works for chat but not Responses or Google

This is expected. Custom chat providers cover Chat Completions and Messages;
custom embedding providers cover Embeddings. Other API families are not
automatically routed to custom providers.

### A protected Docker container is unhealthy

Check `/health/ready` and the selected database connection. A partial Turso
pair, unavailable database, or incomplete import/restore prevents readiness.

### Authentication or path diagnostics

```sh
bunx --bun @ashsec/copilot-api@latest debug
bunx --bun @ashsec/copilot-api@latest debug --json
bunx --bun @ashsec/copilot-api@latest check-usage
```

Use verbose/debug/token-output options only in a private terminal and remove
sensitive logs afterward.

## Development

```sh
bun install
bun run dev start --host 127.0.0.1
```

Useful checks:

```sh
bun run lint:all
bun run typecheck
bun test tests/*.test.ts
bun run build
```

PowerShell does not expand that test glob for Bun. Use:

```powershell
$tests = Get-ChildItem tests -File -Filter *.test.ts
bun test $tests.FullName
```

Run a single test file:

```sh
bun test tests/anthropic-request.test.ts
```

Run the production entry point from source:

```sh
bun run start start --host 127.0.0.1
```

Integration tests under `tests/integration/` make live authenticated requests
and should be run only with a suitable test account and environment.

## Attribution and license

This codebase builds on the original
[ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) project by Erick
Christian Purwanto and has since grown additional compatibility, routing, and
operator-control features.

Released under the [MIT License](LICENSE).
