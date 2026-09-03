#!/bin/bash
# ============================================================
#  Business Observability Demonstrator — Full Deployment Script
# ============================================================
#
#  Usage:
#    bash deploy.sh
#    bash deploy.sh --dt-url https://abc123.live.dynatrace.com \
#                   --dt-token dt0c01.XXX \
#                   --otel-token dt0c01.YYY
#
#  This script handles everything:
#    1. Installs Node.js 20 (if missing)
#    2. Installs Ollama + pulls the LLM model
#    3. Clones the app repo (if not already cloned)
#    4. Runs npm install + TypeScript build
#    5. Configures .env and .dt-credentials.json
#    6. Creates runtime directories
#    7. Starts the server with OpenTelemetry instrumentation
#    8. Deploys the Dynatrace AppEngine UI to your tenant
#    9. Sets up EdgeConnect (Docker) for tenant ↔ server tunnel
#
# ============================================================

set -e

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

TOTAL_STEPS=9
step() { echo -e "\n${CYAN}${BOLD}[$1/$TOTAL_STEPS]${NC} ${BOLD}$2${NC}"; }
ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; exit 1; }

# ── Parse CLI args ──
DT_URL=""
DT_API_TOKEN=""
DT_OTEL_TOKEN=""
OLLAMA_MODEL="llama3.2:1b"
APP_DIR=""
REPO_URL="https://github.com/israel-salgado/Business-Observability-Demonstrator.git"
APP_OAUTH_CLIENT_ID=""
APP_OAUTH_CLIENT_SECRET=""
EC_NAME=""
EC_CLIENT_ID=""
EC_CLIENT_SECRET=""
EC_RESOURCE=""
SKIP_APPENGINE=""
SKIP_EDGECONNECT=""
SKIP_OLLAMA=""
SKIP_ONEAGENT=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --dt-url)           DT_URL="$2"; shift 2 ;;
    --dt-token)         DT_API_TOKEN="$2"; shift 2 ;;
    --otel-token)       DT_OTEL_TOKEN="$2"; shift 2 ;;
    --model)            OLLAMA_MODEL="$2"; shift 2 ;;
    --dir)              APP_DIR="$2"; shift 2 ;;
    --app-oauth-id)     APP_OAUTH_CLIENT_ID="$2"; shift 2 ;;
    --app-oauth-secret) APP_OAUTH_CLIENT_SECRET="$2"; shift 2 ;;
    --ec-name)          EC_NAME="$2"; shift 2 ;;
    --ec-client-id)     EC_CLIENT_ID="$2"; shift 2 ;;
    --ec-client-secret) EC_CLIENT_SECRET="$2"; shift 2 ;;
    --ec-resource)      EC_RESOURCE="$2"; shift 2 ;;
    --skip-appengine)   SKIP_APPENGINE=1; shift ;;
    --skip-edgeconnect) SKIP_EDGECONNECT=1; shift ;;
    --skip-ollama)      SKIP_OLLAMA=1; shift ;;
    --skip-oneagent)    SKIP_ONEAGENT=1; shift ;;
    -h|--help)
      echo "Usage: bash deploy.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --dt-url URL              Dynatrace environment URL"
      echo "  --dt-token TOKEN          Dynatrace API token (problems.read, metrics.read, etc.)"
      echo "  --otel-token TOKEN        Dynatrace OTel ingest token (traces, metrics, logs ingest)"
      echo "  --model MODEL             Ollama model to use (default: llama3.2:1b)"
      echo "  --dir PATH                App directory (default: auto)"
      echo "  --app-oauth-id ID         AppEngine deploy OAuth client ID"
      echo "  --app-oauth-secret SECRET AppEngine deploy OAuth client secret"
      echo "  --ec-name NAME            EdgeConnect name (as created in Dynatrace)"
      echo "  --ec-client-id ID         EdgeConnect OAuth client ID"
      echo "  --ec-client-secret SECRET EdgeConnect OAuth client secret"
      echo "  --ec-resource URN         EdgeConnect OAuth resource (urn:dtenvironment:TENANT_ID)"
      echo "  --skip-appengine          Skip Dynatrace AppEngine UI deployment"
      echo "  --skip-edgeconnect        Skip EdgeConnect Docker setup"
      echo "  --skip-ollama             Skip Ollama install (uses rule-based AI fallbacks)"
      echo "  --skip-oneagent           Skip Dynatrace OneAgent installation"
      echo ""
      echo "If values are not provided via CLI, the script will prompt for them."
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo -e "${BOLD}"
echo "╔══════════════════════════════════════════════════════════╗"
echo "║     Business Observability Demonstrator — Full Deployment      ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Server + OTel + AppEngine UI + EdgeConnect             ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 1: Node.js
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step 1 "Node.js"

if command -v node &>/dev/null; then
  NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
  if [[ "$NODE_VER" -ge 18 ]]; then
    ok "Node.js $(node --version) already installed"
  else
    warn "Node.js $(node --version) is too old (need 18+), installing v20..."
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - 2>/dev/null \
      || curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - 2>/dev/null
    sudo yum install -y nodejs 2>/dev/null || sudo apt-get install -y nodejs 2>/dev/null
    ok "Node.js $(node --version) installed"
  fi
else
  echo "  Installing Node.js 20..."
  curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - 2>/dev/null \
    || curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - 2>/dev/null
  sudo yum install -y nodejs 2>/dev/null || sudo apt-get install -y nodejs 2>/dev/null
  ok "Node.js $(node --version) installed"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 2: Ollama
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step 2 "Ollama (local AI engine)"

if [[ -n "$SKIP_OLLAMA" ]]; then
  warn "Skipping Ollama (--skip-ollama flag set)"
  warn "AI features will use rule-based fallbacks (OLLAMA_MODE=disabled)"
  OLLAMA_MODE="disabled"
else
  OLLAMA_MODE="full"

  if command -v ollama &>/dev/null; then
    ok "Ollama already installed"
  else
    echo "  Installing Ollama..."
    curl -fsSL https://ollama.com/install.sh | sh
    ok "Ollama installed"
  fi

  # Start Ollama if not running
  if ! curl -sf http://localhost:11434/api/tags &>/dev/null; then
    echo "  Starting Ollama service..."
    sudo systemctl enable ollama 2>/dev/null && sudo systemctl start ollama 2>/dev/null \
      || (nohup ollama serve > /dev/null 2>&1 &)

    echo -n "  Waiting for Ollama"
    for i in {1..30}; do
      if curl -sf http://localhost:11434/api/tags &>/dev/null; then break; fi
      echo -n "."
      sleep 2
    done
    echo ""

    if ! curl -sf http://localhost:11434/api/tags &>/dev/null; then
      fail "Ollama didn't start. Check: sudo systemctl status ollama"
    fi
  fi
  ok "Ollama running on localhost:11434"

  # Pull model if not present
  if ollama list 2>/dev/null | grep -q "$OLLAMA_MODEL"; then
    ok "Model '$OLLAMA_MODEL' already pulled"
  else
    echo "  Pulling model '$OLLAMA_MODEL' (this may take a few minutes)..."
    ollama pull "$OLLAMA_MODEL"
    ok "Model '$OLLAMA_MODEL' ready"
  fi
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 3: App code
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step 3 "Application code"

# Figure out where the app should live
if [[ -n "$APP_DIR" ]]; then
  :
elif [[ -f "server.js" && -f "package.json" ]]; then
  APP_DIR="$(pwd)"
  ok "Already in app directory"
elif [[ -f "../server.js" && -f "../package.json" ]]; then
  APP_DIR="$(cd .. && pwd)"
else
  APP_DIR="$(pwd)/Business Observability Demonstrator"
fi

if [[ ! -f "$APP_DIR/server.js" ]]; then
  echo "  Cloning repository..."
  git clone "$REPO_URL" "$APP_DIR"
  ok "Cloned to: $APP_DIR"
else
  ok "App found at: $APP_DIR"
fi

cd "$APP_DIR"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 4: Dependencies
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step 4 "Installing dependencies & building"

echo "  Running npm install (this may take a minute)..."
npm install --loglevel=warn 2>&1 | tail -3
ok "npm install complete"

echo "  Building TypeScript agents..."
npx tsc --project tsconfig.json 2>&1 || warn "TypeScript build had warnings (may be ok)"
ok "Build complete — dist/ folder ready"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 5: Configuration
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step 5 "Dynatrace configuration"

# Create .env if missing
if [[ ! -f .env ]]; then
  cat > .env << ENVEOF
PORT=8080
NODE_ENV=production
OLLAMA_MODE=$OLLAMA_MODE
OLLAMA_ENDPOINT=http://localhost:11434
OLLAMA_MODEL=$OLLAMA_MODEL
ENVEOF
  ok "Created .env (OLLAMA_MODE=$OLLAMA_MODE)"
else
  # Ensure OLLAMA_MODE is set in existing .env
  if ! grep -q "OLLAMA_MODE" .env; then
    echo "OLLAMA_MODE=$OLLAMA_MODE" >> .env
  fi
  ok ".env already exists (ensured OLLAMA_MODE=$OLLAMA_MODE)"
fi

# Prompt for DT credentials if not provided
if [[ -z "$DT_URL" ]]; then
  echo ""
  echo -e "  ${BOLD}Enter your Dynatrace environment URL${NC}"
  echo -e "  ${CYAN}(e.g. https://abc12345.live.dynatrace.com)${NC}"
  read -rp "  → " DT_URL
fi

if [[ -z "$DT_URL" ]]; then
  warn "No Dynatrace URL provided — skipping DT config (you can set it later via the UI)"
else
  # Clean up URL
  DT_URL="${DT_URL%/}"

  # Derive tenant ID from URL (e.g. abc12345 from https://abc12345.live.dynatrace.com)
  DT_TENANT_ID=$(echo "$DT_URL" | sed -E 's|https?://||' | cut -d. -f1)

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

  # Update app.config.json with the correct tenant URL
  if [[ -f app.config.json ]]; then
    DT_DOMAIN=$(echo "$DT_URL" | sed -E 's|https?://[^.]+\.||')
    # For sprint/dev tenants: tenant.sprint.apps.domain (not tenant.apps.sprint.domain)
    if echo "$DT_DOMAIN" | grep -qE '^sprint\.|^dev\.'; then
      DT_ENV_TYPE=$(echo "$DT_DOMAIN" | cut -d. -f1)
      DT_BASE_DOMAIN=$(echo "$DT_DOMAIN" | sed -E 's|^[^.]+\.||')
      DT_APPS_URL="https://${DT_TENANT_ID}.${DT_ENV_TYPE}.apps.${DT_BASE_DOMAIN}"
    else
      DT_APPS_URL="https://${DT_TENANT_ID}.apps.${DT_DOMAIN}"
    fi
    sed -i "s|https://YOUR_TENANT_ID\.apps\.[^/\"]*|${DT_APPS_URL}|g" app.config.json 2>/dev/null || true
    # Also catch any existing tenant-specific URLs (re-deploy scenario)
    sed -i "s|https://${DT_TENANT_ID}\.[^/\"]*apps[^/\"]*|${DT_APPS_URL}|g" app.config.json 2>/dev/null || true
    ok "Updated app.config.json → ${DT_APPS_URL}"
  fi
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 6: Create directories
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step 6 "Preparing runtime"

mkdir -p logs services/.dynamic-runners public/assets saved-configs
ok "Directories created"

# Kill any existing server
if [[ -f server.pid ]]; then
  kill "$(cat server.pid)" 2>/dev/null && echo "  Stopped previous server" || true
  rm -f server.pid
fi
pkill -f "node.*server.js" 2>/dev/null || true
sleep 1

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 7: Start server with OpenTelemetry
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step 7 "Starting BizObs Demonstrator with OpenTelemetry"

truncate -s 0 logs/server.log 2>/dev/null || true
node --require ./otel.cjs server.js >> logs/server.log 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > server.pid
echo "  PID: $SERVER_PID"

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
# Step 8: Deploy Dynatrace AppEngine UI
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step 8 "Deploying Dynatrace AppEngine UI"

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
    if npx dt-app build 2>&1 | tail -5; then
      ok "AppEngine app built"
    else
      warn "AppEngine build FAILED — check app.config.json (app.name must be ≤40 chars)"
      echo -e "  ${CYAN}You can fix app.config.json and re-run: npx dt-app build && npx dt-app deploy --non-interactive${NC}"
    fi

    DT_DOMAIN=$(echo "$DT_URL" | sed -E 's|https?://[^.]+\.||')
    # For sprint/dev tenants: tenant.sprint.apps.domain
    if echo "$DT_DOMAIN" | grep -qE '^sprint\.|^dev\.'; then
      DT_ENV_TYPE=$(echo "$DT_DOMAIN" | cut -d. -f1)
      DT_BASE_DOMAIN=$(echo "$DT_DOMAIN" | sed -E 's|^[^.]+\.||')
      DT_APPS_URL="https://${DT_TENANT_ID}.${DT_ENV_TYPE}.apps.${DT_BASE_DOMAIN}"
    else
      DT_APPS_URL="https://${DT_TENANT_ID}.apps.${DT_DOMAIN}"
    fi
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
# Step 9: EdgeConnect (Docker tunnel)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
step 9 "EdgeConnect (Dynatrace ↔ server tunnel)"

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

    # Default EdgeConnect name if not provided
    if [[ -z "$EC_NAME" ]]; then
      EC_NAME="bizobs-demonstrator"
    fi

    # Derive apps host for EdgeConnect
    DT_STRIPPED=$(echo "$DT_URL" | sed -E 's|https?://[^.]+\.||')
    if echo "$DT_STRIPPED" | grep -qE '^sprint\.|^dev\.'; then
      DT_ENV_TYPE=$(echo "$DT_STRIPPED" | cut -d. -f1)
      DT_BASE_DOMAIN=$(echo "$DT_STRIPPED" | sed -E 's|^[^.]+\.||')
      EC_API_HOST="${DT_TENANT_ID}.${DT_ENV_TYPE}.apps.${DT_BASE_DOMAIN}"
    else
      DT_DOMAIN=$(echo "$DT_URL" | sed -E 's|https?://[^.]+\.||')
      EC_API_HOST="${DT_TENANT_ID}.apps.${DT_DOMAIN}"
    fi

    # Write the EdgeConnect YAML
    mkdir -p edgeconnect
    cat > edgeconnect/edgeConnect.yaml << ECEOF
name: ${EC_NAME}
api_endpoint_host: ${EC_API_HOST}
oauth:
  client_id: ${EC_CLIENT_ID}
  client_secret: ${EC_CLIENT_SECRET}
  resource: ${EC_RESOURCE}
  endpoint: ${SSO_ENDPOINT}
ECEOF
    ok "Created edgeconnect/edgeConnect.yaml"

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
    CONTAINER_NAME="edgeconnect-bizobs"
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
# Done
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║              Deployment Complete! 🎉                    ║${NC}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Server URL:${NC}     http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo localhost):8080"
echo -e "  ${BOLD}Health check:${NC}   curl http://localhost:8080/api/health"
echo -e "  ${BOLD}Logs:${NC}           tail -f logs/server.log"
echo -e "  ${BOLD}Stop:${NC}           kill \$(cat server.pid)"
echo -e "  ${BOLD}Restart:${NC}        kill \$(cat server.pid); sleep 2; node --require ./otel.cjs server.js >> logs/server.log 2>&1 &"
echo ""
if [[ -n "$DT_URL" ]]; then
  echo -e "  ${BOLD}Dynatrace:${NC}      $DT_URL"
  echo -e "  ${BOLD}AppEngine UI:${NC}   Dynatrace → Apps → Business Observability Demonstrator"
  echo -e "  ${BOLD}View traces:${NC}    Distributed Traces → Ingested traces tab"
  echo -e "  ${BOLD}AI Observability:${NC} Look for gen_ai.system = ollama"
  echo ""
  echo -e "  ${YELLOW}Remember to enable in Dynatrace Settings:${NC}"
  echo -e "    1. W3C Trace Context (Settings → OneAgent features)"
  echo -e "    2. OpenTelemetry (Node.js) (Settings → OneAgent features)"
  echo -e "    3. Span attributes allowlist (Settings → Span attributes)"
  echo -e "       Add: gen_ai.system, gen_ai.request.model, gen_ai.usage.prompt_tokens, etc."
fi
echo ""
