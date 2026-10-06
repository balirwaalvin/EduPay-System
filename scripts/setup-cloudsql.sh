#!/usr/bin/env bash
#
# Deploy the EduPay schema to Google Cloud SQL for PostgreSQL.
#
# Checks the prerequisites, starts the Cloud SQL Auth Proxy if it is not already
# running, applies the migrations and seeds the first administrator.
#
#   ./scripts/setup-cloudsql.sh
#
# Expects these in .env (or the environment):
#   INSTANCE_CONNECTION_NAME   project:region:instance
#   DB_USER, DB_PASSWORD, DB_NAME
#   JWT_SECRET
#
set -euo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$OFF" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$OFF" "$1"; }
die()  { printf '\n  %s✗ %s%s\n\n' "$RED" "$1" "$OFF" >&2; exit 1; }

printf '\n  EduPay — Cloud SQL schema deployment\n\n'

# --- Configuration ---------------------------------------------------------
if [[ -f .env ]]; then
    set -a; # shellcheck disable=SC1091
    source .env; set +a
    ok ".env loaded"
else
    warn ".env not found — relying on the environment"
fi

: "${INSTANCE_CONNECTION_NAME:?Set INSTANCE_CONNECTION_NAME (project:region:instance) in .env}"
: "${DB_USER:?Set DB_USER in .env}"
: "${DB_PASSWORD:?Set DB_PASSWORD in .env}"
: "${DB_NAME:?Set DB_NAME in .env}"

if [[ -z "${JWT_SECRET:-}" ]]; then
    die "JWT_SECRET is not set. Generate one with: openssl rand -base64 48"
fi
if (( ${#JWT_SECRET} < 32 )); then
    die "JWT_SECRET must be at least 32 characters."
fi

PROXY_PORT="${PROXY_PORT:-5432}"

# --- Prerequisites ---------------------------------------------------------
command -v node >/dev/null || die "Node.js is not installed."

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
(( NODE_MAJOR >= 20 )) || die "Node.js 20 or newer is required (found $(node -v))."
ok "Node $(node -v)"

[[ -d node_modules ]] || { warn "Installing dependencies"; npm install; }

# --- Cloud SQL Auth Proxy --------------------------------------------------
PROXY_BIN=""
for candidate in ./cloud-sql-proxy "$(command -v cloud-sql-proxy 2>/dev/null || true)"; do
    [[ -n "$candidate" && -x "$candidate" ]] && { PROXY_BIN="$candidate"; break; }
done

PROXY_PID=""
cleanup() {
    if [[ -n "$PROXY_PID" ]]; then
        printf '\n  %sStopping the Auth Proxy%s\n' "$DIM" "$OFF"
        kill "$PROXY_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

if (exec 3<>/dev/tcp/127.0.0.1/"$PROXY_PORT") 2>/dev/null; then
    ok "Something is already listening on port $PROXY_PORT — assuming the proxy is up"
elif [[ -n "$PROXY_BIN" ]]; then
    warn "Starting the Cloud SQL Auth Proxy"
    "$PROXY_BIN" "$INSTANCE_CONNECTION_NAME" --port "$PROXY_PORT" >/tmp/edupay-proxy.log 2>&1 &
    PROXY_PID=$!

    for _ in $(seq 1 30); do
        (exec 3<>/dev/tcp/127.0.0.1/"$PROXY_PORT") 2>/dev/null && break
        sleep 1
    done

    (exec 3<>/dev/tcp/127.0.0.1/"$PROXY_PORT") 2>/dev/null \
        || die "The proxy did not start. See /tmp/edupay-proxy.log"
    ok "Auth Proxy listening on $PROXY_PORT"
else
    die "The Cloud SQL Auth Proxy is not installed, and nothing is listening on port $PROXY_PORT.

  Install it:
    curl -o cloud-sql-proxy \\
      https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.1/cloud-sql-proxy.linux.amd64
    chmod +x cloud-sql-proxy

  Then authenticate:
    gcloud auth application-default login"
fi

# The app reads DATABASE_URL; point it at the proxy. The password is
# percent-encoded so punctuation cannot break the URL.
ENCODED_PASSWORD=$(node -p 'encodeURIComponent(process.env.DB_PASSWORD)')
export DATABASE_URL="postgresql://${DB_USER}:${ENCODED_PASSWORD}@127.0.0.1:${PROXY_PORT}/${DB_NAME}"

# --- Deploy ----------------------------------------------------------------
printf '\n  %sApplying migrations%s\n' "$DIM" "$OFF"
npm run --silent db:migrate

printf '\n  %sSeeding%s\n' "$DIM" "$OFF"
npm run --silent db:seed

printf '\n  %sVerifying%s\n' "$DIM" "$OFF"
npm run --silent db:migrate:status

printf '\n  %s✓ Done.%s Store the administrator password above — it is shown only once.\n' "$GREEN" "$OFF"
printf '  Start the app with:  npm start\n\n'
