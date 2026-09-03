# Business Observability Demonstrator — Quick Start (Plain English)

This is the simple version. If you want the full technical reference, see the main README.md.

---

## What You're Setting Up

You're deploying a Node.js app that generates realistic business telemetry (customer journeys, transactions, errors) and sends it all to Dynatrace. It also runs AI agents powered by a local LLM (Ollama) that can diagnose problems and inject chaos — and all the AI calls get traced into Dynatrace too.

**Two deployment modes:**
- **Full mode** (default) — includes Ollama for AI-powered features. Needs 8 GB RAM.
- **Lite mode** (`--skip-ollama`) — no Ollama needed, uses smart rule-based fallbacks. Only needs 4 GB RAM. All features still work, just without LLM intelligence.

On top of the server, you're deploying a Dynatrace AppEngine UI so partners can use the tool directly from inside Dynatrace, and an EdgeConnect tunnel that connects the two.

**The three pieces:**
1. **The server** — runs on a Linux VM, does the actual work, sends OTel data to Dynatrace
2. **The AppEngine UI** — a React app deployed to your Dynatrace tenant, shows up in the Apps menu
3. **EdgeConnect** — a Docker container on your VM that tunnels traffic from the AppEngine UI to the server

---

## What You Need Before You Start

- **A Linux machine that's already running**, which you can SSH into with `sudo`. Anywhere is
  fine: a Proxmox or vSphere VM, EC2, Azure, GCP, or even a VM on your laptop. This is not a
  cloud setup tool, so there's nothing to provision.
- A Dynatrace environment (SaaS with AppEngine/DPS licence)
- About 20 to 30 minutes

### Server Sizing Quick Reference

| Setup | vCPU | RAM | Disk |
|---|---:|---:|---:|
| **Default** (cloud AI provider) | 2 | 4 GB | 20 GB |
| **With local Ollama** | 4 | 8 GB | 40 GB |

4 GB is the floor. AI generation runs against a cloud provider you configure in the app, so you
only need 8 GB if you specifically want local models. Cloud equivalents of the default profile:
AWS `t3.medium`, Azure `Standard_B2s`, GCP `e2-medium`.

**OS:** any Linux with systemd and `dnf`/`yum`/`apt`. Verified on Ubuntu 22.04+, Debian 12+, and
Amazon Linux 2023. RHEL, Rocky, and AlmaLinux work once you add the Docker CE repo.

**Network:** outbound HTTPS only. No inbound ports, no public IP, no port forwarding.

---

## The Fastest Way

There's a single script that does everything — installs Node, Ollama, the app, OTel, deploys the UI to Dynatrace, and sets up EdgeConnect. Just run:

```bash
bash deploy.sh
```

**For Lite mode** (no Ollama, smaller servers):
```bash
bash deploy.sh --skip-ollama
```

It'll prompt you for your Dynatrace URL, tokens, and EdgeConnect OAuth credentials. That's it.

You can also pass everything as flags if you don't want to be prompted:

```bash
bash deploy.sh \
  --dt-url https://abc123.live.dynatrace.com \
  --dt-token dt0c01.XXX \
  --otel-token dt0c01.YYY \
  --ec-client-id dt0s10.XXXXX \
  --ec-client-secret dt0s10.XXXXX.YYYYYYYY
```

If you'd rather do it step by step (or something went wrong), here's the manual way:

---

## The Setup

### 1. Get Node.js on the box

You need Node 22 or newer. If you're on Amazon Linux, RHEL, Rocky, or Alma:

```bash
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs   # or: sudo yum install -y nodejs
```

On Ubuntu or Debian:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Check it worked with `node --version`.

### 2. Install Ollama (optional, for local models only)

> **Most people should skip this step.** AI generation runs against a cloud provider you configure
> in the app under **Settings → AI Provider** (OpenAI, Anthropic, Azure OpenAI, GitHub Models, or
> any OpenAI-compatible gateway). Ollama is only needed if you specifically want to demo local
> open-source models. Skipping it keeps you at 4 GB RAM instead of 8 GB.
>
> If you skip it, set `OLLAMA_MODE=disabled` in `.env` and jump to Step 3. `setup.sh` and
> `deploy.sh` now detect this and write the correct value for you.

Ollama runs LLM models locally on your server. One command:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Start it up and pull the model the app expects:

```bash
sudo systemctl enable ollama && sudo systemctl start ollama
ollama pull llama3.2:1b
```

`llama3.2:1b` is ~1 GB and is what the scripts and `.env` default to, chosen for CPU-only
inference. Larger variants like `llama3.2` (~2 GB) work too, but set `OLLAMA_MODEL` in `.env` to
match whatever you pulled, or the app won't find it.

Without Ollama the app still works: AI agents fall back to rule-based logic and dashboards fall
back to templates.

### 3. Get the app code

```bash
cd /home/ec2-user
git clone https://github.com/israel-salgado/Business-Observability-Demonstrator.git
cd Business-Observability-Demonstrator
```

The repo doesn't include `node_modules` — you need to install them first. Then build the TypeScript agents (the server needs the compiled JS in the `dist/` folder):

```bash
npm install
npm run build:agents
```

Both steps are required. If you skip `npm install` nothing will start. If you skip the build step, the AI agents won't load.

### 4. Tell the app about your Dynatrace environment

You have **three ways** to configure Dynatrace credentials:

1. **Interactive prompt** — Just start the server. If no credentials are found, it'll ask you in the terminal.
2. **Config file** — Create `.dt-credentials.json` manually.
3. **UI** — Start the server with no credentials, then configure via Settings → Dynatrace Configuration.

**Option 1: Let the server ask you (easiest)**

Just start the server (Step 5) — it'll prompt for your URL and tokens on first run.

**Option 2: Create the config file manually**

Create a file called `.dt-credentials.json` in the app folder:

```json
{
  "environmentUrl": "https://abc12345.live.dynatrace.com",
  "apiToken": "dt0c01.XXXX.YYYY",
  "otelToken": "dt0c01.AAAA.BBBB",
  "configuredAt": "2025-01-01T00:00:00.000Z",
  "configuredBy": "manual"
}
```

- **environmentUrl** — your Dynatrace URL, like `https://abc12345.live.dynatrace.com`
- **apiToken** — a general-purpose token (needs `problems.read`, `metrics.read`, `logs.read`, `entities.read` scopes)
- **otelToken** — a separate token just for sending telemetry (needs `openTelemetryTrace.ingest`, `metrics.ingest`, `logs.ingest` scopes)

You create both tokens in Dynatrace under **Access Tokens** (Settings → Integration → Access Tokens). We use two separate tokens because the OTel one only needs ingest permissions — keeps things clean.

Also set up the `.env` file:

```bash
cp .env.template .env
```

The defaults are fine for most setups. The main things to check are `OLLAMA_MODE` (set to `disabled` for Lite mode), `OLLAMA_MODEL` (should match what you pulled), and `PORT` (defaults to 8080).

### 5. Flip a couple of switches in Dynatrace

Before traces show up, you need to tell Dynatrace to accept them:

1. Go to **Settings → Preferences → OneAgent features**
2. Turn on **Send W3C Trace Context HTTP headers**
3. Search for **OpenTelemetry** and enable **OpenTelemetry (Node.js)**

Then, to see the AI-specific attributes (model name, prompts, token counts etc.):

1. Go to **Settings → Server-side service monitoring → Span attributes**
2. Add these to the allow list: `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.prompt_tokens`, `gen_ai.usage.completion_tokens`, `gen_ai.response.duration_ms`

There are more attributes you can add (the full list is in the main README), but those are the key ones.

### 6. Start the server

```bash
mkdir -p logs
node --require ./otel.cjs server.js >> logs/server.log 2>&1 &
echo $! > server.pid
```

That's it. The `--require ./otel.cjs` part is what wires up OpenTelemetry before the app starts. It automatically instruments all HTTP calls (including the ones to Ollama) and ships traces, metrics, and logs to your Dynatrace environment.

Check the logs to make sure everything initialized:

```bash
tail -20 logs/server.log
```

You should see lines about OTel loading credentials, connecting to your Dynatrace OTLP endpoint, and the server starting on port 8080.

Hit the health check to confirm:

```bash
curl http://localhost:8080/api/health
```

### 7. Deploy the AppEngine UI to Dynatrace

The AppEngine UI is a React app that shows up in Dynatrace's Apps menu. First, update `app.config.json` with your tenant:

```bash
# Replace the placeholder tenant URL (change YOUR_TENANT to your actual ID)
sed -i 's|YOUR_TENANT_ID.apps.dynatracelabs.com|YOUR_TENANT.apps.dynatrace.com|g' app.config.json
```

Then build and deploy:

```bash
npx dt-app build
npx dt-app deploy
```

After it deploys, go to your Dynatrace environment → Apps → you should see **Business Observability Demonstrator** in the list. It won't fully work yet though — it needs EdgeConnect to reach the server (next step).

### 8. Set up EdgeConnect

EdgeConnect is a Docker container that creates a tunnel from Dynatrace to your server. The AppEngine UI uses this tunnel to talk to the BizObs Demonstrator API.

**First, create an OAuth client in Dynatrace:**

1. Go to **Account Management → Identity & access management → OAuth clients**
2. Create a new client with:
   - **Grant type:** Client credentials
   - **Scopes:** `app-engine:edge-connects:connect`, `app-engine:edge-connects:write`
3. Copy the Client ID and Client Secret

**Then, install Docker if you don't have it:**

```bash
sudo yum install -y docker          # Amazon Linux
sudo systemctl start docker && sudo systemctl enable docker
```

**Configure EdgeConnect:**

Edit `edgeconnect/edgeConnect.yaml` and put in your real values:

```yaml
name: bizobs-demonstrator
api_endpoint_host: YOUR_TENANT.apps.dynatrace.com
oauth:
  client_id: YOUR_OAUTH_CLIENT_ID
  client_secret: YOUR_OAUTH_CLIENT_SECRET
  resource: urn:dtenvironment:YOUR_TENANT_ID
  endpoint: https://sso.dynatrace.com/sso/oauth2/token
```

**Start it:**

```bash
bash edgeconnect/run-edgeconnect.sh
```

Check the logs after a few seconds:

```bash
sudo docker logs edgeconnect-bizobs 2>&1 | tail -10
```

You should see it connect successfully. Now go back to the AppEngine UI in Dynatrace — it should be able to reach the server.

### 9. Check it's all working in Dynatrace

Give it a couple of minutes for data to flow, then:

- **Apps** → **Business Observability Demonstrator** → should load the UI and connect to the server
- **Distributed Traces** → click the **Ingested traces** tab → look for traces from `bizobs-ai-engine`
- **Logs & Events** → filter by `bizobs-ai-engine`
- **AI Observability** → you should see Ollama LLM calls with model info, latency, and token usage

If you don't see anything under Distributed Traces, make sure you're on the **Ingested traces** tab, not PurePaths.

---

## Day-to-Day Commands

| What | Command |
|---|---|
| Start the server | `node --require ./otel.cjs server.js >> logs/server.log 2>&1 &` |
| Stop the server | `kill $(cat server.pid)` |
| Check if it's running | `curl http://localhost:8080/api/health` |
| Watch the logs | `tail -f logs/server.log` |
| Rebuild after code changes | `npm run build:agents` |
| Redeploy AppEngine UI | `npx dt-app build && npx dt-app deploy` |
| Check EdgeConnect | `sudo docker logs edgeconnect-bizobs` |
| Restart EdgeConnect | `sudo docker restart edgeconnect-bizobs` |

---

## If Something's Not Working

**"OTel tracing NOT enabled"** — Your `.dt-credentials.json` is missing or has empty values. Double-check `environmentUrl` and `otelToken`.

**"403 Token missing scope"** — The token doesn't have the right permissions. Go back to Dynatrace Access Tokens and add the ingest scopes.

**"Ollama connection refused"** — Ollama isn't running. Start it with `sudo systemctl start ollama`.

**No traces in Dynatrace** — Wait 2-3 minutes. If still nothing, check `tail logs/server.log` for any OTLP export errors. Also verify you're on the **Ingested traces** tab.

**"require is not defined"** — You probably renamed `otel.cjs` to `otel.js`. It must be `.cjs` because the project uses ES modules.

**AppEngine UI is blank or errors** — Check that `app.config.json` has the right tenant URL. Run `npx dt-app deploy` again.

**AppEngine can't reach the server** — EdgeConnect isn't running. Check `sudo docker ps` and `sudo docker logs edgeconnect-bizobs`.

**EdgeConnect won't connect** — Check the YAML has real OAuth credentials, not placeholders. The OAuth client needs `app-engine:edge-connects:connect` scope.
