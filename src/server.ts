import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import WebSocket, { WebSocketServer } from 'ws';
import {
  setupSchema,
  upsertVessels,
  loadAllVessels,
  cleanupOldVessels,
  loadMpasForLocale,
  VesselRow,
} from './db';
import { LOCALES, DEFAULT_LOCALE, Locale } from './locales';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 5000;
const PORT = Number(process.env.PORT) || DEFAULT_PORT;
const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
const API_KEY = 'ac0083bc3324249a8bc4572aebaf89f1314abb7a';

// Message types to subscribe to.
const FILTER_MESSAGE_TYPES: string[] = [
  'PositionReport',
  'StandardClassBPositionReport',
  'ShipStaticData',
];

// How many raw messages to keep in the rolling buffer (for the HTML page table)
const MAX_MESSAGES = 300;

// Reconnect delay in ms if the AISStream socket closes
const RECONNECT_DELAY_MS = 5000;

// How often to run the 24-hour cleanup against Neon (every hour)
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// Minimum gap between position-triggered DB writes per vessel (20 minutes).
// Static data (ShipStaticData) is persisted once per MMSI.
const POSITION_WRITE_THROTTLE_MS = 20 * 60 * 1000;

// Flush dirty vessel rows in bulk to reduce Neon network overhead.
const DB_WRITE_BATCH_SIZE = 100;
const DB_WRITE_FLUSH_INTERVAL_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AISUpdate {
  mmsi: string;
  shipName: string;
  messageType: string;
  latitude: number | null;
  longitude: number | null;
  speed: number | null;      // knots (SOG)
  course: number | null;     // degrees (COG)
  heading: number | null;    // degrees (true heading)
  navStatus: string | null;
  timestamp: string;
  // From ShipStaticData
  callsign: string | null;
  imo: string | null;
  vesselType: string | null;
  lengthM: number | null;
  widthM: number | null;
  draught: number | null;
  destination: string | null;
}

interface BrowserMessage {
  type: 'status' | 'update' | 'snapshot' | 'debug';
  connected?: boolean;
  totalReceived?: number;
  update?: AISUpdate;
  messages?: AISUpdate[];
  // debug only
  raw?: unknown;
  note?: string;
}

// ---------------------------------------------------------------------------
// AIS NavigationalStatus decoder
// ---------------------------------------------------------------------------

const NAV_STATUS: Record<number, string> = {
  0: 'Under way (engine)',
  1: 'At anchor',
  2: 'Not under command',
  3: 'Restricted maneuverability',
  4: 'Constrained by draught',
  5: 'Moored',
  6: 'Aground',
  7: 'Fishing',
  8: 'Under way (sailing)',
  15: 'Not defined',
};

const VESSEL_TYPE: Record<number, string> = {
  0:  'Not available',
  20: 'Wing in ground (WIG)',     21: 'WIG — Hazardous A',
  22: 'WIG — Hazardous B',        23: 'WIG — Hazardous C',        24: 'WIG — Hazardous D',
  30: 'Fishing',                  31: 'Towing',                   32: 'Towing (large)',
  33: 'Dredging / underwater',    34: 'Diving ops',               35: 'Military ops',
  36: 'Sailing',                  37: 'Pleasure craft',
  40: 'High-speed craft (HSC)',   41: 'HSC — Hazardous A',
  42: 'HSC — Hazardous B',        43: 'HSC — Hazardous C',        44: 'HSC — Hazardous D',
  50: 'Pilot vessel',             51: 'Search and rescue',        52: 'Tug',
  53: 'Port tender',              54: 'Anti-pollution',           55: 'Law enforcement',
  56: 'Spare (unclassified)',     57: 'Medical transport',        58: 'Ship per RR',
  59: 'Special craft',
  60: 'Passenger',                61: 'Passenger — Hazardous A', 62: 'Passenger — Hazardous B',
  63: 'Passenger — Hazardous C', 64: 'Passenger — Hazardous D',
  70: 'Cargo',                    71: 'Cargo — Hazardous A',     72: 'Cargo — Hazardous B',
  73: 'Cargo — Hazardous C',      74: 'Cargo — Hazardous D',
  80: 'Tanker',                   81: 'Tanker — Hazardous A',    82: 'Tanker — Hazardous B',
  83: 'Tanker — Hazardous C',     84: 'Tanker — Hazardous D',
  90: 'Other',                    91: 'Other — Hazardous A',     92: 'Other — Hazardous B',
  93: 'Other — Hazardous C',      94: 'Other — Hazardous D',     99: 'Unknown',
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Rolling raw message buffer — drives the HTML page table (unchanged behaviour)
const recentMessages: AISUpdate[] = [];

// Server-side merged vessel state keyed by MMSI
const vesselMap = new Map<string, AISUpdate>();
const vesselLocale = new Map<string, string>();

let activeLocale: Locale = DEFAULT_LOCALE;
let totalReceived = 0;
let aisConnected = false;
let rawMessageLog: unknown[] = [];
let rawMessageCount = 0;
// Reference to the active AISStream WebSocket so we can close it on locale switch
let aisSocket: WebSocket | null = null;

// Tracks the last time each vessel was written to Neon (keyed by MMSI).
// Used to throttle position-only writes to at most once per 20 minutes.
const lastDbWrite = new Map<string, number>();

// Tracks vessels whose ShipStaticData has already been persisted.
// Static AIS messages are repetitive; write them only once per MMSI.
const staticDataWritten = new Set<string>();

// ---------------------------------------------------------------------------
// Frontend read path — serves live in-memory state hydrated from Neon at startup
// and updated continuously by the AIS stream.
// ---------------------------------------------------------------------------

function getVesselsForFrontend(): AISUpdate[] {
  return Array.from(vesselMap.entries())
    .filter(([, vessel]) => (
      vesselLocale.get(vessel.mmsi) === activeLocale.name &&
      vessel.latitude != null &&
      vessel.longitude != null
    ))
    .map(([, vessel]) => vessel);
}

// ---------------------------------------------------------------------------
// Batched Neon persistence
// ---------------------------------------------------------------------------

const pendingDbWrites = new Map<string, VesselRow>();
let flushInFlight = false;

function mergeQueuedRow(prev: VesselRow, next: VesselRow): VesselRow {
  return {
    mmsi:             next.mmsi,
    ship_name:        next.ship_name        ?? prev.ship_name,
    callsign:         next.callsign         ?? prev.callsign,
    imo:              next.imo              ?? prev.imo,
    vessel_type:      next.vessel_type      ?? prev.vessel_type,
    length_m:         next.length_m         ?? prev.length_m,
    width_m:          next.width_m          ?? prev.width_m,
    latitude:         next.latitude         ?? prev.latitude,
    longitude:        next.longitude        ?? prev.longitude,
    speed:            next.speed            ?? prev.speed,
    course:           next.course           ?? prev.course,
    heading:          next.heading          ?? prev.heading,
    nav_status:       next.nav_status       ?? prev.nav_status,
    draught:          next.draught          ?? prev.draught,
    destination:      next.destination      ?? prev.destination,
    locale:           next.locale           ?? prev.locale,
    last_position_at: next.last_position_at ?? prev.last_position_at,
    last_static_at:   next.last_static_at   ?? prev.last_static_at,
    updated_at:       next.updated_at,
  };
}

function queueDbWrite(row: VesselRow): void {
  const prev = pendingDbWrites.get(row.mmsi);
  pendingDbWrites.set(row.mmsi, prev ? mergeQueuedRow(prev, row) : row);
  if (pendingDbWrites.size >= DB_WRITE_BATCH_SIZE) {
    void flushPendingDbWrites();
  }
}

async function flushPendingDbWrites(): Promise<void> {
  if (flushInFlight || pendingDbWrites.size === 0) return;

  flushInFlight = true;
  const rows = Array.from(pendingDbWrites.values()).slice(0, DB_WRITE_BATCH_SIZE);

  try {
    await upsertVessels(rows);
    rows.forEach((row) => pendingDbWrites.delete(row.mmsi));
  } catch {
    // Keep pending rows queued; the interval will retry.
  } finally {
    flushInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Merge an incoming AISUpdate into the server-side vessel map
// ---------------------------------------------------------------------------

function mergeIntoVesselMap(u: AISUpdate): void {
  const prev = vesselMap.get(u.mmsi);
  if (!prev) {
    vesselMap.set(u.mmsi, { ...u });
    return;
  }

  const hasPosition = u.latitude != null && u.longitude != null;

  vesselMap.set(u.mmsi, {
    ...prev,
    messageType: u.messageType,
    timestamp:   u.timestamp,
    // Only overwrite ship name if the new one is non-empty
    shipName:    (u.shipName && u.shipName !== '—') ? u.shipName : prev.shipName,
    // Position fields: only update when this message carries a position fix
    latitude:    hasPosition ? u.latitude   : prev.latitude,
    longitude:   hasPosition ? u.longitude  : prev.longitude,
    speed:       hasPosition ? (u.speed     ?? prev.speed)     : prev.speed,
    course:      hasPosition ? (u.course    ?? prev.course)    : prev.course,
    heading:     hasPosition ? (u.heading   ?? prev.heading)   : prev.heading,
    navStatus:   hasPosition ? (u.navStatus ?? prev.navStatus) : prev.navStatus,
    // Static fields: prefer non-null
    callsign:    u.callsign    ?? prev.callsign,
    imo:         u.imo         ?? prev.imo,
    vesselType:  u.vesselType  ?? prev.vesselType,
    lengthM:     u.lengthM     ?? prev.lengthM,
    widthM:      u.widthM      ?? prev.widthM,
    draught:     u.draught     ?? prev.draught,
    destination: u.destination ?? prev.destination,
  });
}

// ---------------------------------------------------------------------------
// Convert AISUpdate ↔ VesselRow (for Neon persistence)
// ---------------------------------------------------------------------------

function toVesselRow(
  u: AISUpdate,
  localeName: string,
  writeKind: 'position' | 'static',
): VesselRow {
  return {
    mmsi:             u.mmsi,
    ship_name:        (u.shipName && u.shipName !== '—') ? u.shipName : null,
    callsign:         u.callsign,
    imo:              u.imo,
    vessel_type:      u.vesselType,
    length_m:         u.lengthM,
    width_m:          u.widthM,
    latitude:         u.latitude,
    longitude:        u.longitude,
    speed:            u.speed,
    course:           u.course,
    heading:          u.heading,
    nav_status:       u.navStatus,
    draught:          u.draught,
    destination:      u.destination,
    locale:           localeName,
    last_position_at: writeKind === 'position' ? u.timestamp : null,
    last_static_at:   writeKind === 'static'   ? u.timestamp : null,
    updated_at:       u.timestamp,
  };
}

function fromVesselRow(r: VesselRow): AISUpdate {
  return {
    mmsi:        r.mmsi,
    shipName:    r.ship_name ?? '—',
    messageType: 'Persisted',
    latitude:    r.latitude  ?? null,
    longitude:   r.longitude ?? null,
    speed:       r.speed     ?? null,
    course:      r.course    ?? null,
    heading:     r.heading   ?? null,
    navStatus:   r.nav_status,
    timestamp:   r.last_position_at ?? r.updated_at,
    callsign:    r.callsign,
    imo:         r.imo,
    vesselType:  r.vessel_type,
    lengthM:     r.length_m  ?? null,
    widthM:      r.width_m   ?? null,
    draught:     r.draught   ?? null,
    destination: r.destination,
  };
}

// ---------------------------------------------------------------------------
// Normalise the Go-style AISStream timestamp into ISO 8601 for Postgres.
// Input:  "2026-04-25 00:05:39.004682189 +0000 UTC"
// Output: "2026-04-25T00:05:39.004Z"
// ---------------------------------------------------------------------------

function normaliseTimestamp(ts: string): string {
  return ts
    .replace(' ', 'T')                       // date/time separator
    .replace(/(\.\d{3})\d*/, '$1')           // truncate sub-ms precision
    .replace(/\s+\+0000\s+UTC$/, 'Z')        // "+0000 UTC" → "Z"
    .replace(/\s+\+0000$/, 'Z');             // "+0000" → "Z" (fallback)
}

// ---------------------------------------------------------------------------
// Parse a raw AISStream JSON message into an AISUpdate
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseAISMessage(raw: any): AISUpdate | null {
  try {
    const messageType: string = raw?.MessageType;
    const meta = raw?.MetaData;
    const body = raw?.Message?.[messageType];

    if (!messageType || !meta) {
      console.warn('[parse] Dropping message — missing MessageType or MetaData. Keys:', Object.keys(raw ?? {}));
      return null;
    }

    const mmsi = String(meta.MMSI ?? '');
    if (!mmsi) {
      console.warn('[parse] Dropping message — no MMSI. MessageType:', messageType);
      return null;
    }

    const shipName: string = (meta.ShipName ?? body?.Name ?? '').trim() || '—';
    const timestamp: string = typeof meta.time_utc === 'string'
      ? normaliseTimestamp(meta.time_utc)
      : new Date().toISOString();

    // ── ShipStaticData — no position, but rich vessel metadata ────────────────
    if (messageType === 'ShipStaticData') {
      const typeCode: number | undefined = body?.Type;
      const dim = body?.Dimension ?? {};
      const lenA: number = dim.A ?? 0;
      const lenB: number = dim.B ?? 0;
      const widC: number = dim.C ?? 0;
      const widD: number = dim.D ?? 0;
      const lengthM = (lenA + lenB) > 0 ? lenA + lenB : null;
      const widthM  = (widC + widD) > 0 ? widC + widD : null;

      return {
        mmsi, shipName, messageType, timestamp,
        latitude: null, longitude: null,
        speed: null, course: null, heading: null, navStatus: null,
        callsign:   (body?.CallSign ?? '').trim() || null,
        imo:        body?.ImoNumber ? String(body.ImoNumber) : null,
        vesselType: typeCode != null ? String(typeCode) : null,
        lengthM,
        widthM,
        draught:     body?.MaximumStaticDraught ?? null,
        destination: (body?.Destination ?? '').trim() || null,
      };
    }

    // ── PositionReport + StandardClassBPositionReport ─────────────────────────
    const rawLat: number | undefined = body?.Latitude ?? meta.latitude;
    const rawLon: number | undefined = body?.Longitude ?? meta.longitude;
    const latitude  = rawLat != null && Math.abs(rawLat) <= 90  ? rawLat  : null;
    const longitude = rawLon != null && Math.abs(rawLon) <= 180 ? rawLon : null;

    const rawSog: number | undefined = body?.Sog;
    const speed = rawSog != null && rawSog < 102.3 ? rawSog : null;

    const rawCog: number | undefined = body?.Cog;
    const course = rawCog != null && rawCog < 360.0 ? rawCog : null;

    const rawHdg: number | undefined = body?.TrueHeading;
    const heading = rawHdg != null && rawHdg !== 511 ? rawHdg : null;

    const navStatusCode: number | undefined = body?.NavigationalStatus;
    const navStatus =
      navStatusCode != null ? (NAV_STATUS[navStatusCode] ?? `Status ${navStatusCode}`) : null;

    return {
      mmsi, shipName, messageType, timestamp,
      latitude, longitude, speed, course, heading, navStatus,
      callsign: null, imo: null, vesselType: null,
      lengthM: null, widthM: null, draught: null, destination: null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/' || req.url === '/index.html') {
    const filePath = path.join(__dirname, '..', 'public', 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(500); res.end('Could not read index.html'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // /vessels — in-memory vessel list for the map frontend.
  // Neon is used for startup hydration and batched persistence, not live reads.
  if (req.url === '/vessels') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      connected: aisConnected,
      totalReceived,
      localeId:  activeLocale.id,
      messages:  getVesselsForFrontend(),
    }));
    return;
  }

  // /status — returns merged vessel map + current locale to the map frontend
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        connected:     aisConnected,
        totalReceived,
        localeId:      activeLocale.id,
        messages:      Array.from(vesselMap.values()),
      })
    );
    return;
  }

  // /locales — list of available locales
  if (req.url === '/locales') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(LOCALES.map(({ id, name, center, zoom }) => ({ id, name, center, zoom }))));
    return;
  }

  // POST /locale — switch active locale
  if (req.url === '/locale' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { localeId } = JSON.parse(body);
        const next = LOCALES.find((l) => l.id === localeId);
        if (!next) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Unknown locale: ${localeId}` }));
          return;
        }
        if (next.id === activeLocale.id) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, localeId: next.id }));
          return;
        }

        console.log(`[locale] Switching: ${activeLocale.name} → ${next.name}`);
        console.log(`[locale] New bounding boxes: ${JSON.stringify(next.boundingBoxes)}`);
        activeLocale = next;

        // Close existing AIS connection (close handler won't reconnect — see guard above)
        aisConnected = false;
        if (aisSocket) { aisSocket.close(); aisSocket = null; }

        // Clear stale vessels and caches from the previous region
        await flushPendingDbWrites();
        vesselMap.clear();
        vesselLocale.clear();
        recentMessages.length = 0;
        totalReceived = 0;
        rawMessageLog = [];
        rawMessageCount = 0;
        lastDbWrite.clear();

        broadcast({ type: 'status', connected: false, totalReceived });

        // Reconnect for new locale after a short delay
        setTimeout(() => connectToAISStream(activeLocale), 500);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, localeId: next.id }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // /debug — connection health, active locale, and first few raw frames
  if (req.url === '/debug') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        aisConnected,
        totalReceived,
        rawMessageCount,
        vesselCount:      vesselMap.size,
        activeLocale: {
          id:           activeLocale.id,
          name:         activeLocale.name,
          boundingBoxes: activeLocale.boundingBoxes,
        },
        availableLocales: LOCALES.map((l) => ({
          id:           l.id,
          name:         l.name,
          boundingBoxes: l.boundingBoxes,
        })),
        firstRawMessages: rawMessageLog,
      }, null, 2)
    );
    return;
  }

  if (req.url?.startsWith('/mpas')) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const localeId = url.searchParams.get('localeId') ?? activeLocale.id;
    void loadMpasForLocale(localeId).then((features) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'FeatureCollection',
        localeId,
        features,
      }));
    }).catch(() => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to load MPA layer' }));
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ---------------------------------------------------------------------------
// WebSocket server — browser clients connect here for live push updates
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server: httpServer });

function broadcast(msg: BrowserMessage): void {
  const json = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  }
}

wss.on('connection', (socket) => {
  // Send merged snapshot to newly connected browser tab
  const snapshot: BrowserMessage = {
    type: 'snapshot',
    connected: aisConnected,
    totalReceived,
    messages: Array.from(vesselMap.values()).slice(0, 100),
  };
  socket.send(JSON.stringify(snapshot));
});

// ---------------------------------------------------------------------------
// AISStream WebSocket client
// ---------------------------------------------------------------------------

function connectToAISStream(locale: Locale = activeLocale): void {
  console.log(`Connecting to AISStream for locale: ${locale.name}...`);
  const ws = new WebSocket(AISSTREAM_URL);
  aisSocket = ws;

  ws.on('open', () => {
    aisConnected = true;
    const subscription = {
      APIKey: API_KEY,
      BoundingBoxes: locale.boundingBoxes,
      FilterMessageTypes: FILTER_MESSAGE_TYPES,
    };
    console.log(`[ais] Connected [${locale.name}]. Subscription:`, JSON.stringify(subscription));
    ws.send(JSON.stringify(subscription));

    broadcast({ type: 'status', connected: true, totalReceived });
  });

  ws.on('message', (data) => {
    // Discard buffered messages from a superseded (locale-switched) socket
    if (aisSocket !== ws) return;

    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      console.warn('Received non-JSON data from AISStream:', data.toString().slice(0, 200));
      return;
    }

    rawMessageCount++;

    // Keep the first 5 raw frames so /debug can show them
    if (rawMessageLog.length < 5) {
      rawMessageLog.push(raw);
      console.log(`[raw #${rawMessageCount}]`, JSON.stringify(raw).slice(0, 300));
    } else if (rawMessageCount <= 10) {
      console.log(`[raw #${rawMessageCount}]`, JSON.stringify(raw).slice(0, 300));
    } else if (rawMessageCount === 11) {
      console.log('[raw] Suppressing further raw logs. Check /debug for samples.');
    }

    const update = parseAISMessage(raw);
    if (!update) return;

    totalReceived++;

    // 1. Raw rolling buffer — keeps the HTML page table working as before
    recentMessages.unshift(update);
    if (recentMessages.length > MAX_MESSAGES) recentMessages.length = MAX_MESSAGES;

    // 2. Merge into server-side vessel map (source of truth for the map frontend)
    mergeIntoVesselMap(update);
    vesselLocale.set(update.mmsi, activeLocale.name);

    // 3. Persist merged state to Neon — throttled by message type:
    //    • ShipStaticData  → once per MMSI only
    //    • Position report → at most once per 20 minutes per vessel
    const merged    = vesselMap.get(update.mmsi)!;
    const isStatic  = update.messageType === 'ShipStaticData';
    const nowMs     = Date.now();
    const lastWrite = lastDbWrite.get(update.mmsi) ?? 0;
    const shouldWriteStatic = isStatic && !staticDataWritten.has(update.mmsi);
    const dueForPositionWrite = nowMs - lastWrite >= POSITION_WRITE_THROTTLE_MS;

    if (shouldWriteStatic) {
      staticDataWritten.add(update.mmsi);
      queueDbWrite(toVesselRow(merged, activeLocale.name, 'static'));
    }

    if (!isStatic && dueForPositionWrite) {
      queueDbWrite(toVesselRow(merged, activeLocale.name, 'position'));
      lastDbWrite.set(update.mmsi, nowMs);
    }

    broadcast({ type: 'update', update, totalReceived });
  });

  ws.on('close', (code, reason) => {
    if (aisSocket !== ws) return; // superseded by a locale switch — don't reconnect
    console.log(`AISStream disconnected (${code} ${reason}). Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    aisConnected = false;
    broadcast({ type: 'status', connected: false, totalReceived });
    setTimeout(() => connectToAISStream(activeLocale), RECONNECT_DELAY_MS);
  });

  ws.on('error', (err) => {
    console.error('AISStream WebSocket error:', err.message);
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  // 1. Ensure the schema exists in Neon
  await setupSchema();

  // 2. Seed in-memory vessel map from persisted DB state (survives restarts)
  const rows = await loadAllVessels();
  for (const row of rows) {
    vesselMap.set(row.mmsi, fromVesselRow(row));
    if (row.locale) vesselLocale.set(row.mmsi, row.locale);
    if (row.last_static_at) staticDataWritten.add(row.mmsi);
  }
  if (rows.length > 0) {
    console.log(`[db] Loaded ${rows.length} vessel(s) from Neon into memory`);
  }

  // 3. Schedule hourly cleanup of records older than 24 hours
  setInterval(async () => {
    const deleted = await cleanupOldVessels();
    if (deleted > 0) {
      console.log(`[db] Cleaned up ${deleted} vessel record(s) older than 24 hours`);
      // Also remove from in-memory map if they've gone stale
      // (vessel will re-appear naturally if it broadcasts again)
    }
  }, CLEANUP_INTERVAL_MS);

  // 4. Flush dirty vessel rows to Neon in batches.
  setInterval(() => {
    void flushPendingDbWrites();
  }, DB_WRITE_FLUSH_INTERVAL_MS);

  // 5. Start HTTP server
  httpServer.listen(PORT, () => {
    console.log(`AIS Viewer running at http://localhost:${PORT}`);
    console.log(`WebSocket endpoint for browser: ws://localhost:${PORT}`);
  });

  // 6. Connect to AISStream using the default locale
  connectToAISStream(activeLocale);
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

async function shutdown(): Promise<void> {
  await flushPendingDbWrites();
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown();
});

process.on('SIGTERM', () => {
  void shutdown();
});
