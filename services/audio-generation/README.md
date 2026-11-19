# Local audio generation

This directory is a separate home service. It queues instrumental music jobs, runs one generation at a time, stores WAV files and metadata locally, and can optionally upload them later. It does not run inside the Node API container and it does not call Ollama.

The job API binds to localhost. A read-only preview can be enabled separately. Remote clients should submit request files to their own repository. This service polls that repository outbound and pushes JSON results back. Audio bytes are not committed.

## Layout

- `audio_studio/` — API, worker, queue, preview, generator adapter, and GitHub bridge
- `systemd/` — user units with memory and CPU limits
- `tests/` — queue, auth, local completion, preview, and bridge tests
- Runtime data, tokens, checkpoints, and generated audio stay outside this repository, under `AUDIO_HOME` (default `~/audio-service`)

## States

`queued`, `running`, `uploading`, `local_ready`, `completed`, `failed`, and `cancelled`.

`local_ready` means a verified local WAV exists and Drive upload is disabled. `completed` is used only after a Drive file is confirmed. Set `AUDIO_DRIVE_ENABLED=true` after OAuth to turn uploads on. The Drive client code stays in the service either way.

## Client contract

A client repository contains:

- `audio-requests/inbox/<request_id>.json`
- `audio-results/<request_id>.json` written by the bridge
- optional `ops/activity/` notes

The bridge commits only those prefixes. Set `AUDIO_STUDIO_ROOT` to the client checkout and `AUDIO_GITHUB_BRANCH` to the branch it should watch. `AUDIO_GITHUB_PUSH=true` is required for the remote bridge. Credentials come from the local Git credential helper, not from this repository.

Reuse an approved library asset with `reuse_asset_id` instead of sending a new prompt. Unapproved assets are rejected. Sound-effect generation is rejected unless it reuses an approved asset.

## Run

```bash
services/audio-generation/scripts/install-user-services.sh
systemctl --user enable --now audio-preview.service audio-bridge.timer
```

The API listens on `127.0.0.1:8795`. Health is `GET /health`. Every other route requires a bearer token.

The preview has no password. `GET /` lists library tracks, and `/audio/<asset_id>` streams that one WAV. It accepts only loopback and private-network clients, and it cannot create jobs, approve tracks, or read files outside the library. Set `AUDIO_PREVIEW_BIND` to `127.0.0.1`, a private address, or `0.0.0.0` for the home LAN. Do not add port 8796 to Cloudflare Tunnel or any public hostname. `AUDIO_PREVIEW_TOKEN` is unused.

Generation uses ACE-Step 1.5 in the isolated environment under `AUDIO_HOME`. Keep the language model off on CPU (`ACESTEP_INIT_LLM=false` is set by the worker). Re-apply `patches/dit-only-skip-lm.patch` after updating that checkout. Do not install the CUDA wheels from upstream `uv sync` on a machine without NVIDIA.

Rollback:

```bash
systemctl --user disable --now audio-api.service audio-worker.service audio-preview.service audio-bridge.timer
```

That leaves the Node API, Ollama, and saved library files in place.

## Production

Run the units from a dedicated checkout of `main` so unrelated working-tree edits cannot change the running code. The job API stays on localhost with its bearer token. The preview stays on the home LAN without a password. Set `AUDIO_GITHUB_BRANCH` to the client branch that should be polled. The bridge only commits request, result, and activity files.

Giving a cloud renderer the WAV is not built in. Do not publish the library directory. A later free option is an outbound upload of one checksum-verified file into a short-lived private workflow artifact, or mixing on the same machine that already holds the file.
