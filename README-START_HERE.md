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

## 1.4 ✅ Create the OAuth client

**Account Management → Identity & access management → OAuth clients → Create OAuth client**

| Field | Value |
|---|---|
| **Grant type** | **Client credentials** |
| **Subject of this OAuth client's token** | **An active user** |
| **Subject user email** | your email |
| **Description** | `Business Observability Demonstrator` |

Tick **four** permissions:

```
Install apps          → app-engine:apps:install
Run apps              → app-engine:apps:run
Connect EdgeConnect   → app-engine:edge-connects:connect
Manage OAuth clients  → oauth2:clients:manage
```

**Record as `DEPLOY_OAUTH_CLIENT_ID` and `DEPLOY_OAUTH_CLIENT_SECRET`.**

> ### Why `oauth2:clients:manage` is on this list
> `setup.sh` creates the EdgeConnect configuration for you via the API, which removes the
> most error-prone step in the old flow. Creating an EdgeConnect makes Dynatrace mint a
> dedicated OAuth client for the tunnel, and minting a client requires
> `oauth2:clients:manage`.
>
> **That scope is not offered to platform tokens.** Verified against a live Gen3 sprint
> tenant on 2026-09-04 — posting to the EdgeConnect endpoint with a `dt0s16` platform token
> returns:
>
> ```json
> 403 {"missingScopes":["oauth2:clients:manage"],
>      "message":"Missing permission to create OAuth client"}
> ```
>
> This is why EdgeConnect provisioning authenticates with the OAuth client rather than the
> platform token. It is also why you still need two credentials rather than one.

> **If `app-engine:apps:install` is missing from this list**, your tenant can't install custom
> apps. Stop here and sort that out before going further.

## 1.5 — EdgeConnect: nothing to do

**You no longer create an EdgeConnect by hand.** `setup.sh` does all of it:

- creates the configuration named `bizobs-demonstrator`
- sets the host pattern to this machine's private IP, detected automatically
- captures the generated OAuth credentials straight from the API response
- writes `edgeconnect/edgeConnect.yaml` and starts the container

> ### Why this step was automated
> The name in the Dynatrace configuration had to match a hardcoded literal in `setup.sh`
> exactly, and **nothing validated it**. A one-character typo (`bizops` for `bizobs`) produced
> a tunnel that authenticated fine, started cleanly, and never associated — surfacing much
> later as a vague failed connection test. The container log was the only place the real cause
> appeared:
>
> ```
> EdgeConnect 'bizobs-demonstrator' is not configured for tenant 'abc12345'
> ```
>
> Compounding it, **the Dynatrace UI does not let you rename an EdgeConnect.** Fixing a typo
> means deleting and recreating, which mints a *new* OAuth client and invalidates the YAML you
> already downloaded.

> ### The host pattern must be the IP, not a name
> EdgeConnect makes the final hop from *inside* your VM, so the host pattern has to be
> something that resolves there. A bare name like `bizobs-demonstrator` resolves to nothing
> locally, and the request dies after a tunnel that looks perfectly healthy. `setup.sh` uses
> `hostname -I` and always sets the private IP.

> ### You do not need the outbound allowlist
> `Settings → General → External requests` has a second tab, an allowlist for outbound
> connections. **Tunnelled traffic does not need an entry there.** A request is matched
> against EdgeConnect host patterns first; only if nothing matches does it fall through to the
> allowlist. Note that the allowlist rejects private RFC 1918 addresses outright
> ("must be within the public range"), so trying to add your VM's IP there will fail — and it
> is not what you want anyway.

## Phase 1 checklist

- [x] Tenant ID and `ENV_TYPE` recorded
- [x] `PLATFORM_TOKEN` created (`dt0s16.…`)
- [x] Ingest verified with `Bearer`
- [ ] OAuth client created with **all four** permissions, including `oauth2:clients:manage`
- [ ] `DEPLOY_OAUTH_CLIENT_ID` / `DEPLOY_OAUTH_CLIENT_SECRET` recorded

Nothing else. EdgeConnect, its OAuth client, the host pattern, and the YAML are all handled by
`setup.sh`.

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

## 2.2 ⬜ Answer the four prompts

| # | Prompt | Value |
|---|---|---|
| 1 | Environment type | `1` for sprint, `2` for prod |
| 2 | Tenant ID | the `abc12345` part of your URL |
| 3 | Platform token | `dt0s16.…` from Phase 1.2 |
| 4 | OAuth client ID + secret | from Phase 1.4 |

That is the whole list. Token and secret input is **hidden as you type** — the script echoes
back only the first seven characters (`dt0s16.…`) so you can confirm you pasted the right kind
of credential without it landing in your scrollback.

The platform token is used for ingest *and* dashboard deployment, so you are only asked once.
There is no prompt for EdgeConnect credentials: they do not exist until `setup.sh` creates the
EdgeConnect, and it reads them straight out of the API response.

> **Made a typo?** Re-running plain `./setup.sh` reuses the saved `setup.conf` and will not
> ask again. To start over:
> ```bash
> ./setup.sh --reset
> ```
> That clears `setup.conf`, `.env`, and the generated `edgeConnect.yaml`.

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
| EdgeConnect name is a hardcoded literal with no validation | **Fixed 2026-09-04** — `setup.sh` creates the EdgeConnect via API; the name is never typed by a human |
| Manual EdgeConnect creation + YAML download | **Fixed 2026-09-04** — fully automated, credentials read from the create response |
| Tokens echoed in clear text at the prompts | **Fixed 2026-09-04** — `read -s`, only the first 7 chars are shown back |
| No way to correct a mistyped credential on re-run | **Fixed 2026-09-04** — `./setup.sh --reset` |
| `start.sh` crashed with `bad substitution` before reaching `setup.sh` | **Fixed 2026-09-04** — angle brackets in a `${var:-default}` inside an unquoted heredoc |
| `setup.sh` prompt counter mislabels itself | **Fixed 2026-09-04** — now a straight 1/4 → 4/4 |
| Prompt 6 silently reused the EdgeConnect client for the app install | **Fixed 2026-09-04** — that prompt no longer exists |
| `TECHNICAL-GUIDE.md` still documents the old four-credential classic flow | Open, rewrite after a clean run |
| The four AI agents still require Ollama; they don't use the AI Provider setting | Open, by design for now |
| `deployment-guide/` still contains pre-June-2026 instructions | Open |
| Checklist items 7-10 not yet validated | Open — BizEvents with revenue *do* arrive without them, landing on `bizevents:default` |
