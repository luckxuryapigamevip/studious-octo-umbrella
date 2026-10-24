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
const API_TX = 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau';
const DB_DIR = process.env.DB_DIR || __dirname;
const TICK_MS = 5000;

if (!fs.existsSync(DB_DIR)) { try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch (e) {} }

function safeInt(x, def = 0) { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
const label = c => c === 'T' ? 'Tài' : (c === 'X' ? 'Xỉu' : null);
const flip = c => c === 'T' ? 'X' : (c === 'X' ? 'T' : null);

function readDB(g) {
    const p = path.join(DB_DIR, `db_v13_${g}.json`);
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {}
    return { history: [], lastProcessedSession: null, weights: {}, streakStats: { T: {}, X: {} } };
}
function saveDB(g, db) {
    const p = path.join(DB_DIR, `db_v13_${g}.json`);
    try { fs.writeFileSync(p, JSON.stringify(db, null, 2)); } catch (e) {}
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
// 1. TOÁN HỌC CORE & ENTROPY
// ========================================================================
function calcEntropy(arr) {
    const f = {}; for (const x of arr) f[x] = (f[x] || 0) + 1;
    let h = 0; const n = arr.length;
    for (const k in f) { const p = f[k] / n; if (p > 0) h -= p * Math.log2(p); }
    return h;
}

// Học phân phối độ dài Bệt từ lịch sử
function updateStreakStats(seq, db) {
    if (!db.streakStats) db.streakStats = { T: {}, X: {} };
    let curSide = seq[0], curLen = 1;
    for (let i = 1; i < seq.length; i++) {
        if (seq[i] === curSide) curLen++;
        else {
            const side = curSide, len = curLen;
            if (!db.streakStats[side][len]) db.streakStats[side][len] = { cont: 0, stop: 0 };
            db.streakStats[side][len].stop++;
            for (let l = 1; l < len; l++) {
                if (!db.streakStats[side][l]) db.streakStats[side][l] = { cont: 0, stop: 0 };
                db.streakStats[side][l].cont++;
            }
            curSide = seq[i]; curLen = 1;
        }
    }
}

// ========================================================================
// 2. ENGINE SINH 120+ CẦU TỰ ĐỘNG (12 FAMILIES x 10 VARIANTS)
// ========================================================================
function generate120Patterns() {
    const algos = [];

    // --- FAMILY 1: BỆT (STREAK) ---
    for (let minLen = 2; minLen <= 6; minLen++) {
        algos.push({
            id: `streak_${minLen}`, base: 1.5,
            fn: (seq, db) => {
                const n = seq.length, last = seq[n - 1]; let len = 1;
                for (let i = n - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
                if (len < minLen) return null;
                const stats = db.streakStats?.[last]?.[len];
                if (stats && (stats.cont + stats.stop) >= 2) {
                    const pCont = (stats.cont + 1) / (stats.cont + stats.stop + 2);
                    if (pCont > 0.55) return { code: last, name: `BỆT-${len}-TIẾP`, conf: clamp(pCont, 0.6, 0.85) };
                    if (pCont < 0.45) return { code: flip(last), name: `BỆT-${len}-GÃY`, conf: clamp(1 - pCont, 0.6, 0.85) };
                }
                return null;
            }
        });
    }
    // Thêm 4 biến thể bệt thuần không học
    for (let minLen = 3; minLen <= 6; minLen++) {
        algos.push({
            id: `streak_pure_${minLen}`, base: 1.2,
            fn: (seq) => {
                const n = seq.length, last = seq[n - 1]; let len = 1;
                for (let i = n - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
                if (len >= minLen) return { code: last, name: `BỆT-THUẦN-${len}`, conf: 0.65 };
                return null;
            }
        });
    }

    // --- FAMILY 2: ĐẢO 1-1 (BOUNCE) ---
    for (let win = 4; win <= 8; win++) {
        algos.push({
            id: `bounce_${win}`, base: 1.4,
            fn: (seq) => {
                const n = seq.length; if (n < win + 1) return null;
                let flips = 0;
                for (let i = n - win; i < n; i++) if (seq[i] !== seq[i - 1]) flips++;
                if (flips === win) return { code: flip(seq[n - 1]), name: `ĐẢO-1-1-W${win}`, conf: 0.75 };
                return null;
            }
        });
    }

    // --- FAMILY 3: ZIGZAG (A-B-A-B) ---
    for (let p = 2; p <= 6; p++) {
        algos.push({
            id: `zigzag_${p}`, base: 1.3,
            fn: (seq) => {
                const n = seq.length; if (n < p * 2 + 2) return null;
                let match = true;
                for (let i = n - p * 2; i < n - p; i++) if (seq[i] !== seq[i + p]) { match = false; break; }
                if (match) return { code: seq[n - p], name: `ZIGZAG-${p}`, conf: 0.72 };
                return null;
            }
        });
    }

    // --- FAMILY 4: GƯƠNG (MIRROR) ---
    for (let half = 3; half <= 7; half++) {
        algos.push({
            id: `mirror_${half}`, base: 1.3,
            fn: (seq) => {
                const n = seq.length; if (n < half * 2 + 2) return null;
                const rec = seq.slice(-(half * 2));
                if (rec.slice(0, half).map(flip).join('') === rec.slice(half).join('')) return { code: flip(seq[n - 1]), name: `GƯƠNG-${half}`, conf: 0.7 };
                return null;
            }
        });
    }

    // --- FAMILY 5: N-GRAM CỐ ĐỊNH ---
    for (let len = 3; len <= 8; len++) {
        algos.push({
            id: `ngram_${len}`, base: 1.4,
            fn: (seq) => {
                const n = seq.length; if (n < len + 5) return null;
                const tail = seq.slice(-len).join(''); let t = 0, x = 0, occ = 0;
                for (let i = 0; i + len < n; i++) {
                    if (seq.slice(i, i + len).join('') === tail) {
                        occ++; if (seq[i + len] === 'T') t++; else x++;
                    }
                }
                if (occ < 2) return null;
                const pT = (t + 1) / (occ + 2), pX = (x + 1) / (occ + 2);
                const conf = Math.max(pT, pX);
                if (conf < 0.65) return null;
                return { code: pT > pX ? 'T' : 'X', name: `NGRAM-${len}`, conf };
            }
        });
    }
    
    // Thêm 2 biến thể N-Gram có Skip (cách quãng)
    for (let len = 3; len <= 5; len++) {
        algos.push({
            id: `ngram_skip_${len}`, base: 1.2,
            fn: (seq) => {
                const n = seq.length; if (n < len * 2 + 5) return null;
                let t = 0, x = 0, occ = 0;
                const tail = [seq[n-1], seq[n-3], seq[n-5]].join(''); // Lấy cách quãng
                for (let i = 0; i + 6 < n; i++) {
                    if ([seq[i], seq[i+2], seq[i+4]].join('') === tail) {
                        occ++; if (seq[i+6] === 'T') t++; else x++;
                    }
                }
                if (occ < 2) return null;
                const pT = (t + 1) / (occ + 2), pX = (x + 1) / (occ + 2);
                if (Math.max(pT, pX) < 0.65) return null;
                return { code: pT > pX ? 'T' : 'X', name: `NGRAM-SKIP-${len}`, conf: Math.max(pT, pX) };
            }
        });
    }

    // --- FAMILY 6: MARKOV BẬC 2 ĐẾN 8 ---
    for (let k = 2; k <= 8; k++) {
        algos.push({
            id: `markov_${k}`, base: 1.5,
            fn: (seq) => {
                const n = seq.length; if (n < k + 5) return null;
                const key = seq.slice(-k).join(''); let t = 0, x = 0;
                for (let i = k; i < n; i++) {
                    if (seq.slice(i - k, i).join('') === key) { if (seq[i] === 'T') t++; else x++; }
                }
                const total = t + x; if (total < 3) return null;
                const pT = (t + 1) / (total + 2), pX = (x + 1) / (total + 2);
                const conf = Math.max(pT, pX);
                if (conf < 0.6) return null;
                return { code: pT > pX ? 'T' : 'X', name: `MARKOV-${k}`, conf };
            }
        });
    }

    // --- FAMILY 7: CHU KỲ (CYCLE) ---
    for (let p = 2; p <= 15; p++) {
        algos.push({
            id: `cycle_${p}`, base: 1.2,
            fn: (seq) => {
                const n = seq.length; if (n < p * 2 + 2) return null;
                let match = 0, total = 0;
                for (let i = p; i < n; i++) { total++; if (seq[i] === seq[i - p]) match++; }
                const ratio = match / total;
                if (ratio >= 0.7) return { code: seq[n - p], name: `CHU-KỲ-${p}`, conf: clamp(ratio, 0.7, 0.9) };
                return null;
            }
        });
    }

    // --- FAMILY 8: GAP (KHOẢNG CÁCH) ---
    for (let threshold = 0.5; threshold <= 1.4; threshold += 0.15) {
        algos.push({
            id: `gap_${threshold.toFixed(2)}`, base: 1.1,
            fn: (seq) => {
                const n = seq.length; if (n < 20) return null;
                const tP = [], xP = []; for (let i = 0; i < n; i++) { if (seq[i] === 'T') tP.push(i); else xP.push(i); }
                if (tP.length < 3 || xP.length < 3) return null;
                const tG = tP[tP.length-1] - tP[tP.length-2], xG = xP[xP.length-1] - xP[xP.length-2];
                const tPress = (n - tP[tP.length - 1]) / Math.max(tG, 1), xPress = (n - xP[xP.length - 1]) / Math.max(xG, 1);
                const diff = tPress - xPress; 
                if (Math.abs(diff) < threshold) return null;
                if (diff > threshold) return { code: 'T', name: `GAP-T-${threshold.toFixed(1)}`, conf: clamp(0.55 + diff * 0.05, 0.55, 0.8) };
                return { code: 'X', name: `GAP-X-${threshold.toFixed(1)}`, conf: clamp(0.55 + Math.abs(diff) * 0.05, 0.55, 0.8) };
            }
        });
    }

    // --- FAMILY 9: FRACTAL (LẶP LẠI KHỐI) ---
    for (let sc = 3; sc <= 8; sc++) {
        algos.push({
            id: `fractal_${sc}`, base: 1.3,
            fn: (seq) => {
                const n = seq.length; if (n < sc * 3) return null;
                let t = 0, x = 0, cnt = 0;
                const lastB = seq.slice(-sc).join('');
                for (let i = 0; i + sc < n - sc; i += 1) { // Tìm khối giống nhau
                    if (seq.slice(i, i + sc).join('') === lastB) {
                        if (seq[i + sc] === 'T') t++; else x++; cnt++;
                    }
                }
                if (cnt < 2) return null;
                const pT = (t + 0.5) / (cnt + 1), pX = (x + 0.5) / (cnt + 1);
                if (Math.max(pT, pX) < 0.65) return null;
                return { code: pT > pX ? 'T' : 'X', name: `FRACTAL-${sc}`, conf: Math.max(pT, pX) };
            }
        });
    }

    // --- FAMILY 10: MOMENTUM MULTI-TIMEFRAME ---
    for (let w = 5; w <= 20; w += 3) {
        algos.push({
            id: `mtf_${w}`, base: 1.1,
            fn: (seq) => {
                const n = seq.length; if (n < w) return null;
                const pT = seq.slice(-w).filter(x => x === 'T').length / w;
                if (pT >= 0.7) return { code: 'X', name: `MTF-REV-X-${w}`, conf: 0.62 };
                if (pT <= 0.3) return { code: 'T', name: `MTF-REV-T-${w}`, conf: 0.62 };
                if (pT >= 0.6) return { code: 'T', name: `MTF-FOLLOW-T-${w}`, conf: 0.58 };
                if (pT <= 0.4) return { code: 'X', name: `MTF-FOLLOW-X-${w}`, conf: 0.58 };
                return null;
            }
        });
    }

    // --- FAMILY 11: LỰC KÉO CÂN BẰNG (PULL) ---
    for (let w = 20; w <= 50; w += 5) {
        algos.push({
            id: `pull_${w}`, base: 1.0,
            fn: (seq) => {
                const n = seq.length; if (n < w) return null;
                const recent = seq.slice(-w); const tCount = recent.filter(x => x === 'T').length;
                const pT = tCount / recent.length;
                if (pT >= 0.60) return { code: 'X', name: `KÉO-CB-X-${w}`, conf: clamp(0.52 + (pT - 0.60), 0.52, 0.75) };
                if (pT <= 0.40) return { code: 'T', name: `KÉO-CB-T-${w}`, conf: clamp(0.52 + (0.40 - pT), 0.52, 0.75) };
                return null;
            }
        });
    }

    // --- FAMILY 12: SUM PATTERN (ĐIỂM TỔNG) ---
    for (let w = 10; w <= 20; w += 5) {
        algos.push({
            id: `sum_${w}`, base: 1.0,
            fn: (seq, sums) => {
                if (!sums || sums.length < w) return null;
                const rec = sums.slice(-w);
                const half = Math.floor(w / 2);
                const m1 = rec.slice(0, half).reduce((a, b) => a + b, 0) / half;
                const m2 = rec.slice(half).reduce((a, b) => a + b, 0) / half;
                if (m2 - m1 > 2.0) return { code: 'X', name: `SUM-UP-${w}`, conf: 0.62 };
                if (m1 - m2 > 2.0) return { code: 'T', name: `SUM-DOWN-${w}`, conf: 0.62 };
                return null;
            }
        });
    }

    return algos;
}

const ALL_ALGOS = generate120Patterns();

// ========================================================================
// 3. META ENGINE V13 - TỔNG HỢP 120+ CẦU
// ========================================================================
function runMetaEngine(seq, sums, db, session) {
    const votes = { T: 0, X: 0 };
    const details = [];

    // Chạy tất cả 120+ thuật toán
    for (const algo of ALL_ALGOS) {
        let res = null; 
        try { res = algo.fn(seq, sums, db); } catch (e) { res = null; }
        if (!res || !res.code) continue;

        // Lấy trọng số học online
        const learnedWeight = db.weights?.[algo.id] || 1.0;
        const w = clamp(algo.base * learnedWeight, 0.3, 3.0);
        
        const finalVote = res.conf * w;
        votes[res.code] += finalVote;
        details.push({ algo: algo.id, code: res.code, name: res.name, conf: +res.conf.toFixed(2), vote: +finalVote.toFixed(2) });
    }

    const total = votes.T + votes.X;
    let winner, confidence, gap;

    // BẮT BUỘC RA KẾT QUẢ: Nếu không có thuật toán nào nhận diện được cầu
    if (total < 0.01) {
        const recent = seq.slice(-20);
        const tCount = recent.filter(x => x === 'T').length;
        winner = tCount <= recent.length / 2 ? 'T' : 'X';
        confidence = 0.51; 
        details.push({ algo: 'default_pull', code: winner, name: 'CÂN-BẰNG-MẶC-ĐỊNH', conf: 0.51, vote: 1 });
    } else {
        const pT = votes.T / total, pX = votes.X / total;
        gap = Math.abs(pT - pX);
        winner = pT > pX ? 'T' : 'X';
        confidence = Math.max(pT, pX);
    }

    // Chặn trần (Không bao giờ ảo giác 90-99%)
    confidence = clamp(confidence, 0.50, 0.85);
    
    const isWeak = confidence < 0.58;
    const isVeryWeak = confidence <= 0.52;

    // Tìm thuật toán vote mạnh nhất cho bên thắng
    const topAlgo = details.filter(d => d.code === winner).sort((a, b) => b.vote - a.vote)[0];
    let labelName = topAlgo ? topAlgo.name : 'META';
    
    // Đếm số lượng thuật toán đồng thuận
    const consensusCount = details.filter(d => d.code === winner).length;
    if (consensusCount >= 20) labelName += ` (${consensusCount} cầu)`;

    return {
        code: winner, 
        label: labelName, 
        tiLe: (confidence * 100).toFixed(1) + '%',
        details, 
        weak: isWeak, 
        veryWeak: isVeryWeak, 
        gap: +(gap || 0).toFixed(2)
    };
}

// ========================================================================
// 4. HỌC ONLINE & CẬP NHẬT
// ========================================================================
function updateAllStats(db, prev, actual) {
    if (!prev || !actual) return;
    if (!db.weights) db.weights = {};
    for (const d of (prev.algoDetails || [])) {
        const isCorrect = (d.code === actual);
        const curW = db.weights[d.algo] || 1.0;
        db.weights[d.algo] = clamp(curW + (isCorrect ? 0.05 : -0.05), 0.3, 3.0);
    }
}

// ========================================================================
// 5. FETCH & PROCESS
// ========================================================================
async function fetchApi(url) {
    for (let i = 0; i < 3; i++) {
        try {
            const res = await axios.get(url, { timeout: 8000 });
            let arr = res.data?.data?.list || res.data?.list || res.data?.data || (Array.isArray(res.data) ? res.data : []);
            if (arr.length >= 2 && Number(arr[0].SessionId) > Number(arr[arr.length - 1].SessionId)) arr.reverse();
            return arr;
        } catch (e) { if (i === 2) return []; await new Promise(r => setTimeout(r, 500)); }
    }
}

async function processGame(game) {
    const list = await fetchApi(game === 'md5' ? API_MD5 : API_TX);
    if (!list || !list.length) return;

    const latest = list[list.length - 1], session = safeInt(latest.SessionId), db = readDB(game);
    if (db.lastProcessedSession === session) return;

    const seq = list.map(getResult).filter(Boolean);
    const sums = list.map(getSum).filter(s => s >= 3 && s <= 18);
    if (seq.length < 15) return; 

    updateStreakStats(seq, db);

    const prev = db.history[db.history.length - 1];
    if (prev && safeInt(prev.phienDuDoan) === session) {
        const actual = getResult(latest);
        prev.ketQua = actual; 
        prev.ketQuaLabel = label(actual);
        prev.trangThai = !prev.DU_DOAN_CODE ? 'BỎ QUA' : (prev.DU_DOAN_CODE === actual ? 'ĐÚNG' : 'SAI');
        updateAllStats(db, prev, actual);
    }

    const pred = runMetaEngine(seq, sums, db, session + 1);

    db.history.push({
        phien: session, xucXac: getDice(latest), tong: getSum(latest), ketQua: getResult(latest), ketQuaLabel: label(getResult(latest)),
        phienDuDoan: session + 1, DU_DOAN_CODE: pred.code, DU_DOAN: label(pred.code), TI_LE: pred.tiLe, patternName: pred.label,
        algoDetails: pred.details, weak: pred.weak, veryWeak: pred.veryWeak, trangThai: 'ĐANG CHỜ'
    });

    if (db.history.length > 600) db.history.shift();
    db.lastProcessedSession = session; 
    saveDB(game, db);
}

setInterval(() => { processGame('md5'); processGame('taixiu'); }, TICK_MS);

// ========================================================================
// 6. API ROUTES & UI
// ========================================================================
app.get('/', (req, res) => res.redirect('/md5'));

app.get('/api/predict/:game', async (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.status(400).json({ success: false });
    const list = await fetchApi(game === 'md5' ? API_MD5 : API_TX);
    if (!list || !list.length) return res.status(500).json({ success: false });

    const latest = list[list.length - 1], session = safeInt(latest.SessionId);
    const seq = list.map(getResult).filter(Boolean);
    const sums = list.map(getSum).filter(s => s >= 3 && s <= 18);
    const db = readDB(game), pred = runMetaEngine(seq, sums, db, session + 1);

    res.json({
        success: true, game, phien: session, xucXac: getDice(latest), tong: getSum(latest), ketQua: getResult(latest), ketQuaLabel: label(getResult(latest)),
        phienDuDoan: session + 1, duDoan: label(pred.code), duDoanCode: pred.code, tiLe: pred.tiLe, reason: pred.label,
        weak: pred.weak, veryWeak: pred.veryWeak, algoVotes: pred.details
    });
});

app.get('/:game', (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.send('Trang không tồn tại');

    const db = readDB(game), rows = db.history.slice(-50).reverse();
    const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const correct = settled.filter(h => h.trangThai === 'ĐÚNG').length;
    const acc = settled.length ? (correct / settled.length * 100).toFixed(1) : '0.0';

    const strong = settled.filter(h => !h.weak), weak = settled.filter(h => h.weak);
    const sWR = strong.length ? (strong.filter(h => h.trangThai === 'ĐÚNG').length / strong.length * 100).toFixed(1) : '-';
    const wWR = weak.length ? (weak.filter(h => h.trangThai === 'ĐÚNG').length / weak.length * 100).toFixed(1) : '-';

    const html = `<!DOCTYPE html>
    <html lang="vi">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
    <title>META V13 - ${game.toUpperCase()}</title>
    <style>
      *{box-sizing:border-box}
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0e27;color:#e6eef6;padding:12px;margin:0;}
      .header{background:linear-gradient(135deg,#1e3a8a,#3b82f6);padding:16px;border-radius:14px;margin-bottom:14px;text-align:center;}
      h1{color:#fff;font-size:20px;margin:0;font-weight:800;text-transform:uppercase}
      .stat{margin-top:8px;font-size:13px;color:#fff}
      .split{display:flex;gap:8px;margin-top:8px;justify-content:center;font-size:12px}
      .split>div{background:rgba(0,0,0,.25);padding:6px 10px;border-radius:8px;}
      .table-wrap{background:#0f172a;border-radius:12px;overflow-x:auto;border:1px solid #334155;}
      table{width:100%;border-collapse:collapse;font-size:12px}
      th{background:#1e40af;color:#fff;padding:10px 4px;font-size:10px;text-transform:uppercase;}
      td{padding:10px 4px;text-align:center;border-bottom:1px solid #1e293b;}
      .tai{color:#22c55e;font-weight:700}.xiu{color:#ef4444;font-weight:700}
      .dung{color:#22c55e;font-weight:700}.sai{color:#ef4444;font-weight:700}.cho{color:#94a3b8;font-weight:600}
      .dice{color:#fbbf24;font-weight:700;line-height:1.2}
      .sum{display:inline-block;padding:4px 8px;border-radius:6px;background:#334155;color:#fbbf24;font-weight:800;font-size:13px}
      .session{font-family:monospace;font-size:11px;color:#64748b}
      .ti-le{font-size:12px;color:#cbd5e1;font-weight:600}
      .ti-le.weak{color:#fbbf24;background:#78350f;padding:2px 6px;border-radius:4px;}
      .ti-le.veryweak{color:#fca5a5;background:#7f1d1d;padding:2px 6px;border-radius:4px;}
      .badge{display:inline-block;padding:4px 6px;border-radius:4px;font-size:10px;font-weight:700;white-space:nowrap;background:#334155;color:#cbd5e1}
    </style>
    <script>setTimeout(()=>location.reload(), 5000);</script>
    </head>
    <body>
      <div class="header">
        <h1>META V13 · ${game.toUpperCase()}</h1>
        <div class="stat">Chính xác: <strong>${acc}%</strong> (${settled.length} phiên)</div>
        <div class="split">
          <div>🔥 Mạnh: <strong>${sWR}%</strong> (${strong.length})</div>
          <div>⚠️ Yếu: <strong>${wWR}%</strong> (${weak.length})</div>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>PHIÊN</th><th>XX</th><th>TỔNG</th><th>KQ</th><th>DỰ ĐOÁN</th><th>TỈ LỆ</th><th>LOẠI CẦU</th><th>TT</th></tr></thead>
          <tbody>
            ${rows.map(it => {
              const dice = (it.xucXac || []).join('-').replace(/-/g, '-<br>');
              const kq = it.ketQua === 'T' ? 'tai' : 'xiu';
              const dd = it.DU_DOAN_CODE === 'T' ? 'tai' : 'xiu';
              const tt = it.trangThai === 'ĐÚNG' ? 'dung' : (it.trangThai === 'SAI' ? 'sai' : 'cho');
              const tC = it.veryWeak ? 'veryweak' : (it.weak ? 'weak' : '');
              return `<tr>
                <td class="session">${it.phien}</td><td class="dice">${dice}</td>
                <td><span class="sum">${it.tong || ''}</span></td><td class="${kq}">${it.ketQuaLabel || ''}</td>
                <td class="${dd}">${it.DU_DOAN || ''}</td>
                <td><span class="ti-le ${tC}">${it.TI_LE}</span></td>
                <td><span class="badge">${it.patternName}</span></td>
                <td class="${tt}">${it.trangThai === 'ĐANG CHỜ' ? '...' : it.trangThai}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </body>
    </html>`;
    res.send(html);
});

app.listen(PORT, () => console.log(`🚀 META V13 - 120+ PATTERNS chạy port ${PORT}`));
