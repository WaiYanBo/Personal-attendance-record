const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { google } = require('googleapis');
require('dotenv').config();
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const app = express();

// Tell Express it is behind a reverse proxy (Render/Railway)
app.set('trust proxy', 1);
// Basic security headers
app.use(helmet());
// Basic security headers
app.use(helmet());

// Limit each IP to 20 login requests per 15 minutes
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 20, 
  message: { message: 'Too many login attempts. Try again later.' }
});

app.use('/api/login', loginLimiter);
const PORT = process.env.PORT || 3000;
const AUTH_SECRET = process.env.AUTH_SECRET || 'attendance-web-secret';
const TIME_ZONE = process.env.TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const LOGIN_USERNAME = process.env.LOGIN_USERNAME || 'admin';
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || '1234';
const ATTENDANCE_SHEET = 'Attendance';
const LOG_SHEET = 'Activity Log';
const ATTENDANCE_HEADERS = ['Date', 'Check In', 'Check Out', 'Hours Worked', 'Check In ISO', 'Check Out ISO', 'Updated At'];
const LOG_HEADERS = ['Recorded At', 'Date', 'Action', 'Time', 'Hours Worked', 'Note'];
const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const SPREADSHEET_ID = getSpreadsheetId();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let spreadsheetSetupPromise = null;

function getSpreadsheetId() {
  const directId = process.env.GOOGLE_SHEETS_ID?.trim();
  if (directId) {
    return directId;
  }

  const sheetUrl = process.env.GOOGLE_SHEETS_URL?.trim();
  if (!sheetUrl) {
    return '';
  }

  const match = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : '';
}

function getServiceAccountCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    credentials.private_key = credentials.private_key?.replace(/\\n/g, '\n');
    return credentials;
  }

  if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    return {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
  }

  throw new Error('Google Sheets credentials are missing. Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY.');
}

function getSheetsClient() {
  const credentials = getServiceAccountCredentials();
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: GOOGLE_SCOPES,
  });

  return google.sheets({ version: 'v4', auth });
}

function columnName(index) {
  let result = '';
  let current = index;

  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }

  return result;
}

function getNowParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    parts[part.type] = part.value;
  }

  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    dateLabel: `${parts.day}/${parts.month}/${parts.year}`,
    timeLabel: `${parts.hour}:${parts.minute}:${parts.second}`,
    timestampLabel: `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function calculateHoursWorked(checkInIso, checkOutIso) {
  const checkIn = new Date(checkInIso);
  const checkOut = new Date(checkOutIso);
  const hours = Math.max(0, (checkOut.getTime() - checkIn.getTime()) / 36e5);
  return hours.toFixed(2);
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') {
    return null;
  }

  const [body, signature] = token.split('.');
  if (!body || !signature) {
    return null;
  }

  const expectedSignature = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  if (signature.length !== expectedSignature.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

function requireAuth(req, res, next) {
  const payload = verifyToken(getBearerToken(req));
  if (!payload) {
    return res.status(401).json({ message: 'Session expired. Please sign in again.' });
  }

  req.user = { username: payload.username };
  next();
}

function formatAttendanceRecord(row) {
  if (!row) {
    const now = getNowParts();
    return {
      date: now.dateKey,
      dateLabel: now.dateLabel,
      checkIn: '--',
      checkOut: '--',
      hoursWorked: '--',
      status: 'ready',
      checkInIso: '',
      checkOutIso: '',
      updatedAt: '',
    };
  }

  const status = row.checkOutIso ? 'completed' : row.checkInIso ? 'checked_in' : 'ready';

  return {
    date: row.date,
    dateLabel: row.date.split('-').reverse().join('/'),
    checkIn: row.checkIn || '--',
    checkOut: row.checkOut || '--',
    hoursWorked: row.hoursWorked || '--',
    status,
    checkInIso: row.checkInIso || '',
    checkOutIso: row.checkOutIso || '',
    updatedAt: row.updatedAt || '',
  };
}

async function ensureHeaderRow(sheets, sheetName, headers) {
  const range = `${sheetName}!A1:${columnName(headers.length)}1`;
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const firstRow = response.data.values?.[0] || [];
  const hasHeaders = headers.every((value, index) => firstRow[index] === value);

  if (!hasHeaders) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  }
}

async function initializeSpreadsheet() {
  if (!SPREADSHEET_ID) {
    throw new Error('Google Sheets target is missing. Set GOOGLE_SHEETS_ID or GOOGLE_SHEETS_URL.');
  }

  const sheets = getSheetsClient();
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets(properties(title))',
  });

  const sheetTitles = new Set((metadata.data.sheets || []).map((sheet) => sheet.properties?.title).filter(Boolean));
  const requests = [];

  if (!sheetTitles.has(ATTENDANCE_SHEET)) {
    requests.push({ addSheet: { properties: { title: ATTENDANCE_SHEET } } });
  }

  if (!sheetTitles.has(LOG_SHEET)) {
    requests.push({ addSheet: { properties: { title: LOG_SHEET } } });
  }

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests },
    });
  }

  await ensureHeaderRow(sheets, ATTENDANCE_SHEET, ATTENDANCE_HEADERS);
  await ensureHeaderRow(sheets, LOG_SHEET, LOG_HEADERS);
}

async function ensureSpreadsheetReady() {
  if (!spreadsheetSetupPromise) {
    spreadsheetSetupPromise = initializeSpreadsheet();
  }

  return spreadsheetSetupPromise;
}

async function getTodayRecord() {
  await ensureSpreadsheetReady();

  const sheets = getSheetsClient();
  const today = getNowParts();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${ATTENDANCE_SHEET}!A2:G`,
  });

  const rows = response.data.values || [];
  const rowIndex = rows.findIndex((row) => row[0] === today.dateKey);

  if (rowIndex === -1) {
    return { today, record: null };
  }

  const row = rows[rowIndex];
  return {
    today,
    record: {
      rowNumber: rowIndex + 2,
      date: row[0] || '',
      checkIn: row[1] || '',
      checkOut: row[2] || '',
      hoursWorked: row[3] || '',
      checkInIso: row[4] || '',
      checkOutIso: row[5] || '',
      updatedAt: row[6] || '',
    },
  };
}

async function appendLogEntry(action, today, timeLabel, hoursWorked, note) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${LOG_SHEET}!A:F`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[today.timestampLabel, today.dateKey, action, timeLabel, hoursWorked || '', note || '']],
    },
  });
}

function buildResponse(record) {
  return {
    attendance: formatAttendanceRecord(record),
  };
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};

  if (username !== LOGIN_USERNAME || password !== LOGIN_PASSWORD) {
    return res.status(401).json({ message: 'Invalid username or password.' });
  }

  const token = signToken({ username, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 });
  return res.json({ token, user: { username } });
});

app.get('/api/session', requireAuth, async (req, res) => {
  try {
    const state = await getTodayRecord();
    res.json({
      user: req.user,
      ready: true,
      ...buildResponse(state.record),
    });
  } catch (error) {
    res.json({
      user: req.user,
      ready: false,
      configurationError: error.message,
      attendance: formatAttendanceRecord(null),
    });
  }
});

app.get('/api/state', requireAuth, async (req, res) => {
  try {
    const state = await getTodayRecord();
    res.json({ ready: true, ...buildResponse(state.record) });
  } catch (error) {
    res.status(503).json({ ready: false, message: error.message, attendance: formatAttendanceRecord(null) });
  }
});

app.post('/api/checkin', requireAuth, async (req, res) => {
  try {
    const { today, record } = await getTodayRecord();

    if (record?.checkInIso && !record.checkOutIso) {
      return res.status(409).json({ message: 'You are already checked in for today.', ...buildResponse(record) });
    }

    if (record?.checkOutIso) {
      return res.status(409).json({ message: 'Today is already completed. Start a new day tomorrow.', ...buildResponse(record) });
    }

    const now = new Date();
    const timeLabel = getNowParts(now).timeLabel;
    const rowValues = [today.dateKey, timeLabel, '', '', now.toISOString(), '', today.timestampLabel];
    const sheets = getSheetsClient();

    if (record) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${ATTENDANCE_SHEET}!A${record.rowNumber}:G${record.rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values: [rowValues] },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${ATTENDANCE_SHEET}!A:G`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [rowValues] },
      });
    }

    await appendLogEntry('CHECK_IN', today, timeLabel, '', 'Check-in recorded from the browser');

    const updated = {
      date: today.dateKey,
      checkIn: timeLabel,
      checkOut: '',
      hoursWorked: '',
      checkInIso: now.toISOString(),
      checkOutIso: '',
      updatedAt: today.timestampLabel,
    };

    res.json({ message: 'Check-in saved.', ...buildResponse(updated) });
  } catch (error) {
    res.status(503).json({ message: error.message, attendance: formatAttendanceRecord(null) });
  }
});

app.post('/api/checkout', requireAuth, async (req, res) => {
  try {
    const { today, record } = await getTodayRecord();

    if (!record || !record.checkInIso) {
      return res.status(400).json({ message: 'You must check in before checking out.', ...buildResponse(record) });
    }

    if (record.checkOutIso) {
      return res.status(409).json({ message: 'You have already checked out for today.', ...buildResponse(record) });
    }

    const now = new Date();
    const timeLabel = getNowParts(now).timeLabel;
    const hoursWorked = calculateHoursWorked(record.checkInIso, now.toISOString());
    const updatedRecord = {
      ...record,
      checkOut: timeLabel,
      hoursWorked,
      checkOutIso: now.toISOString(),
      updatedAt: today.timestampLabel,
    };

    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${ATTENDANCE_SHEET}!A${record.rowNumber}:G${record.rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          updatedRecord.date,
          updatedRecord.checkIn,
          updatedRecord.checkOut,
          updatedRecord.hoursWorked,
          updatedRecord.checkInIso,
          updatedRecord.checkOutIso,
          updatedRecord.updatedAt,
        ]],
      },
    });

    await appendLogEntry('CHECK_OUT', today, timeLabel, hoursWorked, 'Work session closed');

    res.json({ message: `Checkout saved. You worked ${hoursWorked} hours.`, ...buildResponse(updatedRecord) });
  } catch (error) {
    res.status(503).json({ message: error.message, attendance: formatAttendanceRecord(null) });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Attendance app running on http://localhost:${PORT}`);
});
