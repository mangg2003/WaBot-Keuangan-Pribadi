import fs from 'fs';
import path from 'path';
import http from 'http';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const SHEET_URL = process.env.SHEET_WEBAPP_URL;

// ==========================================
// 1. DUMMY HTTP SERVER (Keep-Alive Railway)
// ==========================================
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot Keuangan Aktif 24 Jam');
}).listen(port, () => {
  console.log(`[INFO] Server HTTP dummy aktif pada port ${port}`);
});

// Helper Tanggal & Waktu WIB (Asia/Jakarta)
function getWIBDate() {
  const now = new Date();
  const tanggal = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(now);

  const waktu = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(now).replace(/\./g, ':');

  return { tanggal, waktu };
}

const formatRupiah = (num) => `Rp ${Number(num || 0).toLocaleString('id-ID')}`;

function clearAuthFolder(folderPath = './auth_info') {
  try {
    if (!fs.existsSync(folderPath)) return;
    const files = fs.readdirSync(folderPath);
    for (const file of files) {
      const curPath = path.join(folderPath, file);
      if (fs.lstatSync(curPath).isDirectory()) {
        fs.rmSync(curPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(curPath);
      }
    }
  } catch (err) {
    console.error('Gagal clear auth_info:', err.message);
  }
}

// ==========================================
// 2. PARSER FOTO STRUK (GEMINI AI)
// ==========================================
async function parseReceipt(buffer) {
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY belum diisi");
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  const prompt = `
  Analisis struk belanja ini. Ambil total pembayaran, kategori belanja, dan rincian singkat merchant/barang.
  Keluarkan HANYA format JSON murni tanpa markdown:
  {
    "nominal": 0,
    "kategori": "Makanan / Belanja / Transport / Tagihan / Hiburan",
    "keterangan": "Nama toko & barang utama"
  }
  `;

  const imagePart = {
    inlineData: {
      data: buffer.toString('base64'),
      mimeType: 'image/jpeg'
    }
  };

  const result = await model.generateContent([prompt, imagePart]);
  const cleanJson = result.response.text().replace(/```json|```/g, '').trim();
  return JSON.parse(cleanJson);
}

// ==========================================
// 3. KOMUNIKASI GOOGLE APPS SCRIPT
// ==========================================
async function callSheetsAPI(payload) {
  if (!SHEET_URL) throw new Error("Variabel SHEET_WEBAPP_URL kosong!");
  const res = await axios.post(SHEET_URL.trim(), payload, {
    maxRedirects: 5,
    headers: { 'Content-Type': 'application/json' }
  });
  let data = res.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (e) {}
  }
  return data;
}

// Hitung total murni dari seluruh baris data di spreadsheet
async function getAccurateStats() {
  const res = await callSheetsAPI({ action: "report" });

  let rows = res?.data || res || [];
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch (e) {}
    rows = rows?.data || rows || [];
  }

  // Jika Apps Script langsung mengembalikan objek statistik hasil kalkulasi server
  if (res && typeof res.saldoTotal === 'number' && typeof res.totalKeluar === 'number') {
    return res;
  }

  let totalMasuk = 0;
  let totalKeluar = 0;
  let masukHariIni = 0;
  let keluarHariIni = 0;
  let totalTransaksi = 0;

  if (Array.isArray(rows) && rows.length > 1) {
    const { tanggal: todayStr } = getWIBDate();
    const dayToday = todayStr.split('/')[0];

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!Array.isArray(r) || r.length === 0) continue;

      const rawNom = String(r[4] || '').replace(/[^0-9]/g, '');
      const nominal = parseInt(rawNom, 10) || 0;
      if (nominal <= 0) continue;

      totalTransaksi++;

      const tipe = String(r[2] || '').toLowerCase().trim();
      const rawDate = String(r[0] || '').trim();

      const isToday = rawDate.includes(todayStr) || (rawDate.includes(dayToday) && rawDate.includes('2026'));

      if (tipe.includes('masuk')) {
        totalMasuk += nominal;
        if (isToday) masukHariIni += nominal;
      } else if (tipe.includes('keluar')) {
        totalKeluar += nominal;
        if (isToday) keluarHariIni += nominal;
      }
    }
  }

  return {
    saldoTotal: totalMasuk - totalKeluar,
    totalMasuk,
    totalKeluar,
    masukHariIni,
    keluarHariIni,
    totalTransaksi
  };
}

// ==========================================
// 4. PARSER TRANSAKSI MANUAL (+ / -)
// ==========================================
function parseTransactionLines(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const items = [];

  for (const line of lines) {
    if (!line.startsWith('+') && !line.startsWith('-')) continue;

    const tipe = line.startsWith('+') ? 'Pemasukan' : 'Pengeluaran';
    const rawContent = line.slice(1).trim();
    const parts = rawContent.split(/\s+/);

    const nominal = parseInt(parts[0].replace(/[^0-9]/g, ''), 10);
    let keterangan = parts.slice(1).join(' ').trim();
    keterangan = keterangan.replace(/^\(+\vert{}\)+$/g, '').trim();

    if (!keterangan) {
      keterangan = tipe === 'Pemasukan' ? 'Pemasukan Umum' : 'Pengeluaran Umum';
    }

    const kategori = tipe === 'Pemasukan' ? 'Pendapatan' : 'Umum';

    if (!isNaN(nominal) && nominal > 0) {
      items.push({ tipe, nominal, kategori, keterangan });
    }
  }

  return items;
}

// ==========================================
// 5. INISIALISASI BOT BAILEYS
// ==========================================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    syncFullHistory: false
  });

  const nomorWA = "6289677640957";
  let pairingRequested = false;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !sock.authState.creds.registered && !pairingRequested) {
      pairingRequested = true;
      try {
        const code = await sock.requestPairingCode(nomorWA);
        console.log(`\n👉 KODE PAIRING: ${code}\n`);
      } catch (err) {
        console.error("Gagal meminta pairing code:", err);
        pairingRequested = false;
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
      const shouldReconnect = !isLoggedOut;

      if (isLoggedOut) {
        clearAuthFolder('./auth_info');
        startBot();
      } else if (shouldReconnect) {
        startBot();
      }
    } else if (connection === 'open') {
      console.log('✅ Bot WhatsApp Keuangan Berhasil Terhubung!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message) return;

    const targetChat = msg.key.remoteJid;
    const bodyText =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      '';

    const isImage = Boolean(msg.message.imageMessage);

    try {
      // 1. Ekstraksi Foto Struk
      if (isImage) {
        await sock.sendMessage(targetChat, { text: '⏳ Sedang membaca struk belanja Anda...' });
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        const result = await parseReceipt(buffer);

        const { tanggal, waktu } = getWIBDate();
        await callSheetsAPI({
          action: "add",
          tanggal,
          waktu,
          tipe: "Pengeluaran",
          kategori: result.kategori,
          nominal: Number(result.nominal),
          keterangan: result.keterangan
        });

        const stats = await getAccurateStats();

        const reply =
          `🧾 *Struk Berhasil Dicatat!*\n` +
          `━━━━━━━━━━━━━━━━━\n` +
          `🏷️ Keterangan: ${result.keterangan}\n` +
          `📂 Kategori: ${result.kategori}\n` +
          `💸 Pengeluaran: ${formatRupiah(result.nominal)}\n` +
          `━━━━━━━━━━━━━━━━━\n` +
          `💵 *Saldo Saat Ini:* ${formatRupiah(stats.saldoTotal)}\n` +
          `🔴 Keluar Hari Ini: ${formatRupiah(stats.keluarHariIni)}\n` +
          `🟢 Masuk Hari Ini: ${formatRupiah(stats.masukHariIni)}`;

        await sock.sendMessage(targetChat, { text: reply });
        return;
      }

      const lower = bodyText.trim().toLowerCase();

      // 2. Menu Bantuan
      if (lower === 'menu' || lower === 'help' || lower === 'halo') {
        const menuText =
          `🤖 *Panduan Bot Keuangan*\n\n` +
          `1. *Catat Transaksi:*\n` +
          `   • \`-20000 Makan lalapan\`\n` +
          `   • \`+500000 Gaji sampingan\`\n\n` +
          `2. *Catat Banyak Sekaligus:*\n` +
          `   \`-15000 Kopi\`\n` +
          `   \`-30000 Bensin\`\n\n` +
          `3. *Cek Saldo:*\n` +
          `   Kirim kata \`saldo\``;
        await sock.sendMessage(targetChat, { text: menuText });
        return;
      }

      // 3. Perintah Cek Saldo
      if (lower === 'saldo' || lower === 'cek saldo' || lower === 'rekap') {
        const stats = await getAccurateStats();
        const replySaldo =
          `💵 *Ringkasan Saldo Keuangan*\n` +
          `━━━━━━━━━━━━━━━━━\n` +
          `💰 *Saldo Saat Ini:* ${formatRupiah(stats.saldoTotal)}\n` +
          `🟢 Masuk Hari Ini: ${formatRupiah(stats.masukHariIni)}\n` +
          `🔴 Keluar Hari Ini: ${formatRupiah(stats.keluarHariIni)}\n` +
          `━━━━━━━━━━━━━━━━━\n` +
          `📈 Total Pemasukan: ${formatRupiah(stats.totalMasuk)}\n` +
          `📉 Total Pengeluaran: ${formatRupiah(stats.totalKeluar)}\n` +
          `📝 Total Riwayat: ${stats.totalTransaksi} transaksi`;

        await sock.sendMessage(targetChat, { text: replySaldo });
        return;
      }

      // 4. Parser Transaksi Manual (+ / -)
      const transactions = parseTransactionLines(bodyText);

      if (transactions.length > 0) {
        const { tanggal, waktu } = getWIBDate();

        for (const t of transactions) {
          await callSheetsAPI({
            action: "add",
            tanggal,
            waktu,
            tipe: t.tipe,
            kategori: t.kategori,
            nominal: Number(t.nominal),
            keterangan: t.keterangan
          });
        }

        const stats = await getAccurateStats();

        // Multi-baris
        if (transactions.length > 1) {
          let detailBaris = transactions
            .map((t) => `• ${t.keterangan}: ${formatRupiah(t.nominal)} (${t.tipe})`)
            .join('\n');

          const replyMulti =
            `✅ *${transactions.length} Transaksi Berhasil Dicatat!*\n` +
            `━━━━━━━━━━━━━━━━━\n` +
            `${detailBaris}\n` +
            `━━━━━━━━━━━━━━━━━\n` +
            `💵 *Saldo Total:* ${formatRupiah(stats.saldoTotal)}\n` +
            `🟢 Masuk Hari Ini: ${formatRupiah(stats.masukHariIni)}\n` +
            `🔴 Keluar Hari Ini: ${formatRupiah(stats.keluarHariIni)}`;

          await sock.sendMessage(targetChat, { text: replyMulti });
          return;
        }

        // Single Transaksi
        const single = transactions[0];

        if (single.tipe === 'Pemasukan') {
          const saldoAwal = stats.saldoTotal - single.nominal;

          const replyPemasukan =
            `💰 *Pemasukan Berhasil Dicatat!*\n` +
            `━━━━━━━━━━━━━━━━━\n` +
            `💵 *Saldo Total:* ${formatRupiah(stats.saldoTotal)}\n\n` +
            `*Detail:*\n` +
            `• Saldo Awal: ${formatRupiah(saldoAwal)}\n` +
            `• Pemasukan Baru: ${formatRupiah(single.nominal)} (${single.keterangan})\n` +
            `• Total Pemasukan: ${formatRupiah(stats.totalMasuk)}\n` +
            `• Total Pengeluaran: ${formatRupiah(stats.totalKeluar)}\n` +
            `• Masuk Hari Ini: ${formatRupiah(stats.masukHariIni)}\n` +
            `• Total Transaksi Database: ${stats.totalTransaksi}`;

          await sock.sendMessage(targetChat, { text: replyPemasukan });
          return;
        }

        if (single.tipe === 'Pengeluaran') {
          const replyPengeluaran =
            `💸 *Pengeluaran Berhasil Dicatat!*\n` +
            `━━━━━━━━━━━━━━━━━\n` +
            `🍽️ ${single.keterangan}: ${formatRupiah(single.nominal)}\n` +
            `━━━━━━━━━━━━━━━━━\n` +
            `💵 *Saldo Saat Ini:* ${formatRupiah(stats.saldoTotal)}\n` +
            `🔴 Keluar Hari Ini: ${formatRupiah(stats.keluarHariIni)}\n` +
            `🟢 Masuk Hari Ini: ${formatRupiah(stats.masukHariIni)}`;

          await sock.sendMessage(targetChat, { text: replyPengeluaran });
          return;
        }
      }
    } catch (err) {
      console.error("Error memproses pesan:", err.message);
      await sock.sendMessage(targetChat, { text: `⚠️ Gagal memproses: ${err.message}` });
    }
  });
}

startBot();