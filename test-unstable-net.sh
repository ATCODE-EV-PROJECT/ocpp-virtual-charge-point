#!/usr/bin/env bash
# =============================================================================
# test-unstable-net.sh — Toxiproxy-based unstable network tester for OCPP VCP
#
# Usage:
#   ./test-unstable-net.sh [scenario]
#
# Scenarios:
#   latency        Add 500 ms latency ± 100 ms jitter (default)
#   slow           Throttle bandwidth to 10 KB/s
#   drop           Total connection freeze (0 KB/s) for DROP_SECS then restore
#   flap           Repeatedly freeze/restore FLAP_COUNT times
#   loss           Timeout-based packet loss simulation
#   clean          Remove all toxics and restore normal connection
#   status         Show current proxy and toxic state
#   teardown       Kill toxiproxy-server and delete the proxy
#
# Env vars (all optional, shown with defaults):
#   CSMS_PORT        4002          Upstream CSMS WebSocket port
#   PROXY_PORT       3001          Port Toxiproxy listens on
#   PROXY_NAME       ocpp          Toxiproxy proxy name
#   TOXI_API         localhost:8474  Toxiproxy management API address
#
#   LATENCY_MS       500           Latency toxic: base delay in ms
#   JITTER_MS        100           Latency toxic: jitter in ms
#   BANDWIDTH_KB     10            Slow toxic: bandwidth in KB/s
#   DROP_SECS        10            Drop toxic: seconds before auto-restore
#   FLAP_COUNT       5             Flap scenario: number of cycles
#   FLAP_DOWN_SECS   8             Flap scenario: seconds connection is frozen
#   FLAP_UP_SECS     5             Flap scenario: seconds connection is healthy
#   LOSS_TIMEOUT     3000          Loss toxic: timeout in ms before closing conn
# =============================================================================

set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
ok()      { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
section() { echo -e "\n${BOLD}━━━  $*  ━━━${RESET}"; }

# ── Config (overridable via env) ──────────────────────────────────────────────
CSMS_PORT="${CSMS_PORT:-4002}"
PROXY_PORT="${PROXY_PORT:-3001}"
PROXY_NAME="${PROXY_NAME:-ocpp}"
TOXI_API="${TOXI_API:-localhost:8474}"

LATENCY_MS="${LATENCY_MS:-500}"
JITTER_MS="${JITTER_MS:-100}"
BANDWIDTH_KB="${BANDWIDTH_KB:-10}"
DROP_SECS="${DROP_SECS:-10}"
FLAP_COUNT="${FLAP_COUNT:-5}"
FLAP_DOWN_SECS="${FLAP_DOWN_SECS:-8}"
FLAP_UP_SECS="${FLAP_UP_SECS:-5}"
LOSS_TIMEOUT="${LOSS_TIMEOUT:-3000}"

SCENARIO="${1:-latency}"

# ── Helpers ───────────────────────────────────────────────────────────────────

check_deps() {
  local missing=()
  for cmd in toxiproxy-server toxiproxy-cli; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    error "Missing: ${missing[*]}"
    echo "  Install with:  brew install toxiproxy"
    exit 1
  fi
}

# Returns 0 if the toxiproxy-server REST API is reachable
server_running() {
  curl -sf "http://${TOXI_API}/proxies" -o /dev/null 2>/dev/null
}

# Ensures toxiproxy-server is running; starts it in the background if not
ensure_server() {
  if server_running; then
    ok "toxiproxy-server is already running (${TOXI_API})"
    return
  fi
  info "Starting toxiproxy-server in the background..."
  toxiproxy-server &>/tmp/toxiproxy-server.log &
  TOXI_PID=$!
  echo "$TOXI_PID" > /tmp/toxiproxy-server.pid
  # Wait up to 5 s for the API to become available
  for i in {1..10}; do
    sleep 0.5
    server_running && break
    if [[ $i -eq 10 ]]; then
      error "toxiproxy-server did not start. Check /tmp/toxiproxy-server.log"
      exit 1
    fi
  done
  ok "toxiproxy-server started (PID $TOXI_PID)"
}

# Ensures the proxy exists; creates it if not
# NOTE: toxiproxy-cli v2.x — proxy name is a positional arg at the END
ensure_proxy() {
  if toxiproxy-cli list 2>/dev/null | grep -q "^${PROXY_NAME}[[:space:]]"; then
    ok "Proxy '${PROXY_NAME}' already exists"
  else
    info "Creating proxy '${PROXY_NAME}'  :${PROXY_PORT} → localhost:${CSMS_PORT}"
    toxiproxy-cli create \
      --listen "0.0.0.0:${PROXY_PORT}" \
      --upstream "localhost:${CSMS_PORT}" \
      "$PROXY_NAME"
    ok "Proxy created"
  fi
}

# Remove a toxic by name, silently ignoring "not found" errors
# NOTE: proxy name is a positional arg at the END in v2.x
remove_toxic() {
  local name="$1"
  toxiproxy-cli toxic remove -n "$name" "$PROXY_NAME" 2>/dev/null && \
    ok "Removed toxic: ${name}" || true
}

# Remove all named toxics used by this script
remove_all_toxics() {
  local names=(
    latency_downstream latency_upstream
    slow_downstream    slow_upstream
    drop_downstream    drop_upstream
    loss_downstream    loss_upstream
  )
  local removed=0
  for n in "${names[@]}"; do
    if toxiproxy-cli toxic remove -n "$n" "$PROXY_NAME" 2>/dev/null; then
      ok "Removed toxic: ${n}"
      removed=$((removed + 1))
    fi
  done
  if [[ $removed -eq 0 ]]; then
    info "No toxics were active"
  else
    ok "All ${removed} toxic(s) removed — connection is clean"
  fi
}

# ── Show status ───────────────────────────────────────────────────────────────
show_status() {
  echo ""
  echo -e "${BOLD}Proxies:${RESET}"
  toxiproxy-cli list 2>/dev/null || warn "Could not reach toxiproxy-server"
  echo ""
  echo -e "${BOLD}VCP connection string:${RESET}"
  echo "  WS_URL=ws://localhost:${PROXY_PORT} npm start index_16.ts"
}

# ── Scenarios ─────────────────────────────────────────────────────────────────

scenario_latency() {
  section "SCENARIO: latency  (${LATENCY_MS}ms ± ${JITTER_MS}ms)"
  remove_toxic "latency_downstream"
  # proxy name is positional at the END
  toxiproxy-cli toxic add \
    -t latency -n latency_downstream \
    -a latency="$LATENCY_MS" -a jitter="$JITTER_MS" \
    "$PROXY_NAME"
  ok "Latency toxic active"
  echo ""
  echo "  VCP messages will be delayed by ${LATENCY_MS} ± ${JITTER_MS} ms."
  echo "  Override:  LATENCY_MS=200 JITTER_MS=50 $0 latency"
  echo "  Remove:    $0 clean"
  show_status
}

scenario_slow() {
  section "SCENARIO: slow  (${BANDWIDTH_KB} KB/s)"
  remove_toxic "slow_downstream"
  toxiproxy-cli toxic add \
    -t bandwidth -n slow_downstream \
    -a rate="$BANDWIDTH_KB" \
    "$PROXY_NAME"
  ok "Bandwidth toxic active (${BANDWIDTH_KB} KB/s)"
  echo ""
  echo "  Override:  BANDWIDTH_KB=1 $0 slow"
  echo "  Remove:    $0 clean"
  show_status
}

scenario_drop() {
  section "SCENARIO: drop  (freeze for ${DROP_SECS}s then auto-restore)"
  remove_toxic "drop_downstream"
  info "Freezing connection (rate=0)..."
  toxiproxy-cli toxic add \
    -t bandwidth -n drop_downstream \
    -a rate=0 \
    "$PROXY_NAME"
  ok "Connection frozen — VCP should start reconnect attempts now"
  echo ""
  info "Waiting ${DROP_SECS}s before restoring..."
  sleep "$DROP_SECS"
  remove_toxic "drop_downstream"
  ok "Connection restored — VCP should reconnect and re-announce"
  echo ""
  echo "  Override:  DROP_SECS=30 $0 drop"
}

scenario_flap() {
  section "SCENARIO: flap  (${FLAP_COUNT} cycles: ${FLAP_DOWN_SECS}s down / ${FLAP_UP_SECS}s up)"
  for i in $(seq 1 "$FLAP_COUNT"); do
    echo ""
    info "Cycle ${i}/${FLAP_COUNT} — freezing connection..."
    remove_toxic "drop_downstream"
    toxiproxy-cli toxic add \
      -t bandwidth -n drop_downstream \
      -a rate=0 \
      "$PROXY_NAME"
    sleep "$FLAP_DOWN_SECS"

    info "Cycle ${i}/${FLAP_COUNT} — restoring connection..."
    remove_toxic "drop_downstream"
    ok "Connection up — VCP should reconnect"
    sleep "$FLAP_UP_SECS"
  done
  echo ""
  ok "Flap scenario complete (${FLAP_COUNT} cycles)"
}

scenario_loss() {
  section "SCENARIO: loss  (timeout ${LOSS_TIMEOUT}ms — simulates packet loss)"
  remove_toxic "loss_downstream"
  toxiproxy-cli toxic add \
    -t timeout -n loss_downstream \
    -a timeout="$LOSS_TIMEOUT" \
    "$PROXY_NAME"
  ok "Timeout toxic active — Toxiproxy closes connection after ${LOSS_TIMEOUT}ms of inactivity"
  echo ""
  echo "  This simulates a network path that drops packets silently."
  echo "  The VCP detects the dead connection via WebSocket close and reconnects."
  echo ""
  echo "  Override:  LOSS_TIMEOUT=2000 $0 loss"
  echo "  Remove:    $0 clean"
  show_status
}

scenario_clean() {
  section "SCENARIO: clean  (remove all toxics)"
  remove_all_toxics
  show_status
}

scenario_status() {
  section "STATUS"
  show_status
}

scenario_teardown() {
  section "TEARDOWN"
  info "Removing all toxics..."
  remove_all_toxics 2>/dev/null || true

  info "Deleting proxy '${PROXY_NAME}'..."
  toxiproxy-cli delete "$PROXY_NAME" 2>/dev/null && \
    ok "Proxy '${PROXY_NAME}' deleted" || \
    warn "Proxy not found (already gone?)"

  if [[ -f /tmp/toxiproxy-server.pid ]]; then
    local pid
    pid=$(cat /tmp/toxiproxy-server.pid)
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" && ok "toxiproxy-server (PID $pid) stopped"
    else
      warn "PID $pid is no longer running"
    fi
    rm -f /tmp/toxiproxy-server.pid
  else
    warn "No PID file found — if toxiproxy-server was started externally, stop it manually"
  fi
  ok "Teardown complete"
}

# ── Usage ─────────────────────────────────────────────────────────────────────

print_usage() {
  echo ""
  echo -e "${BOLD}Usage:${RESET}  $0 <scenario>"
  echo ""
  echo -e "${BOLD}Scenarios:${RESET}"
  printf "  %-12s %s\n" "latency"  "Add ${LATENCY_MS}ms ± ${JITTER_MS}ms jitter       (env: LATENCY_MS, JITTER_MS)"
  printf "  %-12s %s\n" "slow"     "Throttle to ${BANDWIDTH_KB} KB/s                  (env: BANDWIDTH_KB)"
  printf "  %-12s %s\n" "drop"     "Freeze ${DROP_SECS}s then restore           (env: DROP_SECS)"
  printf "  %-12s %s\n" "flap"     "${FLAP_COUNT} cycles of drop/restore         (env: FLAP_COUNT, FLAP_DOWN_SECS, FLAP_UP_SECS)"
  printf "  %-12s %s\n" "loss"     "Timeout toxic (packet loss sim)    (env: LOSS_TIMEOUT)"
  printf "  %-12s %s\n" "clean"    "Remove all toxics, restore normal connection"
  printf "  %-12s %s\n" "status"   "Show proxy and active toxic state"
  printf "  %-12s %s\n" "teardown" "Delete proxy + stop toxiproxy-server"
  echo ""
  echo -e "${BOLD}Quick start:${RESET}"
  echo "  # Terminal 1 — start VCP via the proxy"
  echo "  WS_URL=ws://localhost:${PROXY_PORT} npm start index_16.ts"
  echo ""
  echo "  # Terminal 2 — inject a fault"
  echo "  $0 latency"
  echo "  $0 flap"
  echo "  $0 clean"
  echo ""
  echo -e "${BOLD}Examples with env overrides:${RESET}"
  echo "  LATENCY_MS=1000 JITTER_MS=200 $0 latency"
  echo "  DROP_SECS=30 $0 drop"
  echo "  FLAP_COUNT=10 FLAP_DOWN_SECS=3 FLAP_UP_SECS=2 $0 flap"
  echo "  CSMS_PORT=3000 PROXY_PORT=3001 $0 status"
  echo ""
}

# ── Main ──────────────────────────────────────────────────────────────────────

check_deps

case "$SCENARIO" in
  latency|slow|drop|flap|loss|clean|status)
    ensure_server
    ensure_proxy
    "scenario_${SCENARIO}"
    ;;
  teardown)
    ensure_server 2>/dev/null || true
    scenario_teardown
    ;;
  help|--help|-h)
    print_usage
    ;;
  *)
    error "Unknown scenario: '${SCENARIO}'"
    print_usage
    exit 1
    ;;
esac
