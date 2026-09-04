#!/bin/bash
# ============================================================
#  Business Observability Demonstrator — Full Uninstall
# ============================================================
#  Removes the Demonstrator from this host AND from your Dynatrace tenant.
#
#  Order matters: tenant cleanup runs FIRST, because it needs the credentials
#  in setup.conf, and the last step deletes the directory those live in.
#
#    1. Dynatrace tenant  — the app, and the EdgeConnect configuration
#    2. systemd units     — stopped and disabled before anything is killed
#    3. Server process
#    4. EdgeConnect container and image
#    5. Log-cleanup cron job
#    6. Ollama (only with --all)
#    7. The project directory
#
#  Usage:
#    ./uninstall.sh                 # everything except Ollama
#    ./uninstall.sh --all           # also remove Ollama
#    ./uninstall.sh --keep-repo     # leave the project directory in place
#    ./uninstall.sh --host-only     # skip tenant cleanup entirely
# ============================================================

set -uo pipefail   # deliberately NOT -e: teardown continues past failures

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF_FILE="$SCRIPT_DIR/setup.conf"

REMOVE_OLLAMA=false
KEEP_REPO=false
HOST_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --all)       REMOVE_OLLAMA=true ;;
    --keep-repo) KEEP_REPO=true ;;
    --host-only) HOST_ONLY=true ;;
  esac
done

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠ $1${NC}"; }
info() { echo -e "  ${CYAN}→ $1${NC}"; }

echo -e "${BOLD}"
echo "╔══════════════════════════════════════════════════════════╗"
echo "║   Business Observability Demonstrator — Full Uninstall    ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo -e "  ${RED}This removes the Demonstrator from this host.${NC}"
[ "$HOST_ONLY" = false ] && echo -e "  ${RED}It also removes the app and EdgeConnect from your Dynatrace tenant.${NC}"
[ "$REMOVE_OLLAMA" = true ] && echo -e "  ${RED}Ollama will be removed too (--all).${NC}"
[ "$KEEP_REPO" = true ] && echo -e "  ${YELLOW}The project directory will be kept (--keep-repo).${NC}"
echo ""
read -rp "  Type 'yes' to confirm: " CONFIRM
[[ "$CONFIRM" != "yes" ]] && { echo "  Aborted."; exit 0; }
echo ""

# ── 1. Dynatrace tenant ─────────────────────────────────────
# First, because it needs setup.conf and step 7 deletes it.
echo -e "${BOLD}[1/7] Dynatrace tenant${NC}"

if [ "$HOST_ONLY" = true ]; then
  info "Skipped (--host-only)"
elif [ ! -f "$CONF_FILE" ]; then
  warn "No setup.conf — cannot authenticate, skipping tenant cleanup."
  warn "Remove the app and EdgeConnect manually (instructions at the end)."
else
  # shellcheck disable=SC1090
  source "$CONF_FILE"

  if [ "${ENV_TYPE:-sprint}" = "prod" ]; then
    APPS_URL="https://${TENANT_ID}.apps.dynatrace.com"
    SSO_URL="https://sso.dynatrace.com/sso/oauth2/token"
  else
    APPS_URL="https://${TENANT_ID}.sprint.apps.dynatracelabs.com"
    SSO_URL="https://sso-sprint.dynatracelabs.com/sso/oauth2/token"
  fi

  # Ask for one scope at a time so we can tell exactly which are available.
  # --data-urlencode, not -d: the body is form-encoded, and sending a raw or
  # hand-%20-encoded space makes the endpoint reject the request, which reads
  # as "scope denied" when it is really a malformed request.
  get_token() {
    curl -s -X POST "$SSO_URL" \
      --data-urlencode "grant_type=client_credentials" \
      --data-urlencode "client_id=${DEPLOY_OAUTH_CLIENT_ID:-}" \
      --data-urlencode "client_secret=${DEPLOY_OAUTH_CLIENT_SECRET:-}" \
      --data-urlencode "scope=$1" \
      --data-urlencode "resource=urn:dtenvironment:${TENANT_ID}" \
      2>/dev/null | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4
  }

  # ── 1a. The app ──
  APP_REMOVED=false
  if [ -n "$(get_token 'app-engine:apps:delete')" ]; then
    ok "OAuth client has app-engine:apps:delete"
    echo "  Uninstalling the app from $APPS_URL ..."
    export DT_APP_OAUTH_CLIENT_ID="${DEPLOY_OAUTH_CLIENT_ID:-}"
    export DT_APP_OAUTH_CLIENT_SECRET="${DEPLOY_OAUTH_CLIENT_SECRET:-}"
    if (cd "$SCRIPT_DIR" && npx dt-app uninstall --non-interactive >/dev/null 2>&1); then
      ok "App uninstalled from the tenant"
      APP_REMOVED=true
    else
      warn "npx dt-app uninstall failed — remove it from the UI (see below)"
    fi
  else
    warn "OAuth client does NOT have app-engine:apps:delete."
    warn "That permission was not added when this OAuth client was created,"
    warn "so the app CANNOT be removed from here. Delete it manually:"
    echo ""
    echo -e "    ${BOLD}Dynatrace → Hub → Manage${NC}"
    echo -e "    The Hub opens on ${BOLD}Discover${NC}, which only lists apps you can"
    echo -e "    install. Installed apps are under ${BOLD}Manage${NC} — custom apps are"
    echo -e "    not under Settings, which is where most people look first."
    echo -e "    Search ${BOLD}demonstrator${NC}, then delete it."
    echo ""
    echo -e "    To avoid this next time, add ${BOLD}app-engine:apps:delete${NC} to the"
    echo -e "    OAuth client in Account Management → IAM → OAuth clients."
    echo ""
  fi

  # ── 1b. The EdgeConnect ──
  EC_TOKEN="$(get_token 'app-engine:edge-connects:write app-engine:edge-connects:read')"
  EC_NAME="${EDGECONNECT_NAME:-bizobs-demonstrator}"
  if [ -n "$EC_TOKEN" ]; then
    EC_API="$APPS_URL/platform/app-engine/edge-connect/v1/edge-connects"
    EC_IDS="$(curl -s -H "Authorization: Bearer $EC_TOKEN" "$EC_API" 2>/dev/null | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for e in d.get('edgeConnects', d if isinstance(d, list) else []):
    if e.get('name') == '${EC_NAME}':
        print(e['id'])
" 2>/dev/null)"
    if [ -n "$EC_IDS" ]; then
      for id in $EC_IDS; do
        CODE="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE \
          -H "Authorization: Bearer $EC_TOKEN" "$EC_API/$id" 2>/dev/null)"
        case "$CODE" in
          2*) ok "Deleted EdgeConnect '$EC_NAME' ($id)" ;;
          *)  warn "Could not delete EdgeConnect $id (HTTP $CODE) — remove it in Settings" ;;
        esac
      done
    else
      ok "No EdgeConnect named '$EC_NAME' in the tenant"
    fi
  else
    warn "No EdgeConnect permissions — remove '$EC_NAME' manually from"
    warn "Settings → General → External requests → EdgeConnect tab"
  fi
fi

# ── 2. systemd units ────────────────────────────────────────
# Before killing anything: systemd would otherwise restart the server we are
# about to stop, and the old uninstaller deleted the project directory out from
# under a service that was still enabled.
echo -e "${BOLD}[2/7] systemd units${NC}"

if command -v systemctl >/dev/null 2>&1; then
  for unit in bizobs-server.service bizobs-log-guard.timer bizobs-log-guard.service; do
    if systemctl list-unit-files 2>/dev/null | grep -q "^${unit}"; then
      sudo systemctl disable --now "$unit" >/dev/null 2>&1 || true
      ok "Stopped and disabled $unit"
    fi
  done
  sudo rm -f /etc/systemd/system/bizobs-server.service \
             /etc/systemd/system/bizobs-log-guard.service \
             /etc/systemd/system/bizobs-log-guard.timer 2>/dev/null || true
  sudo systemctl daemon-reload >/dev/null 2>&1 || true
  ok "Unit files removed"
else
  ok "No systemd on this host"
fi

# ── 3. Server process ───────────────────────────────────────
echo -e "${BOLD}[3/7] Server process${NC}"

if [[ -f "$SCRIPT_DIR/server.pid" ]]; then
  PID="$(cat "$SCRIPT_DIR/server.pid")"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    sleep 2
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
    ok "Stopped server (PID $PID)"
  else
    ok "Server not running (stale PID file)"
  fi
  rm -f "$SCRIPT_DIR/server.pid"
fi

# Only target processes running THIS install's server.js. A blanket
# `pkill -f node.*server.js` would take out unrelated Node apps on the host.
LEFTOVER="$(pgrep -f "${SCRIPT_DIR}/server.js" 2>/dev/null || true)"
if [ -z "$LEFTOVER" ]; then
  LEFTOVER="$(pgrep -f 'node.*server\.js' 2>/dev/null | while read -r p; do
      [ "$(readlink -f "/proc/$p/cwd" 2>/dev/null)" = "$SCRIPT_DIR" ] && echo "$p"
    done)"
fi
if [ -n "$LEFTOVER" ]; then
  # shellcheck disable=SC2086
  kill $LEFTOVER 2>/dev/null || true
  ok "Stopped leftover server process(es): $(echo "$LEFTOVER" | tr '\n' ' ')"
else
  ok "No leftover server processes"
fi

# Deliberately NOT running `fuser -k 8080/tcp`: if something unrelated is on
# 8080, killing it is not this script's business.
if command -v ss >/dev/null 2>&1 && ss -tln 2>/dev/null | grep -q ':8080 '; then
  warn "Something is still listening on port 8080 — not ours, leaving it alone"
fi

# ── 4. EdgeConnect container ────────────────────────────────
echo -e "${BOLD}[4/7] EdgeConnect container${NC}"

if command -v docker >/dev/null 2>&1; then
  if sudo docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^edgeconnect-bizobs$'; then
    sudo docker rm -f edgeconnect-bizobs >/dev/null 2>&1 || true
    ok "Removed edgeconnect-bizobs container"
  else
    ok "No EdgeConnect container found"
  fi
  if sudo docker images --format '{{.Repository}}' 2>/dev/null | grep -q 'dynatrace/edgeconnect'; then
    sudo docker rmi dynatrace/edgeconnect:latest >/dev/null 2>&1 || true
    ok "Removed EdgeConnect image"
  fi
else
  ok "Docker not installed — nothing to remove"
fi

# ── 5. Cron job ─────────────────────────────────────────────
echo -e "${BOLD}[5/7] Log-cleanup cron job${NC}"

if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -q 'log-cleanup.sh'; then
  (crontab -l 2>/dev/null || true) | (grep -v 'log-cleanup.sh' || true) | crontab -
  ok "Removed cron job"
else
  ok "No cron job found"
fi

# ── 6. Ollama ───────────────────────────────────────────────
echo -e "${BOLD}[6/7] Ollama${NC}"

if [ "$REMOVE_OLLAMA" = true ]; then
  if command -v ollama >/dev/null 2>&1; then
    sudo systemctl disable --now ollama >/dev/null 2>&1 || true
    sudo rm -f /usr/local/bin/ollama
    sudo rm -rf /usr/share/ollama 2>/dev/null || true
    rm -rf "$HOME/.ollama" 2>/dev/null || true   # $HOME, not a hardcoded ec2-user path
    sudo userdel ollama 2>/dev/null || true
    sudo groupdel ollama 2>/dev/null || true
    ok "Ollama removed"
  else
    ok "Ollama not installed"
  fi
else
  info "Kept (use --all to remove it)"
fi

# ── 7. Project directory ────────────────────────────────────
echo -e "${BOLD}[7/7] Project directory${NC}"

if [ "$KEEP_REPO" = true ]; then
  info "Kept at $SCRIPT_DIR (--keep-repo)"
  warn "setup.conf still contains your credentials"
else
  warn "Deleting $SCRIPT_DIR — this includes setup.conf and your platform token."
  warn "The platform token is shown only once by Dynatrace and cannot be recovered."
  cd "$(dirname "$SCRIPT_DIR")" || cd /
  rm -rf "$SCRIPT_DIR"
  ok "Removed $SCRIPT_DIR"
fi

# ── Done ────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗"
echo -e "║                 Uninstall Complete                        ║"
echo -e "╚══════════════════════════════════════════════════════════╝${NC}"
echo ""

if [ "$HOST_ONLY" = false ] && [ "${APP_REMOVED:-false}" != true ]; then
  echo -e "  ${YELLOW}Still to do by hand:${NC} remove the app from ${BOLD}Hub → Manage${NC}"
  echo -e "  (the Hub opens on Discover; installed apps are under Manage)."
  echo ""
fi

echo -e "  ${BOLD}To reinstall:${NC}"
echo -e "    bash <(curl -fsSL https://raw.githubusercontent.com/israel-salgado/Business-Observability-Demonstrator/wip/test-updates/start.sh)"
echo ""

AVAIL_GB=$(( $(df -m / | awk 'NR==2 {print $4}') / 1024 ))
echo -e "  Disk free: ${AVAIL_GB}GB"
