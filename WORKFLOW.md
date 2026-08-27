# Workflow

This server **is** prod. There are two git repos. Always `cd` into the one you mean before `git` commands.

| Repo | Path | Remote | What it is |
|------|------|--------|------------|
| home-ai | `/home/daurham/home-ai` | `github.com/daurham/home-ai` | Server stack: compose, node-api, nginx, postgres, go2rtc |
| home-dashboard | `/home/daurham/home-ai/home-dashboard` | `github.com/daurham/home-dashboard` | Vite/React UI (nested clone, **not** a git submodule) |

Prod stack: `docker compose` in `home-ai`, started on boot by `home-ai-api.service`.  
Dashboard in the browser: `http://192.168.1.161/dashboard/`

Do not commit `home-dashboard/` from the parent repo. Do not commit `.env`, `go2rtc/.env`, or `go2rtc/bin/`.

Helper scripts (tests, `dev.sh`, port check, postgres install) live in `scripts/`. Only `rebuild.sh` stays in the repo root.

---

## Dashboard → prod

Typical loop: edit on a laptop, push, then pull on this server.

**On the laptop** (hot reload, no Docker): see `home-dashboard/LOCAL_DEVELOPMENT.md` and `LOCAL_DEVELOPMENT.md` in this repo.

```bash
cd home-dashboard
git checkout main
git pull origin main
# ... edit ...
git add -A && git commit -m "why this change"
git push origin main
```

**On this server** (make it live):

```bash
cd /home/daurham/home-ai/home-dashboard
git checkout main
git pull origin main
```

A `post-merge` hook on `main` runs `/home/daurham/home-ai/rebuild.sh` after a pull that actually moved `HEAD`. That bounces the whole compose stack.

If the hook does not run (or you skipped it): the dashboard container bind-mounts this folder and runs Vite `dev`, so source changes are often already live. If the UI looks stale:

```bash
cd /home/daurham/home-ai
sudo docker compose restart dashboard
```

Rebuild the dashboard image only when `package.json` / lockfile / `Dockerfile` changed:

```bash
cd /home/daurham/home-ai
sudo docker compose build dashboard && sudo docker compose up -d dashboard
```

---

## home-ai (not the dashboard repo) → prod

Edit in `/home/daurham/home-ai`, **not** inside `home-dashboard/`.

```bash
cd /home/daurham/home-ai
git checkout main
git pull origin main
# ... edit ...
```

Then apply, depending on what changed:

| You changed | Apply with |
|-------------|------------|
| `node-api/` (JS, `package.json`, Dockerfile) | `sudo docker compose build node-api && sudo docker compose up -d node-api` |
| `docker-compose.yml` | `sudo docker compose up -d` |
| `nginx.conf` | `sudo docker compose restart nginx` |
| `home-ai-api.service` | `sudo cp home-ai-api.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart home-ai-api.service` |
| `postgres/init.sql` | **Does not** update an existing database. Migrate by hand (or only matters on a fresh volume). |
| `go2rtc/go2rtc.yaml` or `go2rtc/.env` | `systemctl --user restart home-ai-go2rtc.service` |

`node-api` is copied into the image at **build** time. Restarting the container is not enough.

When several of those changed, or you are unsure:

```bash
cd /home/daurham/home-ai
./rebuild.sh
```

That rebuilds **node-api and dashboard** and recreates the stack. It does not restart go2rtc.

Push parent-repo work:

```bash
cd /home/daurham/home-ai
git add -A
git status   # confirm home-dashboard/ is not staged
git commit -m "why this change"
git push origin main
```

---

## Quick “what do I run?”

```bash
sudo docker compose ps
sudo docker compose logs -f node-api      # or dashboard, nginx, postgres
systemctl --user status home-ai-go2rtc.service
journalctl --user -u home-ai-go2rtc.service -f
```

go2rtc is separate (user systemd, linger enabled). Do not start `docker-compose.go2rtc.yml` while that unit is running — same ports.
