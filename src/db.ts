import { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;

export const pool: Pool | null = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

if (!DATABASE_URL) {
  console.warn('[db] DATABASE_URL not set — running in-memory only (no Neon persistence)');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VesselRow {
  mmsi:             string;
  ship_name:        string | null;
  callsign:         string | null;
  imo:              string | null;
  vessel_type:      string | null;
  length_m:         number | null;
  width_m:          number | null;
  latitude:         number | null;
  longitude:        number | null;
  speed:            number | null;
  course:           number | null;
  heading:          number | null;
  nav_status:       string | null;
  draught:          number | null;
  destination:      string | null;
  locale:           string | null;   // e.g. "United Kingdom", "Persian Gulf"
  last_position_at: string | null;
  last_static_at:   string | null;
  updated_at:       string;
}

// ---------------------------------------------------------------------------
// Schema setup (run once on startup)
// ---------------------------------------------------------------------------

export async function setupSchema(): Promise<void> {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vessels (
        mmsi             TEXT PRIMARY KEY,
        ship_name        TEXT,
        callsign         TEXT,
        imo              TEXT,
        vessel_type      TEXT,
        length_m         NUMERIC,
        width_m          NUMERIC,
        latitude         NUMERIC,
        longitude        NUMERIC,
        speed            NUMERIC,
        course           NUMERIC,
        heading          NUMERIC,
        nav_status       TEXT,
        draught          NUMERIC,
        destination      TEXT,
        locale           TEXT,
        last_position_at TIMESTAMPTZ,
        last_static_at   TIMESTAMPTZ,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS vessels_updated_at_idx ON vessels(updated_at);

      -- Add locale column if upgrading from an older schema
      ALTER TABLE vessels ADD COLUMN IF NOT EXISTS locale TEXT;
    `);
    console.log('[db] Schema ready');
  } catch (err) {
    console.error('[db] setupSchema error:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Upsert — COALESCE ensures good values are never overwritten with null.
// locale always takes the latest value (vessel moves to current active region).
// ---------------------------------------------------------------------------

export async function upsertVessel(row: VesselRow): Promise<void> {
  if (!pool) return;
  try {
    await pool.query(`
      INSERT INTO vessels (
        mmsi, ship_name, callsign, imo, vessel_type,
        length_m, width_m,
        latitude, longitude, speed, course, heading,
        nav_status, draught, destination,
        locale,
        last_position_at, last_static_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW()
      )
      ON CONFLICT (mmsi) DO UPDATE SET
        ship_name        = COALESCE(EXCLUDED.ship_name,        vessels.ship_name),
        callsign         = COALESCE(EXCLUDED.callsign,         vessels.callsign),
        imo              = COALESCE(EXCLUDED.imo,              vessels.imo),
        vessel_type      = COALESCE(EXCLUDED.vessel_type,      vessels.vessel_type),
        length_m         = COALESCE(EXCLUDED.length_m,         vessels.length_m),
        width_m          = COALESCE(EXCLUDED.width_m,          vessels.width_m),
        latitude         = COALESCE(EXCLUDED.latitude,         vessels.latitude),
        longitude        = COALESCE(EXCLUDED.longitude,        vessels.longitude),
        speed            = COALESCE(EXCLUDED.speed,            vessels.speed),
        course           = COALESCE(EXCLUDED.course,           vessels.course),
        heading          = COALESCE(EXCLUDED.heading,          vessels.heading),
        nav_status       = COALESCE(EXCLUDED.nav_status,       vessels.nav_status),
        draught          = COALESCE(EXCLUDED.draught,          vessels.draught),
        destination      = COALESCE(EXCLUDED.destination,      vessels.destination),
        locale           = EXCLUDED.locale,
        last_position_at = COALESCE(EXCLUDED.last_position_at, vessels.last_position_at),
        last_static_at   = COALESCE(EXCLUDED.last_static_at,   vessels.last_static_at),
        updated_at       = NOW()
    `, [
      row.mmsi, row.ship_name, row.callsign, row.imo, row.vessel_type,
      row.length_m, row.width_m,
      row.latitude, row.longitude, row.speed, row.course, row.heading,
      row.nav_status, row.draught, row.destination,
      row.locale,
      row.last_position_at, row.last_static_at,
    ]);
  } catch (err) {
    console.error('[db] upsertVessel error:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Load — called on startup to seed in-memory map from DB
// ---------------------------------------------------------------------------

export async function loadAllVessels(): Promise<VesselRow[]> {
  if (!pool) return [];
  try {
    const result = await pool.query<VesselRow>(`
      SELECT
        mmsi, ship_name, callsign, imo, vessel_type,
        length_m::float8         AS length_m,
        width_m::float8          AS width_m,
        latitude::float8         AS latitude,
        longitude::float8        AS longitude,
        speed::float8            AS speed,
        course::float8           AS course,
        heading::float8          AS heading,
        nav_status, draught::float8 AS draught, destination,
        locale,
        last_position_at::text   AS last_position_at,
        last_static_at::text     AS last_static_at,
        updated_at::text         AS updated_at
      FROM vessels
      WHERE updated_at > NOW() - INTERVAL '24 hours'
    `);
    return result.rows;
  } catch (err) {
    console.error('[db] loadAllVessels error:', (err as Error).message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Cleanup — delete records not updated in the last 24 hours
// ---------------------------------------------------------------------------

export async function cleanupOldVessels(): Promise<number> {
  if (!pool) return 0;
  try {
    const result = await pool.query(
      `DELETE FROM vessels WHERE updated_at < NOW() - INTERVAL '24 hours'`
    );
    return result.rowCount ?? 0;
  } catch (err) {
    console.error('[db] cleanupOldVessels error:', (err as Error).message);
    return 0;
  }
}
