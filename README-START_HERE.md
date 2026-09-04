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

This one is in your **environment**, not Account Management.

> **There is no EdgeConnect app.** Searching "EdgeConnect" routes you to a settings page.
> Go to **Settings → General → External requests**, then pick the **EdgeConnect** tab
> (the other tab is the allowlist), then **+ New EdgeConnect**.

### First, get the VM's private IP

You need it for the host pattern, so run this on the Linux machine before you start:

```bash
hostname -I | awk '{print $1}'
```

### Then fill the form

The form has exactly two fields.

| Field | Value |
|---|---|
| **Name** | `bizobs-demonstrator` |
| **Host patterns** | the VM's private IP from above |

> ### The name must match exactly
> ```
> bizobs-demonstrator
> ```
> `setup.sh` writes that exact string into `edgeconnect/edgeConnect.yaml` as a hardcoded
> literal. If the name differs by even one character, the tunnel will start and appear
> healthy but never associate, and the failure surfaces much later as a vague failed
> connection test in the app. Nothing validates this for you.
>
> The name must be RFC 1123 label compliant, max 50 characters. `bizobs-demonstrator`
> qualifies (lowercase alphanumeric plus hyphens).

**About host patterns.** They are **required**, and a given pattern can belong to only one
EdgeConnect configuration. They live in this Dynatrace-side config, not in the YAML, which is
why the YAML `setup.sh` generates contains only the name and the OAuth block. The `name` field
is what links the two together. Wildcards are supported (`*.example.org`) but a plain private
IP is what you want here.

### Download the YAML immediately

Click **Download** as soon as the configuration is created.

> **The OAuth client secret is displayed once and cannot be retrieved.** You can re-download
> the config file later, but the secret will no longer be in it. If you miss it, delete the
> EdgeConnect configuration and create it again.

Dynatrace **auto-generates a dedicated OAuth client** for each EdgeConnect configuration.
There is no option to point it at the client you made in 1.4. That's expected: the 1.4 client
is for the **app deploy**, this generated one is for the **tunnel**. `setup.sh` prompts for the
two pairs separately.

From the downloaded YAML, record:
- `oauth.client_id` → **`EC_OAUTH_CLIENT_ID`**
- `oauth.client_secret` → **`EC_OAUTH_CLIENT_SECRET`**

## Phase 1 checklist

- [x] Tenant ID and `ENV_TYPE` recorded
- [x] `PLATFORM_TOKEN` created (`dt0s16.…`)
- [x] Ingest verified with `Bearer`
- [ ] `DEPLOY_OAUTH_CLIENT_ID` / `SECRET` created (the 1.4 client, for the app deploy)
- [ ] VM private IP noted (`hostname -I | awk '{print $1}'`)
- [ ] EdgeConnect created, named exactly `bizobs-demonstrator`, host pattern = private IP
- [ ] `edgeConnect.yaml` downloaded, and `EC_OAUTH_CLIENT_ID` / `SECRET` recorded from it

---

# Phase 2 — On the Linux machine

## 2.1 ⬜ One command

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/israel-salgado/Business-Observability-Demonstrator/wip/test-updates/start.sh)
```

That's it. It installs `git` and `curl` if missing, clones the repo, shows you the list of
things it's about to ask for, waits for you to confirm, then hands off to `setup.sh` which
prompts you for each value in turn.

> **Why `bash <(curl ...)` and not `curl ... | bash`?** With a pipe, the script's stdin *is*
> the pipe, so interactive prompts get skipped or eat garbage. The process-substitution form
> keeps your terminal attached. `start.sh` also re-attaches `/dev/tty` defensively, so the
> pipe form works too, but this form is the reliable one.

**Options**, if you need them:

```bash
BRANCH=main INSTALL_DIR=/opt/bizobs bash <(curl -fsSL .../start.sh)
```

## 2.2 ⬜ Answer the six prompts

| # | Prompt | Value |
|---|---|---|
| 1 | Environment type | `1` for sprint, `2` for prod |
| 2 | Tenant ID | the `abc12345` part of your URL |
| 3 | Platform token | `dt0s16.…` from Phase 1.2 |
| 4 | EdgeConnect OAuth Client ID | `oauth.client_id` from the downloaded YAML |
| 5 | EdgeConnect OAuth Client Secret | `oauth.client_secret` from the same YAML |
| 6 | App install OAuth client ID + secret | from Phase 1.4 |

The platform token is used for **both** telemetry ingest and dashboard deployment, so you're
only asked for it once.

Then it offers an optional block of account-provisioning fields. **Press Enter through all of
them.** They're only for the self-service access-request feature.

## 2.3 ⬜ Watch for these lines

Setup runs six unattended steps: Node 22 and Docker, `npm install`, credentials and `.env`,
the EdgeConnect container, the app deploy, then the server start. Expect a few minutes.

- `✓ No local Ollama (OLLAMA_MODE=disabled)` — correct, you didn't install it
- `✓ EdgeConnect running` — the tunnel container is up
- `✓ Demonstrator UI deployed` — the app is in your tenant
- `✓ Server running on port 8080`

**Write down the private IP it prints at the end.** It should match the host pattern you set
in Phase 1.5.

## 2.4 ⬜ Sanity check

```bash
curl http://localhost:8080/api/health
```

An empty `childServices` array is correct. Nothing spawns until you launch a journey.

## Prefer a config file over prompts?

If you'd rather proofread everything before it runs, which is easier when your tenant and VM
are on different networks:

```bash
cd ~/Business-Observability-Demonstrator
cp setup.conf.example setup.conf
nano setup.conf          # fill it in
./setup.sh               # runs non-interactively
grep -c XXXX setup.conf  # must print 0 before you run
```

`API_TOKEN` and `DT_PLATFORM_TOKEN` both take the same platform token. Leave
`DEPLOY_OAUTH_*` blank only if you accept that the app deploy will 403.

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
