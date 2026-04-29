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

export interface MpaRow {
  mpa_id:           string;
  name:             string;
  designation_type: string;
  source:           string;
  status:           string | null;
  metadata:         Record<string, unknown>;
}

export interface GeoJsonGeometry {
  type: string;
  coordinates: unknown;
}

export interface GeoJsonFeature {
  type: 'Feature';
  id: string;
  geometry: GeoJsonGeometry;
  properties: {
    name: string;
    designationType: string;
    source: string;
    status: string | null;
    metadata: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Schema setup (run once on startup)
// ---------------------------------------------------------------------------

export async function setupSchema(): Promise<void> {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE EXTENSION IF NOT EXISTS postgis;

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
        geom             geometry(Point, 4326),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS vessels_updated_at_idx ON vessels(updated_at);
      CREATE INDEX IF NOT EXISTS vessels_geom_gist_idx ON vessels USING GIST (geom);

      -- Add locale column if upgrading from an older schema
      ALTER TABLE vessels ADD COLUMN IF NOT EXISTS locale TEXT;
      ALTER TABLE vessels ADD COLUMN IF NOT EXISTS geom geometry(Point, 4326);

      UPDATE vessels
      SET geom = ST_SetSRID(ST_MakePoint(longitude::double precision, latitude::double precision), 4326)
      WHERE geom IS NULL
        AND latitude IS NOT NULL
        AND longitude IS NOT NULL;

      CREATE TABLE IF NOT EXISTS mpas (
        mpa_id             TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        designation_type   TEXT NOT NULL,
        source             TEXT NOT NULL,
        status             TEXT,
        metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
        geom               geometry(MultiPolygon, 4326) NOT NULL,
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS mpas_geom_gist_idx ON mpas USING GIST (geom);
      CREATE INDEX IF NOT EXISTS mpas_designation_type_idx ON mpas (designation_type);
      CREATE INDEX IF NOT EXISTS mpas_source_idx ON mpas (source);
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

function geomSql(latRef: string, lonRef: string, fallback = 'NULL'): string {
  return `CASE
    WHEN ${latRef} IS NOT NULL AND ${lonRef} IS NOT NULL
      THEN ST_SetSRID(ST_MakePoint(${lonRef}::double precision, ${latRef}::double precision), 4326)
    ELSE ${fallback}
  END`;
}

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
        last_position_at, last_static_at, geom, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,${geomSql('$8', '$9')},NOW()
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
        geom             = ${geomSql('EXCLUDED.latitude', 'EXCLUDED.longitude', 'vessels.geom')},
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

export async function upsertVessels(rows: VesselRow[]): Promise<void> {
  if (!pool || rows.length === 0) return;

  const values: unknown[] = [];
  const placeholders = rows.map((row, rowIndex) => {
    const offset = rowIndex * 18;
    values.push(
      row.mmsi, row.ship_name, row.callsign, row.imo, row.vessel_type,
      row.length_m, row.width_m,
      row.latitude, row.longitude, row.speed, row.course, row.heading,
      row.nav_status, row.draught, row.destination,
      row.locale,
      row.last_position_at, row.last_static_at,
    );
    const geomExpr = geomSql(`$${offset + 8}`, `$${offset + 9}`);
    return `(${Array.from({ length: 18 }, (_, i) => `$${offset + i + 1}`).join(',')},${geomExpr},NOW())`;
  }).join(',');

  try {
    await pool.query(`
      INSERT INTO vessels (
        mmsi, ship_name, callsign, imo, vessel_type,
        length_m, width_m,
        latitude, longitude, speed, course, heading,
        nav_status, draught, destination,
        locale,
        last_position_at, last_static_at, geom, updated_at
      ) VALUES ${placeholders}
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
        geom             = ${geomSql('EXCLUDED.latitude', 'EXCLUDED.longitude', 'vessels.geom')},
        updated_at       = NOW()
    `, values);
  } catch (err) {
    console.error('[db] upsertVessels error:', (err as Error).message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Shared SELECT columns — keeps both query functions in sync
// ---------------------------------------------------------------------------

const SELECT_COLUMNS = `
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
`;

// ---------------------------------------------------------------------------
// Load all — called on startup to seed the in-memory write buffer from DB
// ---------------------------------------------------------------------------

export async function loadAllVessels(): Promise<VesselRow[]> {
  if (!pool) return [];
  try {
    const result = await pool.query<VesselRow>(`
      SELECT ${SELECT_COLUMNS}
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
// Load by locale — available for diagnostics/backfills.
// The dashboard /vessels path is served from aisstream memory, not Neon.
// Only returns vessels that have a valid position fix.
// ---------------------------------------------------------------------------

export async function loadVesselsForLocale(localeName: string): Promise<VesselRow[]> {
  if (!pool) return [];
  try {
    const result = await pool.query<VesselRow>(`
      SELECT ${SELECT_COLUMNS}
      FROM vessels
      WHERE locale = $1
        AND latitude  IS NOT NULL
        AND longitude IS NOT NULL
        AND updated_at > NOW() - INTERVAL '24 hours'
      ORDER BY updated_at DESC
    `, [localeName]);
    return result.rows;
  } catch (err) {
    console.error('[db] loadVesselsForLocale error:', (err as Error).message);
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

export async function upsertMpas(rows: Array<MpaRow & { geometry: GeoJsonGeometry }>): Promise<void> {
  if (!pool || rows.length === 0) return;

  const batchSize = 1;

  try {
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const values: unknown[] = [];
      const placeholders = batch.map((row, rowIndex) => {
        const offset = rowIndex * 7;
        values.push(
          row.mpa_id,
          row.name,
          row.designation_type,
          row.source,
          row.status,
          JSON.stringify(row.metadata ?? {}),
          JSON.stringify(row.geometry),
        );
        return `(
          $${offset + 1},
          $${offset + 2},
          $${offset + 3},
          $${offset + 4},
          $${offset + 5},
          $${offset + 6}::jsonb,
          ST_Multi(ST_CollectionExtract(ST_SetSRID(ST_GeomFromGeoJSON($${offset + 7}), 4326), 3)),
          NOW()
        )`;
      }).join(',');

      await pool.query(`
        INSERT INTO mpas (
          mpa_id, name, designation_type, source, status, metadata, geom, updated_at
        ) VALUES ${placeholders}
        ON CONFLICT (mpa_id) DO UPDATE SET
          name             = EXCLUDED.name,
          designation_type  = EXCLUDED.designation_type,
          source            = EXCLUDED.source,
          status            = EXCLUDED.status,
          metadata          = EXCLUDED.metadata,
          geom              = EXCLUDED.geom,
          updated_at        = NOW()
      `, values);
    }
  } catch (err) {
    console.error('[db] upsertMpas error:', (err as Error).message);
    throw err;
  }
}

export async function loadMpasForLocale(localeId: string): Promise<GeoJsonFeature[]> {
  if (!pool) return [];
  if (localeId !== 'uk') return [];

  try {
    const result = await pool.query<{
      mpa_id: string;
      name: string;
      designation_type: string;
      source: string;
      status: string | null;
      metadata: Record<string, unknown>;
      geometry: GeoJsonGeometry;
    }>(`
      SELECT
        mpa_id,
        name,
        designation_type,
        source,
        status,
        metadata,
        ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, 0.01), 6)::json AS geometry
      FROM mpas
    `);

    return result.rows.map((row) => ({
      type: 'Feature',
      id: row.mpa_id,
      geometry: row.geometry,
      properties: {
        name: row.name,
        designationType: row.designation_type,
        source: row.source,
        status: row.status,
        metadata: row.metadata ?? {},
      },
    }));
  } catch (err) {
    console.error('[db] loadMpasForLocale error:', (err as Error).message);
    return [];
  }
}
