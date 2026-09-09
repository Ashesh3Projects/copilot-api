# Copilot API Compatibility Contract

This report describes the gateway's reviewed public compatibility behavior. It
is a contract for clients and operators, not a promise that every upstream
feature is enabled for every account. Model availability and capabilities are
dynamic; clients must use model discovery instead of a static model list.

## Contract version and source precedence

The gateway sends Copilot API version `2026-08-01` and its configured
integration identity on upstream model, inference, token-count, policy, Auto,
and model-session requests. Client-supplied headers cannot downgrade that
upstream contract.

When sources disagree, compatibility decisions use this precedence:

1. behavior enforced by the current upstream service;
2. explicit integrator guidance;
3. live account-specific model metadata;
4. current first-party client behavior; and
5. generated schemas, when consistent with the preceding sources.

Live `supported_endpoints` metadata is authoritative for inference routing. A
model record that omits `supported_endpoints` receives the legacy
`/chat/completions` assumption only. A request is never sent to an endpoint that
the selected live record excludes.

## Public route and alias table

All data-plane and control-plane routes below use the gateway's normal inference
authentication when it is configured, unless a separate route-specific
authentication model is documented in the main README.

| Family | Method and canonical route | Aliases and notes |
| --- | --- | --- |
| Model discovery | `GET /v1/models` | `GET /models`; `GET /v1beta/models` |
| Single-model discovery | `GET /v1/models/:model` | `GET /models/:model` |
| Model policy | `POST /v1/models/:model/policy` | `POST /models/:model/policy`; account-aware passthrough, not a local policy emulator |
| Chat Completions | `POST /v1/chat/completions` | `POST /chat/completions` |
| Responses HTTP | `POST /v1/responses` | `POST /responses` |
| Responses compaction | `POST /v1/responses/compact` | `POST /responses/compact`; local compatibility compaction |
| Responses WebSocket | WebSocket upgrade on `/v1/responses` | WebSocket upgrade on `/responses` |
| Anthropic Messages | `POST /v1/messages` | No prefix-free alias |
| Anthropic token count | `POST /v1/messages/count_tokens` | No prefix-free alias |
| Embeddings | `POST /v1/embeddings` | `POST /embeddings` |
| Audio transcriptions | `POST /v1/audio/transcriptions` | No prefix-free alias; Groq-backed Whisper compatibility |
| Search compatibility | `POST /v1/alpha/search` | `POST /alpha/search` |
| Google-style generation | `POST /v1beta/models/:model:generateContent` | `POST /v1/models/:model:generateContent`; `POST /models/:model:generateContent` |
| Google-style streaming | `POST /v1beta/models/:model:streamGenerateContent` | `POST /v1/models/:model:streamGenerateContent`; `POST /models/:model:streamGenerateContent` |
| Google-style token count | `POST /v1beta/models/:model:countTokens` | `POST /v1/models/:model:countTokens`; `POST /models/:model:countTokens`; local/native count only, no generation |
| Liveness | `GET` or `HEAD /health` | `GET` or `HEAD /health/health`; unauthenticated and data-free, other methods/children return `404` |
| Model session | `POST /models/session` | Opaque model-session passthrough |
| Model-session intent | `POST /models/session/intent` | Requires a valid `Copilot-Session-Token` header |
| Auto selection | `POST /auto` | Account and feature availability remain upstream-authoritative |

Other client-integration surfaces are documented in the README. They do not
change the inference contracts described here.

## Audio transcription compatibility

`POST /v1/audio/transcriptions` accepts the OpenAI multipart request shape and
uses the gateway's normal inference authentication. The required `file` and
`model` fields are validated locally. Other multipart fields, including
`language`, `prompt`, `temperature`, and timestamp controls, are forwarded to
Groq without local rewriting. JSON, text, and verbose JSON responses pass
through; SRT and VTT are rendered from Groq verbose segment timestamps.

The OpenAI Whisper compatibility name maps to the configured `groqModel`, whose
default and currently accepted native model IDs are documented in the README.
Models whose contracts Groq cannot serve, including OpenAI GPT transcription
and diarization models, receive a local OpenAI-shaped `400` instead of silent
substitution. Groq response bodies, status codes, content types, and text or
subtitle formats are preserved. Requests and upstream outcomes appear in
routing telemetry under the Groq provider without recording audio contents.

`generateContent`, `streamGenerateContent`, and `countTokens` are supported
public Google actions on each listed route prefix. Count requests return
`totalTokens` through native counting when available or the local estimator and
never dispatch generation. A missing action suffix or any other suffix returns
a local Google `400` before body parsing or upstream dispatch. Ordinary request,
authentication, console, and Sentry diagnostics use the Google route template
instead of the model/action segment, and debug logging does not inspect bodies
for unsupported actions.

## Model discovery and endpoint routing

Discovery preserves current upstream metadata, then adds configured aliases,
reasoning-effort variants, redirect sources, virtual entries, and custom
provider entries. Visibility is still constrained by live account catalogs,
model policy, account health, and per-account routing configuration.
An omitted model-picker flag is visible; only explicit `false` hides a model by
default. Copilot catalog requests carrying `Copilot-Integration-Id` or
`Copilot-Harness-Id` also include picker-hidden utility rows. Google discovery
adds callable `models/<id>` entries under `models` while preserving `data`.
Reserved characters in the ID are percent-encoded in the resource name so
namespaced custom models round-trip through SDK detail and generation calls.

Advertised custom chat models and aliases are reachable through Chat,
Responses HTTP, and Google generate/stream adapters. Responses WebSocket and
compaction remain outside custom-provider chat dispatch, while custom Google
counting remains local and generation-free.

Routing resolves the requested alias, effort, and redirect before selecting the
final upstream protocol. Selection then follows these rules:

1. prefer the caller's native dialect when the selected model advertises it,
   except when an advertised alternative preserves otherwise lost attachments
   or exact signed native reasoning;
2. prepare a detached candidate for each advertised dialect, repairing,
   textualizing, or omitting target-incompatible optional concepts;
3. rank candidates using native preference, bounded translation cost, request
   content, and advisory findings, then dispatch the exact evaluated payload;
   and
4. return a local protocol-native `400` with
   `endpoint_translation_unsupported` only when no endpoint is advertised or
   adaptation leaves no meaningful request.

Translation findings are bounded telemetry, not source-schema rejection gates.
Required tool-call/result association, schema repairs, generated IDs, media,
reasoning, and terminal state are request-local, deterministic, and do not
mutate the caller or sibling candidates.

Native Responses attachments are normalized once before HTTP or WebSocket
dispatch, using the same resource cache as evaluated alternatives. Synthetic
WebSocket warmups do not fetch attachment URLs. Chat/Messages translation
preserves supported tool-result images and PDFs; custom providers do not inherit
Copilot-only PDF degradation. Interleaved or redacted Anthropic content uses an
opaque native-content envelope in `reasoning_opaque` for exact ordered replay.
This includes signature-only thinking. When Messages is unavailable, other
dialects retain readable projections and omit the gateway-specific envelope
instead of forwarding it as an upstream encrypted identifier.

Compaction selects an advertised endpoint, including Messages-only models,
aggregates final summary text, and returns a failure for empty, failed, or
truncated generations instead of issuing a replacement compaction item.

Google-style generation uses the same endpoint authority after lossless Google
to Chat normalization:

<!-- compatibility-contract:google-routing:start -->
| Google request condition | Selected result |
| --- | --- |
| Ordinary text with Chat advertised | /chat/completions |
| Non-Anthropic, Chat unavailable; Responses and Messages advertised | /responses |
| Anthropic, Chat unavailable; Responses and Messages advertised | /v1/messages |
| Messages-only and lossless | /v1/messages |
| Chat-only | /chat/completions |
| Legacy omitted endpoint metadata | /chat/completions |
| No compatible advertised endpoint | endpoint_translation_unsupported |
<!-- compatibility-contract:google-routing:end -->

The `ws:/responses` value in a gateway model listing describes the gateway's
local compatibility transport and does not promise direct upstream WebSocket use.

## Responses accepted, normalized, rejected, and local fields

Native Responses preparation preserves the caller's detached JSON surface,
including future top-level fields, input items, tools, state/context fields, and
extensions. It overrides `store` to `false` and applies only target-required
normalization and hostile-serialization guards. The prepared source remains
separate from the final wire object.

Normalized behavior includes:

- immutable request snapshots at the public boundary;
- `reasoning.effort: "none"` removing reasoning summaries and encrypted
  reasoning inclusion, while enabled reasoning receives compatible defaults;
- duplicate encrypted-reasoning include entries collapsing to one;
- function schemas receiving nonmutating recursive compatibility repairs;
- compatible JSON-object and JSON-schema normalization without a permanent
  known-tool blocklist;
- output limits below the upstream floor being raised to the supported floor;
- `context_management: null` and unsupported sampling fields being omitted when
  required by model configuration; and
- `store: false` remaining stateless while compatible future state/context
  controls remain available to native Responses transport.

Invalid JSON, a missing model, hostile values that cannot be detached or
serialized, and a post-adaptation request with no meaningful input remain local
errors. Unknown optional items, tools, reasoning records, references, malformed
call history, media, and structured controls otherwise degrade best effort on
Chat or Messages fallbacks. Advertised candidates are fully adapted before
selection; unadvertised candidates do not perform attachment I/O.

Local Responses fields and behavior include compatibility compaction, payload
size recovery, media normalization, WebP conversion where required, and the
connection-scoped WebSocket continuation described below. These local features
do not imply upstream stored-response support.

## Messages body, header, and count-tokens behavior

Messages inference requires a non-empty `model` and at least one usable message
after tolerant sanitization. A literal `max_tokens: null` is treated as absent;
when the selected target needs a limit the gateway derives one. Token counting
requires `model` and usable messages but not `max_tokens`. The native body uses
a clone-and-denylist boundary: compatible plain JSON fields and nested content
are preserved, including system blocks, text, image, document, thinking,
tool-use, tool-result, cache-control, fallback-credit, effort, compaction, and
future provider fields. Gateway-only helper fields are removed.

Messages normalization includes:

- retaining usable content, tool history, future roles/blocks, metadata, output
  configuration, and media without mutating the caller's body;
- reducing every ephemeral `cache_control` object to `type` plus a valid `5m`
  or `1h` TTL;
- filtering, trimming, and deduplicating `Anthropic-Beta` per token;
- forwarding a valid inbound `anthropic-version`, or using `2023-06-01` when
  absent;
- forwarding a valid `X-Model-Provider-Preference`; and
- preserving valid sampling and effort controls for upstream model/provider
  handling.

Malformed JSON, missing required routing fields, a message list with no retained
usable entry, or hostile object shapes receive an Anthropic-shaped local error.
Messages, Chat, and Responses candidates are prepared independently; selection
uses the evaluated candidate and does not force Chat parallel tools, Responses
sampling defaults, or target controls not supplied by the request.

For Copilot models, `/v1/messages/count_tokens` calls the upstream native token
counter with the normalized model, messages, system prompt, tools, tool choice,
media context, version, beta, provider preference, affinity, and cancellation
context. An extension-rich request that cannot use native counting falls back
to the local estimator rather than generation; it never returns a constant
count. Configured custom chat providers use the same completed Chat candidate
for local estimation.

## Chat compatibility behavior

Chat prepares one detached source snapshot and separate native Chat, Responses,
and Messages candidates. It tolerates future roles, scalar/null/singleton
content, incomplete or interleaved tool history, legacy functions, arbitrary
tool choice, future parts/tools, reasoning, structured output, sampling, stop
controls, and attachments. Target adapters associate calls/results once,
generate collision-safe request-local IDs when needed, repair schemas
recursively, and preserve native JSON where possible.

Only malformed JSON, a missing model, no usable messages, hostile values, or a
post-adaptation candidate with no meaningful request are hard local failures.
Native preference and translated cost determine selection; the exact evaluated
candidate is dispatched, with resource transforms such as attachment inlining
performed only for the chosen advertised path.

## Streaming and WebSocket termination and continuation semantics

Chat streams end with `[DONE]`. Responses streams preserve named events and
Responses streams do not add `[DONE]`. Messages streams preserve Anthropic
event names and ordering. Messages streams remove the trailing bare `[DONE]`
that the upstream compatibility layer may append after `message_stop`.

Every committed dialect has one terminal owner. Successful completed and
incomplete terminals remain successful; received failed/error terminals remain
visible without a conflicting second terminal. Partial output is retained.

<!-- compatibility-contract:stream-behavior:start -->
| Surface | Behavior |
| --- | --- |
| Messages handled HTTP failure | exactly one dialect-correct error outcome after closing open blocks; preserve partial output and the owned upstream failure representation when present (invalid_request_error, authentication_error, permission_error, not_found_error, request_too_large, rate_limit_error, api_error) |
| Synthetic Responses-from-Messages failure | error then response.failed |
| Native Responses terminal families | preserve response.completed, response.incomplete, response.failed, and error terminal objects in their established protocol representation; exactly one terminal |
| Committed Chat stream failure | preserve emitted partial chunks, then emit one Chat error event and one [DONE]; no writes after abort |
| Source end and abort | clean EOF without a terminal synthesizes one dialect-local failure; abort or detach emits nothing further |
<!-- compatibility-contract:stream-behavior:end -->

Committed non-abort failures emit one dialect-correct failure outcome; Chat also
emits exactly one `[DONE]`. Messages closes open thinking/text/tool blocks before
its error. Responses local/source-end failures emit `error` then
`response.failed`; upstream terminal objects are preserved as the established
protocol representation permits. Clean source end without a terminal fails
once, while abort or detach performs no later write or report. A received HTTP
failure body follows the exact passthrough policy below rather than an
independent stream reserialization rule.

A logical routed call shares a maximum of three upstream sends. One closed
classifier may claim one same-account, same-session compatibility retry before
output for encrypted compaction, tool choice without tools, unsupported
temperature/top-p, or invalid thinking signatures. Unknown validation failures,
WebSocket sends, and continuations after output are never compatibility-retried;
the final attempt alone owns any failure body.

The Responses WebSocket accepts JSON text frames with
`type: "response.create"`. Binary frames, invalid JSON, unsupported message
types, and invalid initiators receive recoverable error frames while the socket
remains open. `stream: false` is coerced to the streaming transport. A visible
`response.incomplete` is a valid terminal, and `response.processed` is not
treated as a create request.

Successful Responses WebSocket turns can create snapshots for continuation.
Only response IDs issued on the current WebSocket connection are valid. A stale
or external ID returns `previous_response_not_found` without echoing that ID.
The client may then replay full history. Omitting `previous_response_id` starts
a new local thread; a successful continuation merges the stored completed turn
with new input and removes the continuation field before the stateless upstream
call. Snapshots are cleared when the connection closes and are never persisted.

Per-turn WebSocket envelopes accept typed attribution and initiator metadata.
Only allowlisted attribution headers are used; authentication, cookies, session
secrets, and arbitrary envelope headers are ignored. Safe response-assignment
and quota metadata may be attached only to eligible events before processing
moves past the terminal frame, without changing event order or body content.

## Multi-account and session-token constraints

Hash-only account affinity keeps an identified conversation on a deterministic
eligible account and derives stable upstream identity without storing a
conversation-to-account map. Endpoint fallback does not authorize moving
encrypted or signed history to another account. Eligibility always comes from
the account's raw current model catalog plus operator routing policy.

In multi-account mode, affinity is necessary but not sufficient for session
continuity. Separate control-plane and inference calls first use the normal
deterministic affinity selector. A session token is then forwarded only when
its bounded issuer subject matches the selected account's bounded current
issuer identity from authenticated user discovery (`analytics_tracking_id`),
with legacy bearer `tid` assignments retained as a fallback. Health,
eligibility, account membership, token format, or
configuration-order changes can therefore lose exact session continuity, but
they cannot cause cross-account replay: inference omits the token and continues
ordinarily, while token-required control-plane calls reject locally. Calls
without affinity retain conservative first-eligible selection and make the
same issuer-proof check. No session-token-to-account map is stored.

`POST /models/session` creates or refreshes a model-scoped session and may
receive an existing `Copilot-Session-Token`.
Acquisition preserves caller-supplied model hints and additive options; a
missing body retains the Auto default. Refresh remains token-only.

`POST /models/session/intent` requires that header. `POST /auto` accepts its
typed selection body but remains
subject to upstream account and feature availability. Model policy and session
operations are routed account-aware; they are not broadcast to every account.
Complete parseable Auto and intent records are forwarded without projecting
away future fields. Initial account selection may use bounded session-token
issuer proof, then endpoint evaluation, dispatch, and any retry share the same
request-local numeric pin without a persistent session/account map.

The session token is an opaque secret, not gateway authentication, and the
gateway never persists it. Ordinary logs, telemetry, Sentry, and configuration
exports never expose `Copilot-Session-Token`. Administrator-only LLM Debug
also redacts session tokens before bounded captures enter its database queue. Inference requires both bounded model matching and, in multi-account
mode, bounded issuer proof for the selected account. A mismatch, unknown proof,
malformed token, or model redirect prevents forwarding. Refresh and intent
calls with a token require the same issuer proof and otherwise return a fixed
secret-free local continuity error without an upstream send. Single-token mode
retains the existing model-scoped forwarding rules because no cross-account
replay is possible.

<!-- compatibility-contract:session-token-privacy:start -->
| Surface | Behavior |
| --- | --- |
| Administrator-only LLM Debug | session token value is retained in raw capture |
| Ordinary handler logs | session token value is redacted |
| Configuration export | token-keyed values are redacted |
| Inference forwarding | multi-account mode also requires issuer proof for the selected account |
| Token-required control plane | issuer mismatch or unknown proof is rejected locally without upstream send |
<!-- compatibility-contract:session-token-privacy:end -->

## Intentional gateway extensions

The gateway intentionally provides behavior beyond a transparent upstream
proxy:

- local HTTP-backed Responses WebSocket transport and current-connection
  snapshots;
- Responses compatibility compaction and oversized binary-payload recovery;
- media normalization, including WebP conversion where the selected upstream
  path requires it;
- MCP-backed web search loops on compatible fallback paths;
- model aliases, effort variants, redirects, and operator routing controls;
- OpenAI-compatible custom chat and embedding providers;
- cross-dialect OpenAI, Anthropic, and Google-style compatibility routes; and
- client-integration surfaces for Claude Code and Codex workflows.

These extensions preserve public protocol framing, but their local state does
not become upstream state. Custom providers also remain limited to their
configured protocol families.

Platform compatibility also includes explicit-origin CORS only for approved
inference methods and paths, including the normal Anthropic/OpenAI/Google
browser SDK headers. The public Nginx template forwards OPTIONS to that origin
policy and publishes Google generation, model details/policy, and Auto/session
routes through narrow locations. Provider replay stays on the recorded
configured destination with fresh credentials; deleted or changed destinations
return a local error instead of falling back to Copilot.

Other platform compatibility includes optional `COPILOT_PUBLIC_BASE_URL` callback origin
selection with trusted-peer forwarding fallback, and transparent provider
proxy authentication through the dedicated `x-copilot-gateway-key`. Provider
authorization and API-key headers remain upstream credentials and the dedicated
gateway header is removed before forwarding. Peripheral routes with required
JSON readers return fixed parse-only `400` responses before side effects;
bodyless worker registration and permissive session PATCH behavior remain.

When inlining is required, Chat image URLs, Responses `image_url` and
`file_url`, Anthropic URL image/document inputs, and Google `fileData.fileUri`
all use the same unrestricted HTTP(S) recovery authority. Loopback, private,
link-local, intranet, literal-IP, metadata-style, userinfo, and redirected
destinations are not filtered. Parseability, caller abort, timeout, byte and
redirect caps, media conversion, URI-free diagnostics, and per-attachment
degradation remain enforced.

<!-- compatibility-contract:attachment-url:start -->
| Surface | Behavior |
| --- | --- |
| Runtime-valid absolute HTTP(S) attachment/file URL | fetchable without destination, DNS, IP, userinfo, or redirect-target filtering; caller abort, timeout, byte, and redirect limits remain |
<!-- compatibility-contract:attachment-url:end -->

## Upstream error passthrough, request/header privacy, and LLM Debug

A received final non-empty upstream HTTP failure body is returned unchanged to
the client with its upstream status and content type. Equality includes JSON,
non-JSON, leading/trailing whitespace and CRLF, and binary bytes as the target
dialect permits. The same owned body representation is intentionally attached
to ordinary error logs and Sentry.

<!-- compatibility-contract:error-envelope:start -->
| Surface | Behavior |
| --- | --- |
| Final non-empty upstream HTTP failure | exact response body in normal client, ordinary logs, and Sentry; preserve upstream status and content type |
| Local, empty-body, unreadable-body, or transport-only failure | use the existing dialect/protocol-shaped proxy-authored fallback |
<!-- compatibility-contract:error-envelope:end -->

Local, empty-body, unreadable-body, transport-only, source-end, and abort cases
continue to use their existing protocol-shaped proxy fallbacks and do not
fabricate upstream bytes. The approved raw material is only the received final
upstream response body. Request bodies, prompts, credentials, session tokens,
request and response headers, beta values, attachment URLs, encrypted reasoning,
and configuration exports keep their established ordinary client/log/Sentry
controls. Header allowlisting and recursive scrubbing remain independent of
body forwarding.

Administrator-only LLM Debug stores raw request and response attempts only in
process memory, including credentials and secret-bearing fields. Captures never enter the database or application backups. Captured
body text and headers are not filtered. Successful captures expire after ten minutes; failed
or interrupted captures after one hour, with earlier capacity eviction possible.
Replay requires a complete eligible capture and obtains fresh credentials.
Raw captures can contain sensitive values. Final upstream
HTTP failure bodies retain their separate passthrough contract above.

## Verification matrix and last-audited date

Last audited: 2026-08-22

| Contract area | Automated evidence | Targeted verification |
| --- | --- | --- |
| Version, integration identity, and safe headers | Contract, client, model, and response-metadata tests | Confirm current discovery metadata parses without truncation |
| Model discovery and endpoint precedence | Model-route and endpoint-routing matrices | Compare route choices with live `supported_endpoints` |
| Responses fields, tools, media, and streaming | Request-contract, evaluated-candidate, payload-recovery, media, and stream-lifecycle tests | Exercise native and translated endpoint choices where advertised |
| Messages fields, headers, counting, and streaming | Messages-contract, header, handler, count-token, error, and lifecycle tests | Exercise native Messages and native token counting where advertised |
| Chat fields and bridges | Chat-contract, tolerant candidate routing, translation-fidelity, and fallback tests | Exercise native and best-effort fallback paths available to the account |
| WebSocket validation and continuation | Protocol, lifecycle, routing, security, and continuation tests | Complete a two-turn current-connection continuation |
| Account affinity and session token | Routing-affinity, account-router, control-plane, and token-scope tests | Confirm one affinity identity remains account-consistent |
| Attachment recovery authority | Destination, redirect, abort, timeout, byte/redirect-limit, logging, and per-adapter tests | Confirm inference clients have only the intended resource-bounded network authority |
| Errors, privacy, and observability | Exact-body client/log/Sentry, independent header redaction, local fallback, and administrator-debug tests | Confirm response-body equality without weakening request/header controls |
| Regression extensions | Search, compaction, retry, custom-provider reachability, control-plane, CORS, health, public-origin, transparent-proxy, Google/count, and client-compatibility tests | Probe only extensions enabled in the deployment |

Contract changes require focused red-green coverage, the full repository test
suite, lint, type checking, build, diff validation, and a tracked-diff scan for
committed credentials, private paths, and unapproved request/header leakage.
Live probes are capability-gated and must not be used to bypass upstream
authorization.

## Residual feature-flag, account, and provider limitations

Compatibility cannot enable a feature that the authenticated account,
integration identity, model, provider, organization policy, or upstream flag
does not expose. A safe upstream `400` or `404` for an unavailable policy,
model-session, intent, or Auto operation is a compatibility result, not a
reason to invent local success.

In particular, provider pinning, one-hour cache controls, modern computer or
image tools, Auto behavior, and multi-agent authorization remain conditional
on live metadata and upstream flags. Syntactic pass-through means only that the
gateway preserves a reviewed field; it is not a capability guarantee.

Models, endpoint combinations, limits, billing fields, quota fields, and
recommendation metadata can vary by account and over time. Clients must refresh
discovery and handle protocol-native availability errors. The local WebSocket
snapshot scope, no-storage affinity design, and model-scoped session-token rules
remain intentional limits rather than incomplete persistent-state support.
