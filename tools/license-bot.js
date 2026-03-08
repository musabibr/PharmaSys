/**
 * PharmaSys — Telegram License Bot
 *
 * A Telegram bot that signs and issues .pharmalicense files.
 * Restricted to a single authorized Telegram user ID.
 *
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN  — Bot token from @BotFather
 *   TELEGRAM_ADMIN_ID   — Your Telegram user ID (from @userinfobot)
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=123:ABC TELEGRAM_ADMIN_ID=987654 node tools/license-bot.js
 *   — or —
 *   npm run license-bot   (set env vars first)
 *
 * Commands:
 *   /start or /help              — Show usage instructions
 *   /license "Name" MachineID    — Generate perpetual license (1 device)
 *   /license "Name" MachineID 2027-06-01           — With expiry date
 *   /license "Name" MachineID perpetual 3 2         — Device 2 of 3, perpetual
 *   /license "Name" MachineID 2027-06-01 3 2        — Device 2 of 3, with expiry
 */

const TelegramBot = require('node-telegram-bot-api');
const crypto      = require('crypto');
const fs          = require('fs');
const path        = require('path');
const os          = require('os');

// ── Config ──────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID  = Number(process.env.TELEGRAM_ADMIN_ID);

if (!BOT_TOKEN) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN env var is not set.');
  console.error('Get one from @BotFather on Telegram.');
  process.exit(1);
}

if (!ADMIN_ID || isNaN(ADMIN_ID)) {
  console.error('ERROR: TELEGRAM_ADMIN_ID env var is not set or invalid.');
  console.error('Send /start to @userinfobot on Telegram to get your user ID.');
  process.exit(1);
}

// ── Private Key ─────────────────────────────────────────────────────────────

const PRIV_KEY_PATH = path.join(__dirname, 'PRIVATE_KEY.pem');

if (!fs.existsSync(PRIV_KEY_PATH)) {
  console.error('ERROR: tools/PRIVATE_KEY.pem not found.');
  console.error('Run: node tools/generate-keypair.js');
  process.exit(1);
}

const PRIVATE_KEY = fs.readFileSync(PRIV_KEY_PATH, 'utf-8');

// ── Machine ID Regex ────────────────────────────────────────────────────────

const MACHINE_ID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}$/;

// ── License Signing (same as tools/generate-license.js) ─────────────────────

function signLicense(payload) {
  const sign = crypto.createSign('SHA256');
  sign.update(JSON.stringify(payload));
  return sign.sign(PRIVATE_KEY, 'base64');
}

function generateLicense(clientName, machineId, expiresAt, maxDevices, deviceIndex) {
  const payload = {
    clientName,
    machineId,
    issuedAt:    new Date().toISOString().slice(0, 10),
    expiresAt:   expiresAt,
    maxDevices:  maxDevices,
    deviceIndex: deviceIndex,
  };

  const signature = signLicense(payload);
  return JSON.stringify({ payload, signature }, null, 2);
}

// ── Argument Parsing ────────────────────────────────────────────────────────

/**
 * Parse the text after /license into structured args.
 * Supports: /license "Client Name" MACHINE-ID [expiry|perpetual] [maxDevices] [deviceIndex]
 * Also supports: /license ClientName MACHINE-ID ...  (no quotes, single word)
 */
function parseArgs(text) {
  const args = [];
  let i = 0;

  while (i < text.length) {
    // Skip whitespace
    while (i < text.length && text[i] === ' ') i++;
    if (i >= text.length) break;

    if (text[i] === '"') {
      // Quoted string
      i++; // skip opening quote
      let val = '';
      while (i < text.length && text[i] !== '"') {
        val += text[i];
        i++;
      }
      i++; // skip closing quote
      args.push(val);
    } else {
      // Unquoted word
      let val = '';
      while (i < text.length && text[i] !== ' ') {
        val += text[i];
        i++;
      }
      args.push(val);
    }
  }

  return args;
}

// ── Help Text ───────────────────────────────────────────────────────────────

const HELP_TEXT = `🔑 *PharmaSys License Bot*

*Usage:*
\`/license "Client Name" MachineID [Expiry] [MaxDevices] [DeviceIndex]\`

*Examples:*
\`/license "Pharmacy ABC" A3F2B7C1-D4E5F6A7-B8C9D0E1-F2A3B4C5\`
→ Perpetual, 1 device

\`/license "Pharmacy ABC" A3F2B7C1-D4E5F6A7-B8C9D0E1-F2A3B4C5 2027-06-01\`
→ Expires June 2027

\`/license "Pharmacy ABC" A3F2B7C1-D4E5F6A7-B8C9D0E1-F2A3B4C5 perpetual 3 2\`
→ Device 2 of 3, perpetual

*Parameters:*
• \`Client Name\` — Use quotes if it has spaces
• \`MachineID\` — From the app's activation screen (XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX)
• \`Expiry\` — Date (YYYY-MM-DD) or \`perpetual\` (default: perpetual)
• \`MaxDevices\` — Total devices for this client (default: 1)
• \`DeviceIndex\` — Which device number (default: 1)`;

// ── Bot Setup ───────────────────────────────────────────────────────────────

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log('');
console.log('🤖 PharmaSys License Bot is running!');
console.log(`   Authorized user ID: ${ADMIN_ID}`);
console.log('   Send /help to the bot for usage instructions.');
console.log('   Press Ctrl+C to stop.');
console.log('');

// ── Authorization Guard ─────────────────────────────────────────────────────

function isAuthorized(msg) {
  return msg.from && msg.from.id === ADMIN_ID;
}

// ── /start and /help ────────────────────────────────────────────────────────

bot.onText(/^\/(start|help)$/, (msg) => {
  if (!isAuthorized(msg)) {
    bot.sendMessage(msg.chat.id, '⛔ Unauthorized. This bot is restricted.');
    return;
  }
  bot.sendMessage(msg.chat.id, HELP_TEXT, { parse_mode: 'Markdown' });
});

// ── /license command ────────────────────────────────────────────────────────

bot.onText(/^\/license\s+(.+)/, (msg, match) => {
  if (!isAuthorized(msg)) {
    bot.sendMessage(msg.chat.id, '⛔ Unauthorized. This bot is restricted.');
    return;
  }

  const chatId  = msg.chat.id;
  const rawArgs = match[1];
  const args    = parseArgs(rawArgs);

  // Validate minimum args: clientName + machineId
  if (args.length < 2) {
    bot.sendMessage(chatId,
      '❌ Missing arguments.\n\n' +
      'Usage: `/license "Client Name" MachineID [Expiry] [MaxDevices] [DeviceIndex]`',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const clientName  = args[0];
  const machineId   = args[1].toUpperCase();
  const expiryArg   = args[2] || 'perpetual';
  const maxDevices  = parseInt(args[3] || '1', 10);
  const deviceIndex = parseInt(args[4] || '1', 10);

  // Validate machine ID format
  if (!MACHINE_ID_RE.test(machineId)) {
    bot.sendMessage(chatId,
      '❌ Invalid Machine ID format.\n\n' +
      'Expected: `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` (32 hex chars, 4 groups)\n' +
      `Got: \`${machineId}\``,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Parse expiry
  let expiresAt = null;
  if (expiryArg !== 'perpetual') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryArg)) {
      bot.sendMessage(chatId,
        '❌ Invalid expiry date format.\n\n' +
        'Use `YYYY-MM-DD` or `perpetual`.\n' +
        `Got: \`${expiryArg}\``,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    expiresAt = expiryArg;
  }

  // Validate numbers
  if (isNaN(maxDevices) || maxDevices < 1) {
    bot.sendMessage(chatId, '❌ MaxDevices must be a positive number.');
    return;
  }
  if (isNaN(deviceIndex) || deviceIndex < 1 || deviceIndex > maxDevices) {
    bot.sendMessage(chatId, `❌ DeviceIndex must be between 1 and ${maxDevices}.`);
    return;
  }

  // Generate the signed license
  try {
    const licenseJson = generateLicense(clientName, machineId, expiresAt, maxDevices, deviceIndex);

    // Write to temp file
    const safeName = clientName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `PharmaSys_${safeName}-Device${deviceIndex}.pharmalicense`;
    const tmpPath  = path.join(os.tmpdir(), filename);
    fs.writeFileSync(tmpPath, licenseJson);

    // Send summary
    const expiryText = expiresAt || 'Perpetual';
    const summary = `✅ License generated!\n\n` +
      `👤 Client: *${clientName}*\n` +
      `🖥️ Machine: \`${machineId}\`\n` +
      `📅 Expires: *${expiryText}*\n` +
      `🔢 Device: ${deviceIndex} of ${maxDevices}`;

    bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' });

    // Send the file
    bot.sendDocument(chatId, tmpPath, {}, {
      filename: filename,
      contentType: 'application/json',
    }).then(() => {
      // Clean up temp file
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    });

    console.log(`[License] Generated for "${clientName}" — ${machineId} — ${expiryText}`);

  } catch (err) {
    bot.sendMessage(chatId, `❌ Error generating license: ${err.message}`);
    console.error('[License] Error:', err);
  }
});

// ── Catch-all for unauthorized messages ─────────────────────────────────────

bot.on('message', (msg) => {
  if (!isAuthorized(msg) && !msg.text?.startsWith('/')) {
    bot.sendMessage(msg.chat.id, '⛔ Unauthorized. This bot is restricted.');
  }
});

// ── Graceful shutdown ───────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\n🛑 Bot stopped.');
  bot.stopPolling();
  process.exit(0);
});
