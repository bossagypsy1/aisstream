-- TrawlerWatch — vessel state table
-- Run once against your Neon database to set up the schema.
--
--   psql "$DATABASE_URL" -f db/schema.sql
--
-- The server also calls setupSchema() on startup, so this file is optional
-- but useful for inspecting or recreating the schema manually.

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
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup when purging old records
CREATE INDEX IF NOT EXISTS vessels_updated_at_idx ON vessels(updated_at);

-- Purge records not updated in the last 24 hours (run manually or see cleanup below)
-- DELETE FROM vessels WHERE updated_at < NOW() - INTERVAL '24 hours';
