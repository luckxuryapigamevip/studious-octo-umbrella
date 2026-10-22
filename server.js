'use strict';

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();

// 1. MỞ CỬA CORS CHO MỌI APP/TOOL KHÁC GỌI API
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json());

// 2. CẤU HÌNH
const PORT = process.env.PORT || 3000;
const API_MD5 = 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau';
const API_TX = 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau';

const DB_DIR = process.env.DB_DIR || __dirname;
if (!fs.existsSync(DB_DIR)) { try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch (e) {} }

// 3. HÀM HỖ TRỢ
const label = c => c === 'T' ? 'Tài' : (c === 'X' ? 'Xỉu' : null);
const flip = c => c === 'T' ? 'X' : (c === 'X' ? 'T' : null);
function safeInt(x, def = 0) { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; }

function readDB(g) {
    const p = path.join(DB_DIR, `db_${g}.json`);
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {}
    return { history: [], lastProcessedSession: null };
}

function saveDB(g, db) {
    const p = path.join(DB_DIR, `db_${g}.json`);
    try { fs.writeFileSync(p, JSON.stringify(db, null, 2)); } catch (e) {}
}

function getDice(item) {
    return [safeInt(item?.FirstDice), safeInt(item?.SecondDice), safeInt(item?.ThirdDice)];
}
function getSum(item) {
    const s = getDice(item).reduce((a, b) => a + b, 0);
    return (s >= 3 && s <= 18) ? s : safeInt(item?.DiceSum);
}
function getResult(item) {
    const s = getSum(item);
    return (s >= 3 && s <= 18) ? (s >= 11 ? 'T' : 'X') : null;
}

// 4. THUẬT TOÁN NHẬN DIỆN CẦU (CHẠY NGẦM)
function detectCau(seq) {
    if (seq.length < 4) return null;
    const n = seq.length, last = seq[n - 1];
    const s = seq.join('');

    // Bệt
    let len = 1;
    for (let i = n - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
    if (len >= 4) return len <= 6 ? { name: `BỆT-${len}`, code: last } : { name: `BỆT-GÃY-${len}`, code: flip(last) };

    // 1-1
    let alt = 0;
    for (let i = n - 1; i >= 1; i--) { if (seq[i] !== seq[i - 1]) alt++; else break; }
    if (alt >= 5) return { name: 'CẦU-1-1', code: flip(last) };

    // Pattern tĩnh
    const pats = [
        ['TXXTXX', 'T', 'CẦU-1-2-1'], ['XTTXTT', 'X', 'CẦU-1-2-1'],
        ['TTXTTX', 'T', 'CẦU-2-1-2'], ['XXTXXT', 'X', 'CẦU-2-1-2'],
        ['TTXXTT', 'X', 'CẦU-2-2'],   ['XXTTXX', 'T', 'CẦU-2-2'],
        ['TTTXXX', 'T', 'CẦU-3-3'],   ['XXXTTT', 'X', 'CẦU-3-3'],
        ['TXXXT', 'X', 'CẦU-1-3-1'],  ['XTTTX', 'T', 'CẦU-1-3-1']
    ];
    for (const [tail, code, name] of pats) if (s.endsWith(tail)) return { name, code };

    // Lặp
    for (const l of [5, 6]) if (n >= l * 2 && seq.slice(-l * 2, -l).join('') === seq.slice(-l).join('')) return { name: `LẶP-${l}`, code: seq[n - l] };

    // Tăng/Giảm tiến
    const blks = []; let ct = seq[0], cl = 1;
    for (let i = 1; i < n; i++) { if (seq[i] === ct) cl++; else { blks.push(cl); ct = seq[i]; cl = 1; } }
    blks.push(cl);
    if (blks.length >= 3) {
        const [a, b, c] = blks.slice(-3);
        if (a > b && b > c) return { name: 'GIẢM-TIẾN', code: flip(last) };
        if (a < b && b < c) return { name: 'TĂNG-TIẾN', code: flip(last) };
    }
    return null;
}

function runEngine(seq, db) {
    let res = detectCau(seq);
    if (!res) {
        // Markov bậc 3
        const key = seq.slice(-3).join('');
        let t = 0, x = 0;
        for (let i = 3; i < seq.length; i++) {
            if (seq.slice(i - 3, i).join('') === key) {
                if (seq[i] === 'T') t++; else x++;
            }
        }
        if (t + x > 2) res = { name: 'MARKOV', code: t > x ? 'T' : 'X' };
    }
    
    if (!res) return { code: null, label: 'MARKOV', tiLe: 'CHỜ' };

    // Balance Guard
    let gt = 0, gx = 0;
    for (const h of db.history.slice(-50)) {
        if (h.DU_DOAN_CODE === 'T') gt++;
        else if (h.DU_DOAN_CODE === 'X') gx++;
    }
    if (gt + gx >= 20) {
        const pX = gx / (gt + gx);
        if (pX >= 0.62 && res.code !== 'T') res = { name: 'GUARD-T', code: 'T' };
        if (pX <= 0.38 && res.code !== 'X') res = { name: 'GUARD-X', code: 'X' };
    }

    const conf = res.name === 'MARKOV' ? 0.69 : 0.92;
    return { code: res.code, label: res.name, tiLe: (conf * 100).toFixed(1) + '%' };
}

// 5. GỌI API GỐC
async function fetchApi(url) {
    for (let i = 0; i < 3; i++) {
        try {
            const res = await axios.get(url, { timeout: 8000 });
            let arr = res.data?.data?.list || res.data?.list || res.data?.data || (Array.isArray(res.data) ? res.data : []);
            if (arr.length >= 2 && Number(arr[0].SessionId) > Number(arr[arr.length - 1].SessionId)) arr.reverse();
            return arr;
        } catch (e) {
            if (i === 2) return [];
            await new Promise(r => setTimeout(r, 500));
        }
    }
}

// 6. CHẠY NGẦM 5 GIÂY 1 LẦN
async function processGame(game) {
    const url = game === 'md5' ? API_MD5 : API_TX;
    const list = await fetchApi(url);
    if (!list || !list.length) return;

    const latest = list[list.length - 1];
    const session = safeInt(latest.SessionId);
    const db = readDB(game);

    if (db.lastProcessedSession === session) return;

    const seq = list.map(getResult).filter(Boolean);
    if (seq.length < 6) return;

    // Chấm điểm phiên trước
    const prev = db.history[db.history.length - 1];
    if (prev && safeInt(prev.phienDuDoan) === session) {
        const actual = getResult(latest);
        prev.ketQua = actual;
        prev.ketQuaLabel = label(actual);
        prev.trangThai = !prev.DU_DOAN_CODE ? 'BỎ QUA' : (prev.DU_DOAN_CODE === actual ? 'ĐÚNG' : 'SAI');
    }

    const pred = runEngine(seq, db);

    db.history.push({
        phien: session,
        xucXac: getDice(latest),
        tong: getSum(latest),
        ketQua: getResult(latest),
        ketQuaLabel: label(getResult(latest)),
        phienDuDoan: session + 1,
        DU_DOAN_CODE: pred.code,
        DU_DOAN: pred.code ? label(pred.code) : 'CHỜ',
        TI_LE: pred.tiLe,
        patternName: pred.label,
        trangThai: 'ĐANG CHỜ'
    });

    if (db.history.length > 500) db.history.shift();
    db.lastProcessedSession = session;
    saveDB(game, db);
}

setInterval(() => { processGame('md5'); processGame('taixiu'); }, 5000);

// ========================================================================
// 7. CÁC ROUTE API (ĐÃ FIX LỖI CANNOT GET)
// ========================================================================

// Trang chủ: Mày mở link gốc Render, nếu thấy chữ này là code đã chạy đúng
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family:sans-serif; padding:20px;">
            <h2 style="color:green;">🚀 BACKEND HOẠT ĐỘNG TỐT</h2>
            <p>Mày dùng các link API dưới đây để cắm vào Tool/Extension:</p>
            <ul>
                <li><a href="/api/predict/md5">/api/predict/md5</a></li>
                <li><a href="/api/predict/taixiu">/api/predict/taixiu</a></li>
                <li><a href="/api/history/all">/api/history/all</a></li>
            </ul>
        </div>
    `);
});

// API Dự đoán
app.get('/api/predict/:game', async (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.status(400).json({ success: false, error: 'Game không hợp lệ' });

    const url = game === 'md5' ? API_MD5 : API_TX;
    const list = await fetchApi(url);
    if (!list || !list.length) return res.status(500).json({ success: false, error: 'Không lấy được dữ liệu từ API gốc' });

    const latest = list[list.length - 1];
    const session = safeInt(latest.SessionId);
    const seq = list.map(getResult).filter(Boolean);
    
    const db = readDB(game);
    const pred = runEngine(seq, db);

    // Trả JSON sạch cho Tool
    res.json({
        success: true,
        game: game,
        phien: session,
        xucXac: getDice(latest),
        tong: getSum(latest),
        ketQua: getResult(latest),
        ketQuaLabel: label(getResult(latest)),
        phienDuDoan: session + 1,
        duDoan: pred.code ? label(pred.code) : 'CHỜ',
        duDoanCode: pred.code, 
        tiLe: pred.tiLe,
        reason: pred.label
    });
});

// API Lịch sử
app.get('/api/history/all', (req, res) => {
    const out = {};
    for (const g of ['md5', 'taixiu']) {
        const db = readDB(g);
        out[g] = {
            items: db.history.slice(-100).reverse().map(it => ({
                phien: it.phien, phienDuDoan: it.phienDuDoan, tong: it.tong, xucXac: it.xucXac,
                ketQua: it.ketQua, ketQuaLabel: it.ketQuaLabel,
                duDoanCode: it.DU_DOAN_CODE, duDoan: it.DU_DOAN, tiLe: it.TI_LE,
                pattern: { type: it.patternName }, trangThai: it.trangThai
            }))
        };
    }
    res.json({ success: true, games: out });
});

// ========================================================================
// 8. GIAO DIỆN WEB (XEM TRỰC TIẾP TRÊN RENDER)
// ========================================================================
app.get('/:game', (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.send('Trang không tồn tại');

    const db = readDB(game);
    const rows = db.history.slice(-50).reverse();

    const getBadge = (type) => {
        if (!type) return 'badge-default';
        if (type.startsWith('BỆT')) return 'badge-bet';
        if (type.includes('MARKOV') || type.includes('GUARD')) return 'badge-markov';
        if (type.match(/\d-\d/)) return 'badge-cycle';
        return 'badge-default';
    };

    const html = `<!DOCTYPE html>
    <html lang="vi">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
    <title>HOANG VIP WIN</title>
    <style>
      *{box-sizing:border-box}
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0e27;color:#e6eef6;padding:12px;margin:0;}
      .header{background:linear-gradient(135deg,#1e3a8a,#3b82f6);padding:16px;border-radius:14px;margin-bottom:14px;box-shadow:0 8px 24px rgba(59,130,246,.3);text-align:center;}
      h1{color:#fff;font-size:20px;margin:0;font-weight:800;text-transform:uppercase}
      .table-wrap{background:#0f172a;border-radius:12px;overflow:hidden;border:1px solid #334155;}
      table{width:100%;border-collapse:collapse;font-size:12px}
      th{background:#1e40af;color:#fff;padding:10px 4px;font-weight:600;text-transform:uppercase;font-size:10px;}
      td{padding:10px 4px;text-align:center;border-bottom:1px solid #1e293b;}
      .tai{color:#22c55e;font-weight:700}.xiu{color:#ef4444;font-weight:700}
      .dung{color:#22c55e;font-weight:700;text-transform:uppercase}.sai{color:#ef4444;font-weight:700;text-transform:uppercase}.cho{color:#94a3b8;font-weight:600;font-style:italic}
      .dice{color:#fbbf24;font-weight:700;line-height:1.2}
      .sum{display:inline-block;padding:4px 10px;border-radius:6px;background:#334155;color:#fbbf24;font-weight:800;font-size:14px}
      .session{font-family:monospace;font-size:11px;color:#64748b}
      .ti-le{font-size:12px;color:#cbd5e1;font-weight:600}
      .badge{display:inline-block;padding:4px 8px;border-radius:6px;font-size:10px;font-weight:700;white-space:nowrap;}
      .badge-bet{background:#78350f;color:#fcd34d}.badge-markov{background:#1e3a8a;color:#93c5fd}.badge-cycle{background:#1e40af;color:#93c5fd}.badge-default{background:#334155;color:#cbd5e1}
    </style>
    <script>setTimeout(()=>location.reload(), 10000);</script>
    </head>
    <body>
      <div class="header"><h1>🎯 HOANG VIP WIN - ${game.toUpperCase()}</h1></div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>PHIÊN</th><th>XX</th><th>TỔNG</th><th>KQ</th><th>PHIÊN DĐ</th><th>DỰ ĐOÁN</th><th>TỈ LỆ</th><th>LOẠI CẦU</th><th>TT</th>
          </tr></thead>
          <tbody>
            ${rows.map(it => {
              const dice = (it.xucXac || []).join('-').replace(/-/g, '-<br>');
              const kqCls = it.ketQua === 'T' ? 'tai' : (it.ketQua === 'X' ? 'xiu' : '');
              const isWait = !it.DU_DOAN_CODE;
              const ddCls = isWait ? 'cho' : (it.DU_DOAN_CODE === 'T' ? 'tai' : 'xiu');
              const ttCls = it.trangThai === 'ĐÚNG' ? 'dung' : (it.trangThai === 'SAI' ? 'sai' : 'cho');
              const ttText = it.trangThai === 'ĐANG CHỜ' ? '...' : (it.trangThai || '');
              const badgeCls = getBadge(it.patternName);
              return `<tr>
                <td class="session">${it.phien}</td><td class="dice">${dice}</td>
                <td><span class="sum">${it.tong || ''}</span></td><td class="${kqCls}">${it.ketQuaLabel || ''}</td>
                <td class="session">${it.phienDuDoan}</td><td class="${ddCls}">${isWait ? 'CHỜ' : it.DU_DOAN}</td>
                <td class="ti-le">${it.TI_LE || 'CHỜ'}</td>
                <td>${it.patternName ? `<span class="badge ${badgeCls}">${it.patternName}</span>` : '-'}</td>
                <td class="${ttCls}">${ttText}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </body>
    </html>`;
    res.send(html);
});

// MỞ CỔNG SERVER
app.listen(PORT, () => console.log(`Server chạy trên port ${PORT}`));
