-- TrawlerWatch - vessel state table
-- Run once against your Neon database to set up the schema.
--
--   psql "$DATABASE_URL" -f db/schema.sql
--
-- The server also calls setupSchema() on startup, so this file is optional
-- but useful for inspecting or recreating the schema manually.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS vessels (
  mmsi             TEXT PRIMARY KEY,
  ship_name        TEXT,
  callsign         TEXT,
  imo              TEXT,
  vessel_type      TEXT,          -- raw numeric string e.g. "70" (Cargo)
  length_m         NUMERIC,
  width_m          NUMERIC,
  latitude         NUMERIC,
  longitude        NUMERIC,
  speed            NUMERIC,       -- knots (SOG)
  course           NUMERIC,       -- degrees (COG)
  heading          NUMERIC,       -- degrees true, 511 = unavailable
  nav_status       TEXT,
  draught          NUMERIC,       -- metres
  destination      TEXT,
  last_position_at TIMESTAMPTZ,   -- when we last received a position fix
  last_static_at   TIMESTAMPTZ,   -- when we last received ShipStaticData
  geom             geometry(Point, 4326),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup when purging old records
CREATE INDEX IF NOT EXISTS vessels_updated_at_idx ON vessels(updated_at);
CREATE INDEX IF NOT EXISTS vessels_geom_gist_idx ON vessels USING GIST (geom);

-- Add geom for older deployments and backfill from existing lon/lat values
ALTER TABLE vessels ADD COLUMN IF NOT EXISTS geom geometry(Point, 4326);
UPDATE vessels
SET geom = ST_SetSRID(ST_MakePoint(longitude::double precision, latitude::double precision), 4326)
WHERE geom IS NULL
  AND latitude IS NOT NULL
  AND longitude IS NOT NULL;

CREATE TABLE IF NOT EXISTS mpas (
  mpa_id           TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  designation_type TEXT NOT NULL,
  source           TEXT NOT NULL,
  status           TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  geom             geometry(MultiPolygon, 4326) NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS mpas_geom_gist_idx ON mpas USING GIST (geom);
CREATE INDEX IF NOT EXISTS mpas_designation_type_idx ON mpas (designation_type);
CREATE INDEX IF NOT EXISTS mpas_source_idx ON mpas (source);

-- Purge records not updated in the last 24 hours (run manually or see cleanup below)
-- DELETE FROM vessels WHERE updated_at < NOW() - INTERVAL '24 hours';
