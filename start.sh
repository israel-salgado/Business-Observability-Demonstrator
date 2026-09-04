#!/bin/bash
# ============================================================
#  Business Observability Demonstrator — One-Command Bootstrap
# ============================================================
#
#  Run this on a fresh Linux machine. It installs git and curl if missing,
#  clones the repo, and hands off to setup.sh, which then prompts you for
#  your Dynatrace tenant details and credentials.
#
#  USAGE (recommended — keeps prompts working):
#    bash <(curl -fsSL https://raw.githubusercontent.com/israel-salgado/Business-Observability-Demonstrator/wip/test-updates/start.sh)
#
#  ALSO WORKS (stdin is re-attached to the terminal for you):
#    curl -fsSL https://raw.githubusercontent.com/israel-salgado/Business-Observability-Demonstrator/wip/test-updates/start.sh | bash
#
#  OPTIONS (environment variables):
#    BRANCH=main            git branch to clone      (default: wip/test-updates)
#    INSTALL_DIR=/opt/bizobs  where to clone         (default: $HOME/Business-Observability-Demonstrator)
#    REPO_URL=https://...   fork to clone from
#
#  You need: a Linux box with systemd, sudo, and one of dnf/yum/apt.
#  You do NOT need: Node, Docker, OneAgent or Ollama. setup.sh handles Node
#  and Docker; OneAgent and Ollama are optional and not required for a demo.
# ============================================================
set -e

REPO_URL="${REPO_URL:-https://github.com/israel-salgado/Business-Observability-Demonstrator.git}"
BRANCH="${BRANCH:-wip/test-updates}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/Business-Observability-Demonstrator}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
step() { echo -e "\n${BLUE}━━━ $1 ━━━${NC}"; }
ok()   { echo -e "  ${GREEN}✓ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠ $1${NC}"; }
fail() { echo -e "  ${RED}✗ $1${NC}"; exit 1; }

echo -e "${BLUE}"
cat << 'BANNER'
╔══════════════════════════════════════════════════════════════╗
║   Business Observability Demonstrator — Bootstrap            ║
╚══════════════════════════════════════════════════════════════╝
BANNER
echo -e "${NC}"

# ── Sanity checks ───────────────────────────────────────────
step "Checking the basics"

[ "$(uname -s)" = "Linux" ] || fail "This installer is for Linux. Detected: $(uname -s)"

if [ "$(id -u)" -eq 0 ]; then
  warn "Running as root. The server will be owned by root."
  warn "Running as a normal user with sudo is preferred."
fi

if ! command -v sudo >/dev/null 2>&1; then
  fail "sudo is required. Install it, or run as a user that has it."
fi

# Detect the package manager up front so we can fail early with a clear message.
if command -v dnf >/dev/null 2>&1;      then PKG_INSTALL="sudo dnf install -y"
elif command -v yum >/dev/null 2>&1;    then PKG_INSTALL="sudo yum install -y"
elif command -v apt-get >/dev/null 2>&1; then PKG_INSTALL="sudo apt-get install -y"; sudo apt-get update -qq || true
else fail "No supported package manager found (need dnf, yum or apt-get)."
fi
ok "Package manager: ${PKG_INSTALL}"

if ! command -v systemctl >/dev/null 2>&1; then
  warn "systemd not found. The server will run under nohup instead of a service."
  warn "It will work, but won't restart automatically after a reboot."
fi

# ── Prerequisites that setup.sh itself does not install ─────
step "Installing git and curl if needed"

for tool in git curl; do
  if command -v "$tool" >/dev/null 2>&1; then
    ok "$tool already present"
  else
    echo "  Installing $tool..."
    $PKG_INSTALL "$tool" >/dev/null 2>&1 || fail "Could not install $tool. Install it manually and re-run."
    ok "$tool installed"
  fi
done

# ── Clone or update ─────────────────────────────────────────
step "Fetching the repository"

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "  Already cloned at $INSTALL_DIR — updating..."
  cd "$INSTALL_DIR"
  git fetch origin --quiet
  git checkout "$BRANCH" --quiet
  git pull origin "$BRANCH" --quiet
  ok "Updated to latest $BRANCH"
else
  echo "  Cloning $BRANCH into $INSTALL_DIR..."
  git clone --branch "$BRANCH" --quiet "$REPO_URL" "$INSTALL_DIR" \
    || fail "Clone failed. Check the branch name and your network."
  cd "$INSTALL_DIR"
  ok "Cloned to $INSTALL_DIR"
fi

# ── What you'll be asked for ────────────────────────────────
step "Next: setup.sh will ask you for 4 things"

# Resolve the fallback text OUTSIDE the heredoc. Inside a ${VAR:-default}
# expansion, a literal "<" is parsed as a redirection operator and bash fails
# with "bad substitution", killing the script before it ever reaches setup.sh.
# Same detection setup.sh uses, kept in sync deliberately: this banner tells the
# user which address the EdgeConnect will be pointed at, so showing a different
# one than setup.sh actually uses would be worse than showing nothing.
# Default-route source address first, then the first non-virtual address.
PRIVATE_IP="$(ip route get 1.1.1.1 2>/dev/null | grep -oP '(?<=src )\d+(\.\d+){3}' | head -1)"
if [ -z "$PRIVATE_IP" ]; then
  for candidate in $(hostname -I 2>/dev/null); do
    case "$candidate" in
      127.*|169.254.*) continue ;;
      172.1[7-9].*|172.2[0-9].*|172.3[0-1].*) continue ;;
      *) PRIVATE_IP="$candidate"; break ;;
    esac
  done
fi
[ -z "$PRIVATE_IP" ] && PRIVATE_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
IP_HINT="${PRIVATE_IP:-not detected — run  hostname -I  to find it}"

# Quoted heredoc: nothing in this block is expanded by the shell, so prose can
# contain any punctuation safely. Values are substituted with printf below.
# (An earlier version interpolated directly here and crashed with
# "bad substitution" because a default value contained angle brackets, which
# bash read as a redirection.)
cat << 'INFO'

  Have these ready. Both come from Account Management (myaccount.dynatrace.com).

    1. Environment type    sprint or prod
    2. Tenant ID           the abc12345 part of your Dynatrace URL
    3. Platform token      dt0s16...   IAM -> Platform tokens
    4. OAuth client        dt0s02...   IAM -> OAuth clients
                           needs 6 permissions:
                             app-engine:apps:install
                             app-engine:apps:run
                             app-engine:edge-connects:connect
                             app-engine:edge-connects:read
                             app-engine:edge-connects:write
                             oauth2:clients:manage

  You do NOT need to create an EdgeConnect by hand. Setup creates it for you,
  names it, sets the host pattern, and collects the generated credentials.

INFO

printf '  Private IP of this machine: %s\n' "$IP_HINT"
printf '  Full details: %s/README-START_HERE.md\n\n' "$INSTALL_DIR"

# Give the user a chance to bail out and go create credentials first.
# Read from /dev/tty so this works even when piped from curl.
if [ -e /dev/tty ]; then
  printf "  Ready to continue? [Y/n] "
  read -r proceed < /dev/tty || proceed="y"
  case "$proceed" in
    [Nn]*)
      echo ""
      ok "Stopped. Nothing has been changed on this machine beyond git/curl."
      echo -e "  Resume any time with:  ${BOLD}cd $INSTALL_DIR && ./setup.sh${NC}"
      exit 0
      ;;
  esac
fi

# ── Hand off ────────────────────────────────────────────────
step "Handing off to setup.sh"

chmod +x setup.sh

# stdin is redirected from /dev/tty so setup.sh's interactive prompts still work
# when this script was piped in from curl (where stdin is the consumed pipe).
if [ -e /dev/tty ]; then
  exec ./setup.sh < /dev/tty
else
  exec ./setup.sh
fi
