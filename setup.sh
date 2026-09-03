#!/bin/bash
# ============================================================
#  Business Observability Demonstrator — One-Command Setup
# ============================================================
#  Usage:
#    git clone https://github.com/israel-salgado/Business-Observability-Demonstrator.git
#    cd Dynatrace-Business-Outcome-Engine && ./setup.sh
#
#  The script will prompt you for values if setup.conf doesn't exist.
#  Or pre-fill setup.conf and it runs non-interactively.
# ============================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF_FILE="$SCRIPT_DIR/setup.conf"

# ── Colors ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
step() { echo -e "\n${BLUE}━━━ $1 ━━━${NC}"; }
ok()   { echo -e "  ${GREEN}✓ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠ $1${NC}"; }
fail() { echo -e "  ${RED}✗ $1${NC}"; exit 1; }

echo -e "${BLUE}"
cat << 'BANNER'
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║     Business Observability Demonstrator                             ║
║     One-Command Setup                                        ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
BANNER
echo -e "${NC}"

# ── Collect credentials ─────────────────────────────────────
# If setup.conf exists and is filled in, use it silently.
# Otherwise, prompt interactively.

if [ -f "$CONF_FILE" ]; then
  source "$CONF_FILE"
fi

prompt_if_missing() {
  local var_name="$1"
  local prompt_text="$2"
  local placeholder="$3"
  local current_val="${!var_name}"

  if [ -z "$current_val" ] || [ "$current_val" = "$placeholder" ]; then
    echo -ne "  ${CYAN}${prompt_text}${NC} "
    read -r input
    if [ -z "$input" ]; then
      fail "$var_name is required. Cannot continue."
    fi
    eval "$var_name=\"$input\""
  fi
}

prompt_optional() {
  local var_name="$1"
  local prompt_text="$2"
  local fallback_var="$3"
  local current_val="${!var_name}"

  if [ -z "$current_val" ]; then
    echo -ne "  ${CYAN}${prompt_text}${NC} "
    read -r input
    if [ -z "$input" ]; then
      eval "$var_name=\"${!fallback_var}\""
      echo -e "  ${GREEN}  → Using same as EdgeConnect${NC}"
    else
      eval "$var_name=\"$input\""
    fi
  fi
}

prompt_optional_blank() {
  local var_name="$1"
  local prompt_text="$2"
  local current_val="${!var_name}"

  if [ -z "$current_val" ]; then
    echo -ne "  ${CYAN}${prompt_text}${NC} "
    read -r input
    eval "$var_name=\"$input\""
  fi
}

NEED_PROMPT=false
if [ -z "$TENANT_ID" ] || [ "$TENANT_ID" = "YOUR_TENANT_ID" ] || \
   [ -z "$ENV_TYPE" ] || \
   [ -z "$API_TOKEN" ] || [[ "$API_TOKEN" == *"XXXX"* ]] || \
  [ -z "$DT_PLATFORM_TOKEN" ] || [[ "$DT_PLATFORM_TOKEN" == *"XXXX"* ]] || \
   [ -z "$EC_OAUTH_CLIENT_ID" ] || [[ "$EC_OAUTH_CLIENT_ID" == *"XXXX"* ]] || \
   [ -z "$EC_OAUTH_CLIENT_SECRET" ] || [[ "$EC_OAUTH_CLIENT_SECRET" == *"YYYY"* ]]; then
  # Support legacy setup.conf that used OAUTH_CLIENT_ID
  if [ -n "$OAUTH_CLIENT_ID" ] && [ -z "$EC_OAUTH_CLIENT_ID" ]; then
    EC_OAUTH_CLIENT_ID="$OAUTH_CLIENT_ID"
    EC_OAUTH_CLIENT_SECRET="$OAUTH_CLIENT_SECRET"
    DEPLOY_OAUTH_CLIENT_ID="$OAUTH_CLIENT_ID"
    DEPLOY_OAUTH_CLIENT_SECRET="$OAUTH_CLIENT_SECRET"
    [ -z "$ENV_TYPE" ] && ENV_TYPE="sprint"
  else
    NEED_PROMPT=true
  fi
fi

if [ "$NEED_PROMPT" = true ]; then
  echo -e "${BOLD}  The prompts below tell you where to find each value.${NC}"
  echo ""

  # 1. Environment type
  echo -e "  ${CYAN}─── 1/6: Environment Type ───${NC}"
  echo -e "  ${YELLOW}What kind of Dynatrace tenant are you using?${NC}"
  echo -e "  ${YELLOW}  1) Sprint   (URL like: abc12345.sprint.dynatracelabs.com)${NC}"
  echo -e "  ${YELLOW}  2) Prod/Live (URL like: abc12345.live.dynatrace.com or abc12345.apps.dynatrace.com)${NC}"
  if [ -z "$ENV_TYPE" ] || [ "$ENV_TYPE" = "YOUR_ENV_TYPE" ]; then
    echo -ne "  ${CYAN}Enter 1 or 2 [1]:${NC} "
    read -r env_choice
    case "$env_choice" in
      2) ENV_TYPE="prod" ;;
      *) ENV_TYPE="sprint" ;;
    esac
  fi
  ok "Environment: $ENV_TYPE"
  echo ""

  # 2. Tenant ID
  echo -e "  ${CYAN}─── 2/6: Tenant ID ───${NC}"
  if [ "$ENV_TYPE" = "sprint" ]; then
    echo -e "  ${YELLOW}Look at your Dynatrace URL: https://${BOLD}<THIS-PART>${NC}${YELLOW}.sprint.dynatracelabs.com${NC}"
  else
    echo -e "  ${YELLOW}Look at your Dynatrace URL: https://${BOLD}<THIS-PART>${NC}${YELLOW}.live.dynatrace.com${NC}"
  fi
  prompt_if_missing "TENANT_ID" "Tenant ID:" "YOUR_TENANT_ID"
  echo ""

  # 3. API Token
  echo -e "  ${CYAN}─── 3/6: API Token ───${NC}"
  echo -e "  ${YELLOW}Dynatrace → Settings → Access Tokens → Generate new token${NC}"
  echo -e "  ${YELLOW}Scopes: events.ingest, metrics.ingest, openTelemetryTrace.ingest, entities.read${NC}"
  echo -e "  ${YELLOW}Starts with: dt0c01.${NC}"
  prompt_if_missing "API_TOKEN" "API Token:" "dt0c01.XXXX..."
  echo ""

  # 4. DT Platform Token (for dtctl dashboard apply)
  echo -e "  ${CYAN}─── 4/7: DT Platform Token (dtctl) ───${NC}"
  echo -e "  ${YELLOW}Needed for bespoke dashboard deployment via dtctl.${NC}"
  echo -e "  ${YELLOW}Use a platform token (typically dt0s16.*), not an ingest token.${NC}"
  echo -e "  ${YELLOW}Minimum scopes:${NC}"
  echo -e "  ${YELLOW}  • document:documents:write${NC}"
  echo -e "  ${YELLOW}Recommended:${NC}"
  echo -e "  ${YELLOW}  • document:documents:read${NC}"
  echo -e "  ${YELLOW}Optional (only if you want environment-wide sharing):${NC}"
  echo -e "  ${YELLOW}  • document:environment-shares:write${NC}"
  echo -e "  ${YELLOW}Recommended:${NC}"
  echo -e "  ${YELLOW}  • document:documents:read${NC}"
  prompt_if_missing "DT_PLATFORM_TOKEN" "DT Platform Token:" "dt0s16.XXXX..."
  echo ""

  # 5. EdgeConnect OAuth Client ID
  echo -e "  ${CYAN}─── 5/7: EdgeConnect OAuth Client ID ───${NC}"
  echo -e "  ${YELLOW}Dynatrace → Settings → General → External Requests → Add EdgeConnect${NC}"
  echo -e "  ${YELLOW}DT generates the OAuth credentials — copy the Client ID${NC}"
  echo -e "  ${YELLOW}Starts with: dt0s10. or dt0s02. (depends on your tenant)${NC}"
  echo -e "  ${YELLOW}Has scope: app-engine:edge-connects:connect (added automatically)${NC}"
  prompt_if_missing "EC_OAUTH_CLIENT_ID" "EdgeConnect OAuth Client ID:" "dt0s10.XXXX"
  echo ""

  # 6. EdgeConnect OAuth Client Secret
  echo -e "  ${CYAN}─── 6/7: EdgeConnect OAuth Client Secret ───${NC}"
  echo -e "  ${YELLOW}Same page — shown only once when you create the EdgeConnect!${NC}"
  echo -e "  ${YELLOW}Starts with same prefix as the ID (dt0s10. or dt0s02.)${NC}"
  prompt_if_missing "EC_OAUTH_CLIENT_SECRET" "EdgeConnect OAuth Client Secret:" "dt0s10.XXXX.YYYY..."
  echo ""

  # 7. AppEngine Deploy OAuth (can be same or different)
  echo -e "  ${CYAN}─── 7/7: AppEngine Deploy OAuth ───${NC}"
  echo -e "  ${YELLOW}This deploys the Demonstrator UI to your Dynatrace Apps.${NC}"
  echo -e "  ${YELLOW}Can be the SAME client as EdgeConnect (if you added deploy scopes to it)${NC}"
  echo -e "  ${YELLOW}OR a different OAuth client. Accepts dt0s10 (env-level) or dt0s02 (account-level).${NC}"
  echo -e "  ${YELLOW}Required scopes:${NC}"
  echo -e "  ${YELLOW}  • app-engine:apps:install${NC}"
  echo -e "  ${YELLOW}  • app-engine:apps:run${NC}"
  echo -e "  ${YELLOW}Press Enter to use the same EdgeConnect client, or paste a different one.${NC}"
  prompt_optional "DEPLOY_OAUTH_CLIENT_ID" "Deploy OAuth Client ID (Enter = same):" "EC_OAUTH_CLIENT_ID"
  prompt_optional "DEPLOY_OAUTH_CLIENT_SECRET" "Deploy OAuth Client Secret (Enter = same):" "EC_OAUTH_CLIENT_SECRET"
  echo ""

  echo -e "  ${CYAN}Optional: Access Request Auto-Provisioning (for /access-request.html)${NC}"
  echo -e "  ${YELLOW}Press Enter to skip for now. You can fill these later in setup.conf.${NC}"
  prompt_optional_blank "DT_ACCOUNT_ID" "Dynatrace Account ID (optional):"
  prompt_optional_blank "DT_ACCESS_GROUP_UUID" "Access Group UUID for new users (optional):"
  prompt_optional_blank "DT_ACCOUNT_OAUTH_CLIENT_ID" "Account OAuth Client ID (optional):"
  prompt_optional_blank "DT_ACCOUNT_OAUTH_CLIENT_SECRET" "Account OAuth Client Secret (optional):"
  prompt_optional_blank "DT_ACCOUNT_RESOURCE" "OAuth Resource (optional, e.g. urn:dtaccount:<id>):"
  prompt_optional_blank "DT_ACCOUNT_TOKEN_URL" "OAuth Token URL (optional, Enter to auto by ENV_TYPE):"
  echo ""
fi

# ── Validate credential formats (always, even from setup.conf) ──
# Default DEPLOY creds to EdgeConnect creds if not set (backward compat)
[ -z "$DEPLOY_OAUTH_CLIENT_ID" ] && DEPLOY_OAUTH_CLIENT_ID="$EC_OAUTH_CLIENT_ID"
[ -z "$DEPLOY_OAUTH_CLIENT_SECRET" ] && DEPLOY_OAUTH_CLIENT_SECRET="$EC_OAUTH_CLIENT_SECRET"
[ -z "$ENV_TYPE" ] && ENV_TYPE="sprint"

if [[ ! "$API_TOKEN" == dt0c01.* ]]; then
  fail "API Token must start with 'dt0c01.' — you entered '${API_TOKEN:0:10}...'. Delete setup.conf and re-run ./setup.sh"
fi

if [[ ! "$DT_PLATFORM_TOKEN" == dt0s*.* ]]; then
  fail "DT Platform Token must be a platform token (expected dt0s*.*). Update setup.conf and re-run ./setup.sh"
fi

# EdgeConnect OAuth — accepts dt0s10 (environment-level) or dt0s02 (account-level)
# Some DT tenants generate dt0s02 for EdgeConnect, others dt0s10
if [[ ! "$EC_OAUTH_CLIENT_ID" == dt0s10.* ]] && [[ ! "$EC_OAUTH_CLIENT_ID" == dt0s02.* ]]; then
  echo -e "  ${RED}✗ EdgeConnect OAuth Client ID must start with 'dt0s10.' or 'dt0s02.'${NC}"
  echo -e "  ${YELLOW}  You entered '${EC_OAUTH_CLIENT_ID:0:12}...'${NC}"
  echo -e "  ${YELLOW}  Create it in: Dynatrace → Settings → General → External Requests → Add EdgeConnect${NC}"
  echo -e "  ${YELLOW}  Delete setup.conf and re-run ./setup.sh${NC}"
  exit 1
fi
if [[ ! "$EC_OAUTH_CLIENT_SECRET" == dt0s10.* ]] && [[ ! "$EC_OAUTH_CLIENT_SECRET" == dt0s02.* ]]; then
  echo -e "  ${RED}✗ EdgeConnect OAuth Client Secret must start with 'dt0s10.' or 'dt0s02.'${NC}"
  echo -e "  ${YELLOW}  Delete setup.conf and re-run ./setup.sh${NC}"
  exit 1
fi

# Deploy OAuth can be dt0s10 (environment-level) OR dt0s02 (account-level)
if [[ ! "$DEPLOY_OAUTH_CLIENT_ID" == dt0s10.* ]] && [[ ! "$DEPLOY_OAUTH_CLIENT_ID" == dt0s02.* ]]; then
  echo -e "  ${RED}✗ Deploy OAuth Client ID must start with 'dt0s10.' or 'dt0s02.'${NC}"
  echo -e "  ${YELLOW}  You entered '${DEPLOY_OAUTH_CLIENT_ID:0:12}...'${NC}"
  echo -e "  ${YELLOW}  Delete setup.conf and re-run ./setup.sh${NC}"
  exit 1
fi
if [[ ! "$DEPLOY_OAUTH_CLIENT_SECRET" == dt0s10.* ]] && [[ ! "$DEPLOY_OAUTH_CLIENT_SECRET" == dt0s02.* ]]; then
  echo -e "  ${RED}✗ Deploy OAuth Client Secret must start with 'dt0s10.' or 'dt0s02.'${NC}"
  echo -e "  ${YELLOW}  Delete setup.conf and re-run ./setup.sh${NC}"
  exit 1
fi

# Detect swapped ID/secret — Client IDs have 2 dot-separated parts, secrets have 3
EC_ID_DOTS=$(echo "$EC_OAUTH_CLIENT_ID" | tr -cd '.' | wc -c)
EC_SECRET_DOTS=$(echo "$EC_OAUTH_CLIENT_SECRET" | tr -cd '.' | wc -c)
DEPLOY_ID_DOTS=$(echo "$DEPLOY_OAUTH_CLIENT_ID" | tr -cd '.' | wc -c)
DEPLOY_SECRET_DOTS=$(echo "$DEPLOY_OAUTH_CLIENT_SECRET" | tr -cd '.' | wc -c)

if [ "$EC_ID_DOTS" -gt 1 ]; then
  echo -e "  ${RED}✗ EdgeConnect OAuth Client ID looks like a secret (too many parts).${NC}"
  echo -e "  ${YELLOW}  Client ID format:     dt0s10.XXXXXXXX  (2 parts)${NC}"
  echo -e "  ${YELLOW}  Client Secret format:  dt0s10.XXXXXXXX.YYYYYYYY...  (3 parts)${NC}"
  echo -e "  ${YELLOW}  You entered: '${EC_OAUTH_CLIENT_ID:0:20}...'${NC}"
  echo -e "  ${YELLOW}  Delete setup.conf and re-run ./setup.sh${NC}"
  exit 1
fi
if [ "$EC_SECRET_DOTS" -lt 2 ]; then
  echo -e "  ${RED}✗ EdgeConnect OAuth Client Secret looks like a client ID (too short).${NC}"
  echo -e "  ${YELLOW}  Client Secret format:  dt0s10.XXXXXXXX.YYYYYYYY...  (3 parts)${NC}"
  echo -e "  ${YELLOW}  Delete setup.conf and re-run ./setup.sh${NC}"
  exit 1
fi
if [ "$DEPLOY_ID_DOTS" -gt 1 ]; then
  echo -e "  ${RED}✗ Deploy OAuth Client ID looks like a secret (too many parts).${NC}"
  echo -e "  ${YELLOW}  Client ID format:     dt0s10.XXXXXXXX  (2 parts)${NC}"
  echo -e "  ${YELLOW}  Client Secret format:  dt0s10.XXXXXXXX.YYYYYYYY...  (3 parts)${NC}"
  echo -e "  ${YELLOW}  You entered: '${DEPLOY_OAUTH_CLIENT_ID:0:20}...'${NC}"
  echo -e "  ${YELLOW}  Delete setup.conf and re-run ./setup.sh${NC}"
  exit 1
fi
if [ "$DEPLOY_SECRET_DOTS" -lt 2 ]; then
  echo -e "  ${RED}✗ Deploy OAuth Client Secret looks like a client ID (too short).${NC}"
  echo -e "  ${YELLOW}  Client Secret format:  dt0s10.XXXXXXXX.YYYYYYYY...  (3 parts)${NC}"
  echo -e "  ${YELLOW}  Delete setup.conf and re-run ./setup.sh${NC}"
  exit 1
fi

# Save valid credentials for future runs
if [ "$NEED_PROMPT" = true ]; then
  cat > "$CONF_FILE" << EOF
ENV_TYPE="$ENV_TYPE"
TENANT_ID="$TENANT_ID"
API_TOKEN="$API_TOKEN"
DT_PLATFORM_TOKEN="$DT_PLATFORM_TOKEN"
EC_OAUTH_CLIENT_ID="$EC_OAUTH_CLIENT_ID"
EC_OAUTH_CLIENT_SECRET="$EC_OAUTH_CLIENT_SECRET"
DEPLOY_OAUTH_CLIENT_ID="$DEPLOY_OAUTH_CLIENT_ID"
DEPLOY_OAUTH_CLIENT_SECRET="$DEPLOY_OAUTH_CLIENT_SECRET"
DT_ACCOUNT_ID="$DT_ACCOUNT_ID"
DT_ACCESS_GROUP_UUID="$DT_ACCESS_GROUP_UUID"
DT_ACCOUNT_OAUTH_CLIENT_ID="$DT_ACCOUNT_OAUTH_CLIENT_ID"
DT_ACCOUNT_OAUTH_CLIENT_SECRET="$DT_ACCOUNT_OAUTH_CLIENT_SECRET"
DT_ACCOUNT_RESOURCE="$DT_ACCOUNT_RESOURCE"
DT_ACCOUNT_TOKEN_URL="$DT_ACCOUNT_TOKEN_URL"
EOF
  ok "Saved to setup.conf (won't ask again)"
fi

# Derive URLs based on environment type
if [ "$ENV_TYPE" = "prod" ]; then
  TENANT_URL="https://${TENANT_ID}.live.dynatrace.com"
  APPS_URL="https://${TENANT_ID}.apps.dynatrace.com"
  SSO_URL="https://sso.dynatrace.com/sso/oauth2/token"
else
  TENANT_URL="https://${TENANT_ID}.sprint.dynatracelabs.com"
  APPS_URL="https://${TENANT_ID}.sprint.apps.dynatracelabs.com"
  SSO_URL="https://sso-sprint.dynatracelabs.com/sso/oauth2/token"
fi
PRIVATE_IP=$(hostname -I | awk '{print $1}')

echo -e "  Tenant:     ${BOLD}$TENANT_URL${NC}"
echo -e "  Private IP: ${BOLD}$PRIVATE_IP${NC}"

# Persist runtime vars used by the server (dotenv loads .env automatically).
ENV_FILE="$SCRIPT_DIR/.env"
upsert_env_var() {
  local key="$1"
  local value="$2"
  if [ -f "$ENV_FILE" ] && grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}

upsert_env_var "ENV_TYPE" "$ENV_TYPE"
upsert_env_var "DT_PLATFORM_TOKEN" "$DT_PLATFORM_TOKEN"
upsert_env_var "DT_ENVIRONMENT" "$APPS_URL"
upsert_env_var "DT_ACCOUNT_ID" "$DT_ACCOUNT_ID"
upsert_env_var "DT_ACCESS_GROUP_UUID" "$DT_ACCESS_GROUP_UUID"
upsert_env_var "DT_ACCOUNT_OAUTH_CLIENT_ID" "$DT_ACCOUNT_OAUTH_CLIENT_ID"
upsert_env_var "DT_ACCOUNT_OAUTH_CLIENT_SECRET" "$DT_ACCOUNT_OAUTH_CLIENT_SECRET"
upsert_env_var "DT_ACCOUNT_RESOURCE" "$DT_ACCOUNT_RESOURCE"
upsert_env_var "DT_ACCOUNT_TOKEN_URL" "$DT_ACCOUNT_TOKEN_URL"

# ── Step 1: Prerequisites ──────────────────────────────────
step "Step 1/6: Checking prerequisites"

install_node22() {
  echo "  Installing Node.js v22..."
  # Remove old Node.js first (dnf/yum won't upgrade if already installed from default repo)
  if command -v node &>/dev/null; then
    echo "  Removing old Node.js $(node --version)..."
    sudo dnf remove -y nodejs npm 2>/dev/null || sudo yum remove -y nodejs npm 2>/dev/null || sudo apt-get remove -y nodejs npm 2>/dev/null || true
    hash -r 2>/dev/null || true
  fi

  local PKG_OK=false

  if command -v dnf &>/dev/null; then
    # Amazon Linux 2023 / Fedora / RHEL 9+
    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - 2>&1 | tail -1
    sudo dnf install -y nodejs 2>&1 | tail -3
    command -v node &>/dev/null && PKG_OK=true
  elif command -v yum &>/dev/null; then
    # Amazon Linux 2 / RHEL 7-8 / CentOS
    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - 2>&1 | tail -1
    sudo yum install -y nodejs 2>&1 | tail -3
    command -v node &>/dev/null && PKG_OK=true
  elif command -v apt-get &>/dev/null; then
    # Ubuntu / Debian / GCP default
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - 2>&1 | tail -3
    sudo apt-get install -y nodejs 2>&1 | tail -3
    command -v node &>/dev/null && PKG_OK=true
  fi

  # Refresh path after package install
  hash -r 2>/dev/null || true

  # Fallback: if package manager failed, use Node.js official binary tarball
  if [ "$PKG_OK" = false ] || ! command -v node &>/dev/null; then
    echo "  Package manager install failed — falling back to Node.js binary tarball..."
    local ARCH
    ARCH=$(uname -m)
    case "$ARCH" in
      x86_64)  ARCH="x64" ;;
      aarch64) ARCH="arm64" ;;
      armv7l)  ARCH="armv7l" ;;
      *)       fail "Unsupported architecture: $ARCH. Install Node.js v22+ manually: https://nodejs.org" ;;
    esac
    local NODE_TAR="node-v22.15.0-linux-${ARCH}.tar.xz"
    local NODE_URL="https://nodejs.org/dist/v22.15.0/${NODE_TAR}"
    echo "  Downloading ${NODE_URL}..."
    curl -fsSL "$NODE_URL" -o "/tmp/${NODE_TAR}" || fail "Failed to download Node.js tarball from ${NODE_URL}"
    echo "  Extracting to /usr/local..."
    sudo tar -xJf "/tmp/${NODE_TAR}" -C /usr/local --strip-components=1
    rm -f "/tmp/${NODE_TAR}"
    hash -r 2>/dev/null || true
  fi

  # Final refresh
  hash -r 2>/dev/null || true
}

NEED_NODE=false
if ! command -v node &>/dev/null; then
  NEED_NODE=true
else
  NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -lt 22 ]; then
    warn "Node.js $(node --version) found but v22+ required — upgrading..."
    NEED_NODE=true
  fi
fi

if [ "$NEED_NODE" = true ]; then
  install_node22
  if ! command -v node &>/dev/null; then
    fail "Node.js installation failed. Install v22+ manually: https://nodejs.org"
  fi
  NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -lt 22 ]; then
    fail "Node.js v22+ required but got $(node --version) after install. Install manually."
  fi
fi
ok "Node.js $(node --version)"

if ! command -v docker &>/dev/null; then
  echo "  Installing Docker..."
  sudo yum install -y docker 2>/dev/null || sudo apt-get install -y docker.io 2>/dev/null
  sudo systemctl start docker
  sudo systemctl enable docker
  sudo usermod -aG docker "$(whoami)"
  ok "Docker installed"
else
  ok "Docker $(docker --version | awk '{print $3}' | tr -d ',')"
fi

if ! sudo docker info &>/dev/null 2>&1; then
  sudo systemctl start docker
fi

# ── Step 2: npm install ────────────────────────────────────
step "Step 2/6: Installing packages"

if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  cd "$SCRIPT_DIR"
  # Use --legacy-peer-deps to avoid eresolve failures with Strato/React peer deps
  if ! npm install --legacy-peer-deps 2>&1 | tail -5; then
    warn "npm install failed — retrying with clean slate..."
    rm -rf node_modules package-lock.json
    npm install --legacy-peer-deps 2>&1 | tail -5 || fail "npm install failed. Check npm logs above."
  fi
fi
# Verify dt-app is available (needed for deploy step)
if ! npx dt-app --version &>/dev/null; then
  warn "dt-app not found — running npm install again..."
  cd "$SCRIPT_DIR"
  rm -rf node_modules package-lock.json
  npm install --legacy-peer-deps 2>&1 | tail -5 || fail "npm install failed. Check npm logs above."
fi
ok "npm packages ready"

# ── Step 3: Credentials file ──────────────────────────────
step "Step 3/6: Configuring credentials"

cat > "$SCRIPT_DIR/.dt-credentials.json" << EOF
{
  "environmentUrl": "$TENANT_URL",
  "apiToken": "$API_TOKEN",
  "otelToken": "$API_TOKEN"
}
EOF
ok "Created .dt-credentials.json"

# ── Step 4: EdgeConnect ────────────────────────────────────
step "Step 4/6: Starting EdgeConnect"

cat > "$SCRIPT_DIR/edgeconnect/edgeConnect.yaml" << EOF
name: bizobs-demonstrator
api_endpoint_host: $(echo "$APPS_URL" | sed 's|https://||')
oauth:
  client_id: ${EC_OAUTH_CLIENT_ID}
  client_secret: ${EC_OAUTH_CLIENT_SECRET}
  resource: urn:dtenvironment:${TENANT_ID}
  endpoint: ${SSO_URL}
EOF
ok "EdgeConnect YAML generated"

CONTAINER_NAME="edgeconnect-bizobs"
if sudo docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  sudo docker stop "$CONTAINER_NAME" 2>/dev/null || true
  sudo docker rm "$CONTAINER_NAME" 2>/dev/null || true
fi

echo "  Pulling EdgeConnect image..."
sudo docker pull dynatrace/edgeconnect:latest 2>&1 | tail -1

sudo docker run -d --restart always \
  --name "$CONTAINER_NAME" \
  --network host \
  --mount "type=bind,src=$SCRIPT_DIR/edgeconnect/edgeConnect.yaml,dst=/edgeConnect.yaml" \
  dynatrace/edgeconnect:latest > /dev/null

sleep 5
if sudo docker ps --filter "name=$CONTAINER_NAME" --format '{{.Status}}' | grep -q "Up"; then
  ok "EdgeConnect running"
else
  warn "EdgeConnect may not have started — check: docker logs $CONTAINER_NAME"
fi

# ── Step 5: Deploy app ─────────────────────────────────────
step "Step 5/6: Deploying Demonstrator UI to Dynatrace"

cd "$SCRIPT_DIR"
export DT_APP_OAUTH_CLIENT_ID="$DEPLOY_OAUTH_CLIENT_ID"
export DT_APP_OAUTH_CLIENT_SECRET="$DEPLOY_OAUTH_CLIENT_SECRET"

# Update app.config.json environmentUrl to match the target tenant
sed -i "s|\"environmentUrl\":.*|\"environmentUrl\": \"${APPS_URL}/\",|" "$SCRIPT_DIR/app.config.json"
ok "app.config.json updated → $APPS_URL"

echo "  Building and deploying (this takes ~30 seconds)..."
DEPLOY_OUTPUT=$(npx dt-app deploy --non-interactive 2>&1)
DEPLOY_EXIT=$?
echo "$DEPLOY_OUTPUT" | tail -5

if echo "$DEPLOY_OUTPUT" | grep -qi 'forbidden\|unauthorized\|403\|401'; then
  echo ""
  echo -e "  ${RED}✗ Deploy failed — 'Forbidden' means your deploy OAuth client is missing scopes.${NC}"
  echo -e "  ${YELLOW}  Go to: Account Management → IAM → OAuth clients → find ${DEPLOY_OAUTH_CLIENT_ID}${NC}"
  echo -e "  ${YELLOW}  Add these scopes:${NC}"
  echo -e "  ${YELLOW}    • app-engine:apps:install${NC}"
  echo -e "  ${YELLOW}    • app-engine:apps:run${NC}"
  echo -e "  ${YELLOW}  Then re-run: ./setup.sh${NC}"
  echo ""
  warn "Continuing with EdgeConnect + server (you can deploy the app later)"
elif [ $DEPLOY_EXIT -ne 0 ] || echo "$DEPLOY_OUTPUT" | grep -qi 'error\|failed'; then
  warn "Deploy may have failed — check output above. Retry: npx dt-app deploy"
else
  ok "Demonstrator UI deployed"
fi

# ── Step 6: Build & start server ───────────────────────────
step "Step 6/6: Starting server"

echo "  Compiling TypeScript agents..."
npm run build:agents 2>&1 | tail -1

# Stop existing services for a clean restart without touching templates/config.
echo "  Stopping existing running services for a clean restart (templates/config are preserved)..."

# Stop systemd-managed service when available.
if command -v systemctl >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  if systemctl list-unit-files 2>/dev/null | grep -q '^bizobs-server.service'; then
    sudo systemctl stop bizobs-server.service 2>/dev/null || true
    ok "Stopped existing bizobs-server.service"
  fi

  # Keep host logs bounded before starting workloads.
  bash "$SCRIPT_DIR/scripts/install-log-guard.sh" >/dev/null 2>&1 || true
  ok "Log guard installed (journald + logrotate + timer)"
fi

# Stop PID-managed/background server and free port 8080.
bash "$SCRIPT_DIR/stop.sh" >/dev/null 2>&1 || true
ok "Stopped old runtime processes"

echo "  Starting server in background..."
mkdir -p "$SCRIPT_DIR/logs"
# Rotate log if it already exists and is large (>50MB)
if [ -f "$SCRIPT_DIR/logs/server.log" ]; then
  LOG_SIZE=$(stat -c%s "$SCRIPT_DIR/logs/server.log" 2>/dev/null || echo 0)
  if [ "$LOG_SIZE" -gt 52428800 ]; then
    gzip -c "$SCRIPT_DIR/logs/server.log" > "$SCRIPT_DIR/logs/server.log.1.gz"
    truncate -s 0 "$SCRIPT_DIR/logs/server.log"
    ok "Rotated previous server.log ($(( LOG_SIZE / 1048576 ))MB)"
  fi
fi
if command -v systemctl >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  bash "$SCRIPT_DIR/scripts/install-systemd-service.sh" --enable --restart >/dev/null
  ok "Server started via systemd (bizobs-server.service)"
else
  nohup npm start >> "$SCRIPT_DIR/logs/server.log" 2>&1 &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$SCRIPT_DIR/server.pid"
fi

for i in {1..20}; do
  if curl -s http://localhost:8080/api/health > /dev/null 2>&1; then
    if [ -n "${SERVER_PID:-}" ]; then
      ok "Server running on port 8080 (PID: $SERVER_PID)"
    else
      ok "Server running on port 8080 (managed by systemd)"
    fi
    break
  fi
  sleep 1
done

if ! curl -s http://localhost:8080/api/health > /dev/null 2>&1; then
  warn "Server still starting — check: tail -f logs/server.log"
fi

# ── Done ────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗"
echo -e "║                    Setup Complete!                        ║"
echo -e "╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Open Dynatrace → Apps → Business Observability Demonstrator${NC}"
echo ""
echo -e "  Then in Settings → Config tab:"
echo -e "    Host/IP:  ${BOLD}$PRIVATE_IP${NC}"
echo -e "    Port:     ${BOLD}8080${NC}"
echo -e "    Protocol: ${BOLD}HTTP${NC}"
echo ""
echo -e "  ${YELLOW}Click Save → Test → then work through the Get Started checklist.${NC}"
echo ""
echo -e "  Commands:"
echo -e "    tail -f logs/server.log               # Server logs"
echo -e "    docker logs -f edgeconnect-bizobs     # EdgeConnect logs"
echo -e "    curl localhost:8080/api/health        # Health check"
echo -e "    kill \$(cat server.pid)                # Stop server"
echo ""
