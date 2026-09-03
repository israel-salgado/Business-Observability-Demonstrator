#!/bin/bash
# ============================================================
#  Business Observability Demonstrator — EC2 Bootstrap Script
# ============================================================
#
#  Run this on a FRESH Amazon Linux 2023 (or AL2/Ubuntu) EC2 instance.
#  It handles everything from bare metal to running app.
#
#  PREREQUISITES:
#    • EC2 instance: t3.large+ (4GB RAM min, 8GB recommended)
#    • Storage: 30GB+ gp3 EBS volume
#    • Security group inbound rules:
#        - TCP 22   (SSH)
#        - TCP 8080  (BizObs server)
#        - TCP 8081-8120 (child service ports)
#        - TCP 11434 (Ollama AI – optional, localhost only)
#    • IAM: No special role required (all DT comms via API tokens)
#
#  USAGE:
#    # Option A: SSH in and run interactively (prompts for DT creds)
#    curl -fsSL https://raw.githubusercontent.com/israel-salgado/Business-Observability-Demonstrator/main/bootstrap-ec2.sh | bash
#
#    # Option B: Pass all credentials via CLI flags (CI/CD, no prompts)
#    bash bootstrap-ec2.sh \
#      --dt-url https://abc123.live.dynatrace.com \
#      --dt-token dt0c01.XXXX \
#      --otel-token dt0c01.YYYY \
#      --app-oauth-id dt0s02.XXXX \
#      --app-oauth-secret dt0s02.XXXX.YYYY \
#      --ec-name bizobs-demonstrator \
#      --ec-client-id dt0s10.XXXX \
#      --ec-client-secret dt0s10.XXXX.YYYY \
#      --ec-resource urn:dtenvironment:abc123
#
#    # Option C: Paste as EC2 User Data (runs on first boot)
#    (paste this entire script into Advanced Details → User Data when launching)
#
#    # Extra flags:
#      --skip-appengine    Skip Dynatrace AppEngine UI deployment
#      --skip-edgeconnect  Skip EdgeConnect tunnel setup
#      --skip-oneagent     Skip Dynatrace OneAgent install
#      --branch BRANCH     Git branch to clone (default: main)
#
# ============================================================

set -euo pipefail

# ── Colors ──
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; exit 1; }

# ── Parse flags (pass through to deploy.sh) ──
BRANCH="main"
DEPLOY_ARGS=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --branch) BRANCH="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: bash bootstrap-ec2.sh [--branch BRANCH] [deploy.sh flags...]"
      echo "  --branch BRANCH   Git branch to clone (default: main)"
      echo ""
      echo "All other flags are passed through to deploy.sh:"
      echo "  --dt-url, --dt-token, --otel-token, --app-oauth-id,"
      echo "  --app-oauth-secret, --ec-name, --ec-client-id,"
      echo "  --ec-client-secret, --ec-resource,"
      echo "  --skip-appengine, --skip-edgeconnect,"
      echo "  --skip-oneagent"
      exit 0 ;;
    *) DEPLOY_ARGS+=("$1"); shift ;;
  esac
done

REPO_URL="https://github.com/israel-salgado/Business-Observability-Demonstrator.git"
INSTALL_DIR="/home/ec2-user/Business-Observability-Demonstrator"

echo -e "${BOLD}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   Business Observability Demonstrator — EC2 Full Bootstrap         ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║   Phase 1: System packages + Node.js + Docker + Git         ║"
echo "║   Phase 2: Clone repo                                       ║"
echo "║   Phase 3: Run deploy.sh (npm, build, DT config, start)     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 1: System Prerequisites
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo -e "\n${CYAN}${BOLD}[Phase 1/3]${NC} ${BOLD}System Prerequisites${NC}"

# Detect package manager
if command -v dnf &>/dev/null; then
  PKG="sudo dnf"
  PKG_INSTALL="$PKG install -y"
elif command -v yum &>/dev/null; then
  PKG="sudo yum"
  PKG_INSTALL="$PKG install -y"
elif command -v apt-get &>/dev/null; then
  PKG="sudo apt-get"
  PKG_INSTALL="$PKG install -y"
  sudo apt-get update -qq
else
  fail "No supported package manager found (dnf/yum/apt-get)"
fi

# Essential packages
echo "  Installing system packages..."
$PKG_INSTALL git curl tar gzip 2>&1 | tail -1 || true
ok "System packages"

# Node.js 20 (LTS)
if command -v node &>/dev/null; then
  NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
  if [[ "$NODE_VER" -ge 18 ]]; then
    ok "Node.js $(node --version) already installed"
  else
    warn "Node.js too old, upgrading..."
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - 2>/dev/null \
      || (curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -) 2>/dev/null
    $PKG_INSTALL nodejs
    ok "Node.js $(node --version) installed"
  fi
else
  echo "  Installing Node.js 20..."
  curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - 2>/dev/null \
    || (curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -) 2>/dev/null
  $PKG_INSTALL nodejs 2>&1 | tail -2
  ok "Node.js $(node --version) installed"
fi

# Docker (needed for EdgeConnect)
if command -v docker &>/dev/null; then
  ok "Docker already installed"
else
  echo "  Installing Docker..."
  $PKG_INSTALL docker 2>&1 | tail -2 || true
  sudo systemctl start docker 2>/dev/null || true
  sudo systemctl enable docker 2>/dev/null || true
  sudo usermod -aG docker ec2-user 2>/dev/null || true
  ok "Docker installed"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 2: Clone Repository
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo -e "\n${CYAN}${BOLD}[Phase 2/3]${NC} ${BOLD}Clone Repository${NC}"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "  Repo already exists — pulling latest..."
  cd "$INSTALL_DIR"
  git fetch origin
  git checkout "$BRANCH"
  git pull origin "$BRANCH"
  ok "Updated to latest $BRANCH"
else
  echo "  Cloning $REPO_URL (branch: $BRANCH)..."
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  ok "Cloned to $INSTALL_DIR"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Phase 3: Run deploy.sh
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo -e "\n${CYAN}${BOLD}[Phase 3/3]${NC} ${BOLD}Running deploy.sh${NC}"

if [[ ! -f "deploy.sh" ]]; then
  fail "deploy.sh not found in $INSTALL_DIR"
fi

chmod +x deploy.sh
bash deploy.sh "${DEPLOY_ARGS[@]}"
