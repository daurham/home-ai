/**
 * Persistence for UI-managed latency targets.
 *
 * Built-in targets still live in node-api/latency-targets.js and are not editable
 * from the dashboard. Rows here are layered on top of them by the scheduler.
 */

import { query } from '../../db.js';

const COLUMNS = `id, name, type, url, method, expect_status, expect_body_includes, host, port,
  connection_string_env, interval_ms, timeout_ms, degraded_threshold_ms, sample_capacity,
  enabled, created_at, updated_at`;

/** Probe ids are used in URLs and log lines, so keep them slug-shaped. */
export function slugifyId(value) {
  const slug = String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'target';
}

/** Appends -2, -3, … until the id is free. */
export function uniqueId(base, taken) {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base.slice(0, 37)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 33)}-${Date.now().toString(36).slice(-4)}`;
}

/** DB row -> the shape loadTargets()/normalizeTarget() expect. */
export function rowToTargetInput(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    url: row.url || undefined,
    method: row.method || undefined,
    expectStatus: Array.isArray(row.expect_status) ? row.expect_status : undefined,
    expectBodyIncludes: row.expect_body_includes || undefined,
    host: row.host || undefined,
    port: row.port ?? undefined,
    connectionStringEnv: row.connection_string_env || undefined,
    intervalMs: row.interval_ms,
    timeoutMs: row.timeout_ms,
    degradedThresholdMs: row.degraded_threshold_ms,
    sampleCapacity: row.sample_capacity,
  };
}

/** DB row -> the shape the dashboard edits. */
export function rowToApi(row) {
  return {
    ...rowToTargetInput(row),
    enabled: row.enabled,
    source: 'database',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listTargetRows() {
  const result = await query(`SELECT ${COLUMNS} FROM latency_targets ORDER BY created_at ASC`);
  return result.rows;
}

export async function getTargetRow(id) {
  const result = await query(`SELECT ${COLUMNS} FROM latency_targets WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

/** Ids already in use, so a new target never shadows a built-in one. */
export async function takenIds(builtinIds = []) {
  const rows = await listTargetRows();
  return new Set([...builtinIds, ...rows.map((row) => row.id)]);
}

/** @param {ReturnType<typeof rowToTargetInput> & { enabled?: boolean }} target normalized target */
export async function insertTargetRow(target) {
  const result = await query(
    `INSERT INTO latency_targets (
       id, name, type, url, method, expect_status, expect_body_includes, host, port,
       connection_string_env, interval_ms, timeout_ms, degraded_threshold_ms, sample_capacity, enabled
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING ${COLUMNS}`,
    [
      target.id,
      target.name,
      target.type,
      target.url ?? null,
      target.method ?? 'GET',
      target.expectStatus ?? [200],
      target.expectBodyIncludes ?? null,
      target.host ?? null,
      target.port ?? null,
      target.connectionStringEnv ?? null,
      target.intervalMs,
      target.timeoutMs,
      target.degradedThresholdMs,
      target.sampleCapacity,
      target.enabled !== false,
    ],
  );
  return result.rows[0];
}

/** Rewrites every probe column, so callers must pass a fully normalized target. */
export async function updateTargetRow(id, target) {
  const result = await query(
    `UPDATE latency_targets SET
       name = $2, type = $3, url = $4, method = $5, expect_status = $6, expect_body_includes = $7,
       host = $8, port = $9, connection_string_env = $10, interval_ms = $11, timeout_ms = $12,
       degraded_threshold_ms = $13, sample_capacity = $14, enabled = $15
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [
      id,
      target.name,
      target.type,
      target.url ?? null,
      target.method ?? 'GET',
      target.expectStatus ?? [200],
      target.expectBodyIncludes ?? null,
      target.host ?? null,
      target.port ?? null,
      target.connectionStringEnv ?? null,
      target.intervalMs,
      target.timeoutMs,
      target.degradedThresholdMs,
      target.sampleCapacity,
      target.enabled !== false,
    ],
  );
  return result.rows[0] ?? null;
}

export async function deleteTargetRow(id) {
  const result = await query('DELETE FROM latency_targets WHERE id = $1 RETURNING id', [id]);
  return result.rows[0] ?? null;
}

/** Targets the scheduler should probe. Disabled rows are skipped. */
export async function listEnabledTargetInputs() {
  const rows = await listTargetRows();
  return rows.filter((row) => row.enabled).map(rowToTargetInput);
}
