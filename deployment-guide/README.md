# Business Observability Demonstrator — Deployment Guide

> **Version:** 2.9.28 · **Last updated:** February 2026
>
> Deploy the full Business Observability Demonstrator: Node.js server with Ollama AI, OpenTelemetry instrumentation (traces, metrics, logs), the Dynatrace AppEngine UI, and EdgeConnect tunnel — all connected to your Dynatrace environment.

---

## Architecture Overview

```
                         ┌──────────────────────────────────┐
                         │        Dynatrace Platform        │
                         │                                  │
                         │  ┌────────────────────────────┐  │
                         │  │   AppEngine UI (React)     │  │
                         │  │   "Business Observability  │  │
                         │  │    Demonstrator" in Apps menu      │  │
                         │  └─────────┬──────────────────┘  │
                         │            │ HTTP via EdgeConnect │
                         │  ┌─────────▼──────────────────┐  │
                         │  │     EdgeConnect Tunnel      │  │
                         │  └─────────┬──────────────────┘  │
                         │            │                     │
                         │  ┌─────────▼──────────────────┐  │
                         │  │   OTLP Ingest              │  │
                         │  │   /api/v2/otlp/v1/traces   │  │
                         │  │   /api/v2/otlp/v1/metrics  │  │
                         │  │   /api/v2/otlp/v1/logs     │  │
                         │  └────────────────────────────┘  │
                         └──────────┬───────────────────────┘
                                    │
                                    │  HTTPS
                                    │
┌───────────────────────────────────┼──────────────────────────┐
│  Linux VM (EC2 / Azure VM / GCP)  │                          │
│                                   │                          │
│  ┌────────────────┐  OTLP  ┌─────┴──────────┐               │
│  │  otel.cjs      │────────│  EdgeConnect    │               │
│  │  (OTel boot)   │        │  (Docker)       │               │
│  └────┬───────────┘        └────────────────┘               │
│       │ --require                                            │
│  ┌────▼───────────┐   HTTP    ┌──────────────┐              │
│  │  BizObs Demonstrator │ ◄──────► │  Ollama       │              │
│  │  (Node.js)     │  :11434   │  (Local LLM)  │              │
│  │  :8080         │           └──────────────┘              │
│  └────────────────┘                                          │
└──────────────────────────────────────────────────────────────┘
```

**Components:**

| Component | What It Does |
|---|---|
| **BizObs Demonstrator** | Node.js server — generates business journeys, runs AI agents (Fix-It, Nemesis, Librarian) |
| **Ollama** | Local LLM runtime — powers AI dashboard generation, chaos analysis, auto-remediation |
| **otel.cjs** | OpenTelemetry bootstrap — auto-instruments all HTTP calls, ships traces + metrics + logs to Dynatrace |
| **AppEngine UI** | Dynatrace-embedded React app — the partner-facing UI inside the Dynatrace Apps menu |
| **EdgeConnect** | Docker tunnel — lets the AppEngine UI (running in Dynatrace) talk to the BizObs server on your VM |

---

## Deployment Modes

The app supports two deployment modes — choose based on your infrastructure:

| Mode | Flag | Ollama Required? | AI Features | Min RAM |
|---|---|---|---|---|
| **Full** (default) | _(none)_ | Yes | LLM-powered dashboards, agentic diagnosis, smart chaos | 8 GB |
| **Lite** | `--skip-ollama` | No | Rule-based fallbacks — all features still work | 4 GB |

**Lite mode** is ideal for:
- Smaller VMs / budget deployments (t3.medium, e2-medium)
- Quick demos where AI features aren't the focus
- Environments where you can't install Ollama

**What changes in Lite mode:**
- Dashboard generation → template-based (no LLM, still creates valid Dynatrace dashboards)
- Nemesis chaos agent → random fault selection instead of LLM-picked
- Fix-It agent → rule-based diagnosis instead of agentic reasoning
- Librarian → bag-of-words search instead of vector embeddings
- All other features (journeys, services, OTel, metrics, chaos engine) work identically

To deploy in Lite mode:
```bash
bash deploy.sh --skip-ollama
```

Or set the environment variable directly:
```bash
# In .env
OLLAMA_MODE=disabled
```

---

## Infrastructure Prerequisites

### Minimum Requirements

| Resource | Minimum | Recommended |
|---|---|---|
| **vCPUs** | 2 | 4 |
| **RAM** | 4 GB | 8 GB (Ollama loads the LLM into memory) |
| **Disk** | 15 GB | 30 GB (model files + node_modules + logs) |
| **OS** | Ubuntu 20.04+ / Amazon Linux 2023 / RHEL 8+ | Amazon Linux 2023 |
| **Node.js** | 18.x | 20.x or 22.x |
| **Docker** | 20.10+ (for EdgeConnect) | Latest |

### Recommended Cloud Instance Sizes

| Cloud | Instance Type | vCPUs | RAM | Cost (approx.) |
|---|---|---|---|---|
| **AWS** | `t3.large` | 2 | 8 GB | ~$0.08/hr |
| **AWS** (budget) | `t3.medium` | 2 | 4 GB | ~$0.04/hr |
| **AWS** (performance) | `t3.xlarge` | 4 | 16 GB | ~$0.17/hr |
| **Azure** | `Standard_B2s` | 2 | 4 GB | ~$0.04/hr |
| **Azure** (recommended) | `Standard_B2ms` | 2 | 8 GB | ~$0.08/hr |
| **Azure** (performance) | `Standard_D4s_v5` | 4 | 16 GB | ~$0.19/hr |
| **GCP** | `e2-medium` | 2 | 4 GB | ~$0.03/hr |
| **GCP** (recommended) | `e2-standard-2` | 2 | 8 GB | ~$0.07/hr |
| **GCP** (performance) | `e2-standard-4` | 4 | 16 GB | ~$0.13/hr |

> **Why 8 GB RAM?** The Ollama `llama3.2` model uses ~2 GB of RAM at runtime, plus Node.js needs ~500 MB, plus headroom for service runners. With 4 GB it works but you may see slower LLM responses or OOM on large prompts.

### Network & Ports

| Port | Purpose | Open To |
|---|---|---|
| **8080** | BizObs Demonstrator HTTP API | EdgeConnect (localhost) + your browser for testing |
| **11434** | Ollama API | Localhost only (internal) |
| **443** | HTTPS outbound to Dynatrace | Outbound only (OTLP export, AppEngine deployment) |

> **Inbound firewall:** Only port 8080 needs to be open for direct browser access. If you're using EdgeConnect + the AppEngine UI exclusively, no inbound ports are needed at all — EdgeConnect makes an outbound tunnel.

### Dynatrace Requirements

| Requirement | Details |
|---|---|
| **Dynatrace Version** | SaaS or Managed 1.275+ (AppEngine support required) |
| **Platform subscription** | AppEngine apps require a DPS license |
| **API Token** | `problems.read`, `metrics.read`, `logs.read`, `entities.read` scopes |
| **OTel Ingest Token** | `openTelemetryTrace.ingest`, `metrics.ingest`, `logs.ingest` scopes |
| **OAuth Client** | For EdgeConnect — created in Settings → OAuth clients |

### Software Dependencies (installed by deploy.sh automatically)

| Software | Version | Purpose |
|---|---|---|
| **Node.js** | 18+ (20 recommended) | Server runtime |
| **npm** | 10+ (comes with Node) | Package manager |
| **Ollama** | Latest | Local LLM runtime |
| **Docker** | 20.10+ | Runs EdgeConnect container |
| **dt-app CLI** | 1.6+ | Deploys AppEngine UI to Dynatrace |
| **Git** | 2.x+ | Cloning the repo |

---

## One-Click Deploy

The deploy script handles all 9 steps automatically. Just run:

```bash
bash deploy.sh
```

Or pass everything on the command line:

```bash
bash deploy.sh \
  --dt-url https://YOUR_TENANT.live.dynatrace.com \
  --dt-token dt0c01.XXXX.YYYY \
  --otel-token dt0c01.AAAA.BBBB \
  --ec-client-id dt0s10.XXXXX \
  --ec-client-secret dt0s10.XXXXX.YYYYYYYY
```

**What the script does:**

| Step | Action |
|---|---|
| 1 | Installs Node.js 20 (if missing) |
| 2 | Installs Ollama + pulls the LLM model (skipped with `--skip-ollama`) |
| 3 | Clones the repo (or detects existing code) |
| 4 | `npm install` + TypeScript build |
| 5 | Configures `.env` + `.dt-credentials.json` + `app.config.json` |
| 6 | Creates runtime directories (logs, services, saved-configs) |
| 7 | Starts the server with `--require ./otel.cjs` (OTel auto-instrumentation) |
| 8 | Builds and deploys the AppEngine UI to your Dynatrace tenant |
| 9 | Installs Docker, writes EdgeConnect YAML, starts the EdgeConnect container |

Use `--skip-ollama`, `--skip-appengine`, or `--skip-edgeconnect` to skip those steps if needed.

If you prefer to do it step by step, keep reading.

---

## Step 1 — Install Node.js

```bash
# Amazon Linux / RHEL
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node --version   # v20.x+
npm --version    # 10.x+
```

---

## Step 2 — Install & Configure Ollama

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Start Ollama service
sudo systemctl enable ollama
sudo systemctl start ollama

# Wait for Ollama to be ready
until curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; do
  echo "Waiting for Ollama..."
  sleep 2
done

# Pull the default model (llama3.2 — 2 GB)
ollama pull llama3.2

# (Optional) For lightweight environments, use qwen2:1.5b instead (934 MB)
# ollama pull qwen2:1.5b
```

> **Note:** The app has full rule-based fallbacks for all AI features. If you're deploying in **Lite mode** (`OLLAMA_MODE=disabled`), skip this entire step — the app works without Ollama installed.

> **Lite mode alternative:** Instead of installing Ollama, just set `OLLAMA_MODE=disabled` in your `.env` file, or use `bash deploy.sh --skip-ollama`.

---

## Step 3 — Clone & Install the App

```bash
cd /home/ec2-user   # or your preferred directory
git clone https://github.com/israel-salgado/Business-Observability-Demonstrator.git "Business-Observability-Demonstrator"
cd "Business Observability Demonstrator"

# Install dependencies (the repo does NOT include node_modules — this is required)
npm install

# Build TypeScript agents (compiles agents/, tools/, utils/, routes/ into dist/)
npm run build:agents
```

> **Important:** The app ships without `node_modules`. You **must** run `npm install` before anything else will work. The TypeScript build step is also required — the server imports compiled JS from the `dist/` folder.

---

## Step 4 — Configure Environment

### 4a. Create `.env`

```bash
cp deployment-guide/env.template .env
```

Edit `.env` with your values:

```dotenv
# === Required ===
PORT=8080
NODE_ENV=production

# === Ollama ===
OLLAMA_ENDPOINT=http://localhost:11434
OLLAMA_MODEL=llama3.2
```

### 4b. Configure Dynatrace Credentials

The app reads Dynatrace credentials from `.dt-credentials.json`:

```bash
cat > .dt-credentials.json << 'EOF'
{
  "environmentUrl": "https://YOUR_TENANT_ID.live.dynatrace.com",
  "apiToken": "YOUR_GENERAL_API_TOKEN",
  "otelToken": "YOUR_OTEL_INGEST_TOKEN"
}
EOF
```

| Field | Purpose | Required Token Scopes |
|---|---|---|
| `apiToken` | DT API access (problems, logs, metrics queries) | `problems.read`, `metrics.read`, `logs.read`, `entities.read` |
| `otelToken` | OTLP signal ingestion | `openTelemetryTrace.ingest`, `metrics.ingest`, `logs.ingest` |

> **How to create tokens:** In Dynatrace, go to **Access Tokens** (Settings → Integration → Access Tokens), click **Generate new token**, and select the required scopes.

### 4c. Update `app.config.json`

The AppEngine config needs your tenant's Apps URL:

```bash
# Replace the placeholder with your actual tenant
sed -i 's|YOUR_TENANT_ID.apps.dynatracelabs.com|YOUR_ACTUAL_TENANT.apps.dynatrace.com|g' app.config.json
```

---

## Step 5 — Configure Dynatrace for OpenTelemetry Ingestion

In your Dynatrace environment, ensure these settings are enabled:

### 5a. Enable W3C Trace Context

1. Go to **Settings** → **Preferences** → **OneAgent features**
2. Turn on **Send W3C Trace Context HTTP headers**

### 5b. Enable OpenTelemetry Ingestion

1. Go to **Settings** → **Preferences** → **OneAgent features**
2. Search for **OpenTelemetry** and enable:
   - **OpenTelemetry (Node.js)**

### 5c. Allow Custom OTel Attributes (for GenAI spans)

1. Go to **Settings** → **Server-side service monitoring** → **Span attributes**
2. Add the following attributes to the allowlist:

```
gen_ai.system
gen_ai.request.model
gen_ai.request.temperature
gen_ai.prompt.0.role
gen_ai.prompt.0.content
gen_ai.prompt.1.role
gen_ai.prompt.1.content
gen_ai.completion.0.role
gen_ai.completion.0.content
gen_ai.response.model
gen_ai.usage.prompt_tokens
gen_ai.usage.completion_tokens
gen_ai.response.tool_calls
gen_ai.response.duration_ms
gen_ai.request.tools
gen_ai.request.tools_count
ai.agent.framework
ai.engine.type
```

---

## Step 6 — Start the Server

```bash
mkdir -p logs

# Start with OpenTelemetry auto-instrumentation
node --require ./otel.cjs server.js >> logs/server.log 2>&1 &
echo $! > server.pid

# Verify it's running
sleep 5
curl -s http://localhost:8080/api/health | head -c 200
```

You should see in the logs:

```
[otel.cjs] 📦 Loaded credentials from .dt-credentials.json
[otel.cjs]    Token type: otelToken (ingest scopes)
[otel.cjs] ✅ OTLP endpoint: https://YOUR_TENANT.live.dynatrace.com/api/v2/otlp
[otel.cjs] 📡 Traces → .../v1/traces
[otel.cjs] 📊 Metrics → .../v1/metrics
[otel.cjs] 📝 Logs   → .../v1/logs
[otel.cjs] 🎯 OpenTelemetry initialized — traces + metrics + logs → Dynatrace
🚀 Business Observability Server running on port 8080
```

---

## Step 7 — Deploy the AppEngine UI

The AppEngine UI is a React app that runs inside Dynatrace's Apps menu. It gives partners a Dynatrace-native interface to the BizObs Demonstrator.

### 7a. Build and deploy

```bash
# Install the dt-app CLI (if not already in devDependencies)
npx dt-app --version || npm install dt-app@latest --save-dev

# Build the AppEngine app
npx dt-app build

# Deploy to your Dynatrace tenant
npx dt-app deploy
```

The `dt-app deploy` command reads `app.config.json` (which you updated in Step 4c) and pushes the built app to your tenant.

### 7b. Verify

1. Open your Dynatrace environment
2. Go to **Apps** (left sidebar)
3. Look for **Business Observability Demonstrator** in the app list
4. Click it — it should load the UI

> **Note:** The AppEngine UI won't be able to reach the server until EdgeConnect is running (next step).

---

## Step 8 — Set Up EdgeConnect

EdgeConnect creates a secure tunnel between the Dynatrace platform and your server. Without it, the AppEngine UI can't call the BizObs Demonstrator API.

### 8a. Create an OAuth Client in Dynatrace

1. Go to **Account Management** → **Identity & access management** → **OAuth clients**
2. Click **Create client**
3. Configure:
   - **Name:** `BizObs EdgeConnect`
   - **Grant type:** Client credentials
   - **Scopes:** `app-engine:edge-connects:connect`, `app-engine:edge-connects:write`
4. Save the **Client ID** and **Client Secret** — you'll need them below

### 8b. Install Docker

```bash
# Amazon Linux / RHEL
sudo yum install -y docker
sudo systemctl start docker
sudo systemctl enable docker

# Ubuntu / Debian
sudo apt-get install -y docker.io
sudo systemctl start docker
sudo systemctl enable docker
```

### 8c. Configure EdgeConnect

Edit the `edgeconnect/edgeConnect.yaml`:

```yaml
name: bizobs-demonstrator
api_endpoint_host: YOUR_TENANT_ID.apps.dynatrace.com
oauth:
  client_id: YOUR_OAUTH_CLIENT_ID
  client_secret: YOUR_OAUTH_CLIENT_SECRET
  resource: urn:dtenvironment:YOUR_TENANT_ID
  endpoint: https://sso.dynatrace.com/sso/oauth2/token
```

Replace:
- `YOUR_TENANT_ID` with your Dynatrace environment ID (e.g. `abc12345`)
- `YOUR_OAUTH_CLIENT_ID` + `YOUR_OAUTH_CLIENT_SECRET` with the OAuth client you created above
- The `endpoint` SSO URL matches your Dynatrace flavour:
  - **SaaS:** `https://sso.dynatrace.com/sso/oauth2/token`
  - **Sprint/Labs:** `https://sso.dynatracelabs.com/sso/oauth2/token`

### 8d. Start EdgeConnect

```bash
bash edgeconnect/run-edgeconnect.sh
```

Or manually:

```bash
sudo docker run -d --restart always \
  --name edgeconnect-bizobs \
  --mount "type=bind,src=$(pwd)/edgeconnect/edgeConnect.yaml,dst=/edgeConnect.yaml" \
  dynatrace/edgeconnect:latest
```

### 8e. Verify EdgeConnect

```bash
# Check container is running
sudo docker ps --filter name=edgeconnect-bizobs

# Check logs for successful connection
sudo docker logs edgeconnect-bizobs 2>&1 | tail -20
```

You should see the EdgeConnect successfully connecting to your Dynatrace environment. The AppEngine UI should now be able to reach the BizObs Demonstrator.

---

## Step 9 — (Optional) Nginx Reverse Proxy

For production access via HTTPS or a custom domain:

```bash
sudo yum install -y nginx   # Amazon Linux
# sudo apt install -y nginx # Ubuntu

sudo cp nginx/bizobs.conf /etc/nginx/conf.d/
sudo nginx -t && sudo systemctl restart nginx
```

For HTTPS with SSL certs:

```bash
sudo mkdir -p /etc/nginx/ssl
sudo cp your-cert.crt /etc/nginx/ssl/bizobs.crt
sudo cp your-cert.key /etc/nginx/ssl/bizobs.key
sudo cp nginx/bizobs-https.conf /etc/nginx/conf.d/
sudo nginx -t && sudo systemctl restart nginx
```

---

## Step 10 — (Optional) System Service

For auto-start on boot:

```bash
sudo tee /etc/systemd/system/bizobs-server.service << EOF
[Unit]
Description=Business Observability Demonstrator
After=network.target ollama.service
Wants=ollama.service
StartLimitIntervalSec=600
StartLimitBurst=20

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$(pwd)
Environment=NODE_ENV=production
Environment=PORT=8080
Environment=HOME=/home/$(whoami)
Environment=PATH=$(dirname $(command -v node)):/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-$(pwd)/.env
ExecStartPre=/bin/bash $(pwd)/scripts/self-heal.sh
ExecStart=$(command -v node) --require ./otel.cjs server.js
Restart=always
RestartSec=5
SyslogIdentifier=bizobs-server
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$(pwd)
ReadWritePaths=/tmp

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now bizobs-server.service
journalctl -u bizobs-server.service -f

sudo systemctl daemon-reload
sudo systemctl enable bizobs
sudo systemctl start bizobs
```

---

## Step 11 — Verify in Dynatrace

### Traces

1. Go to **Distributed Traces** → **Ingested traces** tab
2. Filter by `service.name = bizobs-ai-engine`
3. You should see HTTP spans for every API call, with Ollama calls tagged with `gen_ai.system = ollama`

### Metrics

1. Go to **Metrics** explorer
2. Search for metrics from the `bizobs-ai-engine` service

### Logs

1. Go to **Logs & Events**
2. Filter by `service.name = bizobs-ai-engine`

### AI Observability (GenAI Spans)

1. Go to **AI Observability** (or **Notebooks** → search "AI Observability")
2. You should see LLM call traces with model name, prompt/completion content, token usage, and latency

### AppEngine UI

1. Go to **Apps** in the Dynatrace sidebar
2. Open **Business Observability Demonstrator**
3. The UI should connect to the server via EdgeConnect and display the dashboard

---

## Quick Reference

| Item | Value |
|---|---|
| **Server URL** | `http://YOUR_HOST:8080` |
| **Health endpoint** | `http://YOUR_HOST:8080/api/health` |
| **Ollama** | `http://localhost:11434` |
| **Default model** | `llama3.2` |
| **Start command** | `node --require ./otel.cjs server.js` |
| **Config files** | `.env`, `.dt-credentials.json`, `app.config.json` |
| **Logs** | `logs/server.log` |
| **PID file** | `server.pid` |
| **OTel bootstrap** | `otel.cjs` (loaded via `--require`) |
| **TypeScript build** | `npm run build:agents` |
| **AppEngine deploy** | `npx dt-app build && npx dt-app deploy` |
| **EdgeConnect** | `bash edgeconnect/run-edgeconnect.sh` |
| **EdgeConnect logs** | `sudo docker logs edgeconnect-bizobs` |

---

## Troubleshooting

| Issue | Solution |
|---|---|
| `OTel tracing NOT enabled` | Check `.dt-credentials.json` has `environmentUrl` and `otelToken` |
| `403 Token missing scope` | Ensure `otelToken` has `openTelemetryTrace.ingest`, `metrics.ingest`, `logs.ingest` |
| `Ollama connection refused` | Run `sudo systemctl start ollama` and verify `curl http://localhost:11434` |
| `LLM request timed out` | The model may be loading. First request after cold start takes longer. Try again. |
| No traces in Dynatrace | Check **Ingested traces** tab (not PurePaths). Allow 2-3 minutes for data to appear. |
| GenAI attributes missing | Add them to the **Span attributes** allowlist in Dynatrace Settings |
| `require is not defined` | The bootstrap file must be `otel.cjs` (not `.js`) because the project uses ESM |
| AppEngine UI blank | Make sure `app.config.json` has the correct tenant URL, and you've run `npx dt-app deploy` |
| AppEngine can't reach server | EdgeConnect must be running. Check: `sudo docker ps` and `sudo docker logs edgeconnect-bizobs` |
| `dt-app deploy` fails | Run `npx dt-app deploy` manually and check the output. Ensure `app.config.json` `environmentUrl` is correct. |
| EdgeConnect won't start | Verify `edgeconnect/edgeConnect.yaml` has real OAuth credentials (not `YOUR_TENANT_ID` placeholders) |
| EdgeConnect auth errors | Check the OAuth client has `app-engine:edge-connects:connect` and `write` scopes |
