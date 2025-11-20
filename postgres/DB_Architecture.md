The database now acts as the single source of truth for:

- Dashboard module definitions
- Module instances placed on the dashboard
- Persistent module data (budget entries, lists, canvas objects, etc.)
- Calendar events
- System-wide/shared data your home AI uses
Below is the full architecture.

🏛️ Home Dashboard Database Architecture (PostgreSQL)
Hybrid Schema for Extensible Modules with JSONB
This design supports:
- Unlimited future module types
- Completely flexible data models (budget, lists, drawings, notes, sensors, logs, etc.)
- Powerful querying for structured domains (calendar)
- Zero schema migration required for new module types
- Local-only device settings
- Multi-device dashboards accessing the same data

🔷 1. Core Concepts
Your system has 3 key entities:
1. Module Types — "budget", "list", "canvas", “security feed”, “AI Chat”, etc.
2. Module Instances — each time you place a module on your screen
3. Module Data — entries created/managed by a module
And then some specialized structured tables where it makes sense (calendar).

🗂️ 2. Table Overview

| Table |	Purpose |	Type |
| -----------------------|
| modules |	Registry of module types |	Structured + JSONB |
| module_instances |	Dashboard objects the user places |	Structured + JSONB |
| module_data_records |	The actual content for each instance |	JSONB |
| calendar_events	Highly | structured data for performance |	Structured + JSONB |

🧱 3. PostgreSQL Schema (Copy–Paste Ready)
```sql
-- 1. Module type definitions
CREATE TABLE modules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,                -- "budget", "list", "canvas", etc.
    description TEXT,
    version INT NOT NULL DEFAULT 1,
    config_schema JSONB,               -- describes module settings
    data_schema JSONB,                 -- describes expected data structure
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 2. Instances of modules placed on the dashboard
CREATE TABLE module_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_id UUID REFERENCES modules(id) ON DELETE CASCADE,
    layout JSONB,                      -- { x, y, width, height }
    settings JSONB,                    -- per-instance settings
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 3. Data records for each module instance
CREATE TABLE module_data_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_instance_id UUID REFERENCES module_instances(id) ON DELETE CASCADE,
    data JSONB NOT NULL,               -- module-defined arbitrary shape
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 4. Calendar events (structured)
CREATE TABLE calendar_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_instance_id UUID REFERENCES module_instances(id),
    title TEXT NOT NULL,
    description TEXT,
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP,
    recurrence_rule JSONB,             -- null or object describing RRULE-like data
    metadata JSONB,                    -- tags, color, priority
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
```

🔍 4. Table-by-Table Deep Explanation
---
4.1 modules — Module Type Definitions

This table defines what modules exist in your system.

Example rows
```json
// Budget module
{
  "name": "budget",
  "description": "Tracks spending and income",
  "config_schema": {
    "fields": [
      { "key": "currency", "type": "string", "default": "USD" },
      { "key": "showRemaining", "type": "boolean", "default": true }
    ]
  },
  "data_schema": {
    "startingAmount": "number",
    "transactions": [
      { "title": "string", "amount": "number", "created": "datetime" }
    ]
  }
}

// Canvas module
{
  "name": "canvas",
  "description": "Freeform drawing pad",
  "data_schema": {
    "shapes": [
      { "type": "string", "x": "number", "y": "number" }
    ]
  }
}

// List module
{
  "name": "list",
  "data_schema": {
    "entries": [
      { "text": "string", "type": "string", "checked": "boolean" }
    ]
  }
}
```
These schemas are optional, but help validation later.

---
4.2 module_instances — Active Dashboard Modules

Each item you add to your dashboard corresponds to one row here.

```json
// Example instance (budget module)
{
  "module_id": "budget-module-uuid",
  "layout": {
    "x": 30,
    "y": 0,
    "width": 3,
    "height": 2
  },
  "settings": {
    "currency": "USD",
    "theme": "dark",
    "collapsed": false
  }
}

// Example instance (list)
{
  "module_id": "list-module-uuid",
  "layout": {
    "x": 0,
    "y": 3,
    "width": 4,
    "height": 4
  },
  "settings": {
    "title": "Groceries",
    "sortOrder": "manual"
  }
}
```

4.3 module_data_records — Module Data

This is where persistent content lives.

Example Data Records
```json
// Budget Module Example
{
  "data": {
    "startingAmount": 2000,
    "transactions": [
      { "id": 1, "title": "Rent", "amount": -1500 },
      { "id": 2, "title": "Coffee", "amount": -5 }
    ]
  }
}

// List Module Example
{
  "data": {
    "entries": [
      { "id": 1, "text": "Buy eggs", "type": "checkbox", "checked": true },
      { "id": 2, "text": "Plan seeds", "type": "bullet" }
    ]
  }
}

// Canvas Module Example
{
  "data": {
    "shapes": [
      { "id": "a1", "type": "rect", "x": 90, "y": 20, "width": 100, "height": 80 },
      { "id": "a2", "type": "text", "x": 10, "y": 50, "text": "Hello!" }
    ]
  }
}
```

4.4 calendar_events — Structured Table for Speed

Since calendar queries frequently filter by date ranges, structured storage is essential.

```json
// Example Event
{
  "title": "Dentist Appointment",
  "description": "Cleaning and x-rays",
  "start_time": "2025-01-12T14:00:00",
  "end_time": "2025-01-12T15:00:00",
  "recurrence_rule": {
    "freq": "monthly",
    "interval": 1,
    "byday": ["MO"]
  },
  "metadata": {
    "color": "blue",
    "priority": "medium"
  }
}
```

---
🧠 5. Query Examples (Useful for API Development)
```sql
-- Retrieve all module instances
SELECT *
FROM module_instances
ORDER BY created_at;

-- Get data for a single module instance
SELECT * 
FROM module_data_records
WHERE module_instance_id = 'uuid-here';

--- Update JSONB record
UPDATE module_data_records
SET data = jsonb_set(data, '{startingAmount}', '3000')
WHERE id = 'record-id';

--- Get this week’s events
SELECT *
FROM calendar_events
WHERE start_time BETWEEN NOW()::date AND NOW()::date + INTERVAL '7 days';
```

---
🛠️ 6. What Goes in the DB vs. LocalStorage
Database (Persisted, Shared Across Devices)
- Calendar events
- Modules & module types
- Module instances
- Module data
- Home-level configuration
- System logs / sensor readings (future)

LocalStorage (Device-specific UI state)
- Theme (light/dark)
- Sidebar open/closed
- Last visited tab
- Kiosk mode state
- Per-device preferences
- Temporary values