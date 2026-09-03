# Dynatrace Business Observability Demonstrator

<p align="center">
  <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=https://github.com/israel-salgado/Business-Observability-Demonstrator" alt="QR code linking to the Business Observability Demonstrator repository on GitHub" />
</p>

Model any customer’s real business journey — their exact checkout flow, claims process, or patient care pathway — and turn it into a live, fully instrumented simulation inside Dynatrace. Describe the journey in plain language (or use AI to research it), and the Demonstrator generates real microservices, realistic traffic, business events with revenue metadata, and executive dashboards — all wired into Dynatrace OneAgent, BizEvents, and Dynatrace Intelligence.

**110+ pre-built industry templates** across 55+ verticals get you started in one click — but the real power is generating bespoke journeys tailored to any customer's actual operations.

**This is a unified repo** — it contains both the **Engine** (Node.js server) and the **Demonstrator UI** (Dynatrace AppEngine app).

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Custom Journey Generation** | Describe any customer’s real business flow in plain language — or use AI (Copilot, Gemini, etc.) to research it — and the Demonstrator generates the full journey config: steps, substeps, services, and business metadata. No coding required. |
| **24 Pre-Built Templates** | One-click industry templates across Banking, Insurance, Manufacturing, Retail, Telecommunications, Healthcare, Financial Services, Travel & Hospitality — great for getting started fast or running a quick demo |
| **Dynamic Microservices** | Spawns real Node.js child processes per journey step — each with its own Express server, Dynatrace OneAgent identity, and health endpoint |
| **Auto-Load System** | Generates 30–60 journeys/minute per active company with zero manual interaction |
| **AI Agent Hub** | 4 AI agents — Nemesis (chaos), Fix-It (remediation), Librarian (memory), Dashboard (deployment) |
| **Per-Service Chaos Injection** | Target individual services with configurable error rates without affecting the rest of the fleet |
| **Dynatrace-Native** | OneAgent metadata propagation, event ingestion (CUSTOM_DEPLOYMENT), OAuth SSO, dashboard deployment, DT API proxy, EdgeConnect tunneling |
| **Monaco Config-as-Code** | Automated Dynatrace configuration deployment (capture rules, service naming, OpenPipeline, OneAgent features) |
| **Persistence** | Chaos state, port allocations, credentials, and saved configs all survive server restarts |

---

## Deploy

### Prerequisites

#### What you bring: one running Linux host

This is not a cloud provisioning tool. It assumes you **already have a Linux machine running**
that you can SSH into. Where it runs makes no difference: EC2, Azure, GCP, Proxmox, vSphere, a
laptop VM, a bare-metal box, or a Codespace all work identically.

| | Requirement |
|---|---|
| **OS** | Any Linux with `systemd` and one of `dnf`, `yum`, or `apt`. Verified on **Ubuntu 22.04+**, **Debian 12+**, and **Amazon Linux 2023**. RHEL / Rocky / AlmaLinux work, but add the Docker CE repo first (`setup.sh` prints the exact commands if it hits this). |
| **Arch** | x86_64 or arm64 |
| **Size** | **2 vCPU / 4 GB RAM / 20 GB disk** is enough by default. Only go to **4 vCPU / 8 GB / 40 GB** if you want local Ollama models. |
| **Access** | SSH plus `sudo`. Passwordless `sudo` is preferred: without it the systemd service install is skipped and the server runs under `nohup` instead. |
| **Network** | Outbound HTTPS (443) to your Dynatrace tenant. **No inbound ports, no public IP, and no port forwarding** are needed, because EdgeConnect makes an outbound tunnel. |

**`setup.sh` installs everything else for you:** Node.js 22, Docker, npm packages, the EdgeConnect
container, the Demonstrator UI, and the systemd service.

**Not installed, and not required:** OneAgent (optional, adds host and process instrumentation)
and Ollama (optional, only for local-model demos). `setup.sh` detects whether Ollama is running
and records the result, so AI features fall back to templates cleanly when it's absent. For AI
generation, configure any cloud provider in the app under **Settings → AI Provider**.

#### Dynatrace side

- **Dynatrace NFR tenant** (SaaS or Managed 1.275+, AppEngine requires a DPS licence)
- **4 Dynatrace credentials** (see [TECHNICAL-GUIDE.md](TECHNICAL-GUIDE.md#step-2-create-dynatrace-credentials) for how to create them):

| Credential | Type | Where To Create |
|-----------|------|-----------------|
| **API Token** | `dt0c01.*` | DT tenant → Settings → Access Tokens (scopes: `events.ingest`, `metrics.ingest`, `openTelemetryTrace.ingest`, `entities.read`) |
| **DT Platform Token (dtctl)** | `dt0s16.*` (recommended) | Used by bespoke dashboard deployment via dtctl. Minimum scope: `document:documents:write` (recommended: `document:documents:read`; optional for environment sharing: `document:environment-shares:write`) |
| **EdgeConnect OAuth** | `dt0s10.*` or `dt0s02.*` | DT tenant → Settings → General → External Requests → Add EdgeConnect. DT generates the credentials automatically. |
| **Deploy OAuth** *(optional)* | `dt0s10.*` or `dt0s02.*` | Same client works if you add `app-engine:apps:install` + `app-engine:apps:run` scopes. Or use a separate account-level client from Account Management → IAM → OAuth clients. |

### One Command

```bash
git clone https://github.com/israel-salgado/Business-Observability-Demonstrator.git && cd Business-Observability-Demonstrator && chmod +x setup.sh && ./setup.sh
```

The script walks you through 7 guided prompts (environment type, tenant ID, API token, DT platform token for dtctl, EdgeConnect OAuth, and deploy OAuth), then automatically:

1. Installs npm packages
2. Configures & starts EdgeConnect (Docker)
3. Deploys the Demonstrator UI to your Dynatrace tenant
4. Builds TypeScript agents
5. Starts the Demonstrator server

**After setup:** Open **Dynatrace → Apps → Business Observability Demonstrator** → Settings → Config → enter your private IP → Save → Test → Get Started checklist.

**Then:** Pick a pre-built template to see it in action immediately — or describe a customer’s real journey and generate a bespoke simulation tailored to their business.

---

<details>
<summary><strong>Manual Setup (step-by-step)</strong></summary>

### Phase 1 — Pull

```bash
git clone https://github.com/israel-salgado/Business-Observability-Demonstrator.git
cd Business-Observability-Demonstrator
chmod +x setup.sh
./setup.sh
```

### Phase 2 — Deploy

```bash
# 1. Copy your EdgeConnect YAML (downloaded from DT External Requests page)
#    Or edit edgeconnect/edgeConnect.yaml with your OAuth values
#    Make sure the 'name:' field matches your EdgeConnect name in DT UI
cp ~/Downloads/edgeConnect.yaml edgeconnect/edgeConnect.yaml

# 2. Start EdgeConnect tunnel
bash edgeconnect/run-edgeconnect.sh

# 3. Deploy Demonstrator UI to Dynatrace AppEngine
#    (setup.sh handles credentials automatically — for manual deploy, run ./setup.sh)
npx dt-app deploy

# 4. Build agents & start the Demonstrator server
npm run build:agents
npm start
```

### Phase 3 — Configure

1. Open Dynatrace → **Apps** → **Business Observability Demonstrator**
2. Go to **Settings** (gear icon) → **Config** tab
3. Set Host/IP to your **private IP** (not public!) — find it with `hostname -I | awk '{print $1}'`
4. Set Port to `8080`, Protocol to `HTTP`
5. Click **Save**, then **Test**
6. Go to **Get Started** tab → work through the checklist (deploy OpenPipeline, capture rules, etc.)
7. Go to **Home** → pick a template → click **Run**

> **AWS users:** Always use the **private IP** (e.g. `172.31.x.x`), not the Elastic/public IP. AWS does not support NAT hairpin.

</details>

For the full detailed guide, see [TECHNICAL-GUIDE.md](TECHNICAL-GUIDE.md).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Dynatrace Platform                            │
│                                                                  │
│  ┌──────────────────────────┐   ┌───────────────────────────┐   │
│  │  Business Observability  │   │  Services / BizEvents /   │   │
│  │  Demonstrator UI (AppEngine)    │   │  Dashboards / Problems    │   │
│  └──────────┬───────────────┘   └───────────────────────────┘   │
│             │ EdgeConnect Tunnel                  ▲               │
│             │ (HTTPS → port 8080)                 │ OneAgent +   │
│             │                                     │ OTLP         │
└─────────────┼─────────────────────────────────────┼──────────────┘
              │                                     │
              ▼                                     │
┌─────────────────────────────────────────────────────────────────┐
│  Your Host (EC2 / VM / Codespace)                                │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Main Server (port 8080) — Express.js + Socket.IO        │   │
│  │  ├── 20+ API route modules (100+ endpoints)             │   │
│  │  ├── AI Agents, MCP Server, PDF Export                  │   │
│  │  └── Dynatrace Event Ingestion + DT API Proxy           │   │
│  └──────────────────────────────────────────────────────────┘   │
│                          │                                       │
│              spawns child processes (with --require otel.cjs)    │
│                          ▼                                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Dynamic Child Services (ports 8081–8740, 660 ports)     │   │
│  │  Each = separate Node.js process with OTel + OneAgent    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌────────────────┐  ┌───────────┐  ┌────────────────────┐     │
│  │  EdgeConnect    │  │  OneAgent  │  │  Ollama (LLM)     │     │
│  │  (tunnel)       │  │           │  │  llama3.2          │     │
│  └────────────────┘  └───────────┘  └────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

---

## AI Agent Hub

The Agent Hub (Step 4 in the UI) provides four specialized AI agents powered by an LLM backend (Ollama).

### Nemesis — Chaos Agent
Controlled chaos injection with LLM-powered recipe selection.

- **7 chaos recipes**: `enable_errors`, `increase_error_rate`, `slow_responses`, `disable_circuit_breaker`, `disable_cache`, `target_company`, `custom_flag`
- **Per-service targeting**: Errors only affect the targeted service — other services remain healthy
- **Configurable intensity**: Scale 1–10 maps to 10%–100% error rates
- **Auto-revert**: Configurable duration timers automatically restore healthy state
- **Safety lock**: Max concurrent faults limit
- **Dynatrace events**: Every chaos injection sends a `CUSTOM_DEPLOYMENT` event with `[ROOT CAUSE]` metadata

### Fix-It — Remediation Agent
Autonomous problem detection, diagnosis, and remediation.

- **Full pipeline**: Detect → Diagnose → Propose Fix → Execute → Verify → Learn
- **Dynatrace-aware**: Queries DT problems, logs, metrics, and topology for diagnosis
- **7 fix types**: `disable_errors`, `reset_feature_flags`, `reduce_error_rate`, `enable_circuit_breaker`, `enable_cache`, `disable_slow_responses`, `send_dt_event`
- **LLM agent loop**: Function calling for intelligent decision-making
- **Learning**: Records outcomes to Librarian for future reference

### Librarian — Operational Memory
Persistent knowledge store for the AI agent ecosystem.

- **Vector store**: Similarity search across past incidents
- **History store**: Chronological event timeline
- **Records**: Chaos events, reverts, DT problems, diagnoses, fixes, outcomes
- **LLM-powered learning**: Generates insights from incident history
- **Librarian Dashboard**: Modal overlay on the Demonstrator Dashboards page — Ollama analyses your full incident history and renders an AI Summary, colour-coded Stats Cards, severity-tagged Insights, Detected Patterns, and a scrollable Event Timeline. Falls back to raw-data analysis when Ollama is cold.

### Dashboard — AI Dashboard Deployer
One-click Dynatrace dashboard deployment.

- **Pre-built dashboards**: Generate from journey configurations
- **AI-generated**: LLM creates custom dashboard JSON
- **Deployment**: Via Dynatrace Document API (OAuth or API token auth)

---

## Auto-Load System

Once services are running, the auto-load system automatically generates realistic traffic:

- **30–60 journeys/minute** per active company
- **Zero interaction required** — starts automatically when services come online
- **Service watcher**: Polls for new/removed companies every 10 seconds
- **Randomized profiles**: 10 customer profiles across 4 priority levels
- **Tracks metrics**: Iterations, successes, and errors per company
- **Stops automatically** when services are shut down

---

## Chaos Injection & Feature Flags

### Per-Service Isolation
Each child service fetches its own feature flags from the main server (`GET /api/feature_flag?service=<name>`). Only services with explicit overrides receive elevated error rates.

### Key Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/feature_flag` | Get global + per-service flags |
| `POST` | `/api/feature_flag` | Set global or targeted (`targetService`) overrides |
| `DELETE` | `/api/feature_flag/service/:name` | Remove a per-service override |
| `POST` | `/api/remediation/feature-flag` | Set remediation flags + send DT event |

### Persistence
- Feature flag overrides → `.chaos-state.json` (restored on startup)
- Service port assignments → `.port-allocations.json` (restored on startup)
- Dynatrace credentials → `.dt-credentials.json` (restored on startup)

---

## Dynatrace Integration

### Event Ingestion
Every chaos injection and remediation action sends a `CUSTOM_DEPLOYMENT` event to Dynatrace with rich metadata:
- `deployment.project`, `deployment.name`, `deployment.version`
- `dt.event.is_rootcause_relevant: true`
- `dt.event.description` with `[ROOT CAUSE]` or `[REMEDIATION]` prefixes

### DT API Proxy
Agents query Dynatrace through local proxy endpoints:

| Endpoint | DT API |
|----------|--------|
| `/api/dt-proxy/problems` | Problems v2 |
| `/api/dt-proxy/events` | Events v2 |
| `/api/dt-proxy/metrics` | Metrics v2 |
| `/api/dt-proxy/entities` | Entities v2 |
| `/api/dt-proxy/logs` | Logs v2 |

### OneAgent Metadata
Each child service gets Dynatrace environment variables:
- `DT_APPLICATION_ID`, `DT_CUSTOM_PROP`, `DT_TAGS`, `DT_CLUSTER_ID`
- Release metadata for version tracking

### Authentication
- **OAuth SSO**: Dynatrace Sprint SSO via `simple-oauth2` (authorization code grant)
- **API Token**: Direct token auth for event ingestion
- **UI Config**: ⚙️ Settings modal for credential management

### Monaco Config-as-Code

```bash
# Automated deployment via Settings API
npm run configure:dynatrace

# Or via Monaco CLI
npm run configure:monaco
```

Deploys: OneAgent features, capture rules, service naming, OpenPipeline pipelines & routing.

---

## UI Overview

### 5-Tab Wizard + Engine Pages

| Tab/Page | Description |
|-----|-------------|
| 🏠 **Welcome** | Application overview and getting-started guide |
| **Step 1: Customer Details** | Company name, domain, industry type input |
| **Step 2: Generate Prompts** | AI/Copilot prompt generation for journey creation |
| **Step 3: Generate Data** | Journey simulation controls, data generation, LoadRunner integration |
| 🤖 **Step 4: AI Agent Hub** | Nemesis / Fix-It / Librarian / Dashboard agent controls |
| 📊 **Demonstrator Dashboards** | DQL-powered dashboard presets (Security, DI, Infra) + 📚 Librarian modal overlay |
| 🏭 **Solutions** | 55+ industry verticals with clickable demo journeys and Dynatrace capability mapping |
| 🎯 **Demo Guide** | Interactive walkthrough paths (Quick Start, Chaos & Fix-It, Traces, Platform, LiveDebugger) |

### Additional UI Elements
- **Saved Prompts Sidebar** (left panel): Save/load/duplicate/delete/export/import journey configs. 110+ pre-built + user-saved configs.
- **Service Status Dropdown** (top-right): Live service status with refresh.
- **Dynatrace Settings Modal**: Configure DT environment URL + API token from the UI.

---

## Technical Stack

| Component | Technology |
|-----------|-----------|
| **Runtime** | Node.js v22+ (ESM modules) |
| **Framework** | Express.js 4 + Socket.IO 4 |
| **AI Agents** | TypeScript → compiled to `dist/` |
| **LLM Backend** | Ollama (llama3.2) |
| **Observability** | Dynatrace OneAgent + OpenTelemetry SDK (otel.cjs) |
| **AppEngine UI** | React 18 + Dynatrace Strato components |
| **Auth** | OAuth 2.0 (client_credentials + authorization code) |

---

## Project Structure

```
├── server.js                    # Main application server (~4,700 lines, 100+ endpoints)
├── package.json                 # business-observability-engine
├── otel.cjs                     # OpenTelemetry bootstrap (auto-loaded by child services)
│
├── agents/                      # TypeScript AI agent source
│   ├── nemesis/                 # Chaos injection agent
│   ├── fixit/                   # Auto-remediation agent
│   └── librarian/               # Operational memory agent
├── dist/                        # Compiled TypeScript output
│
├── tools/                       # TypeScript tool libraries
│   ├── chaos/                   # 7 chaos recipes
│   ├── dynatrace/               # DT API wrappers + LLM tool definitions
│   └── fixes/                   # 7 fix type implementations
├── utils/                       # LLM client, config, logger, OpenTelemetry
│
├── routes/                      # 20+ Express route modules
│   ├── journey-simulation.js    # Full journey simulation engine
│   ├── oauth.js                 # Dynatrace OAuth SSO
│   ├── mcp-server.js            # MCP (Model Context Protocol) server
│   ├── ai-dashboard.js          # AI dashboard generation
│   ├── pdf-export.js            # PDF export
│   ├── loadrunner-*.js          # LoadRunner integration
│   └── ...                      # Journey, simulate, metrics, steps, flow, config, proxy
│
├── services/                    # Core service infrastructure
│   ├── service-manager.js       # Dynamic service creation + OTel child spawning
│   ├── dynamic-step-service.cjs # Child service template
│   ├── auto-load.js             # Auto-load watcher
│   ├── port-manager.js          # Port allocation + persistence (8081–8740)
│   ├── service-runner.cjs       # Individual service spawner
│   └── ...                      # Child-caller, event service, metrics service
│
├── middleware/                   # Express middleware
│   └── dynatrace-metadata.js    # DT metadata injection/propagation
│
├── public/                      # Frontend
│   └── index.html               # Single-page UI (~10,800 lines)
│
├── saved-configs/               # 110+ persisted journey configs (pre-built templates + user-saved)
├── dynatrace-monaco/            # Monaco v2 config-as-code project
├── dynatrace-workflows/         # Self-healing workflow JSON
├── dashboards/                  # Saved dashboard presets + generated dashboards
├── data/                        # Field definitions (4800+ lines across all verticals)
├── loadrunner-tests/            # LoadRunner scenarios by industry
├── memory/                      # Vector + history stores for Librarian
├── prompts/                     # AI prompt templates (system context, DQL, dashboards)
├── scripts/                     # Operational scripts (deploy, simulate, autostart)
├── k8s/                         # Kubernetes deployment manifests
├── logs/                        # Application + continuous-generation logs
│
├── .chaos-state.json            # Persisted chaos/feature flag state
├── .dt-credentials.json         # Persisted Dynatrace credentials
└── .port-allocations.json       # Persisted port-to-service mappings
```

---

## API Route Summary

| Mount | Purpose |
|-------|---------|
| `/api/journey-simulation` | Full journey simulation engine |
| `/api/journey` | Journey CRUD |
| `/api/simulate` | Basic simulation |
| `/api/metrics` | Metrics endpoints |
| `/api/steps` | Step management |
| `/api/flow` | Flow visualization |
| `/api/config` | Copilot prompt generation |
| `/api/nemesis` | Nemesis chaos agent API |
| `/api/fixit` | Fix-It remediation agent API |
| `/api/librarian` | Librarian memory agent API |
| `/api/librarian/analyze` | Ollama-powered Librarian Dashboard analysis |
| `/api/ai-dashboard` | AI dashboard generation |
| `/api/pdf` | PDF export |
| `/api/mcp` | MCP (Model Context Protocol) server |
| `/api/autonomous` | Autonomous agent orchestration |
| `/api/workflow-webhook` | Dynatrace workflow webhook receiver |
| `/api/business-flow` | Business flow configuration |
| `/api/loadrunner` | LoadRunner integration |
| `/api/loadrunner-service` | LoadRunner service management |
| `/api/oauth` | Dynatrace OAuth SSO |
| `/api/service-proxy` | Service proxy |
| `/api/feature_flag` | Feature flag management |
| `/api/remediation/*` | Remediation flag management |
| `/api/dt-proxy/*` | Dynatrace API proxy |
| `/api/dynatrace/*` | Dashboard deployment, connection test |
| `/api/admin/*` | Service management, config persistence, credentials |

---

## Management Commands

```bash
./status.sh          # Detailed status report
./stop.sh            # Stop all services
bash update.sh --server   # Pull, rebuild, refresh systemd unit, restart server
sudo systemctl restart bizobs-server.service
```

### One command update (works on any machine/path)

> **No pre-reqs needed.** Just run the update command — you don't need to pre-install Node.js, Docker, or anything else. The script uses whatever's already on your system and pulls the latest code.

```bash
cd /path/to/Business-Observability-Demonstrator && bash scripts/update-any-machine.sh --ui
```

Modes:

```bash
bash scripts/update-any-machine.sh --ui         # AppEngine UI only
bash scripts/update-any-machine.sh --server     # Server only
bash scripts/update-any-machine.sh --all        # Server + AppEngine UI
bash scripts/update-any-machine.sh --no-restart # Pull + build, no restart
```

### In-Place Upgrade Script (no fresh install)

```bash
set -euo pipefail

REPO_DIR="/home/ec2-user/Dynatrace-Business-Observability-Forge"
BRANCH="main"

cd "$REPO_DIR"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
bash scripts/update-any-machine.sh --server
./status.sh
```

```bash
npm start                       # Start server
npm run build:agents            # Compile TypeScript agents
npm run configure:dynatrace     # Deploy DT config via Settings API
npm run configure:monaco        # Deploy DT config via Monaco CLI
```

---

## Demo Walkthrough

### Quick Start (pre-built template)
1. Open the Demonstrator UI → **Home** → pick a template from the **Template Library** (e.g. Healthcare — Patient Care Journey)
2. Click **Run** → services spin up, auto-load generates traffic, Dynatrace lights up
3. Open the **AI Agent Hub** → inject chaos with **Nemesis** → watch **Dynatrace Intelligence** detect it → let **Fix-It** auto-remediate

The 110+ templates are a fast on-ramp — use them for demos, POCs, or to learn how the platform works.

### Custom Journey (the real power)
1. **Describe any customer’s journey** — e.g. “A patient registers, gets triaged, sees a consultant, receives treatment, and is discharged”
2. **Or use AI to research it** — ask Copilot/Gemini about a customer’s real business flow, paste the output into the Demonstrator
3. The Demonstrator generates the full config: services, substeps, business metadata (revenue, KPIs, churn risk)
4. **Run it** → real microservices, real traffic, real Dynatrace telemetry — tailored to *that* customer’s operations
5. **Demo it** → chaos injection → Dynatrace Intelligence detection → AI remediation → revenue impact dashboard

This is what makes the Demonstrator different: it’s not a canned demo. It’s *their* business, running live in Dynatrace.

---

**Built on Dynatrace SaaS — Grail, DPS & Dynatrace Intelligence**
Demonstrating advanced business observability with AI-powered chaos engineering and automated remediation.
