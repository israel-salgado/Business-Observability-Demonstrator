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

# ── Reset ───────────────────────────────────────────────────
# ./setup.sh --reset wipes saved credentials so a mistyped value can be
# corrected. Without this, setup.conf is reused silently and a re-run cannot
# fix a bad credential.
if [ "${1:-}" = "--reset" ] || [ "${1:-}" = "-r" ]; then
  rm -f "$CONF_FILE" "$SCRIPT_DIR/.env" "$SCRIPT_DIR/edgeconnect/edgeConnect.yaml"
  echo -e "  ${GREEN}✓ Cleared setup.conf, .env and edgeConnect.yaml — starting fresh${NC}"
  echo ""
fi

# ── Collect credentials ─────────────────────────────────────
# Two credentials come from you:
#   1. Platform token  (dt0s16.*)  — ingest, dashboards, settings, DQL
#   2. OAuth client    (dt0s02.*)  — app install AND EdgeConnect creation
# The EdgeConnect OAuth client is minted automatically by Dynatrace when this
# script creates the EdgeConnect configuration. You never see or paste it.
#
# If setup.conf exists and is filled in, use it silently. Otherwise, prompt.

if [ -f "$CONF_FILE" ]; then
  source "$CONF_FILE"
fi

# Prints a short, non-reversible hint so the user can confirm they pasted the
# right thing without the full secret ever appearing on screen or in scrollback.
# The character count matters: it is what catches a truncated paste, which is
# otherwise invisible and fails much later with a confusing auth error.
mask_secret() {
  local v="$1"
  local n=${#v}
  if [ "$n" -le 12 ]; then
    printf '%s' "$(printf '%*s' "$n" '' | tr ' ' '*')"
  else
    printf '%s…%s (%d chars)' "${v:0:8}" "${v: -4}" "$n"
  fi
}

# Read from /dev/tty where available so prompts survive `bash <(curl ...)`,
# where stdin is the consumed process-substitution pipe rather than the
# terminal. Test by actually opening it: `[ -r /dev/tty ]` returns true even
# in contexts with no controlling terminal, where the redirect then fails.
_tty() { if { : < /dev/tty; } 2>/dev/null; then echo "/dev/tty"; else echo "/dev/stdin"; fi; }

prompt_if_missing() {
  local var_name="$1"
  local prompt_text="$2"
  local placeholder="$3"
  local current_val="${!var_name}"

  if [ -z "$current_val" ] || [ "$current_val" = "$placeholder" ]; then
    echo -ne "  ${CYAN}${prompt_text}${NC} "
    read -r input < "$(_tty)"
    if [ -z "$input" ]; then
      fail "$var_name is required. Cannot continue."
    fi
    printf -v "$var_name" '%s' "$input"
  fi
}

# Same as prompt_if_missing but does not echo what you type. Use this for every
# token, client secret, or anything else that shouldn't end up in terminal
# scrollback, a screen share, or a recorded session.
#
# Echoes one '*' per character as you type. Plain `read -s` shows nothing at
# all, which is indistinguishable from a paste that silently failed — you press
# Enter and hope. The asterisks confirm input is arriving without revealing it.
prompt_secret() {
  local var_name="$1"
  local prompt_text="$2"
  local placeholder="$3"
  local current_val="${!var_name}"

  if [ -z "$current_val" ] || [ "$current_val" = "$placeholder" ]; then
    local src input='' char
    src="$(_tty)"
    echo -ne "  ${CYAN}${prompt_text}${NC} "

    if [ "$src" = "/dev/tty" ]; then
      # Character at a time so we can draw the asterisks ourselves.
      while IFS= read -rsn1 char; do
        [ -z "$char" ] && break                      # Enter
        if [ "$char" = $'\177' ] || [ "$char" = $'\b' ]; then
          if [ -n "$input" ]; then
            input="${input%?}"
            echo -ne '\b \b'                          # rub out one asterisk
          fi
          continue
        fi
        input+="$char"
        echo -n '*'
      done < /dev/tty
    else
      # No terminal (piped or non-interactive): fall back to a plain read.
      read -rs input < "$src"
    fi
    echo ""

    if [ -z "$input" ]; then
      fail "$var_name is required. Cannot continue."
    fi
    printf -v "$var_name" '%s' "$input"
    echo -e "  ${GREEN}  → received $(mask_secret "$input")${NC}"
  fi
}

NEED_PROMPT=false
if [ -z "$TENANT_ID" ] || [ "$TENANT_ID" = "YOUR_TENANT_ID" ] || \
   [ -z "$ENV_TYPE" ] || \
   [ -z "$API_TOKEN" ] || [[ "$API_TOKEN" == *"XXXX"* ]] || \
   [ -z "$DT_PLATFORM_TOKEN" ] || [[ "$DT_PLATFORM_TOKEN" == *"XXXX"* ]] || \
   [ -z "$DEPLOY_OAUTH_CLIENT_ID" ] || [[ "$DEPLOY_OAUTH_CLIENT_ID" == *"XXXX"* ]] || \
   [ -z "$DEPLOY_OAUTH_CLIENT_SECRET" ] || [[ "$DEPLOY_OAUTH_CLIENT_SECRET" == *"YYYY"* ]]; then
  # Support legacy setup.conf that used a single OAUTH_CLIENT_ID for everything
  if [ -n "$OAUTH_CLIENT_ID" ] && [ -z "$DEPLOY_OAUTH_CLIENT_ID" ]; then
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
  echo -e "  ${CYAN}─── 1/4: Environment Type ───${NC}"
  echo -e "  ${YELLOW}What kind of Dynatrace tenant are you using?${NC}"
  echo -e "  ${YELLOW}  1) Sprint   (URL like: abc12345.sprint.dynatracelabs.com)${NC}"
  echo -e "  ${YELLOW}  2) Prod/Live (URL like: abc12345.live.dynatrace.com or abc12345.apps.dynatrace.com)${NC}"
  if [ -z "$ENV_TYPE" ] || [ "$ENV_TYPE" = "YOUR_ENV_TYPE" ]; then
    echo -ne "  ${CYAN}Enter 1 or 2 [1]:${NC} "
    read -r env_choice < "$(_tty)"
    case "$env_choice" in
      2) ENV_TYPE="prod" ;;
      *) ENV_TYPE="sprint" ;;
    esac
  fi
  ok "Environment: $ENV_TYPE"
  echo ""

  # 2. Tenant ID
  echo -e "  ${CYAN}─── 2/4: Tenant ID ───${NC}"
  if [ "$ENV_TYPE" = "sprint" ]; then
    echo -e "  ${YELLOW}Look at your Dynatrace URL: https://${BOLD}<THIS-PART>${NC}${YELLOW}.sprint.dynatracelabs.com${NC}"
  else
    echo -e "  ${YELLOW}Look at your Dynatrace URL: https://${BOLD}<THIS-PART>${NC}${YELLOW}.live.dynatrace.com${NC}"
  fi
  prompt_if_missing "TENANT_ID" "Tenant ID:" "YOUR_TENANT_ID"
  echo ""

  # 3. Platform token (ingest + dashboards + settings + DQL)
  echo -e "  ${CYAN}─── 3/4: Platform Token ───${NC}"
  echo -e "  ${YELLOW}Account Management → Identity & access management → Platform tokens${NC}"
  echo -e "  ${YELLOW}(myaccount.dynatrace.com — NOT your environment settings)${NC}"
  echo -e "  ${YELLOW}This one token covers ingest, dashboards, settings and DQL.${NC}"
  echo -e "  ${YELLOW}Key scopes: openpipeline:traces|metrics|logs|bizevents|events:ingest,${NC}"
  echo -e "  ${YELLOW}            document:documents:read+write, settings:objects:read+write,${NC}"
  echo -e "  ${YELLOW}            storage:buckets:read + the storage:*:read set${NC}"
  echo -e "  ${YELLOW}Starts with: dt0s16.  (input is hidden)${NC}"
  prompt_secret "API_TOKEN" "Platform Token:" "dt0s16.XXXX..."
  echo ""

  # The same platform token is reused for dashboard deployment. Kept as a
  # separate variable for back-compat with existing setup.conf files.
  if [ -z "$DT_PLATFORM_TOKEN" ] || [[ "$DT_PLATFORM_TOKEN" == *"XXXX"* ]]; then
    DT_PLATFORM_TOKEN="$API_TOKEN"
    ok "Reusing the same platform token for dashboard deployment"
    echo ""
  fi

  # 4. OAuth client — app install AND EdgeConnect creation
  echo -e "  ${CYAN}─── 4/4: OAuth Client ───${NC}"
  echo -e "  ${YELLOW}Account Management → Identity & access management → OAuth clients${NC}"
  echo -e "  ${YELLOW}  Grant type: Client credentials   Subject: an active user (your email)${NC}"
  echo -e "  ${YELLOW}  Required permissions — all four:${NC}"
  echo -e "  ${YELLOW}    app-engine:apps:install${NC}"
  echo -e "  ${YELLOW}    app-engine:apps:run${NC}"
  echo -e "  ${YELLOW}    app-engine:edge-connects:connect${NC}"
  echo -e "  ${YELLOW}    oauth2:clients:manage      ${BOLD}← required to auto-create EdgeConnect${NC}"
  echo -e "  ${YELLOW}Client ID starts with dt0s02. — secret input is hidden.${NC}"
  prompt_if_missing "DEPLOY_OAUTH_CLIENT_ID" "OAuth Client ID:" "dt0s02.XXXX"
  prompt_secret     "DEPLOY_OAUTH_CLIENT_SECRET" "OAuth Client Secret:" "dt0s02.XXXX.YYYY..."
  echo ""

  # Optional account auto-provisioning fields are intentionally NOT prompted.
  # They are only used by the self-service /access-request.html page, which is
  # not part of a working demo. Fill them into setup.conf directly if needed.
fi

# ── Validate credential formats (always, even from setup.conf) ──
[ -z "$ENV_TYPE" ] && ENV_TYPE="sprint"

# Ingest credential: accepts either a Gen3 platform token (dt0s16.*, preferred) or a
# classic access token (dt0c01.*, legacy). Classic access tokens are labelled "classic" in
# the Dynatrace docs and the OAuth picker now carries a "[DEPRECATED] Environment Api"
# section, so new setups should use a platform token with the openpipeline:*:ingest scopes.
if [[ "$API_TOKEN" == dt0s16.* ]]; then
  INGEST_TOKEN_KIND="platform"
elif [[ "$API_TOKEN" == dt0c01.* ]]; then
  INGEST_TOKEN_KIND="classic"
else
  fail "Ingest token must be a platform token (dt0s16.*) or a classic access token (dt0c01.*) — you entered '${API_TOKEN:0:10}...'. Re-run with: ./setup.sh --reset"
fi

# Dashboard deployment credential. Normally the same platform token as above.
# Falls back to API_TOKEN so a setup.conf that only supplies one token still works.
[ -z "$DT_PLATFORM_TOKEN" ] && DT_PLATFORM_TOKEN="$API_TOKEN"
if [[ ! "$DT_PLATFORM_TOKEN" == dt0s*.* ]] && [[ ! "$DT_PLATFORM_TOKEN" == dt0c01.* ]]; then
  fail "DT Platform Token must be a platform token (dt0s16.*) or a classic access token (dt0c01.*). Update setup.conf and re-run ./setup.sh"
fi

# EdgeConnect OAuth credentials are NOT validated here — they are minted by
# Dynatrace when this script creates the EdgeConnect configuration further down.
# Nothing is pasted by the user, so there is nothing to get wrong.

# Deploy OAuth can be dt0s10 (environment-level) OR dt0s02 (account-level)
if [[ ! "$DEPLOY_OAUTH_CLIENT_ID" == dt0s10.* ]] && [[ ! "$DEPLOY_OAUTH_CLIENT_ID" == dt0s02.* ]]; then
  echo -e "  ${RED}✗ Deploy OAuth Client ID must start with 'dt0s10.' or 'dt0s02.'${NC}"
  echo -e "  ${YELLOW}  You entered '${DEPLOY_OAUTH_CLIENT_ID:0:12}...'${NC}"
  echo -e "  ${YELLOW}  Re-run with: ./setup.sh --reset${NC}"
  exit 1
fi
if [[ ! "$DEPLOY_OAUTH_CLIENT_SECRET" == dt0s10.* ]] && [[ ! "$DEPLOY_OAUTH_CLIENT_SECRET" == dt0s02.* ]]; then
  echo -e "  ${RED}✗ Deploy OAuth Client Secret must start with 'dt0s10.' or 'dt0s02.'${NC}"
  echo -e "  ${YELLOW}  Re-run with: ./setup.sh --reset${NC}"
  exit 1
fi

# Detect swapped ID/secret — Client IDs have 2 dot-separated parts, secrets have 3
DEPLOY_ID_DOTS=$(echo "$DEPLOY_OAUTH_CLIENT_ID" | tr -cd '.' | wc -c)
DEPLOY_SECRET_DOTS=$(echo "$DEPLOY_OAUTH_CLIENT_SECRET" | tr -cd '.' | wc -c)

if [ "$DEPLOY_ID_DOTS" -gt 1 ]; then
  echo -e "  ${RED}✗ Deploy OAuth Client ID looks like a secret (too many parts).${NC}"
  echo -e "  ${YELLOW}  Client ID format:     dt0s10.XXXXXXXX  (2 parts)${NC}"
  echo -e "  ${YELLOW}  Client Secret format:  dt0s10.XXXXXXXX.YYYYYYYY...  (3 parts)${NC}"
  echo -e "  ${YELLOW}  You entered: '${DEPLOY_OAUTH_CLIENT_ID:0:20}...'${NC}"
  echo -e "  ${YELLOW}  Re-run with: ./setup.sh --reset${NC}"
  exit 1
fi
if [ "$DEPLOY_SECRET_DOTS" -lt 2 ]; then
  echo -e "  ${RED}✗ Deploy OAuth Client Secret looks like a client ID (too short).${NC}"
  echo -e "  ${YELLOW}  Client Secret format:  dt0s10.XXXXXXXX.YYYYYYYY...  (3 parts)${NC}"
  echo -e "  ${YELLOW}  Re-run with: ./setup.sh --reset${NC}"
  exit 1
fi

# Save valid credentials for future runs.
# EC_OAUTH_* are written later, after the EdgeConnect is created, by save_conf().
save_conf() {
  cat > "$CONF_FILE" << EOF
ENV_TYPE="$ENV_TYPE"
TENANT_ID="$TENANT_ID"
API_TOKEN="$API_TOKEN"
DT_PLATFORM_TOKEN="$DT_PLATFORM_TOKEN"
DEPLOY_OAUTH_CLIENT_ID="$DEPLOY_OAUTH_CLIENT_ID"
DEPLOY_OAUTH_CLIENT_SECRET="$DEPLOY_OAUTH_CLIENT_SECRET"
EC_OAUTH_CLIENT_ID="$EC_OAUTH_CLIENT_ID"
EC_OAUTH_CLIENT_SECRET="$EC_OAUTH_CLIENT_SECRET"
EDGECONNECT_NAME="$EDGECONNECT_NAME"
EDGECONNECT_ID="$EDGECONNECT_ID"
DT_ACCOUNT_ID="$DT_ACCOUNT_ID"
DT_ACCESS_GROUP_UUID="$DT_ACCESS_GROUP_UUID"
DT_ACCOUNT_OAUTH_CLIENT_ID="$DT_ACCOUNT_OAUTH_CLIENT_ID"
DT_ACCOUNT_OAUTH_CLIENT_SECRET="$DT_ACCOUNT_OAUTH_CLIENT_SECRET"
DT_ACCOUNT_RESOURCE="$DT_ACCOUNT_RESOURCE"
DT_ACCOUNT_TOKEN_URL="$DT_ACCOUNT_TOKEN_URL"
EOF
  chmod 600 "$CONF_FILE"
}

if [ "$NEED_PROMPT" = true ]; then
  save_conf
  ok "Saved to setup.conf (won't ask again — use ./setup.sh --reset to start over)"
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
# Work out this host's real LAN address, used as the EdgeConnect host pattern.
#
# `hostname -I | awk '{print $1}'` is not good enough. It lists every address in
# interface-index order, so a Docker bridge, a compose network, or a VPN can sit
# in first place and win. Getting this wrong is expensive to diagnose: the
# EdgeConnect authenticates, the tunnel reports healthy, and traffic then dies
# on the final hop from inside this host with nothing obviously broken.
#
# Primary: ask the kernel which source address it would use to reach the
# internet. That is the interface carrying the default route, which is the
# address the tenant should be pointed at.
# Fallback: first address from `hostname -I` that is not on a known-virtual
# range — Docker bridges (172.17-172.31), link-local (169.254), loopback.
detect_private_ip() {
  local ip=""

  ip="$(ip route get 1.1.1.1 2>/dev/null | grep -oP '(?<=src )\d+(\.\d+){3}' | head -1)"
  if [ -n "$ip" ]; then
    printf '%s' "$ip"
    return 0
  fi

  for candidate in $(hostname -I 2>/dev/null); do
    case "$candidate" in
      127.*|169.254.*) continue ;;
      172.1[7-9].*|172.2[0-9].*|172.3[0-1].*) continue ;;   # docker/compose
      *) printf '%s' "$candidate"; return 0 ;;
    esac
  done

  # Everything was filtered out; fall back to the old behaviour rather than
  # returning nothing.
  hostname -I 2>/dev/null | awk '{print $1}'
}

PRIVATE_IP="$(detect_private_ip)"
if [ -z "$PRIVATE_IP" ]; then
  fail "Could not determine this host's IP address. Check 'ip route get 1.1.1.1' and 'hostname -I'."
fi

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
# Tell the runtime which auth scheme the ingest token needs: platform tokens use
# "Authorization: Bearer", classic access tokens use "Authorization: Api-Token".
upsert_env_var "DT_INGEST_TOKEN_KIND" "${INGEST_TOKEN_KIND:-classic}"

# Record the local-LLM mode explicitly so the runtime never has to guess.
# setup.sh does not install Ollama: local models are opt-in. If Ollama is already
# running we use it; otherwise we pin 'disabled' so AI features fall back to
# templates cleanly instead of erroring against a dead localhost:11434.
# Cloud AI providers are configured in the app (Settings → AI Provider) and are
# unaffected by this value.
if curl -sf --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1; then
  upsert_env_var "OLLAMA_MODE" "full"
  ok "Ollama detected on localhost:11434 (OLLAMA_MODE=full)"
else
  upsert_env_var "OLLAMA_MODE" "disabled"
  ok "No local Ollama (OLLAMA_MODE=disabled) — configure a cloud AI provider in the app, or install Ollama later"
fi

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
  # Amazon Linux 2023 and Fedora ship a usable 'docker' package via dnf.
  # Debian/Ubuntu use docker.io. RHEL/Rocky/Alma ship Podman instead and need
  # the Docker CE repo, so we detect that and tell the user exactly what to run.
  DOCKER_OK=false
  if command -v dnf &>/dev/null; then
    sudo dnf install -y docker 2>/dev/null && DOCKER_OK=true
  fi
  if [ "$DOCKER_OK" = false ] && command -v yum &>/dev/null; then
    sudo yum install -y docker 2>/dev/null && DOCKER_OK=true
  fi
  if [ "$DOCKER_OK" = false ] && command -v apt-get &>/dev/null; then
    sudo apt-get update -qq 2>/dev/null || true
    sudo apt-get install -y docker.io 2>/dev/null && DOCKER_OK=true
  fi

  if [ "$DOCKER_OK" = false ] || ! command -v docker &>/dev/null; then
    echo ""
    warn "Could not install Docker from this distro's default repositories."
    echo "  Docker is required to run the EdgeConnect tunnel container."
    echo ""
    echo "  On RHEL / Rocky / AlmaLinux, add the Docker CE repo first:"
    echo "    sudo dnf -y install dnf-plugins-core"
    echo "    sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo"
    echo "    sudo dnf -y install docker-ce docker-ce-cli containerd.io"
    echo ""
    echo "  Then re-run ./setup.sh"
    fail "Docker is required. See the commands above."
  fi

  sudo systemctl enable --now docker 2>/dev/null || sudo systemctl start docker 2>/dev/null || true
  sudo usermod -aG docker "$(whoami)" 2>/dev/null || true
  ok "Docker installed"
else
  ok "Docker $(docker --version | awk '{print $3}' | tr -d ',')"
fi

if ! sudo docker info &>/dev/null 2>&1; then
  sudo systemctl start docker 2>/dev/null || true
fi
if ! sudo docker info &>/dev/null 2>&1; then
  fail "Docker is installed but the daemon isn't responding. Check: sudo systemctl status docker"
fi

# Make sure Docker starts on boot, whether or not we installed it.
#
# The EdgeConnect container runs with --restart always, but that only means
# "Docker restarts it" — it does nothing if the Docker daemon itself never
# starts. On a host where Docker was already present but not enabled, a reboot
# leaves the daemon down, the tunnel never comes up, and the app reports a vague
# connection failure with nothing pointing at the cause.
if command -v systemctl >/dev/null 2>&1; then
  if ! systemctl is-enabled docker >/dev/null 2>&1; then
    if sudo systemctl enable docker >/dev/null 2>&1; then
      ok "Docker enabled at boot"
    else
      warn "Could not enable Docker at boot. After a reboot the EdgeConnect tunnel"
      warn "will not come back until you run: sudo systemctl enable --now docker"
    fi
  else
    ok "Docker enabled at boot"
  fi
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
step "Step 4/6: Creating and starting EdgeConnect"

# The EdgeConnect configuration is created via API rather than by hand in the
# Dynatrace UI. This removes the single worst failure mode in the old flow: the
# configuration name had to match a hardcoded literal exactly, nothing validated
# it, and a one-character typo produced a tunnel that started, looked healthy,
# and never associated.
#
# IMPORTANT — why the OAuth client and not the platform token:
# creating an EdgeConnect makes Dynatrace mint a dedicated OAuth client for the
# tunnel, which requires the oauth2:clients:manage scope. That scope is NOT
# offered to platform tokens. Verified against a live Gen3 sprint tenant:
#   POST .../edge-connects with a dt0s16 platform token
#   → 403 {"missingScopes":["oauth2:clients:manage"],
#          "message":"Missing permission to create OAuth client"}
# So this step authenticates with the OAuth client instead.
EDGECONNECT_NAME="${EDGECONNECT_NAME:-bizobs-demonstrator}"
EC_API="$APPS_URL/platform/app-engine/edge-connect/v1/edge-connects"

# The host pattern is this machine's private IP. It must be the IP and not a
# hostname: EdgeConnect performs the final hop from inside this VM, so the
# pattern has to be something that resolves here. A bare name like
# "bizobs-demonstrator" resolves to nothing locally and the request dies after
# a tunnel that otherwise looks perfectly healthy.
echo "  Requesting OAuth token for EdgeConnect provisioning..."
# --data-urlencode, not -d. The scope parameter is a space-separated list, and
# `-d` sends the body verbatim without form-encoding, so the spaces go out raw.
# Encoding them by hand as %20 is worse: that is sent literally too, the SSO
# endpoint rejects the whole request, and every scope comes back denied — which
# looks exactly like a permissions problem and is not.
EC_MGMT_TOKEN=$(curl -s -X POST "$SSO_URL" \
  --data-urlencode "grant_type=client_credentials" \
  --data-urlencode "client_id=${DEPLOY_OAUTH_CLIENT_ID}" \
  --data-urlencode "client_secret=${DEPLOY_OAUTH_CLIENT_SECRET}" \
  --data-urlencode "scope=oauth2:clients:manage app-engine:edge-connects:write app-engine:edge-connects:read" \
  --data-urlencode "resource=urn:dtenvironment:${TENANT_ID}" \
  | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)

if [ -z "$EC_MGMT_TOKEN" ]; then
  echo -e "  ${RED}✗ Could not get an OAuth token with oauth2:clients:manage${NC}"
  echo -e "  ${YELLOW}  Your OAuth client is missing a required permission.${NC}"
  echo -e "  ${YELLOW}  Account Management → IAM → OAuth clients → your client → add:${NC}"
  echo -e "  ${YELLOW}      oauth2:clients:manage${NC}"
  echo -e "  ${YELLOW}      app-engine:edge-connects:write${NC}"
  echo -e "  ${YELLOW}      app-engine:edge-connects:read${NC}"
  echo -e "  ${YELLOW}  Then re-run: ./setup.sh${NC}"
  fail "EdgeConnect provisioning cannot continue without that scope."
fi
ok "OAuth token acquired"

# Reuse the stored EdgeConnect credentials when the configuration still exists
# in the tenant. The client secret is returned only once at creation and cannot
# be read back, so if the config is gone (or we never stored a secret) the only
# correct move is to delete any same-named leftover and create a fresh one.
EC_REUSED=false
if [ -n "$EC_OAUTH_CLIENT_SECRET" ] && [ -n "$EDGECONNECT_ID" ]; then
  EXISTING_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $EC_MGMT_TOKEN" "$EC_API/$EDGECONNECT_ID")
  if [ "$EXISTING_CODE" = "200" ]; then
    ok "Reusing existing EdgeConnect '$EDGECONNECT_NAME'"
    EC_REUSED=true
  fi
fi

if [ "$EC_REUSED" = false ]; then
  # Look for a leftover configuration using our name.
  #
  # The list endpoint returns ONLY ids — no name, no hostPatterns — so every
  # entry has to be fetched individually to find out what it is. Filtering the
  # list response by name silently matches nothing, deletes nothing, and the
  # create then fails with a confusing message about a location that already
  # exists.
  echo "  Checking for an existing EdgeConnect named '$EDGECONNECT_NAME'..."
  EC_CONFLICT_ID=""
  for cand_id in $(curl -s -H "Authorization: Bearer $EC_MGMT_TOKEN" "$EC_API" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for e in d.get('edgeConnects', d if isinstance(d, list) else []):
    if e.get('id'):
        print(e['id'])
" 2>/dev/null); do
    cand_name=$(curl -s -H "Authorization: Bearer $EC_MGMT_TOKEN" "$EC_API/$cand_id" | python3 -c "
import json,sys
try:
    print(json.load(sys.stdin).get('name',''))
except Exception:
    pass
" 2>/dev/null)
    if [ "$cand_name" = "$EDGECONNECT_NAME" ]; then
      EC_CONFLICT_ID="$cand_id"
      break
    fi
  done

  if [ -n "$EC_CONFLICT_ID" ]; then
    # Deleting needs app-engine:edge-connects:delete, which is NOT one of the
    # six required permissions.
    #
    # It has to be requested as a separate token, not bundled into the main one
    # above. Dynatrace SSO grants scopes all-or-nothing: ask for four scopes
    # when the client holds three and the entire request fails with a bare
    # `400 invalid_request` — no indication of which scope was the problem. So
    # a client that followed the documented six permissions would fail at this
    # step instead of at worst losing the ability to self-clean.
    EC_DEL_TOKEN=$(curl -s -X POST "$SSO_URL" \
      --data-urlencode "grant_type=client_credentials" \
      --data-urlencode "client_id=${DEPLOY_OAUTH_CLIENT_ID}" \
      --data-urlencode "client_secret=${DEPLOY_OAUTH_CLIENT_SECRET}" \
      --data-urlencode "scope=app-engine:edge-connects:delete" \
      --data-urlencode "resource=urn:dtenvironment:${TENANT_ID}" \
      | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)

    if [ -n "$EC_DEL_TOKEN" ]; then
      DEL_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE \
        -H "Authorization: Bearer $EC_DEL_TOKEN" "$EC_API/$EC_CONFLICT_ID")
    else
      DEL_CODE="no-scope"
    fi

    case "$DEL_CODE" in
      2*)
        ok "Removed pre-existing EdgeConnect '$EDGECONNECT_NAME'"
        ;;
      *)
        echo -e "  ${RED}✗ An EdgeConnect named '${EDGECONNECT_NAME}' already exists${NC}"
        echo -e "  ${YELLOW}    id: ${EC_CONFLICT_ID}${NC}"
        echo ""
        if [ "$DEL_CODE" = "no-scope" ]; then
          echo -e "  ${YELLOW}  Your OAuth client does not have app-engine:edge-connects:delete,${NC}"
          echo -e "  ${YELLOW}  so setup cannot remove it for you.${NC}"
        else
          echo -e "  ${YELLOW}  It could not be removed automatically (HTTP ${DEL_CODE}).${NC}"
        fi
        echo -e "  ${YELLOW}  Its OAuth client secret is shown only once at creation and cannot${NC}"
        echo -e "  ${YELLOW}  be read back, so this setup cannot adopt it either. It has to go.${NC}"
        echo ""
        echo -e "  ${BOLD}  Delete it, then re-run ./setup.sh${NC}"
        echo ""
        echo -e "  ${YELLOW}  In the UI:${NC}"
        echo -e "      Settings → General → External requests → EdgeConnect tab"
        echo -e "      delete '${EDGECONNECT_NAME}'"
        echo ""
        echo -e "  ${YELLOW}  Or let setup do it next time by adding this permission to your${NC}"
        echo -e "  ${YELLOW}  OAuth client (Account Management → IAM → OAuth clients):${NC}"
        echo -e "      app-engine:edge-connects:delete"
        echo ""
        fail "Cannot create '${EDGECONNECT_NAME}' while another one has that name."
        ;;
    esac
  else
    ok "No name conflict"
  fi

  echo "  Creating EdgeConnect '$EDGECONNECT_NAME' → host pattern $PRIVATE_IP ..."
  EC_CREATE_BODY=$(printf '{"name":"%s","hostPatterns":["%s"]}' "$EDGECONNECT_NAME" "$PRIVATE_IP")
  EC_RESPONSE=$(curl -s -X POST "$EC_API" \
    -H "Authorization: Bearer $EC_MGMT_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "$EC_CREATE_BODY")

  EC_PARSED=$(echo "$EC_RESPONSE" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print('PARSE_ERROR'); sys.exit(0)
if 'error' in d:
    print('ERROR|' + str(d['error'].get('message','unknown')))
else:
    print('OK|%s|%s|%s' % (d.get('id',''), d.get('oauthClientId',''), d.get('oauthClientSecret','')))
" 2>/dev/null)

  case "$EC_PARSED" in
    OK\|*)
      IFS='|' read -r _ EDGECONNECT_ID EC_OAUTH_CLIENT_ID EC_OAUTH_CLIENT_SECRET <<< "$EC_PARSED"
      if [ -z "$EC_OAUTH_CLIENT_SECRET" ]; then
        fail "EdgeConnect was created but no client secret came back. Delete it in the UI and re-run ./setup.sh"
      fi
      ok "EdgeConnect created (client ${EC_OAUTH_CLIENT_ID})"
      save_conf   # persist the generated secret immediately — it is shown once
      ;;
    ERROR\|*)
      fail "EdgeConnect creation failed: ${EC_PARSED#ERROR|}"
      ;;
    *)
      fail "Unexpected response creating EdgeConnect. Re-run with ./setup.sh --reset"
      ;;
  esac
fi

mkdir -p "$SCRIPT_DIR/edgeconnect"
cat > "$SCRIPT_DIR/edgeconnect/edgeConnect.yaml" << EOF
name: ${EDGECONNECT_NAME}
api_endpoint_host: $(echo "$APPS_URL" | sed 's|https://||')
oauth:
  client_id: ${EC_OAUTH_CLIENT_ID}
  client_secret: ${EC_OAUTH_CLIENT_SECRET}
  resource: urn:dtenvironment:${TENANT_ID}
  endpoint: ${SSO_URL}
EOF
chmod 600 "$SCRIPT_DIR/edgeconnect/edgeConnect.yaml"
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

# Generate app.config.json from the tracked template.
#
# app.config.json is deliberately NOT in git: it carries environmentUrl, which
# is tenant-specific. When it was tracked, the repo shipped with whoever last
# ran setup, every partner cloned a stranger's tenant URL, and every run left a
# dirty working tree that was easy to commit by accident. The template holds a
# __ENVIRONMENT_URL__ placeholder and this step fills it in.
if [ ! -f "$SCRIPT_DIR/app.config.template.json" ]; then
  fail "app.config.template.json is missing — cannot generate app.config.json"
fi
sed "s|__ENVIRONMENT_URL__|${APPS_URL}/|" \
  "$SCRIPT_DIR/app.config.template.json" > "$SCRIPT_DIR/app.config.json"
ok "app.config.json generated → $APPS_URL"

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
# systemd if we can, nohup if we can't — but say which, because the difference
# only shows up after a reboot.
#
# `sudo -n true` tests for a *currently valid* sudo credential, not for whether
# the user has sudo at all. Type your password early in the run and it succeeds;
# if the sudo timestamp (15 minutes by default) expires during a long npm
# install or Docker pull, the same machine silently takes the nohup path
# instead. The demo works either way, then the server does not come back after a
# reboot, and nothing in the output ever said so.
SERVER_UNDER_SYSTEMD=false
if command -v systemctl >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  bash "$SCRIPT_DIR/scripts/install-systemd-service.sh" --enable --restart >/dev/null
  SERVER_UNDER_SYSTEMD=true
  ok "Server started via systemd (bizobs-server.service) — survives reboot"
else
  nohup npm start >> "$SCRIPT_DIR/logs/server.log" 2>&1 &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$SCRIPT_DIR/server.pid"
  warn "Server started with nohup — it will NOT survive a reboot."
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "  Reason: no systemd on this host."
  else
    warn "  Reason: sudo needed a password at this point in the run."
    warn "  Install the service now with:"
    warn "    sudo bash scripts/install-systemd-service.sh --enable --restart"
  fi
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
if [ "$SERVER_UNDER_SYSTEMD" = true ]; then
  echo -e "    sudo systemctl stop bizobs-server     # Stop server"
  echo -e "    sudo systemctl restart bizobs-server  # Restart server"
else
  echo -e "    kill \$(cat server.pid)                # Stop server"
fi
echo -e "    ./setup.sh --reset                    # Start over with new credentials"
echo ""
echo -e "  ${BOLD}Removing all of this later${NC}"
echo ""
echo -e "  ${YELLOW}1. The app, from your tenant:${NC}"
echo -e "     In Dynatrace go to ${BOLD}Hub → Manage${NC} (it opens on Discover, which only"
echo -e "     lists apps you can install — installed ones are under Manage)."
echo -e "     Search ${BOLD}demonstrator${NC} and delete it."
echo ""
echo -e "     Or from here, if your OAuth client has ${BOLD}app-engine:apps:delete${NC}:"
echo -e "       npx dt-app uninstall --dry-run     # preview"
echo -e "       npx dt-app uninstall"
echo ""
echo -e "  ${YELLOW}2. The EdgeConnect, from your tenant:${NC}"
echo -e "     Settings → General → External requests → EdgeConnect tab →"
echo -e "     delete ${BOLD}${EDGECONNECT_NAME}${NC}. Its OAuth client is removed with it."
echo ""
echo -e "  ${YELLOW}3. This host:${NC}"
if [ "$SERVER_UNDER_SYSTEMD" = true ]; then
  echo -e "       sudo systemctl disable --now bizobs-server"
else
  echo -e "       kill \$(cat server.pid)"
fi
echo -e "       sudo docker rm -f ${CONTAINER_NAME}"
echo -e "       rm -rf $SCRIPT_DIR"
echo ""
