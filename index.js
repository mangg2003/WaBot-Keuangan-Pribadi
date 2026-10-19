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
// 1. DUMMY HTTP SERVER (Wajib Railway)
// ==========================================
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot Keuangan Aktif');
}).listen(port, () => {
  console.log(`[INFO] Server running on port ${port}`);
});

// Helper Tanggal & Waktu WIB (Asia/Jakarta)
function getWIBInfo() {
  const now = new Date();
  const optionsTgl = { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', year: 'numeric' };
  const optionsWkt = { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };

  // Format baku: DD/MM/YYYY
  const tanggal = new Intl.DateTimeFormat('id-ID', optionsTgl).format(now);
  const waktu = new Intl.DateTimeFormat('id-ID', optionsWkt).format(now).replace(/\./g, ':');

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
// 3. SIMPAN KE GOOGLE SHEETS
// ==========================================
async function saveToSheet(tipe, nominal, kategori, keterangan) {
  if (!SHEET_URL) throw new Error("Variabel SHEET_WEBAPP_URL kosong!");

  const { tanggal, waktu } = getWIBInfo();
  try {
    const res = await axios.post(
      SHEET_URL.trim(),
      {
        action: "add",
        tanggal,
        waktu,
        tipe,
        kategori,
        nominal: Number(nominal),
        keterangan
      },
      {
        maxRedirects: 5,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    return res.data;
  } catch (err) {
    console.error("Gagal simpan ke Google Sheets:", err.message);
    throw err;
  }
}

// ==========================================
// 4. HITUNG STATISTIK DARI SPREADSHEET
// ==========================================
async function calculateRealtimeStats() {
  if (!SHEET_URL) throw new Error("Variabel SHEET_WEBAPP_URL kosong!");

  try {
    const res = await axios.post(
      SHEET_URL.trim(),
      { action: "report" },
      {
        maxRedirects: 5,
        headers: { 'Content-Type': 'application/json' }
      }
    );

    let rows = res.data;
    if (typeof rows === 'string') {
      try { rows = JSON.parse(rows); } catch (e) {}
    }
    if (rows && typeof rows === 'object' && rows.data) {
      rows = rows.data;
    }

    let totalMasuk = 0;
    let totalKeluar = 0;
    let masukHariIni = 0;
    let keluarHariIni = 0;
    let totalTransaksi = 0;

    if (Array.isArray(rows) && rows.length > 1) {
      const items = rows.slice(1);
      const { tanggal: todayStr } = getWIBInfo();
      const partsToday = todayStr.split('/');
      const dayToday = partsToday[0];
      const monthToday = partsToday[1];
      const yearToday = partsToday[2];

      for (const r of items) {
        if (!r || !Array.isArray(r) || r.length === 0) continue;

        const rawDate = r[0];
        const rawTipe = String(r[2] || '').toLowerCase().trim();
        const fullRowText = r.map(c => String(c || '').toLowerCase()).join(' ');

        // Ekstraksi nominal angka murni
        let nominal = 0;
        const cleanE = String(r[4] || '').replace(/[^0-9]/g, '');
        if (cleanE && parseInt(cleanE, 10) > 0) {
          nominal = parseInt(cleanE, 10);
        } else {
          for (let i = 1; i < r.length; i++) {
            const rawVal = String(r[i] || '').trim();
            if (rawVal.includes(':') || rawVal.includes('/')) continue;
            const parsed = parseInt(rawVal.replace(/[^0-9]/g, ''), 10);
            if (!isNaN(parsed) && parsed > 0 && rawVal.length < 12) {
              nominal = parsed;
              break;
            }
          }
        }

        if (nominal <= 0) continue;
        totalTransaksi += 1;

        // Pengecekan Tanggal Hari Ini yang Kuat
        let isToday = false;
        if (rawDate) {
          const strDate = String(rawDate).trim();
          if (strDate.includes(todayStr) || (strDate.includes(dayToday) && strDate.includes(yearToday))) {
            isToday = true;
          } else {
            const d = new Date(rawDate);
            if (!isNaN(d.getTime())) {
              const dStr = new Intl.DateTimeFormat('id-ID', {
                timeZone: 'Asia/Jakarta',
                day: '2-digit',
                month: '2-digit',
                year: 'numeric'
              }).format(d);
              if (dStr === todayStr) isToday = true;
            }
          }
        }

        // Deteksi Tipe (Pemasukan / Pengeluaran)
        if (rawTipe.includes('keluar') || fullRowText.includes('pengeluaran')) {
          totalKeluar += nominal;
          if (isToday) keluarHariIni += nominal;
        } else if (rawTipe.includes('masuk') || fullRowText.includes('pemasukan')) {
          totalMasuk += nominal;
          if (isToday) masukHariIni += nominal;
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
  } catch (err) {
    console.error("Gagal baca sheet:", err.message);
    throw err;
  }
}

// ==========================================
// 5. PARSER TRANSAKSI (+ / -)
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
// 6. BOT BAILEYS
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
        console.error("Pairing code error:", err);
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
      console.log('✅ Bot WhatsApp Aktif!');
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
      // 1. Struk Belanja
      if (isImage) {
        await sock.sendMessage(targetChat, { text: '⏳ Sedang membaca struk belanja...' });
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        const result = await parseReceipt(buffer);

        const before = await calculateRealtimeStats();
        await saveToSheet("Pengeluaran", result.nominal, result.kategori, result.keterangan);

        const saldoAkhir = before.saldoTotal - result.nominal;
        const keluarAkhir = before.keluarHariIni + result.nominal;

        const reply =
          `🧾 *Struk Berhasil Dicatat!*\n` +
          `━━━━━━━━━━━━━━━━━\n` +
          `🏷️ Keterangan: ${result.keterangan}\n` +
          `📂 Kategori: ${result.kategori}\n` +
          `💸 Pengeluaran: ${formatRupiah(result.nominal)}\n` +
          `━━━━━━━━━━━━━━━━━\n` +
          `💵 *Saldo Saat Ini:* ${formatRupiah(saldoAkhir)}\n` +
          `🔴 Keluar Hari Ini: ${formatRupiah(keluarAkhir)}\n` +
          `🟢 Masuk Hari Ini: ${formatRupiah(before.masukHariIni)}`;

        await sock.sendMessage(targetChat, { text: reply });
        return;
      }

      const lower = bodyText.trim().toLowerCase();

      // 2. Menu
      if (lower === 'menu' || lower === 'help' || lower === 'halo') {
        const menuText =
          `🤖 *Panduan Bot Keuangan*\n\n` +
          `1. *Catat Transaksi:*\n` +
          `   • \`-20000 Makan\`\n` +
          `   • \`+500000 Gaji\`\n\n` +
          `2. *Banyak Sekaligus:*\n` +
          `   \`-15000 Kopi\`\n` +
          `   \`-30000 Bensin\`\n\n` +
          `3. *Cek Saldo:* Kirim kata \`saldo\``;
        await sock.sendMessage(targetChat, { text: menuText });
        return;
      }

      // 3. Cek Saldo
      if (lower === 'saldo' || lower === 'cek saldo' || lower === 'rekap') {
        const stats = await calculateRealtimeStats();
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

      // 4. Catat Transaksi Manual
      const transactions = parseTransactionLines(bodyText);

      if (transactions.length > 0) {
        // Ambil kalkulasi data sebelum transaksi baru ditambahkan
        const before = await calculateRealtimeStats();

        // Simpan baris transaksi ke Google Sheets
        for (const t of transactions) {
          await saveToSheet(t.tipe, t.nominal, t.kategori, t.keterangan);
        }

        // Kalkulasi mutlak (atomic local calculation)
        let deltaMasuk = 0;
        let deltaKeluar = 0;
        transactions.forEach((t) => {
          if (t.tipe === 'Pemasukan') deltaMasuk += t.nominal;
          if (t.tipe === 'Pengeluaran') deltaKeluar += t.nominal;
        });

        const saldoFinal = before.saldoTotal + deltaMasuk - deltaKeluar;
        const masukFinal = before.masukHariIni + deltaMasuk;
        const keluarFinal = before.keluarHariIni + deltaKeluar;
        const totalMasukFinal = before.totalMasuk + deltaMasuk;
        const totalKeluarFinal = before.totalKeluar + deltaKeluar;
        const totalTrxFinal = before.totalTransaksi + transactions.length;

        if (transactions.length > 1) {
          let detailBaris = transactions
            .map((t) => `• ${t.keterangan}: ${formatRupiah(t.nominal)} (${t.tipe})`)
            .join('\n');

          const replyMulti =
            `✅ *${transactions.length} Transaksi Berhasil Dicatat!*\n` +
            `━━━━━━━━━━━━━━━━━\n` +
            `${detailBaris}\n` +
            `━━━━━━━━━━━━━━━━━\n` +
            `💵 *Saldo Total:* ${formatRupiah(saldoFinal)}\n` +
            `🟢 Masuk Hari Ini: ${formatRupiah(masukFinal)}\n` +
            `🔴 Keluar Hari Ini: ${formatRupiah(keluarFinal)}`;

          await sock.sendMessage(targetChat, { text: replyMulti });
          return;
        }

        const single = transactions[0];

        if (single.tipe === 'Pemasukan') {
          const replyPemasukan =
            `💰 *Pemasukan Berhasil Dicatat!*\n` +
            `━━━━━━━━━━━━━━━━━\n` +
            `💵 *Saldo Total:* ${formatRupiah(saldoFinal)}\n\n` +
            `*Detail:*\n` +
            `• Saldo Awal: ${formatRupiah(before.saldoTotal)}\n` +
            `• Pemasukan Baru: ${formatRupiah(single.nominal)} (${single.keterangan})\n` +
            `• Total Pemasukan: ${formatRupiah(totalMasukFinal)}\n` +
            `• Total Pengeluaran: ${formatRupiah(totalKeluarFinal)}\n` +
            `• Masuk Hari Ini: ${formatRupiah(masukFinal)}\n` +
            `• Total Transaksi Database: ${totalTrxFinal}`;

          await sock.sendMessage(targetChat, { text: replyPemasukan });
          return;
        }

        if (single.tipe === 'Pengeluaran') {
          const replyPengeluaran =
            `💸 *Pengeluaran Berhasil Dicatat!*\n` +
            `━━━━━━━━━━━━━━━━━\n` +
            `🍽️ ${single.keterangan}: ${formatRupiah(single.nominal)}\n` +
            `━━━━━━━━━━━━━━━━━\n` +
            `💵 *Saldo Saat Ini:* ${formatRupiah(saldoFinal)}\n` +
            `🔴 Keluar Hari Ini: ${formatRupiah(keluarFinal)}\n` +
            `🟢 Masuk Hari Ini: ${formatRupiah(masukFinal)}`;

          await sock.sendMessage(targetChat, { text: replyPengeluaran });
          return;
        }
      }
    } catch (err) {
      console.error("Error processing message:", err.message);
      await sock.sendMessage(targetChat, { text: `⚠️ Gagal memproses: ${err.message}` });
    }
  });
}

startBot();