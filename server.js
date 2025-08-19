// server.js (CommonJS, Render-ready)
const fs = require('fs');
const path = require('path');
const express = require('express');
const { google } = require('googleapis');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TZ || 'America/Costa_Rica';

// ===== Helpers para credenciales/tokens por ENV o archivo =====
const CREDENTIALS_JSON = process.env.CREDENTIALS_JSON || null; // contenido JSON literal
const TOKENS_JSON = process.env.TOKENS_JSON || null;           // contenido JSON literal
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'tokens.json');

function readJsonFallback(envValue, filePath) {
  if (envValue) return JSON.parse(envValue);
  if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return null;
}

function getOAuth2Client() {
  const creds = readJsonFallback(CREDENTIALS_JSON, CREDENTIALS_PATH) || {};
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web || {};
  const redirectUri = (redirect_uris && redirect_uris[0]) || process.env.OAUTH_REDIRECT_URI || 'http://localhost:3000/oauth2callback';
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  const tokens = readJsonFallback(TOKENS_JSON, TOKEN_PATH);
  if (tokens) oAuth2Client.setCredentials(tokens);
  return oAuth2Client;
}

async function ensureAuthed(oAuth2Client) {
  if (!oAuth2Client.credentials || !oAuth2Client.credentials.refresh_token) {
    throw new Error('Faltan tokens. Ejecuta /auth y /oauth2callback una vez para guardarlos.');
  }
}

function calendarClient(auth) {
  return google.calendar({ version: 'v3', auth });
}

// ===== Express =====
const app = express();
app.use(express.json());

// Health / raíz (útil para Render y pruebas)
app.get('/', (_, res) => res.send('ok'));
app.get('/health', (_, res) => res.send('ok'));

// Paso 1: Consent (si necesitas generar tokens en prod)
app.get('/auth', (req, res) => {
  const auth = getOAuth2Client();
  const url = auth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar']
  });
  res.send(`<a href="${url}">Authorize Google Calendar</a>`);
});

// OAuth2 callback
app.get('/oauth2callback', async (req, res) => {
  try {
    const auth = getOAuth2Client();
    const { code } = req.query;
    const { tokens } = await auth.getToken(code);

    // Guarda tokens en archivo en tiempo de ejecución y sugiere copiarlos a env
    try {
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    } catch (err) {
      console.error('No se pudo escribir tokens.json (filesystem inmutable). Copia el JSON mostrado a TOKENS_JSON.');
    }
    res.send('✅ Tokens guardados (si el filesystem lo permite). Copia tokens.json a la variable de entorno TOKENS_JSON en Render.');
  } catch (e) {
    console.error(e);
    res.status(500).send('Auth error');
  }
});

// Listar calendarios (para obtener IDs)
app.get('/calendars/list', async (req, res) => {
  try {
    const auth = getOAuth2Client(); await ensureAuthed(auth);
    const cal = calendarClient(auth);
    const r = await cal.calendarList.list();
    const items = (r.data.items || []).map(c => ({
      summary: c.summary, id: c.id, primary: !!c.primary, timeZone: c.timeZone
    }));
    res.json(items);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'list_failed' });
  }
});

// Crear calendario secundario
app.post('/calendars/create', async (req, res) => {
  try {
    const { summary, timeZone = TIMEZONE } = req.body;
    const auth = getOAuth2Client(); await ensureAuthed(auth);
    const cal = calendarClient(auth);
    const r = await cal.calendars.insert({ requestBody: { summary, timeZone } });
    res.json({ ok: true, id: r.data.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'create_calendar_failed' });
  }
});

// Chequear disponibilidad y sugerir horarios
app.post('/availability', async (req, res) => {
  try {
    const {
      calendarId,              // ID del calendario del barbero
      date,                    // 'YYYY-MM-DD'
      time,                    // 'HH:mm'
      durationMin = 45,
      tz = TIMEZONE,
      horarioInicio = '09:00',
      horarioFin = '19:00',
      stepMin = 15,
      maxSugs = 3
    } = req.body;

    if (!calendarId || !date || !time) return res.status(400).json({ error: 'missing_fields' });

    const auth = getOAuth2Client(); await ensureAuthed(auth);
    const cal = calendarClient(auth);

    const start = dayjs.tz(`${date} ${time}`, tz);
    const end   = start.add(durationMin, 'minute');

    const fb = await cal.freebusy.query({
      requestBody: {
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        timeZone: tz,
        items: [{ id: calendarId }]
      }
    });

    const busy = fb.data.calendars[calendarId]?.busy || [];
    if (busy.length === 0) {
      return res.json({ disponible: true, sugerencias: [] });
    }

    const workStart = dayjs.tz(`${date} ${horarioInicio}`, tz);
    const workEnd   = dayjs.tz(`${date} ${horarioFin}`, tz);
    const sug = [];
    let cursor = start;

    while (sug.length < maxSugs) {
      cursor = cursor.add(stepMin, 'minute');
      const s = cursor;
      const e = s.add(durationMin, 'minute');
      if (s.isBefore(workStart) || e.isAfter(workEnd)) break;

      const fb2 = await cal.freebusy.query({
        requestBody: {
          timeMin: s.toISOString(),
          timeMax: e.toISOString(),
          timeZone: tz,
          items: [{ id: calendarId }]
        }
      });
      const b2 = fb2.data.calendars[calendarId]?.busy || [];
      if (b2.length === 0) sug.push(s.format('HH:mm'));
      if (cursor.diff(start, 'minute') > 180) break; // máximo +3h
    }

    res.json({ disponible: false, sugerencias: sug });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'availability_failed' });
  }
});

// Crear cita (evento)
app.post('/book', async (req, res) => {
  try {
    const {
      calendarId,
      date, time, durationMin = 45,
      tz = TIMEZONE,
      nombre, tel, servicio, barbero, nota,
      code
    } = req.body;

    if (!calendarId || !date || !time) return res.status(400).json({ error: 'missing_fields' });

    const auth = getOAuth2Client(); await ensureAuthed(auth);
    const cal = calendarClient(auth);

    const start = dayjs.tz(`${date} ${time}`, tz);
    const end   = start.add(durationMin, 'minute');

    const r = await cal.events.insert({
      calendarId,
      requestBody: {
        summary: `${servicio || 'Servicio'} - ${nombre || 'Cliente'}`,
        description:
          `Cliente: ${nombre || ''}\nTel: ${tel || ''}\nServicio: ${servicio || ''}\nBarbero: ${barbero || ''}\nNota: ${nota || ''}\nCode: ${code || ''}\nEstado: Pendiente de confirmación\nCanal: WhatsApp`,
        start: { dateTime: start.toISOString(), timeZone: tz },
        end:   { dateTime: end.toISOString(),   timeZone: tz }
      }
    });

    res.json({ ok: true, eventId: r.data.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'booking_failed' });
  }
});

app.listen(PORT, () => console.log(`API listening on :${PORT}`));
