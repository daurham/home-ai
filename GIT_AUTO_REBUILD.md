# Git Auto-Rebuild Setup

## Overview

A git post-merge hook has been set up that automatically runs `rebuild.sh` when you pull changes from the `main` branch in the `home-dashboard` repository.

## How It Works

1. You run `git pull origin main` in the `home-dashboard` directory
2. Git completes the pull/merge
3. The `post-merge` hook automatically triggers
4. It checks if you're on the `main` branch
5. If yes, it runs `rebuild.sh` from the project root
6. Dashboard is automatically rebuilt and restarted

## Usage

Simply pull changes as normal:

```bash
cd /home/daurham/home-ai/home-dashboard
git pull origin main
```

The rebuild will happen automatically! You'll see the rebuild output.

## What Gets Rebuilt

The `rebuild.sh` script will:
- Stop current containers
- Check for port conflicts
- Rebuild the dashboard container
- Rebuild the node-api container
- Start all services
- Verify everything is running

## Safety Features

- ✅ Only runs on `main` branch (won't trigger on other branches)
- ✅ Only runs after actual merges (skips if nothing changed)
- ✅ Runs from project root (correct working directory)

## Disable Auto-Rebuild

If you want to pull without rebuilding:

```bash
# Temporarily disable the hook
chmod -x /home/daurham/home-ai/home-dashboard/.git/hooks/post-merge

# Pull without rebuild
git pull origin main

# Re-enable the hook
chmod +x /home/daurham/home-ai/home-dashboard/.git/hooks/post-merge
```

Or use `git pull --no-verify` (though this bypasses all hooks).

## Manual Rebuild

You can still run rebuild manually anytime:

```bash
cd /home/daurham/home-ai
./rebuild.sh
```

## Testing

To test the hook:

```bash
cd /home/daurham/home-ai/home-dashboard

# Make a small change and commit (or just pull if there are remote changes)
git pull origin main

# Watch for the automatic rebuild output
```

## Troubleshooting

### Hook Not Running

1. Check if hook is executable:
   ```bash
   ls -l /home/daurham/home-ai/home-dashboard/.git/hooks/post-merge
   ```
   Should show `-rwxr-xr-x` (executable)

2. Check if you're on main branch:
   ```bash
   cd /home/daurham/home-ai/home-dashboard
   git branch
   ```

3. Check hook syntax:
   ```bash
   bash -n /home/daurham/home-ai/home-dashboard/.git/hooks/post-merge
   ```

### Rebuild Fails

- Check `rebuild.sh` logs
- Verify Docker is running
- Check for port conflicts

## Notes

- The hook runs **after** the merge completes
- It runs in the background of your git pull command
- You'll see all rebuild output in your terminal
- If rebuild fails, git pull still succeeds (hook doesn't block git)

