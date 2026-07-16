#!/bin/bash
# Standalone launcher for the Modly FastAPI backend — for running the AI
# inference server on its own machine (e.g. a headless Linux box with the
# GPUs), separate from the Electron GUI which can then run on a laptop and
# point at this server over the network via the PYTHON_API_URL env var.
#
# Unlike Electron's PythonBridge, this is not managed/killed by any parent
# process — run it under systemd, tmux, screen, etc. so it survives logout.
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR/api"

if [ -d ".venv" ]; then
  source .venv/bin/activate
elif [ -d "venv" ]; then
  source venv/bin/activate
else
  echo "[run_server] No .venv found in api/. Run the Setup steps in api/README.md first." >&2
  exit 1
fi

export MODELS_DIR="${MODELS_DIR:-$PROJECT_DIR/.modly/models}"
export WORKSPACE_DIR="${WORKSPACE_DIR:-$PROJECT_DIR/.modly/workspace}"
export EXTENSIONS_DIR="${EXTENSIONS_DIR:-$PROJECT_DIR/.modly/extensions}"
mkdir -p "$MODELS_DIR" "$WORKSPACE_DIR" "$EXTENSIONS_DIR"

HOST="${MODLY_API_HOST:-0.0.0.0}"
PORT="${MODLY_API_PORT:-8765}"

echo "[run_server] MODELS_DIR     = $MODELS_DIR"
echo "[run_server] WORKSPACE_DIR  = $WORKSPACE_DIR"
echo "[run_server] EXTENSIONS_DIR = $EXTENSIONS_DIR"
echo "[run_server] Listening on   $HOST:$PORT"
echo "[run_server] WARNING: no authentication — only expose this on a trusted network (LAN/VPN), never the open internet."

exec uvicorn main:app --host "$HOST" --port "$PORT"
