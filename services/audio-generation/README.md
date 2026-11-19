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

Open `http://<this-machine>:8796/` on the home network for Home AI Music Studio. There is no password. The page can queue a track, show the job, play it, and download WAV or MP3. The browser does not receive the API token. The page only accepts loopback, link-local, and private-network clients, and it forwards generation to `127.0.0.1:8795`. State-changing requests need a same-origin page token. Do not add port 8796 to Cloudflare Tunnel.

Anyone who can open that page can use this computer's generation time. The queue still holds one active generation, and the API keeps its existing rate limit. GitHub requests use the same SQLite queue and do not need the page.

`python -m audio_studio.cli listening` writes MP3 copies and, when a WAV has a long silent tail, a separate trimmed listening file. Original WAVs are not rewritten. Playback at 1× is the generated file. Other speeds are the browser's playback rate: they change pitch and can sound thin. That does not repair the recording. A player that shows 0:00 before the header loads is waiting on metadata; the studio shows the stored duration immediately and requests the header up front.

Generation uses ACE-Step 1.5 Turbo in the isolated environment under `AUDIO_HOME`. The worker keeps `ACESTEP_INIT_LLM=false` and eight inference steps. BPM, musical key, and time signature are sent as model fields when a request includes them. Turbo does not use a higher guidance scale or a different step count. Re-apply `patches/dit-only-skip-lm.patch` after updating that checkout so a planner experiment cannot download the 1.7B or 4B language models. Do not install the CUDA wheels from upstream `uv sync` on a machine without NVIDIA.

The 0.6B planner (`acestep-5Hz-lm-0.6B`, PyTorch on CPU) was tested once at 30 seconds with the same prompt and seed as a DiT-only run. It loaded, peaked near 18 GB, and took about three minutes including model load. The worker limit is 16 GB, so that mode is not offered in the studio. Its written plan also replaced the requested orchestra with soft piano, pads, and a drum machine. Fast Turbo remains the generator.

The Lab tab plays those three recordings from a fixed list. It does not import them into the library. A reference WAV can be stored under `AUDIO_HOME/data/references` after a rights confirmation. Generate does not send those files to ACE-Step. Turbo already supports reference audio as a cover task, but that path stays unwired until a separate listening test is authorized. The non-XL SFT and Turbo shift checkpoints are about 4.8 GB each and are not installed. SFT is a 50-step model, so it was not downloaded or run.

Rollback:

```bash
systemctl --user disable --now audio-api.service audio-worker.service audio-preview.service audio-bridge.timer
```

That leaves the Node API, Ollama, and saved library files in place.

## Production

Run the units from a dedicated checkout of `main` so unrelated working-tree edits cannot change the running code. The job API stays on localhost with its bearer token. The studio page stays on the home LAN without a password. Set `AUDIO_GITHUB_BRANCH` to the client branch that should be polled. The bridge only commits request, result, and activity files.

Giving a cloud renderer the WAV is not built in. Do not publish the library directory. A later free option is an outbound upload of one checksum-verified file into a short-lived private workflow artifact, or mixing on the same machine that already holds the file.
