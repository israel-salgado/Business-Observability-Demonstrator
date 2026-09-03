# Technical Guide — Business Observability Demonstrator (v2.38.9)

> A hands-on guide for engineers, SEs, and developers who want to get the platform running and understand what's under the hood.

> **Want the fast path?** Just run `sudo ./setup.sh` — it walks you through 7 guided prompts and does everything automatically. This guide explains what the script does and how to do it manually.

---

## What Is This?

The Business Observability Demonstrator is a two-part system:

1. **The Demonstrator** — A Node.js server that dynamically spawns microservices, simulates customer journeys, runs AI agents for chaos injection and auto-remediation, and provides an AI-powered journey generation pipeline via GitHub Models.
2. **The Demonstrator UI** — A Dynatrace AppEngine app (React + Strato) that gives you a single-pane-of-glass inside Dynatrace to control everything, with two distinct pathways: **AI-powered** (GitHub Models) and **Manual** (copy/paste prompts).

The Demonstrator runs on your host (EC2, VM, Codespace). The Demonstrator UI runs inside Dynatrace and talks to the Demonstrator through an **EdgeConnect** tunnel.

---

<details>
<summary><h2>Architecture Overview</h2></summary>


```
┌──────────────────────────────────────────────────────────────────┐
│                    Dynatrace Platform                            │
│                                                                  │
│  ┌──────────────────────────┐   ┌───────────────────────────┐    │
│  │  Business Observability  │   │  Services / BizEvents /   │    │
│  │  Demonstrator UI (AppEngine)    │   │  Dashboards / Problems    │    │
│  └──────────┬───────────────┘   └───────────────────────────┘    │
│             │ EdgeConnect Tunnel                  ▲              │
│             │ (HTTPS → port 8080)                 │ OneAgent +   │
│             │                                     │ OTLP         │
└─────────────┼─────────────────────────────────────┼──────────────┘
              │                                     │
              ▼                                     │
┌──────────────────────────────────────────────────────────────────┐
│  Your Host (EC2 / VM / Codespace)                                │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  Main Server (port 8080) — Express.js + Socket.IO        │    │
│  │  ├── 20+ API route modules (100+ endpoints)              │    │
│  │  ├── AI Generation Pipeline (GitHub Models proxy)        │    │
│  │  ├── AI Agents: Nemesis (chaos), Fix-It (remediation),   │    │
│  │  │     Librarian (memory/audit), Dashboard (BI deploy)   │    │
│  │  ├── Feature Flag Manager (per-service isolation)        │    │
│  │  ├── Journey Simulation Module                           │    │
│  │  ├── MCP Server + PDF Export + Workflow Webhooks         │    │
│  │  └── Dynatrace Event Ingestion + DT API Proxy            │    │
│  └──────────────────────────────────────────────────────────┘    │
│                          │                                       │
│              spawns child processes (with --require otel.cjs)   │
│                          ▼                                       │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  Dynamic Child Services (ports 8081–8740, 660 ports)     │    │
│  │  Each = separate Node.js process with:                   │    │
│  │  ├── Own Express server + /health endpoint               │    │
│  │  ├── OpenTelemetry auto-instrumentation (otel.cjs)       │    │
│  │  ├── Dynatrace OneAgent identity (unique DT_TAGS)        │    │
│  │  ├── Per-service feature flags from main server          │    │
│  │  └── Service-to-service call chaining                    │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌────────────────┐  ┌───────────┐  ┌────────────────────┐       │
│  │  EdgeConnect   │  │  OneAgent │  │  Ollama (LLM)      │       │
│  │  (tunnel)      │  │           │  │  llama3.2:1b       │       │
│  └────────────────┘  └───────────┘  └────────────────────┘       │
└──────────────────────────────────────────────────────────────────┘
```

</details>

---

<details>
<summary><h2>Prerequisites</h2></summary>

Before you start, make sure you have **all of these** ready. Items marked with ⚙️ are **installed automatically** by `sudo ./setup.sh` — you don't need to install them yourself.

| # | Component | Version | Why You Need It | How To Check |
|---|-----------|---------|-----------------|--------------|
| 1 | **Dynatrace Tenant** | Sprint or Managed | Receives all telemetry | You should have a `*.sprint.dynatracelabs.com` or `*.live.dynatrace.com` URL |
| 2 | **Dynatrace API Token** | — | Demonstrator server sends events to DT | Create in DT: Settings → Access Tokens → Generate. Scopes: `events.ingest`, `metrics.ingest`, `openTelemetryTrace.ingest`, `entities.read` |
| 3 | **EdgeConnect OAuth Client** | — | Authenticates the EdgeConnect tunnel | Create in DT: Settings → General → External Requests → Add EdgeConnect. DT generates the OAuth client ID, secret, and resource. |
| 4 | **AppEngine Deploy OAuth Client** | — | Deploys the Demonstrator UI to Dynatrace AppEngine | Create in Account Management → IAM → OAuth clients. Scopes: `app-engine:apps:install`, `app-engine:apps:run`. Can reuse the EdgeConnect client if you add these scopes to it. |
| 5 | **EC2 / VM / Host** | Linux recommended | Runs the Demonstrator server | SSH access, ports 8080–8200 open in Security Group (inbound not strictly required — EdgeConnect tunnels inbound) |
| 6 | ⚙️ **Node.js** | v22+ | Server runtime — **installed by setup.sh** | `node --version` |
| 7 | ⚙️ **Docker** | Latest | Runs EdgeConnect — **installed by setup.sh** | `docker --version` |
| 8 | **Dynatrace OneAgent** | Latest | Auto-instruments every child service | `sudo systemctl status oneagent` or check Hosts in DT UI |
| 9 | **Ollama** | Latest | Powers AI agents (Nemesis, Fix-It, Librarian) and dashboard generation | `ollama list` → should show `llama3.2:1b` |
| 10 | **GitHub PAT** | — | Powers AI journey generation (GitHub Models) | Configure in Demonstrator UI → Settings → Copilot tab |

### Recommended Server Size

Use these sizes as a practical baseline for this app:

| Deployment Profile | vCPU | RAM | Storage | Notes |
|---|---:|---:|---:|---|
| **Minimum (demo / light use)** | 2 | 8 GB | 40 GB SSD | Good for short demos and low concurrency |
| **Recommended (default for customer demos)** | 4 | 16 GB | 80 GB SSD | Best balance for journey simulation + AI features + OTel export |
| **High-load (multiple concurrent users/journeys)** | 8 | 32 GB | 120 GB SSD | Use when running many child services and frequent AI generation |

**Default recommendation:** use at least **4 vCPU / 16 GB RAM / 80 GB SSD**.

**If using local Ollama heavily:** prioritize RAM. For larger local models, plan for **24–32 GB RAM**.

> **Don't have a Dynatrace API Token yet?** Stop here and create one. Nothing will work without it.

**✅ What you MUST have before setup:**
- Items 1–5 (Dynatrace tenant, credentials, host with SSH access)
- Item 8 (OneAgent — usually pre-installed on production hosts, but optional for demos)
- Items 9–10 (optional — Ollama and GitHub PAT for AI features)

**❌ What you DON'T need to install beforehand (setup.sh handles it):**
- ⚙️ **Node.js** — setup.sh installs v22+ automatically
- ⚙️ **Docker** — setup.sh installs automatically  
- **Don't pre-install these** — setup.sh knows exactly what version to use

Just start with `sudo ./setup.sh` and it will install everything else for you.

</details>

---

<details>
<summary><h2>Getting Started</h2></summary>

Follow these steps **in order**. Each step depends on the one before it.

```
Step 1: Clone & Install            ← Get the code (single unified repo)
Step 2: Create DT Credentials      ← A: API Token + B: DT Platform Token + C: OAuth Clients
Step 3–5: sudo ./setup.sh               ← Handles EdgeConnect, app deploy, build, and server start
Step 6: Configure from Demonstrator UI    ← Wire everything together (private IP + Get Started checklist)
```

> **Shortest path:** Do Steps 1–2, then just run `sudo ./setup.sh` — it walks you through 7 guided prompts and does Steps 3–5 automatically.

---

### Step 1: Clone & Setup

This is a **single unified repo** — it contains both the Demonstrator (server) and the Demonstrator UI (AppEngine app).

```bash
sudo git clone https://github.com/israel-salgado/Business-Observability-Demonstrator.git
cd Business-Observability-Demonstrator
sudo chmod +x setup.sh
sudo ./setup.sh
```

The `setup.sh` script will walk you through 7 guided prompts and handle everything automatically: npm install, credential configuration, EdgeConnect setup, AppEngine deploy, and server startup.

**Verify:** The script ends with a green "All done" message and the server running on port 8080.

---

### Step 2: Create Dynatrace Credentials

You need **3–4 credentials** — an API Token, a DT Platform Token for dtctl dashboard deployment, an EdgeConnect OAuth Client, and optionally a separate Deploy OAuth Client:

| # | Credential | Type | Where To Create | What Uses It |
|---|-----------|------|----------------|---------------|
| A | **API Token** | `dt0c01.*` | Dynatrace tenant → Settings → Access Tokens | The **Demonstrator server** uses this to send events/metrics to Dynatrace |
| B | **DT Platform Token (dtctl)** | `dt0s16.*` (recommended) | Dynatrace tenant token UI (platform token) | **Bespoke dashboard deployment via dtctl** (`/api/ai-dashboard/deploy-dtctl`) |
| C | **EdgeConnect OAuth** | `dt0s10.*` or `dt0s02.*` | Dynatrace tenant → Settings → General → External Requests → EdgeConnect | **EdgeConnect** (tunnel). Can also be used for deploy if you add the right scopes. |
| D | **Deploy OAuth**  | `dt0s10.*` or `dt0s02.*` | Separate client from Account Management → IAM → OAuth clients | **`dt-app deploy`** (app deployment to Dynatrace AppEngine) |

For credential B (DT Platform Token used by dtctl), required scopes are:
- `document:documents:write`
- Recommended: `document:documents:read`
- Optional (only if you want environment-wide sharing): `document:environment-shares:write`

---

#### Credential A: API Token (for the Demonstrator server)

**Create it in Dynatrace:**
1. Go to your Dynatrace tenant
2. Settings → Access Tokens → **Generate new token**
3. Name: `BizObs Demonstrator`
4. Add these scopes:
   - `events.ingest`
   - `metrics.ingest`
   - `openTelemetryTrace.ingest`
   - `entities.read`
5. Click **Generate** → **copy the token** (you can't see it again)
> 📸 **Screenshot: Access Tokens Page** 
![Step 2 – Access Tokens](Screenshots/Step2-AccessTokens.png)
> **You don't need to save this to a file.** `setup.sh` will ask for this token and create `.dt-credentials.json` automatically.

---

#### Credential B: EdgeConnect OAuth Client

This client is used for the EdgeConnect tunnel. Depending on your tenant, it may generate a `dt0s10.*` (environment-level) or `dt0s02.*` (account-level) client.

**Create it in Dynatrace:**
1. Go to your Dynatrace tenant
2. **Settings → General → External Requests**
3. Click **Add EdgeConnect** (or select an existing one)
4. Name it (e.g. `bizobs-demonstrator`) — **remember this name, it must match what the script generates**
5. DT will generate the OAuth credentials for you and show:
   - **OAuth client ID**: `dt0s10.XXXXX` or `dt0s02.XXXXX`
   - **OAuth client secret**: shown only once!
   - **OAuth client resource**: `urn:dtenvironment:YOUR_TENANT_ID`
6. **Click "Download edgeConnect.yaml"** — this gives you a pre-filled YAML with all the values

![Step 6 – EdgeConnect](Screenshots/edgeconnect-setup.png)
![Step 6 – EdgeConnect](Screenshots/edgeconnect-secure.png)


> **Important:** The client secret is only shown once. Copy it or download the YAML immediately.

**Optionally, make this same client work for deploy too:**
1. Go to **Account Management** → **Identity & Access Management** → **OAuth clients**
2. Click **Create Client**
3. Input your **email address** and the description **Business Observability Demonstrator App Install**
4. **Add these scopes**:
   - `app-engine:apps:install` (required to deploy the app)
   - `app-engine:apps:run` (required to run the app)
5. Save
![Step 6 – AppEngine](Screenshots/oAuth-appengine.png)
![Step 6 – AppEngine](Screenshots/oAuth-appengine-final.png)


> **If you can't add deploy scopes** (e.g. the client type doesn't allow it), use a separate account-level OAuth client for deploy. `setup.sh` will ask at prompt 6/6.

---

### Steps 3–5: Deploy Everything

> **Using `sudo ./setup.sh`?** It handles all of this automatically. The steps below are only needed if you're doing a manual setup.

<details>
<summary><strong>Manual Steps 3–5 (click to expand — not needed if you ran sudo ./setup.sh)</strong></summary>

If you prefer to do things manually instead of `sudo ./setup.sh`:

```bash
# 1. Copy the EdgeConnect YAML downloaded from DT External Requests page
#    (or edit edgeconnect/edgeConnect.yaml with your OAuth client values)
cp ~/Downloads/edgeConnect.yaml edgeconnect/edgeConnect.yaml

# 2. Start EdgeConnect tunnel
sudo bash edgeconnect/run-edgeconnect.sh

# 3. Deploy Demonstrator UI (setup.sh passes creds automatically;
#    for manual deploy, re-run: ./setup.sh)
sudo npx dt-app deploy

# 4. Build agents & start server
sudo npm run build:agents
sudo npm start
```

> **Note:** `npx dt-app deploy` requires OAuth credentials in the environment. The easiest way is to run `sudo ./setup.sh` which sets them automatically. If you must deploy manually, export the deploy credentials:
> ```bash
> source setup.conf
> export DT_APP_OAUTH_CLIENT_ID="$DEPLOY_OAUTH_CLIENT_ID"
> export DT_APP_OAUTH_CLIENT_SECRET="$DEPLOY_OAUTH_CLIENT_SECRET"
> sudo npx dt-app deploy
> ```

</details>

**Verify:**
```bash
curl http://localhost:8080/api/health
```

You should get:
```json
{"status":"ok","timestamp":"...","mainProcess":{"pid":...,"uptime":...,"port":8080},"childServices":[]}
```

The `childServices` array is empty — that's correct. **No services are spawned by default.** The server sits idle until you launch a journey from the Demonstrator UI.

> **Want it to run in the background?** Use:
> ```bash
> sudo nohup npm start > server.log 2>&1 &
> echo $! > server.pid
> ```
> Or set it up as a systemd service for auto-restart on reboot.

---

### Step 6: Configure from the Demonstrator UI

Open the Demonstrator app in Dynatrace (**Apps → Business Observability Demonstrator**).

**6a. Go to Settings (gear icon) → Config tab:**

| Field | Value | Example |
|-------|-------|---------|
| Protocol | `HTTP` | (not HTTPS — the server runs plain HTTP) |
| Host / IP Address | Your **private IP** | `***.**.**.**` |
| Port | `8080` | |

Click **Save**, then click **Test**.

![For Ui - Settings](Screenshots/demonstrator_ui-settings.png)

> **If the test fails:**
> - Make sure the Demonstrator server is running (Step 5)
> - Make sure EdgeConnect is running and connected (Step 3c)
> - Make sure you're using the **private IP**, not the public Elastic IP
> - Wait 15 seconds and try again (EdgeConnect routing can take a moment to propagate)

**6b. Go to Settings → EdgeConnect tab:**

If EdgeConnect is already running (Step 3), you should see a green "EdgeConnect Connected" status. The host pattern should show your **private IP**.

If it shows your public IP, click the EdgeConnect tab and update the **Host Pattern / Server IP** to your private IP.

**6c. Go to Settings → Get Started tab:**

This is a checklist that auto-detects your setup and lets you deploy Dynatrace configuration with one click per step:

| Step | What It Does | What To Do |
|------|-------------|------------|
| **Configure Server IP** | Set the IP/hostname of your Demonstrator server | Should be green if you did 7a |
| **Create EdgeConnect** | Registers EdgeConnect config in Dynatrace | Should be green if you did Step 3 |
| **Deploy EdgeConnect** | Instructions for running EdgeConnect on your host | Should be green if EdgeConnect is up |
| **Verify EdgeConnect Online** | Polls DT to confirm tunnel is active | Should be green if Step 3c passed |
| **OneAgent Installed** | Verifies OneAgent is reporting from your host | Green if OneAgent is running |
| **Test Connection** | Pings the Demonstrator server through the EdgeConnect tunnel | Click to test — should go green |
| **OpenPipeline Pipeline** | Creates the BizEvents processing pipeline | Click **Deploy** |
| **OpenPipeline Routing** | Configures routing rules for business events | Click **Deploy** |
| **Business Event Capture Rule** | Deploys capture rules for OneAgent | Click **Deploy** |
| **OneAgent Feature Flags** | Enables required OneAgent feature flags | Click **Deploy** |

Work through from top to bottom. Each green checkmark means that step is configured correctly.
![For Ui - Settings](Screenshots/getting-started-checklist.png)

**Once all steps are green, you're ready.** Go to the **Home** tab, pick a template from the Template Library, and click **Run** to launch your first journey simulation.

</details>

---

<details>
<summary><h2>How It Works</h2></summary>

### Journey Simulation Flow

```
1. User picks a template (e.g. "Healthcare Provider — Patient Care Journey")
   or enters custom company details
                    │
                    ▼
2. Demonstrator spawns child services (one per journey step)
   e.g. PatientRegistrationService (port 8081)
        TriageAndAssessmentService (port 8082)
        ClinicalConsultationService (port 8083)
        ...
                    │
                    ▼
3. Auto-load generates continuous traffic
   - Random customer profiles
   - Realistic timing between steps
   - OneAgent captures each request as a bizevent
                    │
                    ▼
4. Dynatrace sees:
   - Services in Smartscape topology
   - Business events in BizEvents
   - Traces with full distributed context
   - Custom properties (company, industry, step, revenue, etc.)
```

### The Template Library

110+ pre-built industry journey templates across 55+ verticals in 11 categories:

| Category | Verticals |
|----------|----------|
| **Financial Services** | Banking, Insurance, Financial Services, Payments |
| **Healthcare & Life Sciences** | Healthcare, Pharmaceuticals, Veterinary |
| **Technology** | Cybersecurity, Data Centre, Gaming, Robotics, Semiconductor, Social Media |
| **Retail & Consumer** | Retail, Fashion, Beauty, Food & Beverage, Marketplace |
| **Energy & Utilities** | Energy, EV, Water, Waste, Mining |
| **Transport & Logistics** | Airlines, Logistics, Shipping, Rail, Ride-Hailing, Delivery |
| **Manufacturing & Industrial** | Manufacturing, Industrial, Chemical, Construction |
| **Media & Entertainment** | Media, Music, Publishing, Sports, Lottery |
| **Professional Services** | Consulting, Legal, HR, Advertising, Nonprofit |
| **Government & Public** | Government, Defence, Smart City, ESG |
| **Real Estate & Hospitality** | Real Estate, Hospitality, Space, Agriculture, Fitness |

Each vertical includes 2 pre-built demo journeys. Each template includes: company name, domain, industry type, journey steps with substeps, business metadata (revenue, category, KPIs), and customer profiles.

![For Ui - Settings](Screenshots/template-library.png)


### Per-Service Chaos Injection

Chaos is injected through **feature flags**, not by killing processes:

```
┌──────────────────────┐     GET /api/feature_flag?service=X     ┌─────────────┐
│  Child Service       │ ──────────────────────────────────────► │ Main Server │
│  (port 8082)         │ ◄────────────────────────────────────── │ (port 8080) │
│                      │     { errors_per_transaction: 0.8 }     │             │
│  if (Math.random()   │                                         │ Feature     │
│    < errorRate)      │                                         │ Flag Store  │
│    throw Error()     │                                         └─────────────┘
└──────────────────────┘
```

The Nemesis agent (Nemesis) sets error rates on specific services. Each service polls its own flags from the main server. Only the targeted service sees elevated errors — everything else stays healthy.

7 chaos recipes:
- `enable_errors` — Set error rate (10%–100%)
- `increase_error_rate` — Ramp up existing errors
- `slow_responses` — Add latency
- `disable_circuit_breaker` — Remove resilience
- `disable_cache` — Force cache misses
- `target_company` — Target all services for one company
- `custom_flag` — Set any arbitrary flag

### AI Agent Architecture

```
┌─────────────┐    injects chaos    ┌────────────────┐
│  Nemesis     │ ──────────────────► │ Feature Flags  │
│  (Chaos)     │                     │ (per-service)  │
└──────┬───────┘                     └────────────────┘
       │ records to                          │
       ▼                                     │ errors propagate
┌─────────────┐                              ▼
│  Librarian   │ ◄─── records ────── ┌────────────────┐
│  (Memory)    │                     │ Dynatrace      │
└──────┬───────┘                     │ (Problems,     │
       │ provides context            │  BizEvents)    │
       ▼                             └───────┬────────┘
┌─────────────┐    queries DT API            │
│  Fix-It      │ ◄──────────────────────────┘
│  (Remediate) │
│              │ ── resets flags ──► Feature Flags
│              │ ── sends event ──► Dynatrace
└──────────────┘
```

All agents use **LLM function calling** (via Ollama llama3.2:1b) to decide what actions to take, with rule-based fallbacks when Ollama is unavailable. The Librarian provides persistent memory so agents can learn from past incidents.

#### Librarian Dashboard

The Librarian agent also powers the **Librarian Dashboard** — a modal overlay on the Demonstrator Dashboards page (📚 button). When opened, it:

1. Fetches all history events and vector store stats from the backend
2. Sends the condensed timeline to Ollama for SRE-style analysis (with a 65-second `Promise.race` timeout)
3. Renders: AI Summary, colour-coded Stats Cards, severity-tagged Insights, Detected Patterns, and a scrollable Event Timeline
4. Falls back to raw-data analysis when Ollama is cold or unavailable

Backend endpoints: `GET /api/librarian/history`, `GET /api/librarian/stats`, `POST /api/librarian/analyze`.

### Dynatrace Event Ingestion

Every chaos injection and remediation action sends a `CUSTOM_DEPLOYMENT` event to Dynatrace:

```json
{
  "eventType": "CUSTOM_DEPLOYMENT",
  "title": "💥 Chaos Injection: enable_errors on CheckInAndRegistrationService",
  "entitySelector": "type(SERVICE),entityName.contains(\"CheckInAndRegistrationService\")",
  "properties": {
    "change.type": "chaos-injection",
    "chaos.id": "chaos-1772608582260-3",
    "chaos.type": "enable_errors",
    "chaos.target": "CheckInAndRegistrationService",
    "deployment.source": "nemesis-agent",
    "dt.event.is_rootcause_relevant": "true"
  }
}
```

These events appear as deployment markers on the affected service in Dynatrace, enabling root cause correlation with Dynatrace Intelligence.

</details>

---

<details>
<summary><h2>Key API Endpoints</h2></summary>

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/health` | GET | Server health + child service list |
| `/api/journey-simulation/simulate-journey` | POST | Launch a journey simulation |
| `/api/admin/services/status` | GET | All service statuses |
| `/api/admin/services/restart-all` | POST | Restart all core services |
| `/api/gremlin/inject` | POST | Inject chaos into a service |
| `/api/gremlin/active` | GET | List active chaos faults |
| `/api/gremlin/revert/:faultId` | POST | Revert a specific fault |
| `/api/gremlin/revert-all` | POST | Revert all active faults |
| `/api/feature_flag` | GET/POST | Read/set feature flags |
| `/api/nemesis/*` | POST | Nemesis AI agent endpoints |
| `/api/fixit/*` | POST | Fix-It AI agent endpoints |
| `/api/librarian/*` | GET/POST | Librarian memory endpoints |
| `/api/librarian/analyze` | POST | Ollama-powered history analysis (Librarian Dashboard) |
| `/api/ai-generate/github` | POST | AI journey generation via GitHub Models |
| `/api/ai-generate/models` | GET | Available AI models list |
| `/api/ai-dashboard/*` | POST | AI-generated DQL dashboard deployment |
| `/api/pdf/*` | POST | PDF export of dashboards |
| `/api/mcp/*` | Various | MCP (Model Context Protocol) server endpoints |
| `/api/autonomous/*` | POST | Autonomous agent orchestration |
| `/api/workflow-webhook/*` | POST | Dynatrace workflow webhook receiver |
| `/api/business-flow/*` | GET/POST | Business flow configuration |
| `/api/dt-proxy/*` | GET | Proxy to Dynatrace APIs |

</details>

---

<details>
<summary><h2>Demonstrator UI Pages (AppEngine)</h2></summary>

The Dynatrace AppEngine app has 8 routes:

| Page | Route | Purpose |
|------|-------|---------|
| **Home** | `/` | Welcome page with two pathways (AI-powered / Manual), Customer Details, Journey Builder, Active Journeys, Nemesis Chaos modal |
| **Services** | `/services` | Live service dashboard with start/stop controls per company (accessible via direct URL) |
| **Chaos Control** | `/chaos` | Select a service, pick a chaos type, inject — with live active faults list |
| **Fix-It Agent** | `/fixit` | Trigger automated diagnosis and remediation |
| **Demonstrator Dashboards** | `/demonstrator-dashboards` | DQL-powered dashboard presets (Security, DI, Infra, etc.) + Librarian modal overlay for AI-driven incident analysis |
| **Settings** | `/settings` | Configure server IP, API tokens, EdgeConnect credentials |
| **Demo Guide** | `/demo-guide` | Interactive walkthrough paths for demos (Quick Start, Chaos & Fix-It, Traces, Platform, LiveDebugger) |
| **Solutions** | `/solutions` | 55+ industry verticals with Dynatrace capability mapping, clickable demo journeys |

> **Note:** The Home page has two separate pathways from the Welcome screen:
> - **AI Pathway** (requires GitHub PAT): Welcome → Customer Details → Generate with AI (automated pipeline with journey picker)
> - **Manual Pathway**: Welcome → Customer Details → Generate Prompts (copy/paste to external AI)
>
> The AI pathway card is greyed out if no GitHub PAT is configured. Clicking it opens Settings → Copilot tab. Chaos control is also accessible via the Nemesis modal on the Home page. Active Journeys shows running services and their status.

> 📸 **Screenshot: Chaos Control Page** — *The Demonstrator UI Chaos Control page showing: the service selector dropdown with a healthcare service selected, the chaos type picker (enable_errors, slow_responses, etc.), the intensity slider, and below it the "Active Faults" list showing one or two injected faults with their target service, type, and a "Revert" button.*

### Home Page Flow

```
Welcome Tab (Two Pathways)
     │
     ├── AI Pathway (GitHub Models — requires GitHub PAT)
     │   └── Customer Details → Generate with AI
     │       ├── Automated pipeline: C-Suite prompt → Journey extraction
     │       ├── Journey Picker Modal (select from AI-suggested journeys)
     │       ├── Journey-specific prompt generation → AI completion
     │       ├── Auto-parse response → populate config → launch simulation
     │       └── 🔍 "View AI Prompts in Dynatrace" link (AI Observability)
     │
     ├── Manual Pathway (no AI required)
     │   └── Customer Details → Generate Prompts
     │       ├── Copy generated prompts to external AI (ChatGPT, etc.)
     │       ├── Paste AI response back → parse → populate config
     │       └── Launch simulation
     │
     ├── Template Library sidebar (left panel)
     │   ├── 110+ pre-built industry templates (55+ verticals)
     │   ├── Search/filter by industry
     │   ├── Click to load → auto-populates all fields
     │   ├── Export/Import configs (JSON)
     │   └── Save custom configs
     │
     └── Get Started checklist (persisted to DT settings)
         ├── Auto-detects EdgeConnect, OneAgent, OpenPipeline status
         ├── One-click Deploy buttons for each DT config
         └── Progress tracked across sessions
```

</details>

---

<details>
<summary><h2>Persistence</h2></summary>

| File | Contents | Survives Restart? |
|------|----------|-------------------|
| `.chaos-state.json` | Active chaos/feature flag overrides | ✅ |
| `.port-allocations.json` | Service → port mappings | ✅ |
| `.dt-credentials.json` | DT environment URL + API token | ✅ |
| `saved-configs/*.json` | Journey templates + user configs | ✅ |
| `memory/` | Librarian vector + history stores | ✅ |
| `dashboards/saved/*.json` | Saved dashboard preset configurations (31 presets) | ✅ |
| `data/field-repo.json` | Field definitions across all verticals (4800+ lines) | ✅ |

</details>

---

<details>
<summary><h2>Troubleshooting</h2></summary>

| Symptom | Cause | Fix |
|---------|-------|-----|
| **"Cannot reach X.X.X.X:8080"** on Config tab | You're using the **public** Elastic IP | Change to your **private IP** (`hostname -I \| awk '{print $1}'`). AWS doesn't support NAT hairpin — see Step 6a |
| **EdgeConnect shows offline** | OAuth creds wrong, name mismatch, or EdgeConnect not running | Check `sudo docker logs edgeconnect-bizobs`. The `name:` in `edgeConnect.yaml` must match the EdgeConnect name in DT UI (e.g. `bizobs-demonstrator`). Re-run `sudo ./setup.sh`. Double-check `client_id`, `client_secret`, `resource` in YAML (Step 2B → Step 3a) |
| **Test connection fails but EdgeConnect is green** | Server not running, or host pattern not registered | 1) Verify server: `curl http://localhost:8080/api/health` 2) Wait 15s and retry (propagation delay) 3) Ensure private IP is the host pattern |
| **No services in Dynatrace** | OneAgent not installed or feature flags not enabled | Run Get Started checklist in Demonstrator UI — deploy OneAgent Feature Flags step |
| **Demonstrator UI shows "Connection failed"** | Server IP not configured or EdgeConnect not tunneling | Settings → Config tab → set private IP + Test. Settings → EdgeConnect tab → verify green |
| **Chaos injection sends 200+ events** | `entitySelector` too broad (old bug) | Fixed in v2.9.10+ — now scoped to target service name |
| **AI agents don't respond** | Ollama not running or model not pulled | `ollama pull llama3.2:1b` and `curl http://localhost:11434/api/tags` to verify |
| **AI generation fails** | GitHub PAT not configured or expired | Configure in Demonstrator UI → Settings → Copilot tab. Ensure PAT has access to GitHub Models |
| **`npx dt-app deploy` fails** | Missing credentials, wrong scope, or wrong directory | Re-run `sudo ./setup.sh` (it sets credentials automatically). Ensure the OAuth client has `app-engine:apps:install` + `app-engine:apps:run` scopes (Step 2B). Run from project root, not `edgeconnect/` |
| **Settings won't save (400 error)** | Sprint environment app-settings API limitation | App falls back to localStorage automatically — safe to ignore |
| **`api_endpoint_host` rejected** | Using tenant URL instead of AppEngine URL | Use `YOUR_TENANT.sprint.apps.dynatracelabs.com` (with `.apps.`), not `YOUR_TENANT.sprint.dynatracelabs.com` |

</details>

---

<details>
<summary><h2>Full Removal & Reinstall</h2></summary>

To completely remove the Demonstrator from a host and start fresh, use the included `uninstall.sh` script.

### Uninstall (keep Ollama)

```bash
cd /home/ec2-user/Business-Observability-Demonstrator
sudo bash uninstall.sh
```

### Uninstall (remove everything including Ollama)

```bash
cd /home/ec2-user/Business-Observability-Demonstrator
sudo bash uninstall.sh --all
```

### What the uninstall does

| Step | Action |
|------|--------|
| 1 | Stops the BizObs server (PID file + process kill) |
| 2 | Stops & removes the EdgeConnect Docker container and image |
| 3 | Removes the log-cleanup cron job |
| 4 | *(Optional with `--all`)* Stops & removes Ollama and its models |
| 5 | Deletes the entire project directory |

### Reinstall from Git

After uninstalling, clone and run setup:

```bash
cd /home/ec2-user
sudo git clone https://github.com/israel-salgado/Business-Observability-Demonstrator.git
cd Business-Observability-Demonstrator
sudo ./setup.sh
```

The `setup.sh` script will prompt for your Dynatrace credentials and handle everything: Node.js, npm install, EdgeConnect, AppEngine deploy, and server startup.

> **Tip:** If you saved a `setup.conf` previously, copy it into the new clone before running `sudo ./setup.sh` to skip credential prompts.

</details>

---

<details>
<summary><h2>Log Housekeeping</h2></summary>

The Demonstrator includes automatic log rotation to prevent disk fills.

### Manual cleanup

```bash
sudo bash scripts/log-cleanup.sh
```

### Install daily cron (runs at 3 AM)

```bash
sudo bash scripts/log-cleanup.sh --install
```

### Remove the cron job

```bash
sudo bash scripts/log-cleanup.sh --uninstall
```

### What it cleans

| Target | Action |
|--------|--------|
| `logs/server.log` | Rotated when >50MB, keeps 3 compressed backups |
| Root `server.log` | Removed (legacy path, should not exist) |
| `dist/logs/agents.log` | Truncated when >50MB |
| `~/.npm/_logs/` | Debug logs older than 7 days deleted |

</details>

---

<details>
<summary><h2>Updating</h2></summary>

To update the Demonstrator after code changes without a full reinstall, use the included `update.sh` script.

> **Note:** The update commands pull the latest code and redeploy. You don't need to re-install Node.js, Docker, or any dependencies — the update script handles everything. Just run the command and it will use whatever versions and tools are already on your machine.

### Simplest command (any machine/path)

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

### In-place upgrade (recommended, no fresh install)

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

### Update everything (server + AppEngine UI)

```bash
sudo bash update.sh
```

### Server-side only (skip AppEngine deploy)

```bash
sudo bash update.sh --server
```

### AppEngine UI only (hot deploy — users don't need to restart)

```bash
sudo bash update.sh --ui
```

### Pull + build without restarting

```bash
sudo bash update.sh --no-restart
```

### What the update does

| Step | Action | Flag to skip |
|------|--------|--------------|
| 1 | `git pull` from configured remote (stashes local changes first) | — |
| 2 | `npm install` (only if package.json changed) | — |
| 3 | Compile TypeScript agents (`npm run build:agents`) | `--ui` |
| 4 | Stop → start server (with log rotation) | `--ui` or `--no-restart` |
| 5 | `npx dt-app build && npx dt-app deploy` (reads setup.conf for OAuth creds) | `--server` |

> **AppEngine deploys are hot** — the app updates in Dynatrace immediately. Users just refresh the page; no need to restart anything.

</details>

---

<details>
<summary><h2>Tech Stack Summary</h2></summary>

| Layer | Technology |
|-------|-----------|
| Server Runtime | Node.js v22+ (ESM), Express.js 4, Socket.IO 4 |
| AI Generation | GitHub Models API (GPT-4.1, Claude Sonnet 4, o4-mini) via server-side proxy |
| AI Agents | TypeScript → compiled to `dist/`, LLM via Ollama (llama3.2:1b) with rule-based fallbacks |
| AppEngine UI | React 18, Dynatrace Strato components, TypeScript |
| Observability | Dynatrace OneAgent + OpenTelemetry SDK |
| Config-as-Code | Monaco v2 (Settings API deployment) |
| Tunnel | Dynatrace EdgeConnect |
| Auth | OAuth 2.0 (client_credentials), API Token |

</details>

---

<details>
<summary><h2>OpenTelemetry (OTel) in Child Services</h2></summary>

Child services are spawned with `--require otel.cjs` so they get full OpenTelemetry auto-instrumentation from startup. Each child process receives its own `OTEL_SERVICE_NAME` environment variable matching its Dynatrace service name, ensuring traces appear under the correct service identity in Dynatrace.

The `otel.cjs` bootstrap:
- Registers `HttpInstrumentation` and `UndiciInstrumentation` for all HTTP and native-fetch calls
- Tags Ollama spans with `gen_ai.*` semantic conventions (`gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.response.model`)
- Uses OTLP/HTTP exporter to send traces to the local OneAgent endpoint

</details>

---

<details>
<summary><h2>Additional Assets</h2></summary>

| File | Purpose |
|------|--------|
| `PARTNER-EVENT-TALK-TRACK-AND-DEMO.md` | 8-section partner event demo guide |
| `Business-Observability-Demonstrator-Partner-Event.pptx` | 16-slide, 16:9 partner presentation |
| `generate-partner-ppt.py` | Python script to regenerate the PowerPoint deck |
| `BUSINESS-GUIDE.md` | Business perspective and value proposition |

</details>

---

*For the business perspective and demo walkthrough, see [BUSINESS-GUIDE.md](BUSINESS-GUIDE.md).*
