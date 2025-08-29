const { google } = require('googleapis');

async function getSheets() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!clientEmail || !privateKey) {
    throw new Error('Missing Google Sheets credentials');
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: clientEmail,
      private_key: privateKey.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

function formatHuDate(isoOrDate) {
  const d = new Date(isoOrDate);
  const parts = new Intl.DateTimeFormat('hu-HU', {
    timeZone: 'Europe/Budapest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}.${get('month')}.${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function formatDecimal(num) {
  return Number(num || 0).toFixed(2).replace('.', ',');
}

module.exports = { getSheets, formatHuDate, formatDecimal };
