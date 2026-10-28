'use strict';

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_MD5 = 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau';
const API_TX  = 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau';
const DB_DIR = process.env.DB_DIR || __dirname;
const TICK_MS = 5000;

const CONFIG = {
    WARMUP: {
        MIN_SESSIONS: 15,       // Dưới 15 phiên: Không dự đoán (chỉ nhận diện)
        FULL_SESSIONS: 60,      // Trên 60 phiên: Data đầy đủ
        EFS_TARGET: 80          // Ngưỡng EFS để chuyển sang READY
    },
    ENV: { MIN_SAMPLES: 10 }
};

if (!fs.existsSync(DB_DIR)) { try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch (e) {} }

// ========================================================================
// 0. UTILS
// ========================================================================
function safeInt(x, def = 0) { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
const label = c => c === 'T' ? 'TÀI' : (c === 'X' ? 'XỈU' : null);
const flip  = c => c === 'T' ? 'X'   : (c === 'X' ? 'T'   : null);

function entropyBits(arr) {
    if (!arr.length) return 0;
    const f = {};
    for (const x of arr) f[x] = (f[x] || 0) + 1;
    let h = 0;
    for (const k in f) {
        const p = f[k] / arr.length;
        if (p > 0) h -= p * Math.log2(p);
    }
    return h;
}

// ========================================================================
// 1. DATABASE
// ========================================================================
function dbPath(g) { return path.join(DB_DIR, `db_v41_${g}.json`); }
function readDB(g) {
    const p = dbPath(g);
    try {
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {}
    return { history: [], lastSession: null, weights: {}, envProfile: null };
}
function saveDB(g, db) {
    try { fs.writeFileSync(dbPath(g), JSON.stringify(db, null, 2)); } catch (e) {}
}
function getDice(it) { return [safeInt(it?.FirstDice), safeInt(it?.SecondDice), safeInt(it?.ThirdDice)]; }
function getSum(it) {
    const s = getDice(it).reduce((a, b) => a + b, 0);
    return (s >= 3 && s <= 18) ? s : safeInt(it?.DiceSum);
}
function getResult(it) {
    const s = getSum(it);
    return (s >= 3 && s <= 18) ? (s >= 11 ? 'T' : 'X') : null;
}

// ========================================================================
// 2. NHẬN DIỆN MÔI TRƯỜNG (FIX LỖI TIN CẬY 100%)
// ========================================================================
function profileEnvironment(seq) {
    const L = seq.length;
    if (L < CONFIG.ENV.MIN_SAMPLES) {
        return { type: 'CHƯA_ĐỦ_DATA', confidence: 0, efs: 0, purity: 0, entropy: 1, dominant: null, availablePatterns: [], disabledPatterns: [], stats: { sessions: L } };
    }

    const tCount = seq.filter(x => x === 'T').length;
    const xCount = L - tCount;
    const balance = Math.abs(tCount - xCount) / L;
    const entropy = entropyBits(seq); // 0 -> 1

    // Phân tích Streak
    let streaks = [], cur = seq[0], len = 1;
    for (let i = 1; i < L; i++) {
        if (seq[i] === cur) len++;
        else { streaks.push(len); cur = seq[i]; len = 1; }
    }
    streaks.push(len);
    const maxStreak = Math.max(...streaks);
    const streakRatio = streaks.filter(s => s >= 3).length / streaks.length;

    // Phân tích Zigzag (20 phiên)
    const rec20 = seq.slice(-Math.min(20, L));
    let flips20 = 0;
    for (let i = 1; i < rec20.length; i++) if (rec20[i] !== rec20[i-1]) flips20++;
    const zigzagRatio = rec20.length > 1 ? flips20 / (rec20.length - 1) : 0;

    // Phân loại
    let type = 'HỖN_HỢP', confidence = 0.5;
    const purity = 1 - entropy;

    if (entropy > 0.90) {
        type = 'NHIỄU'; 
        confidence = clamp((entropy - 0.90) * 10, 0, 1); // Sửa lỗi: độ tin cậy thấp khi nhiễu
    } else if (entropy < 0.50 && (streakRatio > 0.3 || maxStreak >= 4)) {
        type = 'BỆT'; 
        confidence = clamp((0.5 - entropy) * 2, 0.5, 1);
    } else if (zigzagRatio > 0.75 && entropy > 0.7) {
        type = 'ZIGZAG'; 
        confidence = clamp((zigzagRatio - 0.75) * 4, 0.5, 1);
    }

    const dominant = balance > 0.15 ? (tCount > xCount ? 'T' : 'X') : null;

    // EFS
    const dataVolume = clamp(L / CONFIG.WARMUP.FULL_SESSIONS, 0, 1);
    const efs = (dataVolume * 0.35 + purity * 0.30 + confidence * 0.20 + (1 - entropy) * 0.15) * 100;

    // Available Patterns
    const available = [], disabled = [];
    if (type === 'NHIỄU') {
        disabled.push('streak', 'zigzag', 'mirror', 'cycle');
        available.push('markov', 'ngram', 'pull', 'gap');
    } else if (type === 'BỆT') {
        available.push('streak', 'pull');
        disabled.push('zigzag');
    } else if (type === 'ZIGZAG') {
        available.push('zigzag', 'mirror');
        disabled.push('streak');
    } else {
        available.push('markov', 'ngram', 'pull', 'streak', 'zigzag');
    }

    return { type, confidence, efs: Math.round(efs*10)/10, purity, entropy, dominant, availablePatterns: available, disabledPatterns: disabled, stats: { L, tCount, xCount, maxStreak, zigzagRatio } };
}

// ========================================================================
// 3. DANH SÁCH CẦU (Rút gọn để load nhanh, đủ xài)
// ========================================================================
function generateAllPatterns() {
    const A = [];
    // Bệt
    for (let l = 3; l <= 6; l++) A.push({ id: `streak_${l}`, family: 'streak', base: 1.5, fn: (seq) => {
        const n = seq.length, last = seq[n-1]; let c = 1;
        for (let i = n-2; i >= 0; i--) { if (seq[i] === last) c++; else break; }
        return c >= l ? { code: last, name: `BỆT-${c}`, conf: 0.7 } : null;
    }});
    
    // Zigzag
    for (let w = 4; w <= 8; w++) A.push({ id: `zigzag_${w}`, family: 'zigzag', base: 1.4, fn: (seq) => {
        const n = seq.length; if (n < w + 1) return null;
        let f = 0; for (let i = n-w; i < n; i++) if (seq[i] !== seq[i-1]) f++;
        return f === w ? { code: flip(seq[n-1]), name: `ĐẢO-${w}`, conf: 0.75 } : null;
    }});

    // Ngram
    for (let len = 3; len <= 7; len++) A.push({ id: `ngram_${len}`, family: 'ngram', base: 1.4, fn: (seq) => {
        const n = seq.length; if (n < len + 5) return null;
        const tail = seq.slice(-len).join(''); let t = 0, x = 0, occ = 0;
        for (let i = 0; i + len < n; i++) {
            if (seq.slice(i, i+len).join('') === tail) { occ++; if (seq[i+len] === 'T') t++; else x++; }
        }
        if (occ < 2) return null;
        const pT = (t+1)/(occ+2), pX = (x+1)/(occ+2);
        return Math.max(pT, pX) > 0.65 ? { code: pT > pX ? 'T' : 'X', name: `NGRAM-${len}`, conf: Math.max(pT, pX) } : null;
    }});

    // Markov
    for (let k = 2; k <= 5; k++) A.push({ id: `markov_${k}`, family: 'markov', base: 1.5, fn: (seq) => {
        const n = seq.length; if (n < k + 6) return null;
        const key = seq.slice(-k).join(''); let t = 0, x = 0;
        for (let i = k; i < n; i++) if (seq.slice(i-k, i).join('') === key) { if (seq[i] === 'T') t++; else x++; }
        const tot = t + x; if (tot < 3) return null;
        const pT = (t+1)/(tot+2), pX = (x+1)/(tot+2);
        return Math.max(pT, pX) > 0.6 ? { code: pT > pX ? 'T' : 'X', name: `MARKOV-${k}`, conf: Math.max(pT, pX) } : null;
    }});

    // Pull (Kéo cân bằng)
    for (let w = 20; w <= 40; w += 10) A.push({ id: `pull_${w}`, family: 'pull', base: 1.0, fn: (seq) => {
        const n = seq.length; if (n < w) return null;
        const pT = seq.slice(-w).filter(x => x === 'T').length / w;
        if (pT >= 0.65) return { code: 'X', name: `KÉO-X`, conf: 0.6 };
        if (pT <= 0.35) return { code: 'T', name: `KÉO-T`, conf: 0.6 };
        return null;
    }});

    // Cầu phụ
    A.push({ id: 'mirror', family: 'mirror', base: 1.3, fn: (seq) => {
        const n = seq.length; if (n < 8) return null;
        const w = seq.slice(-4).join('');
        if (w[0] === w[3] && w[1] === w[2] && w[0] !== w[1]) return { code: flip(w[3]), name: 'GƯƠNG-ABBA', conf: 0.72 };
        return null;
    }});

    return A;
}
const ALL_ALGOS = generateAllPatterns();

// ========================================================================
// 4. TỔNG HỢP KHÔNG THIÊN VỊ
// ========================================================================
function runUnbiasedEnsemble(seq, db, env) {
    const disabled = new Set(env.disabledPatterns);
    let votesT = [], votesX = [], details = [];

    for (const algo of ALL_ALGOS) {
        if (disabled.has(algo.family)) continue;
        let res = null; try { res = algo.fn(seq); } catch (e) {}
        if (!res || !res.code) continue;

        const w = db.weights?.[algo.id]?.w || 1.0;
        const vote = res.conf * algo.base * w;
        if (res.code === 'T') votesT.push({ vote, name: res.name });
        else votesX.push({ vote, name: res.name });
        details.push({ algo: algo.id, code: res.code, name: res.name, family: algo.family });
    }

    const cT = votesT.length, cX = votesX.length;
    const sT = votesT.reduce((a, b) => a + b.vote, 0);
    const sX = votesX.reduce((a, b) => a + b.vote, 0);

    // Chia đều (Không thiên vị)
    const scoreT = cT > 0 ? sT / cT : 0;
    const scoreX = cX > 0 ? sX / cX : 0;

    let winner, confidence, patternName, method;

    if (cT + cX === 0) {
        winner = 'T'; confidence = 0.51; patternName = 'TRUNG-LẬP'; method = 'neutral';
    } else if (Math.abs(scoreT - scoreX) < 0.02) {
        winner = env.dominant || (scoreT >= scoreX ? 'T' : 'X');
        confidence = 0.515; patternName = 'HÒA-NHIỄU'; method = 'tie';
    } else {
        winner = scoreT > scoreX ? 'T' : 'X';
        const maxS = Math.max(scoreT, scoreX);
        const diff = Math.abs(scoreT - scoreX) / maxS;
        confidence = clamp(0.5 + diff * 0.5, 0.5, 0.85);
        const top = (winner === 'T' ? votesT : votesX).sort((a,b)=>b.vote-a.vote)[0];
        patternName = top ? top.name : 'META';
        method = 'score';
    }

    // Áp dụng EFS
    const efs = env.efs;
    if (env.stats.L < CONFIG.WARMUP.MIN_SESSIONS) {
        confidence = clamp(0.51 + (confidence - 0.5) * 0.5, 0.51, 0.55); // Warmup cực thấp
    } else if (efs < CONFIG.WARMUP.EFS_TARGET) {
        const ratio = efs / CONFIG.WARMUP.EFS_TARGET;
        const target = 0.51 + 0.08 * ratio;
        confidence = clamp(Math.min(confidence, target), 0.51, 0.59);
    } else {
        const boost = ((efs - CONFIG.WARMUP.EFS_TARGET) / 20) * 0.1;
        confidence = clamp(confidence * (1 + boost), 0.51, 0.85);
    }

    return {
        code: winner, label: patternName, tiLe: (confidence*100).toFixed(1)+'%', confidence, method,
        details, counts: { cT, cX, scoreT: +scoreT.toFixed(2), scoreX: +scoreX.toFixed(2) },
        phase: confidence < 0.60 ? 'WARMING_UP' : 'READY'
    };
}

// ========================================================================
// 5. FETCH & PROCESS
// ========================================================================
async function fetchApi(url) {
    try {
        const res = await axios.get(url, { timeout: 8000 });
        let arr = res.data?.data?.list || res.data?.list || res.data?.data || (Array.isArray(res.data) ? res.data : []);
        if (arr.length >= 2 && Number(arr[0].SessionId) > Number(arr[arr.length - 1].SessionId)) arr.reverse();
        return arr;
    } catch (e) { return []; }
}

async function processGame(game) {
    const list = await fetchApi(game === 'md5' ? API_MD5 : API_TX);
    if (!list || !list.length) return;

    const latest = list[list.length - 1];
    const session = safeInt(latest.SessionId);
    const db = readDB(game);
    if (db.lastSession === session) return;

    const seq = list.map(getResult).filter(Boolean);
    if (seq.length < 5) return;

    const env = profileEnvironment(seq);
    db.envProfile = env;

    // Chỉ dự đoán khi >= 15 phiên
    let pred = null;
    if (seq.length >= 15) {
        pred = runUnbiasedEnsemble(seq, db, env);
    }

    // Cập nhật phiên trước
    const prev = db.history[db.history.length - 1];
    if (prev && safeInt(prev.phienDuDoan) === session && prev.DU_DOAN_CODE) {
        const actual = getResult(latest);
        prev.trangThai = prev.DU_DOAN_CODE === actual ? 'ĐÚNG' : 'SAI';
        // Update weight cơ bản
        for (const d of (prev.algoDetails || [])) {
            if (!db.weights[d.algo]) db.weights[d.algo] = { w: 1.0 };
            if (d.code === actual) db.weights[d.algo].w = clamp(db.weights[d.algo].w + 0.05, 0.5, 2.0);
            else db.weights[d.algo].w = clamp(db.weights[d.algo].w - 0.05, 0.5, 2.0);
        }
    }

    db.history.push({
        phien: session, xucXac: getDice(latest), tong: getSum(latest),
        ketQua: getResult(latest), ketQuaLabel: label(getResult(latest)),
        phienDuDoan: session + 1,
        DU_DOAN_CODE: pred ? pred.code : null,
        DU_DOAN: pred ? label(pred.code) : '—',
        TI_LE: pred ? pred.tiLe : '—',
        patternName: pred ? pred.label : 'CHỜ_DATA',
        algoDetails: pred ? pred.details : [],
        method: pred ? pred.method : 'none',
        phase: pred ? pred.phase : 'WARMUP',
        envType: env.type,
        trangThai: 'ĐANG CHỜ'
    });

    if (db.history.length > 500) db.history.shift();
    db.lastSession = session;
    saveDB(game, db);
}

setInterval(() => { processGame('md5'); processGame('taixiu'); }, TICK_MS);

// ========================================================================
// 6. ROUTE API JSON (THEO ĐÚNG YÊU CẦU: /taixiu, /md5)
// ========================================================================
function buildJsonResponse(game, list, db, env, pred) {
    const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const win = settled.filter(h => h.trangThai === 'ĐÚNG').length;
    const lose = settled.filter(h => h.trangThai === 'SAI').length;

    return {
        status: "success",
        data: {
            phienHienTai: String(safeInt(list[list.length-1].SessionId)),
            phienDuDoan: String(safeInt(list[list.length-1].SessionId) + 1),
            duDoan: pred ? pred.code : null,
            tiLe: pred ? pred.tiLe : "—",
            liDo: pred ? `⭐ ${pred.label} → ${label(pred.code)}` : `⏳ Đang quét ${env.stats.L}/15 phiên để nhận diện...`,
            xucXac: getDice(list[list.length-1]),
            tongDiem: getSum(list[list.length-1]),
            moiTruong: {
                loai: env.type,
                doTinCay: env.confidence.toFixed(2),
                efs: env.efs + "%",
                doTinhKhiet: (env.purity*100).toFixed(1) + "%",
                doNhieu: (env.entropy*100).toFixed(1) + "%",
                nghieng: env.dominant ? label(env.dominant) : "CÂN BẰNG"
            },
            chiTietModel: {
                pattern: pred ? pred.label : '—',
                phase: pred ? pred.phase : 'WARMUP'
            },
            thongKe: {
                win, lose,
                winrate: settled.length ? ((win/settled.length)*100).toFixed(1)+'%' : '—',
                bankroll: (1000 + win*10 - lose*10) + '$'
            }
        }
    };
}

// Route /taixiu
app.get('/taixiu', async (req, res) => {
    const list = await fetchApi(API_TX);
    const db = readDB('taixiu');
    if (!list || !list.length) return res.status(500).json({ status: "error", message: "Không lấy được data" });
    
    const seq = list.map(getResult).filter(Boolean);
    const env = profileEnvironment(seq);
    const pred = seq.length >= 15 ? runUnbiasedEnsemble(seq, db, env) : null;
    res.json(buildJsonResponse('taixiu', list, db, env, pred));
});

// Route /md5
app.get('/md5', async (req, res) => {
    const list = await fetchApi(API_MD5);
    const db = readDB('md5');
    if (!list || !list.length) return res.status(500).json({ status: "error", message: "Không lấy được data" });
    
    const seq = list.map(getResult).filter(Boolean);
    const env = profileEnvironment(seq);
    const pred = seq.length >= 15 ? runUnbiasedEnsemble(seq, db, env) : null;
    res.json(buildJsonResponse('md5', list, db, env, pred));
});

// ========================================================================
// 7. ROUTE UI (Xem giao diện đẹp)
// ========================================================================
app.get('/ui/:game', (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.send('Game không hợp lệ');
    const db = readDB(game);
    const rows = db.history.slice(-80).reverse();
    const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const correct = settled.filter(h => h.trangThai === 'ĐÚNG').length;
    const acc = settled.length ? (correct / settled.length * 100).toFixed(1) : '0.0';
    const env = db.envProfile || { type: 'CHƯA CÓ', confidence: 0, efs: 0, purity: 0, entropy: 1, dominant: null };

    // Trả về HTML giống hệt Hình 1
    res.send(`<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>V41 - ${game.toUpperCase()}</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#0a0e27;color:#e6eef6;padding:12px;margin:0;}
.header{background:linear-gradient(135deg,#1e3a8a,#3b82f6);padding:16px;border-radius:14px;margin-bottom:14px;}
h1{color:#fff;font-size:20px;margin:0 0 8px;font-weight:800;text-align:center}
.env-box{background:rgba(0,0,0,.3);padding:10px;border-radius:10px;font-size:13px;margin-bottom:8px}
.env-row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.1)}
.env-row:last-child{border:none}
.env-val{color:#fbbf24;font-weight:700}
.efs-bar{height:6px;background:#1e293b;border-radius:3px;overflow:hidden;margin-top:6px}
.efs-fill{height:100%;background:linear-gradient(90deg,#ef4444,#fbbf24,#22c55e);transition:width .3s}
.table-wrap{background:#0f172a;border-radius:12px;overflow-x:auto;border:1px solid #334155;}
table{width:100%;border-collapse:collapse;font-size:11px}
th{background:#1e40af;color:#fff;padding:8px 4px;font-size:10px;text-transform:uppercase;}
td{padding:8px 3px;text-align:center;border-bottom:1px solid #1e293b;}
.tai{color:#22c55e;font-weight:700}.xiu{color:#ef4444;font-weight:700}
.dung{color:#22c55e;font-weight:700}.sai{color:#ef4444;font-weight:700}.cho{color:#94a3b8;font-weight:600}
.dice{color:#fbbf24;font-weight:700;line-height:1.2;font-size:10px}
.sum{display:inline-block;padding:2px 5px;border-radius:4px;background:#334155;color:#fbbf24;font-weight:800;font-size:11px}
.session{font-family:monospace;font-size:10px;color:#64748b}
.ti-le{font-size:11px;color:#cbd5e1;font-weight:600}
.phase-warm{color:#fbbf24;background:#78350f;padding:2px 5px;border-radius:4px;}
.phase-ready{color:#22c55e;background:#14532d;padding:2px 5px;border-radius:4px;}
.env-tag{display:inline-block;padding:2px 5px;border-radius:4px;font-size:9px;font-weight:700;background:#1e40af;color:#fff}
</style>
<script>setTimeout(()=>location.reload(), 5000);</script>
</head><body>
<div class="header">
  <h1>V41 · ${game.toUpperCase()}</h1>
  <div class="env-box">
    <div class="env-row"><span>🌍 Môi trường</span><span class="env-val">${env.type}</span></div>
    <div class="env-row"><span>🎯 Độ tin cậy</span><span class="env-val">${(env.confidence*100).toFixed(1)}%</span></div>
    <div class="env-row"><span>📊 EFS</span><span class="env-val">${env.efs}%</span></div>
    <div class="env-row"><span>💎 Tinh khiết</span><span class="env-val">${(env.purity*100).toFixed(1)}%</span></div>
    <div class="env-row"><span>🌫️ Nhiễu</span><span class="env-val">${(env.entropy*100).toFixed(1)}%</span></div>
    <div class="env-row"><span>⚖️ Nghiêng</span><span class="env-val">${env.dominant ? label(env.dominant) : 'CÂN BẰNG'}</span></div>
    <div class="efs-bar"><div class="efs-fill" style="width:${env.efs}%"></div></div>
  </div>
  <div style="text-align:center;font-size:13px;color:#fff">Chính xác: <strong>${acc}%</strong> (${settled.length} phiên)</div>
</div>
<div class="table-wrap"><table>
<thead><tr><th>PHIÊN</th><th>XX</th><th>TỔNG</th><th>KQ</th><th>DỰ ĐOÁN</th><th>TỈ LỆ</th><th>MÔI TRƯỜNG</th><th>PHASE</th><th>TT</th></tr></thead>
<tbody>
${rows.map(it => {
    const dice = (it.xucXac || []).join('-');
    const kq = it.ketQua === 'T' ? 'tai' : 'xiu';
    const dd = it.DU_DOAN_CODE === 'T' ? 'tai' : (it.DU_DOAN_CODE === 'X' ? 'xiu' : '');
    const tt = it.trangThai === 'ĐÚNG' ? 'dung' : (it.trangThai === 'SAI' ? 'sai' : 'cho');
    const phaseCls = it.phase === 'READY' ? 'phase-ready' : 'phase-warm';
    return `<tr>
        <td class="session">${it.phien}</td><td class="dice">${dice}</td>
        <td><span class="sum">${it.tong || ''}</span></td><td class="${kq}">${it.ketQuaLabel || ''}</td>
        <td class="${dd}">${it.DU_DOAN || '—'}</td>
        <td><span class="ti-le">${it.TI_LE}</span></td>
        <td><span class="env-tag">${it.envType || '—'}</span></td>
        <td><span class="${phaseCls}">${it.phase || '—'}</span></td>
        <td class="${tt}">${it.trangThai === 'ĐANG CHỜ' ? '...' : it.trangThai}</td>
    </tr>`;
}).join('')}
</tbody></table></div>
</body></html>`);
});

app.get('/', (req, res) => res.redirect('/ui/md5'));

app.listen(PORT, () => console.log(`🚀 V41 Server running on port ${PORT}`));
