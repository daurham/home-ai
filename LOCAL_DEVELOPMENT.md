# Local Development Setup Guide

This guide explains how to run the dashboard locally on another PC for development, without needing to rebuild Docker containers after every change.

## Prerequisites

1. **Node.js 18+** installed on your development machine
2. **PostgreSQL** with the same schema as production (or access to the remote database)
3. **Access to the home-ai server** (for API calls, or run node-api locally)

## Setup Options

### Option 1: Dashboard + API Both Local (Recommended for Development)

Run both the dashboard and node-api locally, connecting to your PostgreSQL database.

#### Step 1: Set up PostgreSQL

You have two choices:

**A. Use Remote PostgreSQL (Easier - Recommended)**
- Connect to the PostgreSQL on your home-ai server (port 5433)
- Same data, shared across devices
- Connection string: `postgresql://homeai:homeai_password@192.168.0.13:5433/homeai`

**B. Use Local PostgreSQL**
- Install PostgreSQL locally
- Run the init script: `psql -U homeai -d homeai -f postgres/init.sql`
- Or manually create the schema from `postgres/init.sql`
- Connection string: `postgresql://homeai:homeai_password@localhost:5432/homeai`

#### Step 2: Configure node-api

1. Copy `node-api/example.env.local` to `node-api/.env`
2. Update database connection:
   ```bash
   # For remote PostgreSQL (recommended)
   DATABASE_URL=postgresql://homeai:homeai_password@192.168.0.13:5433/homeai
   
   # For local PostgreSQL
   # DATABASE_URL=postgresql://homeai:homeai_password@localhost:5432/homeai
   ```
3. Set your API key (optional for dashboard dev, needed for AI endpoints):
   ```bash
   API_KEY=your-dev-api-key
   ```
4. Set Ollama URL (optional - only needed if testing AI endpoints):
   ```bash
   OLLAMA_URL=http://192.168.0.13:11434/api/generate
   ```

#### Step 3: Run node-api locally

```bash
cd node-api
npm install
npm start
# API will run on http://localhost:3000
```

#### Step 4: Configure and run dashboard

1. Create `home-dashboard/.env.local` file:
   ```bash
   cd home-dashboard
   echo "VITE_API_BASE_URL=http://localhost:3000/api" > .env.local
   ```
   Or manually create `.env.local` with:
   ```
   VITE_API_BASE_URL=http://localhost:3000/api
   ```

2. Run dashboard:
   ```bash
   npm install
   npm run dev
   # Dashboard will run on http://localhost:8080
   ```

### Option 2: Dashboard Local, API Remote

Run only the dashboard locally, connecting to the remote API on your home-ai server.

#### Step 1: Configure dashboard

1. Create `home-dashboard/.env.local` file:
   ```bash
   cd home-dashboard
   echo "VITE_API_BASE_URL=http://192.168.0.13/api" > .env.local
   ```
   (Replace `192.168.0.13` with your server's IP)

#### Step 2: Run dashboard

```bash
npm install
npm run dev
# Dashboard will run on http://localhost:8080
```

**Note:** The node-api already has CORS enabled, so this should work without issues.

## Development Workflow

1. **Make changes** to dashboard code
2. **Hot reload** - Vite will automatically refresh the browser
3. **No rebuild needed** - Changes are instant!

## Important Notes

### API Authentication

**Good news:** The database API endpoints (`/api/modules`, `/api/module-instances`, `/api/module-data`, `/api/calendar`) do NOT require authentication. Only the AI endpoints (`/api/nutrition`, `/api/home-assistant`, `/api/ai`) require the API key.

So for dashboard development, you don't need to worry about API keys!

### Ollama Dependency

The node-api has AI endpoints that require Ollama, but **for dashboard development (modules, calendar, lists, budget), you don't need Ollama running**. The database operations work independently.

If you want to test AI endpoints locally:
- Set `OLLAMA_URL` in `node-api/.env` to point to your remote Ollama: `http://192.168.0.13:11434/api/generate`
- Or install Ollama locally and use: `http://localhost:11434/api/generate`

### Vite Base Path

The dashboard is configured with `base: "/dashboard/"` in `vite.config.ts`. When running locally with `npm run dev`, you can:

- **Option A:** Access at `http://localhost:8080/dashboard/` (matches production)
- **Option B:** Remove the base path for local dev by temporarily commenting it out in `vite.config.ts`

### Database Schema

**You need the same database schema.** The schema is defined in `postgres/init.sql`. If using a local database, run this script to initialize it.

### CORS

The node-api already has CORS enabled (`app.use(cors())`), so connecting from a different origin (your dev machine) works fine.

## Quick Start (Option 1 - Full Local)

```bash
# Terminal 1: Start node-api
cd node-api
npm install
cp example.env.local .env
# Edit .env with your database connection
npm start

# Terminal 2: Start dashboard
cd home-dashboard
npm install
echo "VITE_API_BASE_URL=http://localhost:3000/api" > .env.local
npm run dev
```

Access dashboard at: `http://localhost:8080/dashboard/`

## Troubleshooting

### CORS Errors

If you get CORS errors when connecting to remote API:
- The node-api already has CORS enabled, but verify it's working
- Check that the API is accessible from your dev machine

### Database Connection Issues

- Verify PostgreSQL is running and accessible
- Check connection string format
- Ensure firewall allows connections (if using remote DB)
- Test connection: `psql -h 192.168.0.13 -p 5433 -U homeai -d homeai`

### API Not Found

- Verify `VITE_API_BASE_URL` is set correctly in `.env.local`
- Check that the API server is running
- Test API directly: `curl http://localhost:3000/api/health` (or remote URL)

### Port Already in Use

- Change the port in `vite.config.ts` if 8080 is taken
- Or change node-api port in `server.js` if 3000 is taken
