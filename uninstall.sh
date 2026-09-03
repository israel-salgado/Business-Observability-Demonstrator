#!/bin/bash
# ============================================================
#  Business Observability Demonstrator — Full Uninstall
# ============================================================
#  Completely removes the Demonstrator from this host:
#    1. Stops the BizObs server
#    2. Stops & removes EdgeConnect Docker container + image
#    3. Removes the log-cleanup cron job
#    4. (Optional) Stops & removes Ollama
#    5. Removes the project directory
#
#  Usage:
#    bash uninstall.sh                # Keep Ollama installed
#    bash uninstall.sh --all          # Also remove Ollama
#
#  To reinstall after uninstall:
#    cd /home/ec2-user
#    git clone https://github.com/israel-salgado/Business-Observability-Demonstrator.git
#    cd Dynatrace-Business-Observability-Forge && ./setup.sh
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOVE_OLLAMA=false

if [[ "${1:-}" == "--all" ]]; then
  REMOVE_OLLAMA=true
fi

# ── Colors ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠ $1${NC}"; }
info() { echo -e "  ${RED}→ $1${NC}"; }

echo -e "${BOLD}"
echo "╔══════════════════════════════════════════════════════════╗"
echo "║     Business Observability Demonstrator — Full Uninstall        ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── Confirm ─────────────────────────────────────────────────
echo -e "  ${RED}This will permanently remove the Demonstrator from this host.${NC}"
if [ "$REMOVE_OLLAMA" = true ]; then
  echo -e "  ${RED}Ollama will also be removed (--all flag).${NC}"
fi
echo ""
read -rp "  Type 'yes' to confirm: " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "  Aborted."
  exit 0
fi
echo ""

# ── 1. Stop the BizObs server ──────────────────────────────
echo -e "${BOLD}[1/5] Stopping BizObs server${NC}"

if [[ -f "$SCRIPT_DIR/server.pid" ]]; then
  PID=$(cat "$SCRIPT_DIR/server.pid")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    sleep 2
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
    ok "Stopped server (PID $PID)"
  else
    ok "Server not running (stale PID)"
  fi
  rm -f "$SCRIPT_DIR/server.pid"
else
  ok "No PID file found"
fi

# Catch any remaining node server processes
pkill -f "node.*server.js" 2>/dev/null || true
sleep 1

# Free port 8080 if still held
if command -v fuser &>/dev/null; then
  fuser -k 8080/tcp 2>/dev/null || true
fi
ok "Server stopped"

# ── 2. Stop & remove EdgeConnect ────────────────────────────
echo -e "${BOLD}[2/5] Removing EdgeConnect container${NC}"

if command -v docker &>/dev/null || command -v sudo &>/dev/null; then
  if sudo docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "edgeconnect-bizobs"; then
    sudo docker stop edgeconnect-bizobs 2>/dev/null || true
    sudo docker rm edgeconnect-bizobs 2>/dev/null || true
    ok "Removed edgeconnect-bizobs container"
  else
    ok "No EdgeConnect container found"
  fi

  if sudo docker images --format '{{.Repository}}' 2>/dev/null | grep -q "dynatrace/edgeconnect"; then
    sudo docker rmi dynatrace/edgeconnect:latest 2>/dev/null || true
    ok "Removed EdgeConnect image"
  else
    ok "No EdgeConnect image found"
  fi
else
  warn "Docker not available — skipping container cleanup"
fi

# ── 3. Remove cron job ──────────────────────────────────────
echo -e "${BOLD}[3/5] Removing log-cleanup cron job${NC}"

if command -v crontab &>/dev/null; then
  if crontab -l 2>/dev/null | grep -q "log-cleanup.sh"; then
    (crontab -l 2>/dev/null || true) | (grep -v "log-cleanup.sh" || true) | crontab -
    ok "Removed cron job"
  else
    ok "No cron job found"
  fi
else
  ok "crontab not installed — nothing to remove"
fi

# ── 4. (Optional) Remove Ollama ─────────────────────────────
echo -e "${BOLD}[4/5] Ollama${NC}"

if [ "$REMOVE_OLLAMA" = true ]; then
  if command -v ollama &>/dev/null; then
    sudo systemctl stop ollama 2>/dev/null || true
    sudo systemctl disable ollama 2>/dev/null || true
    sudo rm -f /usr/local/bin/ollama
    sudo rm -rf /usr/share/ollama 2>/dev/null || true
    sudo rm -rf /home/ec2-user/.ollama 2>/dev/null || true
    sudo userdel ollama 2>/dev/null || true
    sudo groupdel ollama 2>/dev/null || true
    ok "Ollama removed"
  else
    ok "Ollama not installed"
  fi
else
  warn "Skipped — Ollama kept (use --all to remove it too)"
fi

# ── 5. Remove project directory ─────────────────────────────
echo -e "${BOLD}[5/5] Removing project directory${NC}"

# We need to cd out before deleting our own directory
PARENT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PARENT_DIR"
rm -rf "$SCRIPT_DIR"
ok "Removed $SCRIPT_DIR"

# ── Done ────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗"
echo -e "║              Uninstall Complete!                          ║"
echo -e "╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}To reinstall:${NC}"
echo -e "    cd /home/ec2-user"
echo -e "    git clone https://github.com/israel-salgado/Business-Observability-Demonstrator.git"
echo -e "    cd Dynatrace-Business-Observability-Forge"
echo -e "    ./setup.sh"
echo ""

AVAIL_GB=$(( $(df -m / | awk 'NR==2 {print $4}') / 1024 ))
echo -e "  💾 Disk: ${AVAIL_GB}GB free"
