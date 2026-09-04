# AI Handoff — read this first

> **If you are an AI coding assistant working in this repo, start here.**
>
> This file is **committed**, so it travels with a `git clone`. The richer local notes
> (`PROJECT-MEMORY.md`, `MVP-TEST-LOG.md`) are gitignored and live only on the machine where
> the earlier work happened, so don't expect them to exist here.
>
> Last updated: **2026-09-03**. Branch: **`wip/test-updates`**.

---

## The one rule that matters most

**This app was written before June 2026**, when a large batch of Dynatrace Gen3 changes went
live. **Treat any instruction, comment, or doc in this repo that predates that as suspect and
re-verify it.** Several were actively wrong, including comments in `otel.cjs` and the entire
credential model in the older guides. The OAuth permission picker in a current tenant now
carries a section literally labelled `[DEPRECATED] Environment Api`.

**`README-START_HERE.md` is the authoritative setup guide.** Where it disagrees with
`README.md`, `TECHNICAL-GUIDE.md`, or anything under `deployment-guide/`, it wins. Those three
still describe the retired four-credential flow.

---

## What this project is, in three sentences

A sales/enablement tool. You describe a customer's business journey in plain language (or
generate it with AI) and it spins up a live instrumented simulation in Dynatrace: real Node
microservices per journey step, continuous traffic, business events with revenue metadata,
dashboards, and AI-driven chaos plus self-healing. The **engine** runs on a Linux host; the
**app** runs inside Dynatrace and reaches the engine through an outbound **EdgeConnect** tunnel.

---

## Where things stand

### Verified working
- All three TypeScript projects typecheck clean: `api/`, `ui/`, and the root agents project
  (`npx tsc --noEmit -p <each>`). All shell scripts pass `bash -n`.
- **Gen3 platform token ingest.** A `dt0s16` platform token with the `openpipeline:*:ingest`
  scopes, sent as `Authorization: Bearer`, is accepted on the **existing** endpoints. Verified
  against a live Gen3 sprint tenant.

### Never run
**Nothing has been deployed to a tenant or executed on a host yet.** All prior work was done on
a laptop that was deliberately edit-only. `setup.sh` has never run to completion.

### If you are running on the VM
The edit-only constraint **does not apply to you**. You can and should actually run things:
`./setup.sh`, `npm`, `docker`, `curl` against the tenant. That's the point of being there.
**Record what you find** (see "How to log findings" below).

---

## The two credentials

| # | Credential | Created in | Covers |
|---|---|---|---|
| 1 | **Platform token** (`dt0s16.*`) | Account Management → IAM → Platform tokens | Telemetry ingest, dashboards, settings, OpenPipeline config, credential vault, DQL |
| 2 | **OAuth client** (`dt0s02.*`) | Account Management → IAM → OAuth clients | App install (`app-engine:apps:install` + `:apps:run`) |

Plus a third that Dynatrace generates for you: creating an **EdgeConnect** configuration
auto-generates its own OAuth client, which is what the tunnel container uses. You can't reuse
credential 2 for it, because `app-engine:edge-connects:connect` is only offered to OAuth
clients and the EdgeConnect form doesn't let you select an existing one.

Full scope lists are in `README-START_HERE.md` Phase 1.

---

## Hard-won facts, don't rediscover these

### The auth rule
**Only `dt0c01.*` (classic access tokens) use `Api-Token`. Everything else uses `Bearer`.**

Single source of truth: **`utils/dt-auth.cjs`**. CommonJS on purpose, because `otel.cjs` is
loaded via `node --require` before the ESM graph exists.

**Do not reintroduce a length-based or `dt0`-prefix check.** The rule had been duplicated in
four places, each with a different and now-wrong test
(`token.length > 100 && !token.startsWith('dt0')`), all of which routed platform tokens to
`Api-Token` and would have produced 401s across the board.

### Two hosts, and it's not interchangeable
- **Ingest** goes to the host **without** `.apps.` — these paths **404** on the `.apps.` host
- **DQL and the app** live on the host **with** `.apps.`

`deriveOtlpBaseUrl()` in `otel.cjs` handles the derivation. Verified endpoint results:

| Endpoint | Result |
|---|---|
| `<ingest>/api/v2/otlp/v1/traces` | 200 |
| `<ingest>/api/v2/bizevents/ingest` | 202 |
| `<ingest>/api/v2/metrics/ingest` | 202 |
| `<ingest>/platform/ingest/v1/events` | 202 |
| `<apps>/platform/ingest/v1/events` | 404 |
| `<apps>/platform/storage/query/v1/query:execute` | 202 |

### Two consoles
**Account Management** (`myaccount.dynatrace.com`) holds platform tokens and OAuth clients.
Your **environment** holds EdgeConnect and the app. Dynatrace docs say "go to Access Tokens"
without saying which, and that ambiguity caused one full round of wrong instructions.

### There is no EdgeConnect app
Searching "EdgeConnect" lands on a settings page. The real path is
**Settings → General → External requests → EdgeConnect tab → + New EdgeConnect**.
Host patterns are **required** (use the VM's private IP) and live in the Dynatrace-side
config, not the YAML.

### The EdgeConnect name is a booby trap
`setup.sh:494` writes `name: bizobs-demonstrator` into `edgeconnect/edgeConnect.yaml` as a
**hardcoded literal**. The Dynatrace-side configuration must be named exactly that. Nothing
validates it. A mismatch gives you a tunnel that starts and looks healthy but never
associates, surfacing much later as a vague failed connection test in the app.

### npm install needs a flag
Plain `npm install` **fails** with `ERESOLVE`: the root pins `react-is@^19` while
`@dynatrace/strato-components` peer-depends on `^18`. Always
`npm install --legacy-peer-deps`. `setup.sh` already does.

---

## Use setup.sh, not the other scripts

| Script | Use it? |
|---|---|
| **`start.sh`** | **Yes.** One-command bootstrap: installs git/curl, clones, hands off to `setup.sh` with prompts intact |
| **`setup.sh`** | **Yes.** The portable path: `$SCRIPT_DIR` throughout, multi-distro, templates its own systemd unit, no instance-metadata calls |
| `bootstrap-ec2.sh` | No. Hardcodes `/home/ec2-user` |
| `deploy.sh` | Works, but curls AWS instance metadata and its disk error tells you to resize an EBS volume |
| `deployment-guide/*` | No. Entirely pre-June-2026 |

Also stale and unused: `scripts/bizobs.service` (static unit, wrong repo name, superseded by
`scripts/install-systemd-service.sh` which templates its own).

---

## Ollama is optional

`OLLAMA_MODE` defaults to `auto` and degrades gracefully. Without Ollama, the four AI agents
(Nemesis, Fix-It, Librarian, Dashboard) fall back to rule-based logic and dashboard generation
falls back to templates. **Nothing breaks.**

AI journey generation is separate and uses a cloud provider you configure in the app under
**Settings → AI Provider** (OpenAI, Anthropic, Azure OpenAI, GitHub Models, or any
OpenAI-compatible gateway). **The four agents were never migrated to that abstraction** and
still call Ollama directly, so "AI Provider works" and "the agents work" are independent.

---

## What to do next, in order

1. **Run setup.** `./setup.sh` (or `start.sh`). It has never completed. Expect to fix something.
2. **Configure the app.** Settings → Config (private IP, port 8080, HTTP) → Save → Test.
   Then Settings → EdgeConnect should be green with your private IP as the host pattern.
3. **Work the Get Started checklist.** 12 items. Items 7-10 (OpenPipeline pipeline, routing,
   BizEvent capture rule, OneAgent feature flags) are what make business events actually work.
   Item 5 (OneAgent) stays red unless you install OneAgent, which is fine.
4. **Run a pre-built template** and confirm BizEvents with revenue arrive in Grail. That's the
   MVP bar.
5. **Then** Settings → AI Provider, save a key, and generate a journey. First live exercise of
   the provider-agnostic work.

---

## First live VM run — 2026-09-04

Everything below was executed on a real Ubuntu VM against a live Gen3 sprint tenant. This
supersedes the "never run" note above for these specific areas.

### The EdgeConnect open question is ANSWERED

The item below used to read "untested: whether a platform token can auto-generate the OAuth
client." It cannot. Measured:

```
POST <apps>/platform/app-engine/edge-connect/v1/edge-connects
Authorization: Bearer <dt0s16 platform token>
→ 403 {"missingScopes":["oauth2:clients:manage"],
       "message":"Missing permission to create OAuth client"}
```

`oauth2:clients:manage` is **not offered to platform tokens**. So EdgeConnect provisioning
authenticates with the **OAuth client** instead, which can hold that scope. `setup.sh` now
does exactly this, and the credential model stays at two user-supplied credentials.
`GET` on the same endpoint works fine with a platform token (200), so reads were never the
problem.

### Fixed in this pass
- `start.sh` crashed on line 122 with `bad substitution` before ever calling `setup.sh` —
  `${PRIVATE_IP:-<this machine's private IP>}` in an unquoted heredoc; bash read `<` as a
  redirection. Now a quoted heredoc with values printed separately.
- EdgeConnect is created via API. The hardcoded-name booby trap is gone.
- Secrets use `read -s`; only the first 7 characters are echoed back.
- `./setup.sh --reset` clears `setup.conf`, `.env`, and `edgeConnect.yaml`.
- Prompts reduced from 6 (plus 6 optional) to 4.

### Confirmed behaviours worth keeping
- **Host patterns must be the private IP, not a name.** EdgeConnect makes the final hop from
  inside the VM, so the pattern must resolve *there*. A bare `bizobs-demonstrator` resolves to
  nothing locally; the tunnel looks healthy and traffic still dies.
- **The outbound allowlist is not needed for tunnelled traffic.** Matching happens against
  EdgeConnect host patterns first. The allowlist also rejects private RFC 1918 IPs outright,
  so the VM IP cannot go there regardless.
- **The UI cannot rename an EdgeConnect.** A typo means delete and recreate, which mints a new
  OAuth client and invalidates the downloaded YAML.
- **Items 7-10 are not required for BizEvents to arrive.** Revenue-bearing events
  (`order.value`, `loyalty`, `location`, correlated `order.id`) landed in Grail with those
  checklist items undeployed, on `dt.openpipeline.pipelines: ["bizevents:default"]`. The
  earlier claim that 7-10 are "what make business events actually work" is too strong.

### Known open items
- `TECHNICAL-GUIDE.md` still documents the retired four-credential flow. Rewrite it only after
  one clean validated run, not before.
- `deployment-guide/otel.cjs` and `dynatrace-monaco/deploy.cjs` still use the old `Api-Token`
  header. Both are off the main path.
- `setup.sh` could create the EdgeConnect itself and skip the manual UI step entirely. The SDK
  model confirms `POST <apps>/platform/app-engine/edge-connect/v1/edge-connects` returns
  `oauthClientSecret` on creation. **Open question:** whether a platform token can
  auto-generate the OAuth client or whether that needs `oauth2:clients:manage`, which is not
  offered to platform tokens. Untested because the EdgeConnect was created manually first.
- `ensureEdgeConnectHostPattern` in `api/proxy-api.function.ts` is dead code.
- Version drift: `package.json` 2.17.0, `BUSINESS-GUIDE.md` 2.23.1, `TECHNICAL-GUIDE.md` 2.38.9.

---

## How to log findings

Every stumble is the actual product of this exercise. The goal is **a partner with near-zero
knowledge getting from clone to running demo in under an hour**, so friction is the bug.

- If `MVP-TEST-LOG.md` exists locally, append there.
- If it doesn't (fresh clone), create it and record: what you ran, what happened, what you
  expected, and what you had to figure out that wasn't written down.
- Then fix the cause in `setup.sh` / `start.sh` / `README-START_HERE.md` rather than only
  documenting the workaround.

**Don't claim something works unless you ran it.** A lot of effort here has gone into undoing
confident-but-wrong assertions from documentation that turned out to be stale.
