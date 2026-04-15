import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import WebSocket, { WebSocketServer } from 'ws';

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
// PositionReport (Class A) is the most common vessel type.
// Add 'StandardClassBPositionReport' for smaller craft if you want more data.
const FILTER_MESSAGE_TYPES: string[] = [
  'PositionReport',
  // 'StandardClassBPositionReport',
  // 'ShipStaticData',
];

// How many messages to keep in memory (rolling)
const MAX_MESSAGES = 300;

// Reconnect delay in ms if the AISStream socket closes
const RECONNECT_DELAY_MS = 5000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AISUpdate {
  mmsi: string;
  shipName: string;
  messageType: string;
  latitude: number | null;
  longitude: number | null;
  speed: number | null;   // knots (SOG)
  course: number | null;  // degrees (COG)
  heading: number | null; // degrees (true heading)
  navStatus: string | null;
  timestamp: string;
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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const recentMessages: AISUpdate[] = [];
let totalReceived = 0;
let aisConnected = false;
let rawMessageLog: unknown[] = [];   // stores first 5 raw messages for /debug
let rawMessageCount = 0;             // total raw frames received (including unparseable)

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

    // Latitude / longitude: prefer the typed message body, fall back to MetaData
    const rawLat: number | undefined = body?.Latitude ?? meta.latitude;
    const rawLon: number | undefined = body?.Longitude ?? meta.longitude;
    const latitude = rawLat != null && Math.abs(rawLat) <= 90 ? rawLat : null;
    const longitude = rawLon != null && Math.abs(rawLon) <= 180 ? rawLon : null;

    // SOG: 102.3 = not available per AIS spec
    const rawSog: number | undefined = body?.Sog;
    const speed = rawSog != null && rawSog < 102.3 ? rawSog : null;

    // COG: 360.0 = not available
    const rawCog: number | undefined = body?.Cog;
    const course = rawCog != null && rawCog < 360.0 ? rawCog : null;

    // True heading: 511 = not available
    const rawHdg: number | undefined = body?.TrueHeading;
    const heading = rawHdg != null && rawHdg !== 511 ? rawHdg : null;

    const navStatusCode: number | undefined = body?.NavigationalStatus;
    const navStatus =
      navStatusCode != null ? (NAV_STATUS[navStatusCode] ?? `Status ${navStatusCode}`) : null;

    const shipName: string = (meta.ShipName ?? '').trim() || '—';

    const timestamp: string =
      typeof meta.time_utc === 'string' ? meta.time_utc : new Date().toISOString();

    return { mmsi, shipName, messageType, latitude, longitude, speed, course, heading, navStatus, timestamp };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP server — serves the HTML page and a /status JSON endpoint
// ---------------------------------------------------------------------------

const httpServer = http.createServer((req, res) => {
  // Allow the map app (localhost:3000) to call this server cross-origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/' || req.url === '/index.html') {
    const filePath = path.join(__dirname, '..', 'public', 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Could not read index.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        connected: aisConnected,
        totalReceived,
        messages: recentMessages.slice(0, 50),
      })
    );
    return;
  }

  // Debug endpoint: shows raw connection health and first few frames verbatim
  if (req.url === '/debug') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        aisConnected,
        totalReceived,
        rawMessageCount,
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
  // Send a snapshot of current state to the newly connected browser tab
  const snapshot: BrowserMessage = {
    type: 'snapshot',
    connected: aisConnected,
    totalReceived,
    messages: recentMessages.slice(0, 100),
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
      // Log a few more to console only
      console.log(`[raw #${rawMessageCount}]`, JSON.stringify(raw).slice(0, 300));
    } else if (rawMessageCount === 11) {
      console.log('[raw] Suppressing further raw logs. Check /debug for samples.');
    }

    const update = parseAISMessage(raw);
    if (!update) return;

    totalReceived++;
    recentMessages.unshift(update);
    if (recentMessages.length > MAX_MESSAGES) recentMessages.length = MAX_MESSAGES;

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
    // 'close' will fire after this, triggering reconnect
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

httpServer.listen(PORT, () => {
  console.log(`AIS Viewer running at http://localhost:${PORT}`);
  console.log(`WebSocket endpoint for browser: ws://localhost:${PORT}`);
});

connectToAISStream();
