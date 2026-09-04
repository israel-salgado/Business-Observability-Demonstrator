# START HERE — Business Observability Demonstrator Setup

> **This is the authoritative setup guide.** Where it disagrees with `README.md`,
> `TECHNICAL-GUIDE.md`, or anything in `deployment-guide/`, **this file wins**. Those
> predate the June 2026 Dynatrace Gen3 changes and still describe the old four-credential
> flow with classic access tokens.
>
> **Status:** actively being validated on a clean VM against a clean tenant. Steps marked
> ✅ have been verified working. Steps marked ⬜ are next up and not yet run end to end.

**What you're building.** Two pieces:
1. A **Linux host** that runs the engine, generating real microservices, real traffic, and
   real telemetry. This is the pretend "customer production environment."
2. A **Dynatrace app** that you open in your tenant to drive it all.

They talk to each other through an **EdgeConnect** tunnel, which dials *out* from your host.
That's why your host needs no public IP and no inbound firewall rules.

---

# Phase 0 — Prerequisites

You bring these. Nothing here is installed by the setup script.

## 0.1 A Dynatrace tenant

Find your tenant ID and type from your browser URL. In every example below, `abc12345` is
the tenant ID.

| Type | URL you browse | Ingest host (no `.apps.`) | `ENV_TYPE` |
|---|---|---|---|
| **Production / Live** | `https://abc12345.apps.dynatrace.com` | `https://abc12345.live.dynatrace.com` | `prod` |
| **Production (older style)** | `https://abc12345.live.dynatrace.com` | same | `prod` |
| **Sprint** (Dynatrace internal) | `https://abc12345.sprint.apps.dynatracelabs.com` | `https://abc12345.sprint.dynatracelabs.com` | `sprint` |

> **The two-host thing matters.** Telemetry ingest goes to the host **without** `.apps.`,
> while the app and DQL live on the host **with** `.apps.`. Verified 2026-09-03: ingest paths
> return 404 on the `.apps.` host. The setup script derives both automatically, but if you
> ever hand-configure anything, this is the trap.

**Also required:**
- **AppEngine available**, which needs a DPS licence. Quick check: when you create the OAuth
  client in Phase 1, if `app-engine:apps:install` isn't in the permission list, you don't have
  it and nothing else will work.
- **Admin access to Account Management**, enough to create a platform token and an OAuth
  client. Both live at `myaccount.dynatrace.com`.

> **Two consoles, and the docs rarely say which.** **Account Management**
> (`myaccount.dynatrace.com`) holds platform tokens and OAuth clients. Your **environment**
> (`abc12345.apps.dynatrace.com`) holds EdgeConnect and the app itself. Most confusion in the
> older guides comes from this split.

## 0.2 A Linux machine, already running

This is **not** a cloud provisioning tool. You need a Linux box you can already SSH into.
EC2, Azure, GCP, Proxmox, vSphere, a laptop VM, or bare metal all behave identically.

| | Requirement |
|---|---|
| **OS** | Any Linux with `systemd` and one of `dnf` / `yum` / `apt`. Verified on **Ubuntu 22.04+**, **Debian 12+**, **Amazon Linux 2023** |
| **RHEL family** | RHEL / Rocky / AlmaLinux work, but they ship Podman not Docker. Add the Docker CE repo first; `setup.sh` stops and prints the exact commands if it detects this |
| **Arch** | x86_64 or arm64 |
| **Size** | **2 vCPU / 4 GB RAM / 20 GB disk.** Only go to 4 vCPU / 8 GB / 40 GB if you want local Ollama models |
| **Access** | SSH plus `sudo`. Passwordless `sudo` preferred: without it the systemd service step is skipped and the server runs under `nohup`, which won't survive a reboot |
| **Network** | Outbound HTTPS (443) to your tenant, `sso.dynatrace.com`, Docker Hub, nodesource. **No inbound ports, no public IP, no port forwarding** |

**Installed for you by `setup.sh`:** Node.js 22, Docker, npm packages, the EdgeConnect
container, the Dynatrace app, and a systemd service.

**Optional, not installed, not needed for a working demo:**
- **OneAgent** — adds host and process instrumentation. One checklist item stays red without
  it. Install from Dynatrace → Deploy Dynatrace if you want the fuller picture.
- **Ollama** — only for local open-source model demos. Without it, the four AI agents fall
  back to rule-based logic and dashboard generation falls back to templates. AI journey
  generation uses a cloud provider you configure in the app instead.

> **Warning:** `setup.sh` runs `apt/dnf/yum remove -y nodejs npm` before installing Node 22.
> Give this box a dedicated purpose, don't put it on a host running other Node apps.

---

# Phase 1 — In Dynatrace

**Two credentials.** Both created in **Account Management → Identity & access management**.

## 1.1 ✅ Record your tenant details

From Phase 0.1, write down your **Tenant ID** (`abc12345`) and **`ENV_TYPE`**
(`prod` or `sprint`).

## 1.2 ✅ Create the platform token

**Account Management → Identity & access management → Platform tokens → Create token**

Name it `bizobs-demonstrator`. Tick the scopes below. It's a long list once, and it's
deliberately generous so you don't chase permission errors mid-demo. We trim it after
validation.

**Telemetry ingest** (the engine sending data)
```
openpipeline:traces:ingest
openpipeline:metrics:ingest
openpipeline:logs:ingest
openpipeline:bizevents:ingest
openpipeline:events:ingest
```

**Dashboards**
```
document:documents:read
document:documents:write
document:environment-shares:write
```

**What the in-app setup checklist deploys**
```
openpipeline:configurations:read
openpipeline:configurations:write
settings:objects:read
settings:objects:write
settings:schemas:read
automation:workflows:read
automation:workflows:write
business-analytics:business-flows:read
business-analytics:business-flows:write
```

**EdgeConnect host patterns** (the app manages these for you)
```
app-engine:edge-connects:read
app-engine:edge-connects:write
```

**AI provider key storage**
```
credential-vault:entries:read
credential-vault:entries:write
```

**The app's DQL queries.** Note `storage:buckets:read` is required *in addition* to the
table scopes, not instead of them.
```
storage:buckets:read
storage:events:read
storage:bizevents:read
storage:metrics:read
storage:logs:read
storage:spans:read
storage:entities:read
storage:smartscape:read
```

**Escape hatch** — include these. They let the setup script mint any additional token it
needs without sending you back to the UI.
```
api-tokens:tokens:read
api-tokens:tokens:write
```

Copy the token. It starts with `dt0s16.` and is shown once. **Record as `PLATFORM_TOKEN`.**

## 1.3 ✅ Verify the token can ingest

Already verified on 2026-09-03 against a Gen3 sprint tenant, so you can skip this unless
something later goes wrong. Recording it because it's the check that proved the Gen3 path
works and it's a useful diagnostic.

A `dt0s16` platform token sent as `Authorization: Bearer` was accepted on the existing
endpoints, with no endpoint changes required:

| Endpoint | Result |
|---|---|
| `<ingest-host>/api/v2/otlp/v1/traces` | **200** |
| `<ingest-host>/api/v2/bizevents/ingest` | **202** |
| `<ingest-host>/api/v2/metrics/ingest` | **202** |
| `<ingest-host>/platform/ingest/v1/events` | **202** |
| `<apps-host>/platform/ingest/v1/events` | 404 (wrong host, expected) |
| `<apps-host>/platform/storage/query/v1/query:execute` | **202** |

To re-run it, substitute your token and tenant:

```bash
TOKEN="PASTE_dt0s16_TOKEN_HERE"
INGEST="https://abc12345.live.dynatrace.com"

printf 'traces    : '; curl -s -o /dev/null -w '%{http_code}\n' -X POST "$INGEST/api/v2/otlp/v1/traces" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/x-protobuf' --data-binary ''
printf 'bizevents : '; curl -s -o /dev/null -w '%{http_code}\n' -X POST "$INGEST/api/v2/bizevents/ingest" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"event.type":"test"}'
printf 'metrics   : '; curl -s -o /dev/null -w '%{http_code}\n' -X POST "$INGEST/api/v2/metrics/ingest" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: text/plain' -d 'test.metric 1'
```

**2xx or 400 means auth is fine.** 401 or 403 means the token or its scopes are wrong.

## 1.4 ⬜ Create the OAuth client

**Account Management → Identity & access management → OAuth clients → Create OAuth client**

| Field | Value |
|---|---|
| **Grant type** | **Client credentials** |
| **Subject of this OAuth client's token** | **An active user** |
| **Subject user email** | your email |
| **Description** | `Business Observability Demonstrator` |

Tick exactly three permissions, all under **App Engine**:

```
Connect EdgeConnect   → app-engine:edge-connects:connect
Install apps          → app-engine:apps:install
Run apps              → app-engine:apps:run
```

**Record as `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET`.**

> **Why a second credential is unavoidable.** `app-engine:edge-connects:connect` is the
> permission an EdgeConnect instance uses to establish its tunnel, and it is **not offered to
> platform tokens** — only to OAuth clients. Everything else the demonstrator needs is
> covered by the platform token from 1.2.

> **If `app-engine:apps:install` is missing from this list**, your tenant can't install custom
> apps. Stop here and sort that out before going further.

## 1.5 ⬜ Create the EdgeConnect configuration

This one is in your **environment**, not Account Management. Search **EdgeConnect**, or go
to Settings → General → **External requests**.

> ### Name it exactly this
> ```
> bizobs-demonstrator
> ```
> `setup.sh` writes that exact string into `edgeconnect/edgeConnect.yaml` as a hardcoded
> literal. If the name differs by even one character, the tunnel will start and appear
> healthy but never associate, and the failure surfaces much later as a vague failed
> connection test in the app. Nothing validates this for you.

- Leave **host patterns empty**. The app fills them in later.
- If the form lets you **point at your existing OAuth client** from 1.4, do that.
- If it insists on **generating its own** OAuth client, that's fine: use the generated one
  for EdgeConnect and keep the 1.4 client for the app install. `setup.sh` asks for them
  separately.

**Record whichever client ID and secret EdgeConnect ends up using as
`EC_OAUTH_CLIENT_ID` and `EC_OAUTH_CLIENT_SECRET`.**

## Phase 1 checklist

- [x] Tenant ID and `ENV_TYPE` recorded
- [x] `PLATFORM_TOKEN` created (`dt0s16.…`)
- [x] Ingest verified with `Bearer`
- [ ] `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` created
- [ ] EdgeConnect created and named exactly `bizobs-demonstrator`

---

# Phase 2 — On the Linux machine

> **Brief for now, to be expanded as we validate each step.**

## 2.1 ⬜ Clone

```bash
git clone -b wip/test-updates \
  https://github.com/israel-salgado/Business-Observability-Demonstrator.git
cd Business-Observability-Demonstrator
```

**Use the `wip/test-updates` branch.** None of the Gen3 work is on `main` yet.

## 2.2 ⬜ Write your values into `setup.conf`

Rather than typing secrets into blind interactive prompts, put them in a file where you can
proofread them first. This matters more if your tenant and your VM are on different networks.

```bash
cp setup.conf.example setup.conf
nano setup.conf
```

Fill in `ENV_TYPE`, `TENANT_ID`, `API_TOKEN` (use your **platform token** here),
`DT_PLATFORM_TOKEN` (the same platform token), `EC_OAUTH_CLIENT_ID`,
`EC_OAUTH_CLIENT_SECRET`. Leave the `DEPLOY_OAUTH_*` pair blank to reuse the EdgeConnect
client, or fill it with the 1.4 client.

Leave the optional account-provisioning block empty.

## 2.3 ⬜ Run setup

```bash
chmod +x setup.sh
./setup.sh
```

Six steps, unattended: Node 22 and Docker, `npm install`, credentials and `.env`, the
EdgeConnect container, the app deploy to your tenant, then the server start.

**Write down the private IP it prints at the end.** You need it in the app.

## 2.4 ⬜ Sanity check

```bash
curl http://localhost:8080/api/health
```

An empty `childServices` array is correct. Nothing spawns until you launch a journey.

---

# What comes next (to be written up as Phase 3)

Once Phase 2 runs clean:

1. Open **Apps → Business Observability Demonstrator** in your tenant
2. **Settings → Config**: private IP, port `8080`, protocol `HTTP`, then Save and Test
3. **Settings → EdgeConnect**: confirm green, and that the host pattern is your private IP
4. **Settings → AI Provider**: pick a provider, paste a key, Save to Vault
5. **Get Started** checklist: 12 items, 6 of which push real configuration into your tenant.
   Items 7 to 10 (OpenPipeline pipeline, routing, BizEvent capture rule, OneAgent feature
   flags) are what make business events actually work
6. **Home**: pick a pre-built template and run it

---

## Known rough edges

Being tracked in `MVP-TEST-LOG.md` and fixed as we go.

| Issue | Status |
|---|---|
| EdgeConnect name is a hardcoded literal with no validation | Open, should become a prompt |
| `setup.sh` prompt counter mislabels itself (1/6, 2/6, 3/6, then 4/7, 5/7, 6/7) | Open, cosmetic |
| `TECHNICAL-GUIDE.md` still documents the old four-credential classic flow | Open, rewrite after a clean run |
| The four AI agents still require Ollama; they don't use the AI Provider setting | Open, by design for now |
| `deployment-guide/` still contains pre-June-2026 instructions | Open |
