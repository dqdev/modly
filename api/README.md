# Modly — FastAPI Backend

Local Python server started and managed by Electron.

## Setup

```bash
cd api
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS/Linux
source .venv/bin/activate

pip install -r requirements.txt
```

## Run (development)

```bash
uvicorn main:app --host 127.0.0.1 --port 8765 --reload
```

## Run as a standalone server (remote GPU box)

To run this API on its own machine — separate from the Electron app, e.g. a headless server with the GPUs — use `run_server.sh` instead. It binds `0.0.0.0:8765` by default so it's reachable from other machines on the network:

```bash
./run_server.sh
```

Env vars: `MODLY_API_HOST`, `MODLY_API_PORT`, `MODELS_DIR`, `WORKSPACE_DIR`, `EXTENSIONS_DIR`. See the root [README](../README.md#running-the-ai-backend-on-a-separate-machine) for how to point the Electron client at it (`PYTHON_API_URL`) and the security caveat (no auth — trusted networks only).

## Key endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (used by Electron to detect readiness) |
| GET | `/model/status` | Model download / load status |
| GET | `/model/download` | SSE stream of download progress |
| POST | `/generate/from-image` | Start image-to-3D job |
| GET | `/generate/status/{job_id}` | Poll job status |

## Model

Default: **TripoSR** (`stabilityai/TripoSR`, ~2.4 GB)
Downloaded on first launch to `~/.modly/models/TripoSR/`.
To change model: edit `services/model_manager.py`.
