#!/bin/bash
# ============================================================
#  Business Observability Demonstrator — One-Command Release Upgrade
# ============================================================
#
#  Usage:
#    bash release-upgrade.sh
#    Or on another server:
#    curl -fsSL https://raw.githubusercontent.com/israel-salgado/Business-Observability-Demonstrator/main/release-upgrade.sh | bash
#
# ============================================================

set -e

TARGET_DIR="/home/Business-Observability-Demonstrator"
REPO_URL="https://github.com/israel-salgado/Business-Observability-Demonstrator.git"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠ $1${NC}"; }
fail() { echo -e "  ${RED}✗ $1${NC}"; exit 1; }

echo -e "${CYAN}${BOLD}"
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Business Observability Demonstrator — Full Upgrade      ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Step 1: Clone or update repo
echo -e "\n${CYAN}${BOLD}[1/2]${NC} ${BOLD}Repository${NC}"

if [ -d "$TARGET_DIR" ]; then
  ok "Repository found at $TARGET_DIR"
  cd "$TARGET_DIR"
  echo "  Pulling latest changes..."
  if git pull origin main 2>&1 | grep -E "Already up to date|Fast-forward|[0-9]+ file" | tail -1; then
    ok "Repository updated"
  else
    warn "Pull had some warnings — continuing"
  fi
else
  echo "  Repository not found — cloning..."
  if sudo git clone "$REPO_URL" "$TARGET_DIR" >/dev/null 2>&1 || git clone "$REPO_URL" "$TARGET_DIR" >/dev/null 2>&1; then
    ok "Repository cloned to $TARGET_DIR"
    cd "$TARGET_DIR"
    # Fix permissions if cloned with sudo
    [ -O . ] || sudo chown -R $(id -u):$(id -g) "$TARGET_DIR" >/dev/null 2>&1
  else
    fail "Failed to clone repository"
  fi
fi

# Step 2: Full update (server + UI)
echo -e "\n${CYAN}${BOLD}[2/2]${NC} ${BOLD}Running full update${NC}"
echo "  Executing: bash update.sh"
echo ""

if [ -x update.sh ]; then
  bash update.sh  # Full update with server + UI deploy
else
  fail "update.sh not found or not executable"
fi

echo ""
echo -e "${GREEN}${BOLD}✅ Full upgrade complete!${NC}"
echo ""
