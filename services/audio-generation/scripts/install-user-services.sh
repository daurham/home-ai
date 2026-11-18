#!/bin/sh
# Install user services. Does not change system Python, Ollama, or other APIs.
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
HOME_DIR="${AUDIO_HOME:-$HOME/audio-service}"
mkdir -p "$HOME_DIR/bin" "$HOME_DIR/data/logs"
if [ ! -f "$HOME_DIR/.env" ]; then
  python3 - <<PY
import secrets
from pathlib import Path
example = Path("$ROOT/.env.example").read_text()
for placeholder in (
    "replace-with-a-long-random-token",
    "replace-with-a-different-random-token",
    "replace-with-a-preview-token",
):
    example = example.replace(placeholder, secrets.token_urlsafe(32), 1)
path = Path("$HOME_DIR/.env")
path.write_text(example)
path.chmod(0o600)
print(path)
PY
fi
VENV_PYTHON="${AUDIO_PYTHON:-$HOME_DIR/.venv/bin/python}"
cat > "$HOME_DIR/bin/audioctl" <<EOF
#!/bin/sh
export PYTHONPATH="$ROOT"
exec "$VENV_PYTHON" -m audio_studio.cli "\$@"
EOF
chmod 755 "$HOME_DIR/bin/audioctl"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
for unit in audio-api.service audio-worker.service audio-preview.service audio-bridge.service audio-bridge.timer; do
  cp "$ROOT/systemd/$unit" "$UNIT_DIR/$unit"
done
systemctl --user daemon-reload
systemctl --user enable --now audio-api.service audio-worker.service
echo "API and worker enabled. Enable audio-preview.service and audio-bridge.timer when a client repository is configured."
