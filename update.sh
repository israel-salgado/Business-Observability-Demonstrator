#!/bin/bash
# ============================================================
#  Business Observability Demonstrator — Update Script
# ============================================================
#
#  Usage:
#    bash update.sh              # Pull + rebuild + restart server + deploy UI (FULL UPDATE)
#    bash update.sh --skip-ui    # Quick update: server only (no UI deploy)
#    bash update.sh --ui         # AppEngine UI deploy only (no server restart)
#    bash update.sh --no-restart # Pull + build but don't restart server
#
#  This script updates without losing credentials, configs, or state.
#  It reads setup.conf for deploy credentials automatically.
# ============================================================

set -e
cd "$(dirname "$0")"

SERVICE_NAME="bizobs-server.service"
READY_URL="http://localhost:8080/api/ready"
HEALTH_URL="http://localhost:8080/api/health"

# ── Colors ──
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠ $1${NC}"; }
fail() { echo -e "  ${RED}✗ $1${NC}"; exit 1; }

install_or_refresh_service() {
  if command -v systemctl >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    bash scripts/install-systemd-service.sh --enable >/dev/null
    bash scripts/install-log-guard.sh >/dev/null 2>&1 || true
    ok "Refreshed systemd service definition"
    return 0
  fi

  warn "Skipping systemd refresh (systemctl unavailable or sudo requires a password)"
  return 1
}

wait_for_ready() {
  local url="$1"
  echo -n "  Waiting for server"
  for i in {1..30}; do
    if curl -sf "$url" >/dev/null 2>&1; then
      echo ""
      return 0
    fi
    echo -n "."
    sleep 1
  done
  echo ""
  return 1
}

# ── Parse flags ──
DO_SERVER=true
DO_UI=true
DO_RESTART=true
UI_BACKGROUND=false
DEPLOY_TIMEOUT=300  # seconds

for arg in "$@"; do
  case "$arg" in
    --skip-ui)    DO_UI=false ;;
    --server)     DO_UI=false ;;
    --ui)         DO_SERVER=false; DO_RESTART=false ;;
    --bg-ui)      UI_BACKGROUND=true ;;
    --no-restart) DO_RESTART=false ;;
    --timeout)    DEPLOY_TIMEOUT="${2:-300}"; shift ;;
    -h|--help)
      echo "Usage: bash update.sh [OPTIONS]"
      echo ""
      echo "Default (no args):    Full update — server + UI deploy (recommended for releases)"
      echo ""
      echo "Options:"
      echo "  --skip-ui            Skip UI deploy (quick server-only update)"
      echo "  --bg-ui              Run UI deploy in background (don't wait)"
      echo "  --ui                 UI only (no server restart)"
      echo "  --no-restart         Pull + build, don't restart server"
      echo "  --timeout SECONDS    Set deploy timeout (default: 300s)"
      exit 0
      ;;
  esac
done

echo -e "${CYAN}${BOLD}"
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Business Observability Demonstrator — Update            ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── Load credentials from setup.conf ──
CONF_FILE="$(pwd)/setup.conf"
if [[ -f "$CONF_FILE" ]]; then
  source "$CONF_FILE"
  ok "Loaded credentials from setup.conf"
else
  warn "No setup.conf found — AppEngine deploy will be skipped unless credentials are in env"
fi

# Derive URLs
if [[ "$ENV_TYPE" == "prod" ]]; then
  APPS_URL="https://${TENANT_ID}.apps.dynatrace.com"
else
  APPS_URL="https://${TENANT_ID}.sprint.apps.dynatracelabs.com"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 1: Pull latest code
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo -e "\n${CYAN}${BOLD}[1/5]${NC} ${BOLD}Pulling latest changes${NC}"

# Stash any local changes to avoid conflicts
if git diff --quiet 2>/dev/null && git diff --cached --quiet 2>/dev/null; then
  STASHED=false
else
  git stash push -m "update-script-$(date +%s)" 2>/dev/null && STASHED=true || STASHED=false
  [[ "$STASHED" == true ]] && warn "Stashed local changes (will restore after)"
fi

BEFORE=$(git rev-parse HEAD 2>/dev/null || echo "unknown")

# Pull from all configured remotes (origin + demonstrator)
PULLED=false
for remote in demonstrator origin; do
  if git remote get-url "$remote" &>/dev/null; then
    BRANCH=$(git branch --show-current 2>/dev/null || echo "main")
    if git pull "$remote" "$BRANCH" 2>&1 | tail -3; then
      ok "Pulled from $remote/$BRANCH"
      PULLED=true
      break
    else
      warn "Failed to pull from $remote — trying next"
    fi
  fi
done

if [[ "$PULLED" != true ]]; then
  warn "No remote pull succeeded — continuing with local code"
fi

AFTER=$(git rev-parse HEAD 2>/dev/null || echo "unknown")

# Restore stashed changes
if [[ "$STASHED" == true ]]; then
  git stash pop 2>/dev/null && ok "Restored stashed changes" || warn "Could not restore stash — run: git stash pop"
fi

if [[ "$BEFORE" == "$AFTER" ]]; then
  echo -e "  Already up to date (${AFTER:0:7})"
else
  echo -e "  Updated: ${BEFORE:0:7} → ${AFTER:0:7}"
  # Show what changed
  git --no-pager log --oneline "${BEFORE}..${AFTER}" 2>/dev/null | head -10
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 2: Install dependencies (only if package.json changed)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo -e "\n${CYAN}${BOLD}[2/5]${NC} ${BOLD}Checking dependencies${NC}"

# --legacy-peer-deps is required: the root pins react-is@^19 while
# @dynatrace/strato-components peer-depends on react-is@^18, so a plain
# npm install dies with ERESOLVE. setup.sh does the same.
# PIPESTATUS is checked because piping into tail would otherwise report
# tail's exit status and hide the failure.
run_npm_install() {
  npm install --legacy-peer-deps --loglevel=warn 2>&1 | tail -3
  if [[ "${PIPESTATUS[0]}" -ne 0 ]]; then
    fail "npm install failed. Re-run with: npm install --legacy-peer-deps"
  fi
}

if [[ "$BEFORE" != "$AFTER" ]] && git diff --name-only "${BEFORE}" "${AFTER}" 2>/dev/null | grep -q "package.json"; then
  echo "  package.json changed — running npm install..."
  run_npm_install
  ok "Dependencies updated"
elif [[ ! -d node_modules ]]; then
  echo "  node_modules missing — running npm install..."
  run_npm_install
  ok "Dependencies installed"
else
  ok "Dependencies up to date (no package.json changes)"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 3: Build TypeScript agents
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo -e "\n${CYAN}${BOLD}[3/5]${NC} ${BOLD}Building TypeScript agents${NC}"

if [[ "$DO_SERVER" == true ]]; then
  npm run build:agents 2>&1 | tail -3
  ok "Agents compiled"
else
  echo "  Skipped (--ui mode)"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 4: Restart server (zero-downtime: stop → start)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo -e "\n${CYAN}${BOLD}[4/5]${NC} ${BOLD}Restarting server${NC}"
echo "  Performing a clean restart: existing running services will be stopped first."
echo "  Templates, saved settings, and credentials are preserved."

if [[ "$DO_RESTART" == true && "$DO_SERVER" == true ]]; then
  if install_or_refresh_service; then
    sudo systemctl restart "$SERVICE_NAME"
    if wait_for_ready "$READY_URL"; then
      ok "Server ready under $SERVICE_NAME"
    elif curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
      warn "Server is healthy but not fully ready — check: ./status.sh"
    else
      warn "Server still starting — check: ./status.sh or sudo journalctl -u $SERVICE_NAME -f"
    fi
  else
    if [[ -f server.pid ]]; then
      PID=$(cat server.pid)
      if kill -0 "$PID" 2>/dev/null; then
        kill "$PID" 2>/dev/null
        echo "  Stopped server (PID $PID)"
        sleep 2
        kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
      fi
      rm -f server.pid
    fi
    pkill -f "node.*server.js" 2>/dev/null || true
    sleep 1

    if [[ -f logs/server.log ]]; then
      LOG_SIZE=$(stat -c%s logs/server.log 2>/dev/null || echo 0)
      if (( LOG_SIZE > 52428800 )); then
        gzip -c logs/server.log > logs/server.log.1.gz
        truncate -s 0 logs/server.log
        ok "Rotated server.log ($(( LOG_SIZE / 1048576 ))MB)"
      fi
    fi

    mkdir -p logs
    nohup npm start >> logs/server.log 2>&1 &
    SERVER_PID=$!
    echo "$SERVER_PID" > server.pid

    if wait_for_ready "$READY_URL"; then
      ok "Server ready on port 8080 (PID: $SERVER_PID)"
    elif curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
      warn "Server is healthy but not fully ready — check: ./status.sh"
    else
      warn "Server still starting — check: tail -f logs/server.log"
    fi
  fi
else
  if [[ "$DO_SERVER" == true ]]; then
    install_or_refresh_service || true
  fi
  echo "  Skipped (--no-restart or --ui mode)"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 5: Deploy AppEngine UI (hot-update — no restart needed)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo -e "\n${CYAN}${BOLD}[5/5]${NC} ${BOLD}Deploying AppEngine UI${NC}"

if [[ "$DO_UI" == true ]]; then
  # Resolve deploy credentials
  DEPLOY_ID="${DEPLOY_OAUTH_CLIENT_ID:-$DT_APP_OAUTH_CLIENT_ID}"
  DEPLOY_SECRET="${DEPLOY_OAUTH_CLIENT_SECRET:-$DT_APP_OAUTH_CLIENT_SECRET}"

  if [[ -z "$DEPLOY_ID" || -z "$DEPLOY_SECRET" ]]; then
    warn "No deploy OAuth credentials found — skipping AppEngine deploy"
    echo -e "  ${CYAN}To deploy manually: DT_APP_OAUTH_CLIENT_ID=... DT_APP_OAUTH_CLIENT_SECRET=... npx dt-app deploy${NC}"
  else
    export DT_APP_OAUTH_CLIENT_ID="$DEPLOY_ID"
    export DT_APP_OAUTH_CLIENT_SECRET="$DEPLOY_SECRET"

    # Function to run UI deploy with timeout
    run_ui_deploy() {
      mkdir -p logs
      local deploy_log="logs/ui-deploy-$(date +%s).log"
      
      echo "  Building AppEngine app..." | tee -a "$deploy_log"
      if ! timeout 120 npx dt-app build >> "$deploy_log" 2>&1; then
        fail "App build failed — check: $deploy_log"
      fi
      ok "App built"

      echo "  Deploying to ${APPS_URL:-Dynatrace}..." | tee -a "$deploy_log"
      if timeout "$DEPLOY_TIMEOUT" npx dt-app deploy --non-interactive >> "$deploy_log" 2>&1; then
        ok "AppEngine UI deployed — changes are live immediately (no restart needed)"
        tail -2 "$deploy_log" | grep -v '^$' || true
        return 0
      else
        local exit_code=$?
        if [[ $exit_code -eq 124 ]]; then
          warn "Deploy timed out after ${DEPLOY_TIMEOUT}s — running in background"
          echo -e "  ${CYAN}Check status: tail -f $deploy_log${NC}"
          return 0  # Non-fatal — server is already updated
        else
          echo "Last 10 lines of deploy log:" >&2
          tail -10 "$deploy_log" >&2
          warn "Deploy had issues — retry with: bash update.sh --ui"
          return 0  # Non-fatal — server is already updated
        fi
      fi
    }

    if [[ "$UI_BACKGROUND" == true ]]; then
      # Run UI deploy in background, don't wait
      mkdir -p logs
      (
        run_ui_deploy
      ) >> logs/ui-deploy-bg.log 2>&1 &
      ok "AppEngine deploy queued in background (check: tail -f logs/ui-deploy-bg.log)"
    else
      # Run UI deploy synchronously (blocks until complete or timeout)
      run_ui_deploy
    fi
  fi
elif [[ "$DO_SERVER" == true ]]; then
  echo "  Skipped (--skip-ui mode)"
else
  echo "  Skipped (--ui-only mode)"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Done
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo -e "${GREEN}${BOLD}✅ Update complete!${NC}"
echo ""
echo -e "  ${CYAN}Server Ready:${NC}   $(curl -sf "$READY_URL" 2>/dev/null | grep -o '"status":"[^"]*"' || echo 'checking...')"
echo -e "  ${CYAN}Commit:${NC}        $(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
echo -e "  ${CYAN}Version:${NC}       $(grep '"version"' app.config.json 2>/dev/null | head -1 | grep -o '"[0-9.]*"' || echo 'unknown')"
if [[ "$DO_UI" == true ]]; then
  echo -e "  ${CYAN}UI Status:${NC}      $(grep -l '2>&1' logs/ui-deploy-*.log 2>/dev/null | tail -1 | xargs tail -1 2>/dev/null || echo 'deploying...')"
fi
echo ""
