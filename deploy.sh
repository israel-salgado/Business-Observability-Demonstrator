#!/bin/bash
# ============================================================
#  Business Observability Demonstrator — Deploy Script
# ============================================================
#
#  Usage (after git clone/pull):
#    bash deploy.sh
#    bash deploy.sh --dt-url https://abc123.live.dynatrace.com \
#                   --dt-token dt0c01.XXX \
#                   --otel-token dt0c01.YYY
#
#  This script handles everything:
#    0. Pre-flight checks (disk space, git, Docker)
#    1. Checks Node.js (installs if missing)
#    2. Runs npm install + TypeScript build
#    3. Prompts for Dynatrace credentials → .dt-credentials.json + .env
#    4. Creates runtime directories
#    5. Starts the server with OpenTelemetry instrumentation
#    6. (Optional) Deploys the Dynatrace AppEngine UI
#    7. (Optional) Sets up EdgeConnect Docker tunnel
#    8. (Optional) Installs Dynatrace OneAgent for full-stack monitoring
#
# ============================================================

set -e

# ── Ensure we're in the repo directory ──
cd "$(dirname "$0")"

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

TOTAL_STEPS=8
step() { echo -e "\n${CYAN}${BOLD}[$1/$TOTAL_STEPS]${NC} ${BOLD}$2${NC}"; }
ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; exit 1; }

# ── Parse CLI args ──
DT_URL=""
DT_API_TOKEN=""
DT_OTEL_TOKEN=""
APP_OAUTH_CLIENT_ID=""
APP_OAUTH_CLIENT_SECRET=""
EC_CLIENT_ID=""
EC_CLIENT_SECRET=""
EC_NAME=""
EC_RESOURCE=""
SKIP_APPENGINE=""
SKIP_EDGECONNECT=""
SKIP_ONEAGENT=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --dt-url)           DT_URL="$2"; shift 2 ;;
    --dt-token)         DT_API_TOKEN="$2"; shift 2 ;;
    --otel-token)       DT_OTEL_TOKEN="$2"; shift 2 ;;
    --app-oauth-id)     APP_OAUTH_CLIENT_ID="$2"; shift 2 ;;
    --app-oauth-secret) APP_OAUTH_CLIENT_SECRET="$2"; shift 2 ;;
    --ec-name)          EC_NAME="$2"; shift 2 ;;
    --ec-client-id)     EC_CLIENT_ID="$2"; shift 2 ;;
    --ec-client-secret) EC_CLIENT_SECRET="$2"; shift 2 ;;
    --ec-resource)      EC_RESOURCE="$2"; shift 2 ;;
    --skip-appengine)   SKIP_APPENGINE=1; shift ;;
    --skip-edgeconnect) SKIP_EDGECONNECT=1; shift ;;
    --skip-oneagent)    SKIP_ONEAGENT=1; shift ;;
    -h|--help)
      echo "Usage: bash deploy.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --dt-url URL              Dynatrace environment URL"
      echo "  --dt-token TOKEN          Dynatrace API token (problems.read, metrics.read, etc.)"
      echo "  --otel-token TOKEN        Dynatrace OTel ingest token (traces, metrics, logs ingest)"
      echo "  --app-oauth-id ID         AppEngine deploy OAuth client ID"
      echo "  --app-oauth-secret SECRET AppEngine deploy OAuth client secret"
      echo "  --ec-client-id ID         EdgeConnect OAuth client ID"
      echo "  --ec-client-secret SECRET EdgeConnect OAuth client secret"
      echo "  --ec-resource URN         EdgeConnect OAuth resource (urn:dtenvironment:TENANT_ID)"
      echo "  --skip-appengine          Skip Dynatrace AppEngine UI deployment"
      echo "  --skip-edgeconnect        Skip EdgeConnect Docker setup"
      echo "  --skip-oneagent           Skip Dynatrace OneAgent installation"
      echo ""
      echo "If credentials are not passed via CLI, the script will prompt for them."
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Validate we're in the right place ──
if [[ ! -f "server.js" || ! -f "package.json" ]]; then
  fail "server.js or package.json not found. Run this script from the repo root."
fi

echo -e "${BOLD}"
echo "╔══════════════════════════════════════════════════════════╗"
echo "║     Business Observability Demonstrator — Deploy                ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Server + OTel + AppEngine UI + EdgeConnect               ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Pre-flight checks
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo -e "${BOLD}Pre-flight checks${NC}"

# Check disk space (need at least 5GB free, 10GB recommended)
AVAIL_MB=$(df -m / | awk 'NR==2 {print $4}')
AVAIL_GB=$(( AVAIL_MB / 1024 ))
if [[ "$AVAIL_MB" -lt 2048 ]]; then
  fail "Only ${AVAIL_GB}GB free disk space. Need at least 5GB (10GB+ recommended).\n  Resize your volume: AWS Console → EC2 → Volumes → Modify Volume → 30GB\n  Then run: sudo growpart /dev/nvme0n1 1 && sudo xfs_growfs /"
elif [[ "$AVAIL_MB" -lt 5120 ]]; then
  warn "${AVAIL_GB}GB free — tight. 10GB+ recommended (resize volume to 30GB)"
else
  ok "${AVAIL_GB}GB free disk space"
fi

# Check git
if command -v git &>/dev/null; then
  ok "git $(git --version | awk '{print $3}')"
else
  echo "  Installing git..."
  sudo yum install -y git 2>/dev/null || sudo apt-get install -y git 2>/dev/null
  ok "git installed"
fi

# Check Docker (needed for EdgeConnect)
if [[ -z "$SKIP_EDGECONNECT" ]]; then
  if command -v docker &>/dev/null; then
    ok "Docker available"
  else
    warn "Docker not installed — will install in Step 7 if EdgeConnect is configured"
  fi
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 1: Node.js
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step 1 "Node.js"

# Node.js 22 is the floor — must match the version enforced by setup.sh
if command -v node &>/dev/null; then
  NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
  if [[ "$NODE_VER" -ge 22 ]]; then
    ok "Node.js $(node --version) already installed"
  else
    warn "Node.js $(node --version) is below the required v22, installing v22..."
    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - 2>/dev/null \
      || curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - 2>/dev/null
    sudo dnf install -y nodejs 2>/dev/null || sudo yum install -y nodejs 2>/dev/null || sudo apt-get install -y nodejs 2>/dev/null
    ok "Node.js $(node --version) installed"
  fi
else
  echo "  Installing Node.js 22..."
  curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - 2>/dev/null \
    || curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - 2>/dev/null
  sudo dnf install -y nodejs 2>/dev/null || sudo yum install -y nodejs 2>/dev/null || sudo apt-get install -y nodejs 2>/dev/null
  ok "Node.js $(node --version) installed"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 2: Install dependencies & build
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step 2 "Installing dependencies & building"

echo "  Running npm install (this may take a minute)..."
npm install --loglevel=warn 2>&1 | tail -3
ok "npm install complete"

echo "  Building TypeScript agents..."
npx tsc --project tsconfig.json 2>&1 || warn "TypeScript build had warnings (may be ok)"
ok "Build complete — dist/ folder ready"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 3: Dynatrace configuration
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step 3 "Dynatrace configuration"

# Detect whether a local Ollama is actually running. This script does NOT install
# Ollama, so pinning OLLAMA_MODE=full unconditionally used to leave the app calling
# a dead localhost:11434. Record what's really there instead.
if curl -sf --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1; then
  DETECTED_OLLAMA_MODE="full"
else
  DETECTED_OLLAMA_MODE="disabled"
fi

# Create .env if missing
if [[ ! -f .env ]]; then
  cat > .env << ENVEOF
PORT=8080
NODE_ENV=production
OLLAMA_MODE=$DETECTED_OLLAMA_MODE
OLLAMA_MODEL=llama3.2:1b
ENVEOF
  ok "Created .env (OLLAMA_MODE=$DETECTED_OLLAMA_MODE)"
else
  # Respect an existing explicit choice; otherwise record what we detected.
  if grep -q "OLLAMA_MODE" .env; then
    ok ".env already exists (OLLAMA_MODE=$(grep OLLAMA_MODE .env | cut -d= -f2))"
  else
    echo "OLLAMA_MODE=$DETECTED_OLLAMA_MODE" >> .env
    ok ".env updated with OLLAMA_MODE=$DETECTED_OLLAMA_MODE"
  fi
  # Ensure OLLAMA_MODEL is set (default to 1B for CPU-only inference)
  if ! grep -q "OLLAMA_MODEL" .env; then
    echo "OLLAMA_MODEL=llama3.2:1b" >> .env
    ok ".env updated with OLLAMA_MODEL=llama3.2:1b"
  fi
fi

if [[ "$DETECTED_OLLAMA_MODE" == "disabled" ]]; then
  warn "No local Ollama detected — AI features will use template fallbacks."
  warn "Configure a cloud AI provider in the app (Settings → AI Provider), or install Ollama:"
  warn "  curl -fsSL https://ollama.com/install.sh | sh && ollama pull llama3.2:1b"
fi

# Prompt for DT credentials if not provided
if [[ -z "$DT_URL" ]]; then
  echo ""
  echo -e "  ${BOLD}Enter your Dynatrace environment URL${NC}"
  echo -e "  ${CYAN}(e.g. https://abc12345.live.dynatrace.com)${NC}"
  echo -e "  ${CYAN}(sprint example: https://abc12345.sprint.dynatracelabs.com)${NC}"
  echo -e "  ${CYAN}(apps URLs are also accepted and auto-normalized)${NC}"
  read -rp "  → " DT_URL
fi

if [[ -z "$DT_URL" ]]; then
  warn "No Dynatrace URL provided — skipping DT config (you can set it later via the UI)"
else
  # Clean up URL
  DT_URL="${DT_URL%/}"

  # Normalize: if user entered an apps URL, convert to environment URL
  # e.g. https://abc123.sprint.apps.dynatracelabs.com → https://abc123.sprint.dynatracelabs.com
  # e.g. https://abc123.apps.dynatrace.com → https://abc123.dynatrace.com
  DT_URL=$(echo "$DT_URL" | sed 's|\.apps\.|.|')

  # Derive tenant ID from URL
  DT_TENANT_ID=$(echo "$DT_URL" | sed -E 's|https?://||' | cut -d. -f1)

  # Derive apps URL — handles sprint/live/managed environments
  # e.g. abc123.live.dynatrace.com → abc123.apps.dynatrace.com
  # e.g. abc123.sprint.dynatracelabs.com → abc123.sprint.apps.dynatracelabs.com
  DT_STRIPPED=$(echo "$DT_URL" | sed -E 's|https?://[^.]+\.||')
  if echo "$DT_STRIPPED" | grep -qE '^sprint\.|^dev\.'; then
    # Sprint/dev environments: TENANT.sprint.apps.domain
    DT_ENV_TYPE=$(echo "$DT_STRIPPED" | cut -d. -f1)
    DT_BASE_DOMAIN=$(echo "$DT_STRIPPED" | sed -E 's|^[^.]+\.||')
    DT_APPS_URL="https://${DT_TENANT_ID}.${DT_ENV_TYPE}.apps.${DT_BASE_DOMAIN}"
  else
    # Standard environments: TENANT.apps.domain
    DT_APPS_URL="https://${DT_TENANT_ID}.apps.${DT_STRIPPED}"
  fi

  if [[ -z "$DT_API_TOKEN" ]]; then
    echo ""
    echo -e "  ${BOLD}Enter your Dynatrace API token${NC}"
    echo -e "  ${CYAN}(needs: problems.read, metrics.read, logs.read, entities.read)${NC}"
    read -rp "  → " DT_API_TOKEN
  fi

  if [[ -z "$DT_OTEL_TOKEN" ]]; then
    echo ""
    echo -e "  ${BOLD}Enter your Dynatrace OTel ingest token${NC}"
    echo -e "  ${CYAN}(needs: openTelemetryTrace.ingest, metrics.ingest, logs.ingest)${NC}"
    echo -e "  ${CYAN}(press Enter to use the same token as above)${NC}"
    read -rp "  → " DT_OTEL_TOKEN
    if [[ -z "$DT_OTEL_TOKEN" ]]; then
      DT_OTEL_TOKEN="$DT_API_TOKEN"
    fi
  fi

  # Write credentials file
  cat > .dt-credentials.json << CREDSEOF
{
  "environmentUrl": "$DT_URL",
  "apiToken": "$DT_API_TOKEN",
  "otelToken": "$DT_OTEL_TOKEN",
  "configuredAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "configuredBy": "deploy-script"
}
CREDSEOF
  ok "Created .dt-credentials.json"
  echo -e "  Environment: ${CYAN}$DT_URL${NC}"

  # Update app.config.json with the correct tenant apps URL
  if [[ -f app.config.json ]]; then
    # Replace any existing environmentUrl value (placeholder or previous config)
    sed -i "s|\"environmentUrl\": \"[^\"]*\"|\"environmentUrl\": \"${DT_APPS_URL}/\"|g" app.config.json 2>/dev/null || true
    ok "Updated app.config.json → ${DT_APPS_URL}"
  fi
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 4: Prepare runtime
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step 4 "Preparing runtime"

mkdir -p logs services/.dynamic-runners public/assets saved-configs
ok "Directories created"

# Install host-level log guard to prevent disk exhaustion from logs.
if command -v systemctl >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  bash scripts/install-log-guard.sh >/dev/null 2>&1 || true
  ok "Log guard installed (journald + logrotate + timer)"
else
  warn "Skipped log guard install (systemctl unavailable or sudo requires password)"
fi

# Kill any existing server
if [[ -f server.pid ]]; then
  kill "$(cat server.pid)" 2>/dev/null && echo "  Stopped previous server" || true
  rm -f server.pid
fi
pkill -f "node.*server.js" 2>/dev/null || true
sleep 1

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 5: Start server with OpenTelemetry
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step 5 "Starting BizObs Demonstrator with OpenTelemetry"

truncate -s 0 logs/server.log 2>/dev/null || true
if command -v systemctl >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  bash scripts/install-systemd-service.sh --enable --restart >/dev/null
  echo "  Started via systemd: bizobs-server.service"
else
  node --require ./otel.cjs server.js >> logs/server.log 2>&1 &
  SERVER_PID=$!
  echo "$SERVER_PID" > server.pid
  echo "  PID: $SERVER_PID"
fi

# Wait for startup
echo -n "  Waiting for server"
for i in {1..30}; do
  if curl -sf http://localhost:8080/api/health &>/dev/null; then
    break
  fi
  echo -n "."
  sleep 2
done
echo ""

if curl -sf http://localhost:8080/api/health &>/dev/null; then
  ok "Server running on port 8080"
else
  fail "Server didn't start. Check: tail -50 logs/server.log"
fi

# Check OTel status
if grep -q "OpenTelemetry initialized" logs/server.log 2>/dev/null; then
  ok "OpenTelemetry active — traces + metrics + logs → Dynatrace"
else
  warn "OTel may not have initialized. Check: grep otel logs/server.log"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 6: Deploy Dynatrace AppEngine UI
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step 6 "Deploying Dynatrace AppEngine UI"

if [[ -n "$SKIP_APPENGINE" ]]; then
  warn "Skipped (--skip-appengine flag)"
elif [[ -z "$DT_URL" ]]; then
  warn "Skipped — no Dynatrace URL configured"
else
  # Prompt for AppEngine deploy OAuth credentials (required for headless/CI deploy)
  if [[ -z "$APP_OAUTH_CLIENT_ID" ]]; then
    echo ""
    echo -e "  ${BOLD}AppEngine deploy requires an OAuth client for headless deployment.${NC}"
    echo -e "  ${CYAN}Create one in Dynatrace: Account Management → OAuth clients${NC}"
    echo -e "  ${CYAN}Required permissions: app-engine:apps:install, app-engine:apps:run${NC}"
    echo -e "  ${CYAN}(or enter 'skip' to skip AppEngine deployment)${NC}"
    echo ""
    echo -e "  ${BOLD}Enter AppEngine OAuth Client ID${NC}"
    read -rp "  → " APP_OAUTH_CLIENT_ID
  fi

  if [[ "$APP_OAUTH_CLIENT_ID" == "skip" || -z "$APP_OAUTH_CLIENT_ID" ]]; then
    warn "AppEngine deploy skipped — deploy later with: DT_APP_OAUTH_CLIENT_ID=... DT_APP_OAUTH_CLIENT_SECRET=... npx dt-app deploy"
  else
    if [[ -z "$APP_OAUTH_CLIENT_SECRET" ]]; then
      echo -e "  ${BOLD}Enter AppEngine OAuth Client Secret${NC}"
      read -rp "  → " APP_OAUTH_CLIENT_SECRET
    fi

    # Set env vars for dt-app CLI (CI/CD headless deploy)
    export DT_APP_OAUTH_CLIENT_ID="$APP_OAUTH_CLIENT_ID"
    export DT_APP_OAUTH_CLIENT_SECRET="$APP_OAUTH_CLIENT_SECRET"

    if ! npx dt-app --version &>/dev/null; then
      warn "dt-app CLI not found — installing..."
      npm install dt-app@latest --save-dev 2>&1 | tail -2
    fi

    echo "  Building AppEngine app..."
    npx dt-app build 2>&1 | tail -5
    ok "AppEngine app built"

    echo "  Deploying to ${DT_APPS_URL}..."
    if npx dt-app deploy --non-interactive 2>&1 | tail -10; then
      ok "AppEngine UI deployed to your Dynatrace tenant"
      echo -e "  ${CYAN}Open Dynatrace → Apps → Business Observability Demonstrator${NC}"
    else
      warn "AppEngine deploy had issues — you can retry manually with:"
      echo -e "  ${CYAN}DT_APP_OAUTH_CLIENT_ID=$APP_OAUTH_CLIENT_ID DT_APP_OAUTH_CLIENT_SECRET=... npx dt-app deploy${NC}"
    fi
  fi
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 7: EdgeConnect (Docker tunnel)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step 7 "EdgeConnect (Dynatrace ↔ server tunnel)"

if [[ -n "$SKIP_EDGECONNECT" ]]; then
  warn "Skipped (--skip-edgeconnect flag)"
elif [[ -z "$DT_URL" ]]; then
  warn "Skipped — no Dynatrace URL configured"
else
  # Derive SSO endpoint from tenant domain
  # Sprint/dev: sso-sprint.dynatracelabs.com  Live/SaaS: sso.dynatrace.com
  DT_STRIPPED_EC=$(echo "$DT_URL" | sed -E 's|https?://[^.]+\.||')
  if echo "$DT_STRIPPED_EC" | grep -qE '^sprint\.|^dev\.'; then
    DT_ENV_TYPE_EC=$(echo "$DT_STRIPPED_EC" | cut -d. -f1)
    DT_BASE_DOMAIN_EC=$(echo "$DT_STRIPPED_EC" | sed -E 's|^[^.]+\.||')
    SSO_ENDPOINT="https://sso-${DT_ENV_TYPE_EC}.${DT_BASE_DOMAIN_EC}/sso/oauth2/token"
  else
    SSO_BASE=$(echo "$DT_STRIPPED_EC" | sed 's|^|https://sso.|')
    SSO_ENDPOINT="${SSO_BASE}/sso/oauth2/token"
  fi

  # Prompt for EdgeConnect OAuth credentials if not provided
  if [[ -z "$EC_CLIENT_ID" ]]; then
    echo ""
    echo -e "  ${BOLD}EdgeConnect connects the Dynatrace AppEngine UI to this server.${NC}"
    echo -e "  ${CYAN}Create an EdgeConnect in Dynatrace: Apps → Edge Connect → Add Edge Connect${NC}"
    echo -e "  ${CYAN}Then copy the OAuth client credentials from the setup page.${NC}"
    echo -e "  ${CYAN}(or enter 'skip' to set this up later)${NC}"
    echo ""
    echo -e "  ${BOLD}Enter the EdgeConnect name (as shown in Dynatrace)${NC}"
    echo -e "  ${CYAN}(e.g. bizobs-demonstrator — must match exactly what you created in Dynatrace)${NC}"
    read -rp "  → " EC_NAME
    echo ""
    echo -e "  ${BOLD}Enter EdgeConnect OAuth Client ID${NC}"
    read -rp "  → " EC_CLIENT_ID
  fi

  if [[ "$EC_CLIENT_ID" == "skip" || -z "$EC_CLIENT_ID" ]]; then
    warn "EdgeConnect skipped — you can set it up later with: bash edgeconnect/run-edgeconnect.sh"
    echo -e "  ${CYAN}See edgeconnect/README.md for instructions${NC}"
  else
    if [[ -z "$EC_CLIENT_SECRET" ]]; then
      echo -e "  ${BOLD}Enter EdgeConnect OAuth Client Secret${NC}"
      read -rp "  → " EC_CLIENT_SECRET
    fi

    if [[ -z "$EC_RESOURCE" ]]; then
      EC_RESOURCE="urn:dtenvironment:${DT_TENANT_ID}"
      echo -e "  Using resource: ${CYAN}${EC_RESOURCE}${NC}"
    fi

    # Derive apps host for EdgeConnect
    DT_STRIPPED=$(echo "$DT_URL" | sed -E 's|https?://[^.]+\.||')
    if echo "$DT_STRIPPED" | grep -qE '^sprint\.|^dev\.'; then
      DT_ENV_TYPE=$(echo "$DT_STRIPPED" | cut -d. -f1)
      DT_BASE_DOMAIN=$(echo "$DT_STRIPPED" | sed -E 's|^[^.]+\.||')
      EC_API_HOST="${DT_TENANT_ID}.${DT_ENV_TYPE}.apps.${DT_BASE_DOMAIN}"
    else
      EC_API_HOST="${DT_TENANT_ID}.apps.${DT_STRIPPED}"
    fi

    # Use provided name or default
    EC_NAME="${EC_NAME:-bizobs-demonstrator}"

    # Auto-detect server IPs for EdgeConnect host patterns
    # The platform needs to know which hosts to route through this EdgeConnect
    EC_PUBLIC_IP=""
    EC_PRIVATE_IP=""

    # Try AWS EC2 metadata service (IMDSv1 + IMDSv2)
    EC2_TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
      -H "X-aws-ec2-metadata-token-ttl-seconds: 5" --connect-timeout 2 2>/dev/null || true)
    if [[ -n "$EC2_TOKEN" ]]; then
      EC_PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $EC2_TOKEN" \
        http://169.254.169.254/latest/meta-data/public-ipv4 --connect-timeout 2 2>/dev/null || true)
      EC_PRIVATE_IP=$(curl -s -H "X-aws-ec2-metadata-token: $EC2_TOKEN" \
        http://169.254.169.254/latest/meta-data/local-ipv4 --connect-timeout 2 2>/dev/null || true)
    fi
    # Fallback for IMDSv1 or non-EC2 environments
    if [[ -z "$EC_PUBLIC_IP" ]]; then
      EC_PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4 --connect-timeout 2 2>/dev/null || true)
    fi
    if [[ -z "$EC_PRIVATE_IP" ]]; then
      EC_PRIVATE_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
    fi

    # Build host_patterns list
    HOST_PATTERNS=""
    if [[ -n "$EC_PUBLIC_IP" && "$EC_PUBLIC_IP" != *"Not Found"* ]]; then
      HOST_PATTERNS="  - \"${EC_PUBLIC_IP}\""
      echo -e "  Detected public IP:  ${CYAN}${EC_PUBLIC_IP}${NC}"
    fi
    if [[ -n "$EC_PRIVATE_IP" && "$EC_PRIVATE_IP" != "$EC_PUBLIC_IP" ]]; then
      if [[ -n "$HOST_PATTERNS" ]]; then
        HOST_PATTERNS="${HOST_PATTERNS}"$'\n'"  - \"${EC_PRIVATE_IP}\""
      else
        HOST_PATTERNS="  - \"${EC_PRIVATE_IP}\""
      fi
      echo -e "  Detected private IP: ${CYAN}${EC_PRIVATE_IP}${NC}"
    fi

    if [[ -z "$HOST_PATTERNS" ]]; then
      warn "Could not auto-detect server IP. You'll need to add host_patterns manually."
      warn "Edit edgeconnect/edgeConnect.yaml and add your server IP under host_patterns:"
    else
      echo -e "  ${GREEN}These IPs will be registered as EdgeConnect host patterns.${NC}"
      echo -e "  ${CYAN}The Dynatrace app will route API calls through EdgeConnect to reach this server.${NC}"
    fi

    # Build host_mappings to rewrite public/private IPs to localhost
    # On EC2, the public IP is NAT'd by VPC — not directly reachable from the instance.
    # EdgeConnect must map incoming requests for the public IP to 127.0.0.1
    HOST_MAPPINGS=""
    if [[ -n "$EC_PUBLIC_IP" && "$EC_PUBLIC_IP" != *"Not Found"* ]]; then
      HOST_MAPPINGS="  - from: \"${EC_PUBLIC_IP}\""$'\n'"    to: \"127.0.0.1\""
    fi
    if [[ -n "$EC_PRIVATE_IP" && "$EC_PRIVATE_IP" != "$EC_PUBLIC_IP" ]]; then
      if [[ -n "$HOST_MAPPINGS" ]]; then
        HOST_MAPPINGS="${HOST_MAPPINGS}"$'\n'"  - from: \"${EC_PRIVATE_IP}\""$'\n'"    to: \"127.0.0.1\""
      else
        HOST_MAPPINGS="  - from: \"${EC_PRIVATE_IP}\""$'\n'"    to: \"127.0.0.1\""
      fi
    fi

    # Generate edgeConnect.yaml with host_patterns and host_mappings
    cat > edgeconnect/edgeConnect.yaml << ECEOF
name: ${EC_NAME}
api_endpoint_host: ${EC_API_HOST}
host_patterns:
${HOST_PATTERNS:-  - "localhost"}
host_mappings:
${HOST_MAPPINGS:-  - from: "localhost"
    to: "127.0.0.1"}
oauth:
  client_id: ${EC_CLIENT_ID}
  client_secret: ${EC_CLIENT_SECRET}
  resource: ${EC_RESOURCE}
  endpoint: ${SSO_ENDPOINT}
ECEOF
    ok "Created edgeconnect/edgeConnect.yaml (with host patterns + mappings)"

    # Install Docker if needed
    if ! command -v docker &>/dev/null; then
      echo "  Installing Docker..."
      sudo yum install -y docker 2>/dev/null || sudo apt-get install -y docker.io 2>/dev/null
      sudo systemctl start docker
      sudo systemctl enable docker
      sudo usermod -aG docker "$(whoami)" 2>/dev/null || true
      ok "Docker installed"
    fi

    # Start Docker if not running
    if ! sudo docker info &>/dev/null 2>&1; then
      sudo systemctl start docker
    fi

    # Stop existing container if running
    CONTAINER_NAME="edgeconnect-${EC_NAME}"
    if sudo docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      sudo docker stop "$CONTAINER_NAME" 2>/dev/null || true
      sudo docker rm "$CONTAINER_NAME" 2>/dev/null || true
    fi

    echo "  Pulling EdgeConnect image..."
    sudo docker pull dynatrace/edgeconnect:latest 2>&1 | tail -2

    echo "  Starting EdgeConnect container..."
    EC_YAML_PATH="$(cd edgeconnect && pwd)/edgeConnect.yaml"
    sudo docker run -d --restart always \
      --name "$CONTAINER_NAME" \
      --network host \
      --mount "type=bind,src=${EC_YAML_PATH},dst=/edgeConnect.yaml" \
      dynatrace/edgeconnect:latest 2>&1

    sleep 5
    if sudo docker ps --filter "name=$CONTAINER_NAME" --format '{{.Status}}' | grep -q "Up"; then
      ok "EdgeConnect running — Dynatrace UI can now reach this server"
    else
      warn "EdgeConnect container may have issues. Check: sudo docker logs $CONTAINER_NAME"
    fi
  fi
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 8: Dynatrace OneAgent (full-stack monitoring)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step 8 "Dynatrace OneAgent (full-stack monitoring)"

if [[ -n "$SKIP_ONEAGENT" ]]; then
  warn "Skipped (--skip-oneagent flag)"
elif [[ -z "$DT_URL" ]]; then
  warn "Skipped — no Dynatrace URL configured"
elif [[ -f /opt/dynatrace/oneagent/agent/lib64/liboneagentproc.so ]]; then
  ok "OneAgent already installed"
else
  echo ""
  echo -e "  ${BOLD}OneAgent provides full-stack monitoring (processes, host metrics, logs).${NC}"
  echo -e "  ${CYAN}Get the installer command from Dynatrace:${NC}"
  echo -e "  ${CYAN}  Deploy Dynatrace → Start installation → Linux${NC}"
  echo -e "  ${CYAN}(or enter 'skip' to skip OneAgent)${NC}"
  echo ""
  echo -e "  ${BOLD}Paste the OneAgent download URL${NC}"
  echo -e "  ${CYAN}(looks like: https://TENANT.dynatrace.com/api/v1/deployment/installer/agent/unix/default/latest?...)${NC}"
  read -rp "  → " OA_URL

  if [[ "$OA_URL" == "skip" || -z "$OA_URL" ]]; then
    warn "OneAgent skipped — install later from Dynatrace → Deploy"
  else
    # Check disk space for OneAgent (~1.6GB)
    AVAIL_MB_OA=$(df -m / | awk 'NR==2 {print $4}')
    if [[ "$AVAIL_MB_OA" -lt 2048 ]]; then
      warn "Only $((AVAIL_MB_OA / 1024))GB free — OneAgent needs ~1.6GB. Resize volume first."
    else
      echo "  Downloading OneAgent..."
      OA_INSTALLER="/tmp/dynatrace-oneagent.sh"
      if curl -fsSL -o "$OA_INSTALLER" "$OA_URL"; then
        echo "  Installing OneAgent (this may take a minute)..."
        if sudo /bin/sh "$OA_INSTALLER" --set-monitoring-mode=fullstack --set-app-log-content-access=true 2>&1 | tail -5; then
          ok "OneAgent installed — host will appear in Dynatrace within 2 minutes"
        else
          warn "OneAgent install had issues. Check: /var/log/dynatrace/oneagent/installer/"
        fi
        rm -f "$OA_INSTALLER"
      else
        warn "Failed to download OneAgent — check the URL and try again"
      fi
    fi
  fi
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Done!
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║              Deployment Complete! 🎉                    ║${NC}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Server URL:${NC}     http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo localhost):8080"
echo -e "  ${BOLD}Health check:${NC}   curl http://localhost:8080/api/health"
echo -e "  ${BOLD}Logs:${NC}           tail -f logs/server.log"
echo -e "  ${BOLD}Stop:${NC}           bash stop.sh"
echo -e "  ${BOLD}Restart:${NC}        bash stop.sh && bash deploy.sh"
echo ""
if [[ -n "$DT_URL" ]]; then
  echo -e "  ${BOLD}Dynatrace:${NC}      $DT_URL"
  echo -e "  ${BOLD}AppEngine UI:${NC}   Dynatrace → Apps → Business Observability Demonstrator"
  echo -e "  ${BOLD}View traces:${NC}    Distributed Traces → Ingested traces tab"
  echo ""
  echo -e "  ${YELLOW}Remember to enable in Dynatrace Settings:${NC}"
  echo -e "    1. W3C Trace Context (Settings → OneAgent features)"
  echo -e "    2. OpenTelemetry (Node.js) (Settings → OneAgent features)"
  echo -e "    3. Span attributes allowlist (Settings → Span attributes)"
  echo -e "       Add: gen_ai.system, gen_ai.request.model, gen_ai.usage.prompt_tokens, etc."
fi
echo ""
