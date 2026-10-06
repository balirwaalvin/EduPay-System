#!/usr/bin/env bash
#
# Local PostgreSQL for development, in a container. No cloud account, no
# credentials, no Auth Proxy — everything runs on this machine.
#
#   ./scripts/dev-db.sh up       start the database, migrate and seed
#   ./scripts/dev-db.sh stop     stop it, keeping the data
#   ./scripts/dev-db.sh down     stop and delete it, data included
#   ./scripts/dev-db.sh psql     open a SQL prompt
#   ./scripts/dev-db.sh reset    delete and rebuild from scratch
#
set -euo pipefail

cd "$(dirname "$0")/.."

NAME="${DEV_DB_CONTAINER:-edupay-dev-db}"
PORT="${DEV_DB_PORT:-5433}"
USER_NAME=edupay
PASSWORD=edupay_dev
DB_NAME=edupay_dev
TEST_DB=edupay_dev_test
IMAGE="docker.io/library/postgres:16-alpine"

GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$OFF" "$1"; }
info() { printf '  %s%s%s\n' "$DIM" "$1" "$OFF"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$OFF" "$1"; }
die()  { printf '\n  %s\n\n' "$1" >&2; exit 1; }

# Either container runtime is fine.
RUNTIME=""
for candidate in podman docker; do
    command -v "$candidate" >/dev/null && { RUNTIME="$candidate"; break; }
done
[[ -n "$RUNTIME" ]] || die "Neither podman nor docker is installed."

URL="postgresql://${USER_NAME}:${PASSWORD}@127.0.0.1:${PORT}/${DB_NAME}"
TEST_URL="postgresql://${USER_NAME}:${PASSWORD}@127.0.0.1:${PORT}/${TEST_DB}"

exists()  { "$RUNTIME" ps -a --format '{{.Names}}' | grep -qx "$NAME"; }
running() { "$RUNTIME" ps    --format '{{.Names}}' | grep -qx "$NAME"; }

# The official image starts a temporary server to run its init scripts, then
# restarts. pg_isready succeeds against that temporary server, so a command
# issued straight afterwards can hit a closed connection. Require two real
# queries a second apart to be confident the final server is up.
wait_ready() {
    local consecutive=0

    for _ in $(seq 1 60); do
        if "$RUNTIME" exec "$NAME" psql -U "$USER_NAME" -d "$DB_NAME" -tAc 'SELECT 1' >/dev/null 2>&1; then
            consecutive=$(( consecutive + 1 ))
            (( consecutive >= 2 )) && return 0
        else
            consecutive=0
        fi
        sleep 1
    done

    die "The database did not become ready. Check: $RUNTIME logs $NAME"
}

# Create the test database, retrying in case the server is still settling, and
# fail loudly rather than leaving the test suites to discover it is missing.
ensure_test_db() {
    for _ in $(seq 1 10); do
        if "$RUNTIME" exec "$NAME" psql -U "$USER_NAME" -d postgres -tAc \
               "SELECT 1 FROM pg_database WHERE datname='${TEST_DB}'" 2>/dev/null | grep -qx 1; then
            return 0
        fi
        "$RUNTIME" exec "$NAME" createdb -U "$USER_NAME" "$TEST_DB" >/dev/null 2>&1 || true
        sleep 1
    done

    die "Could not create the test database '${TEST_DB}'. Check: $RUNTIME logs $NAME"
}

start() {
    if running; then
        ok "Already running"
    elif exists; then
        "$RUNTIME" start "$NAME" >/dev/null
        wait_ready
        ok "Restarted (existing data kept)"
    else
        info "Pulling and starting PostgreSQL 16"
        "$RUNTIME" run -d --name "$NAME" \
            -e POSTGRES_USER="$USER_NAME" \
            -e POSTGRES_PASSWORD="$PASSWORD" \
            -e POSTGRES_DB="$DB_NAME" \
            -p "${PORT}:5432" \
            "$IMAGE" >/dev/null
        wait_ready
        ok "Started on port $PORT"
    fi

    # A separate database for the test suites, which truncate everything.
    ensure_test_db
    ok "Test database '${TEST_DB}' present"
}

case "${1:-up}" in
    up)
        printf '\n  EduPay — local development database\n\n'
        start

        [[ -d node_modules ]] || { info "Installing dependencies"; npm install; }

        info "Applying migrations"
        DATABASE_URL="$URL" npm run --silent db:migrate

        info "Seeding"
        DATABASE_URL="$URL" JWT_SECRET="${JWT_SECRET:-local-development-secret-not-for-production-32}" \
            npm run --silent db:seed

        printf '\n%s' "$GREEN"
        printf '  ✓ Ready.%s Add these to .env:\n\n' "$OFF"
        printf '    DATABASE_URL=%s\n' "$URL"
        printf '    TEST_DATABASE_URL=%s\n' "$TEST_URL"
        printf '    JWT_SECRET=local-development-secret-not-for-production-32\n\n'
        printf '  Then:  npm start        and open http://localhost:3000\n'
        printf '  Tests: npm test        (143 tests, with TEST_DATABASE_URL set)\n\n'
        ;;

    stop)
        running && { "$RUNTIME" stop "$NAME" >/dev/null; ok "Stopped (data kept)"; } || warn "Not running"
        ;;

    down)
        exists || { warn "Nothing to remove"; exit 0; }
        "$RUNTIME" rm -f "$NAME" >/dev/null
        ok "Removed, data deleted"
        ;;

    reset)
        exists && "$RUNTIME" rm -f "$NAME" >/dev/null
        ok "Removed"
        exec "$0" up
        ;;

    psql)
        running || die "Not running. Start it with: $0 up"
        exec "$RUNTIME" exec -it "$NAME" psql -U "$USER_NAME" -d "$DB_NAME"
        ;;

    url)
        printf '%s\n' "$URL"
        ;;

    *)
        die "Usage: $0 {up|stop|down|reset|psql|url}"
        ;;
esac
