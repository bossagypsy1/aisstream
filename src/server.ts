import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import WebSocket, { WebSocketServer } from 'ws';
import {
  setupSchema,
  upsertVessel,
  loadAllVessels,
  cleanupOldVessels,
  VesselRow,
} from './db';

// ---------------------------------------------------------------------------
// Configuration — edit these to tune the stream
// ---------------------------------------------------------------------------

const PORT = 5000;
const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
const API_KEY = 'ac0083bc3324249a8bc4572aebaf89f1314abb7a';

// Bounding boxes: each box is [[min_lat, min_lon], [max_lat, max_lon]]
// Add more boxes to cover more areas, or widen/narrow to tune volume.
const BOUNDING_BOXES: [[number, number], [number, number]][] = [
  [[49.0, -8.0], [62.0, 2.0]], // UK and surrounding waters
];

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
  0: 'Unknown', 20: 'Wing in ground', 21: 'Wing in ground (hazardous A)',
  30: 'Fishing', 31: 'Towing', 32: 'Towing (large)', 33: 'Dredging',
  34: 'Diving', 35: 'Military', 36: 'Sailing', 37: 'Pleasure craft',
  50: 'Pilot', 51: 'SAR', 52: 'Tug', 53: 'Port tender',
  54: 'Anti-pollution', 55: 'Law enforcement', 58: 'Medical',
  60: 'Passenger', 61: 'Passenger (hazardous A)', 62: 'Passenger (hazardous B)',
  69: 'Passenger (other)',
  70: 'Cargo', 71: 'Cargo (hazardous A)', 72: 'Cargo (hazardous B)',
  79: 'Cargo (other)',
  80: 'Tanker', 81: 'Tanker (hazardous A)', 82: 'Tanker (hazardous B)',
  89: 'Tanker (other)',
  90: 'Other',
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Rolling raw message buffer — drives the HTML page table (unchanged behaviour)
const recentMessages: AISUpdate[] = [];

// Server-side merged vessel state keyed by MMSI — this is the source of truth
// served to the map frontend. Seeded from Neon on startup.
const vesselMap = new Map<string, AISUpdate>();

let totalReceived = 0;
let aisConnected = false;
let rawMessageLog: unknown[] = [];   // stores first 5 raw messages for /debug
let rawMessageCount = 0;

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

function toVesselRow(u: AISUpdate): VesselRow {
  const isPosition = u.latitude != null && u.longitude != null;
  const isStatic   = u.messageType === 'ShipStaticData';
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
    last_position_at: isPosition ? u.timestamp : null,
    last_static_at:   isStatic   ? u.timestamp : null,
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
    const timestamp: string =
      typeof meta.time_utc === 'string' ? meta.time_utc : new Date().toISOString();

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

  // /status — returns the server-side merged vessel map to the map frontend.
  // Each MMSI appears exactly once with its fully merged state.
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        connected:     aisConnected,
        totalReceived,
        messages:      Array.from(vesselMap.values()),
      })
    );
    return;
  }

  // /debug — raw connection health and first few frames verbatim
  if (req.url === '/debug') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        aisConnected,
        totalReceived,
        rawMessageCount,
        vesselCount:      vesselMap.size,
        firstRawMessages: rawMessageLog,
      }, null, 2)
    );
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

function connectToAISStream(): void {
  console.log('Connecting to AISStream...');
  const ws = new WebSocket(AISSTREAM_URL);

  ws.on('open', () => {
    console.log('Connected to AISStream. Sending subscription...');
    aisConnected = true;

    ws.send(
      JSON.stringify({
        APIKey: API_KEY,
        BoundingBoxes: BOUNDING_BOXES,
        FilterMessageTypes: FILTER_MESSAGE_TYPES,
      })
    );

    broadcast({ type: 'status', connected: true, totalReceived });
  });

  ws.on('message', (data) => {
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

    // 3. Persist merged state to Neon (fire-and-forget, non-blocking)
    upsertVessel(toVesselRow(vesselMap.get(update.mmsi)!)).catch(() => {/* already logged in db.ts */});

    broadcast({ type: 'update', update, totalReceived });
  });

  ws.on('close', (code, reason) => {
    console.log(`AISStream disconnected (${code} ${reason}). Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    aisConnected = false;
    broadcast({ type: 'status', connected: false, totalReceived });
    setTimeout(connectToAISStream, RECONNECT_DELAY_MS);
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

  // 4. Start HTTP server
  httpServer.listen(PORT, () => {
    console.log(`AIS Viewer running at http://localhost:${PORT}`);
    console.log(`WebSocket endpoint for browser: ws://localhost:${PORT}`);
  });

  // 5. Connect to AISStream
  connectToAISStream();
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
