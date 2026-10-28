'use strict';
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.json());

// ============================================================
// 1. CẤU HÌNH HỆ THỐNG
// ============================================================
const API_MD5 = 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau';
const API_TX  = 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau';
const API_B52 = 'https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=b5&gid=vgmn_101';

const DB_DIR = process.env.DB_DIR || __dirname;
const TICK_MS = 5000;
const MIN_SESSIONS = 15;

if (!fs.existsSync(DB_DIR)) { try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch (e) {} }

// ============================================================
// 2. DATABASE & HELPERS
// ============================================================
function safeInt(x, def = 0) { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
const label = c => c === 'T' ? 'TÀI' : (c === 'X' ? 'XỈU' : null);
const flip  = c => c === 'T' ? 'X'   : (c === 'X' ? 'T'   : null);

function dbPath(g) { return path.join(DB_DIR, `db_v61_${g}.json`); }
function readDB(g) {
    const p = dbPath(g);
    try {
        if (fs.existsSync(p)) {
            const db = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (!db.rawHistory) db.rawHistory = [];
            if (!db.history) db.history = [];
            return db;
        }
    } catch (e) {}
    return { history: [], lastSession: null, rawHistory: [] };
}
function saveDB(g, db) { try { fs.writeFileSync(dbPath(g), JSON.stringify(db, null, 2)); } catch (e) {} }

function getDice(it) { return [safeInt(it?.FirstDice), safeInt(it?.SecondDice), safeInt(it?.ThirdDice)]; }
function getSum(it) { const s = getDice(it).reduce((a, b) => a + b, 0); return (s >= 3 && s <= 18) ? s : safeInt(it?.DiceSum); }
function getResult(it) { const s = getSum(it); return (s >= 3 && s <= 18) ? (s >= 11 ? 'T' : 'X') : null; }

function getB52Dice(it) { return [safeInt(it?.d1), safeInt(it?.d2), safeInt(it?.d3)]; }
function getB52Sum(it) { return getB52Dice(it).reduce((a, b) => a + b, 0); }
function getB52Result(it) {
    const s = getB52Sum(it);
    if (it.rs === 'T' || it.rs === 'TAI') return 'T';
    if (it.rs === 'X' || it.rs === 'XIU') return 'X';
    return (s >= 11 && s <= 18) ? 'T' : 'X';
}

// ============================================================
// 3. THỐNG KÊ CƠ BẢN (DÙNG CHUNG)
// ============================================================
function getBaseStats(seq) {
    const L = seq.length;
    const tCount = seq.filter(x => x === 'T').length;
    const xCount = L - tCount;
    
    let pT = tCount / L, pX = xCount / L, entropy = 0;
    if (pT > 0) entropy -= pT * Math.log2(pT);
    if (pX > 0) entropy -= pX * Math.log2(pX);

    let maxStreak = 1, curStreak = 1;
    for (let i = 1; i < L; i++) {
        if (seq[i] === seq[i-1]) { curStreak++; if (curStreak > maxStreak) maxStreak = curStreak; }
        else curStreak = 1;
    }

    let flips = 0;
    for (let i = 1; i < Math.min(30, L); i++) if (seq[i] !== seq[i-1]) flips++;
    const zigzagRatio = flips / Math.min(30, L);

    return { 
        L, tCount, xCount, entropy, maxStreak, zigzagRatio, 
        purity: 1 - entropy, 
        bias: (tCount - xCount) / L 
    };
}

// ============================================================
// 4. BỘ NHẬN DIỆN MÔI TRƯỜNG (3 GAME RIÊNG BIỆT)
// ============================================================

// --- 4.1 MD5: Chu kỳ & Đối xứng ---
function profileEnvMD5(seq) {
    if (seq.length < 10) return { type: 'CHƯA_ĐỦ_DATA', confidence: 0, efs: 0, stats: { L: seq.length, bias: 0 } };
    const base = getBaseStats(seq);
    
    let maxCycle = 0;
    for (let cLen = 2; cLen <= 7; cLen++) {
        if (seq.length < cLen * 2) continue;
        let match = 0;
        for (let i = cLen; i < seq.length; i++) {
            if (seq[i] === seq[i - cLen]) match++; else break;
        }
        if (match > maxCycle) maxCycle = match;
    }

    let type = 'HỖN_HỢP', conf = 0.5;
    if (maxCycle >= 8) { type = 'CHU_KY_MANH'; conf = 0.9; }
    else if (maxCycle >= 5) { type = 'CHU_KY_VUA'; conf = 0.75; }
    else if (base.entropy > 0.95) { type = 'NHIỄU_CAO'; conf = 0.85; }
    else if (base.zigzagRatio > 0.85) { type = 'ZIGZAG_1_1'; conf = 0.8; }
    else if (base.maxStreak >= 5) { type = 'BỆT_MD5'; conf = 0.75; }
    else if (Math.abs(base.bias) > 0.3) { type = 'LỆCH_NẶNG'; conf = 0.7; }

    const efs = (clamp(base.L / 60, 0, 1) * 0.3 + base.purity * 0.3 + conf * 0.2 + (1 - base.entropy) * 0.2) * 100;
    return { type, confidence: conf, efs: Math.round(efs * 10) / 10, maxCycle, stats: base };
}

// --- 4.2 TÀI XỈU: Xác suất & Cân bằng ---
function profileEnvTX(seq) {
    if (seq.length < 10) return { type: 'CHƯA_ĐỦ_DATA', confidence: 0, efs: 0, stats: { L: seq.length, bias: 0 } };
    const base = getBaseStats(seq);
    
    const recent = seq.slice(0, Math.min(20, seq.length));
    const rT = recent.filter(x => x === 'T').length;
    const recentBalance = Math.abs(rT - (recent.length - rT)) / recent.length;

    let type = 'HỖN_HỢP', conf = 0.5;
    if (base.entropy > 0.98) { type = 'NHIỄU_TUYỆT_ĐỐI'; conf = 0.95; }
    else if (base.entropy > 0.93) { type = 'NHIỄU_CAO'; conf = 0.85; }
    else if (base.maxStreak >= 7) { type = 'BỆT_TRƯỜNG'; conf = 0.9; }
    else if (base.maxStreak >= 4 && base.zigzagRatio < 0.4) { type = 'BỆT_NHẸ'; conf = 0.75; }
    else if (base.zigzagRatio > 0.85) { type = 'ZIGZAG_ĐẢO_1_1'; conf = 0.85; }
    else if (recentBalance > 0.4) { type = 'XU_HUONG_NGẮN'; conf = 0.75; }
    else if (Math.abs(base.bias) > 0.3) { type = 'LỆCH_NẶNG'; conf = 0.7; }

    const efs = (clamp(base.L / 60, 0, 1) * 0.25 + base.purity * 0.35 + conf * 0.2 + (1 - base.entropy) * 0.2) * 100;
    return { type, confidence: conf, efs: Math.round(efs * 10) / 10, recentBalance, stats: base };
}

// --- 4.3 B52: Động lượng & Biến động ---
function profileEnvB52(seq) {
    if (seq.length < 10) return { type: 'CHƯA_ĐỦ_DATA', confidence: 0, efs: 0, stats: { L: seq.length, bias: 0 } };
    const base = getBaseStats(seq);
    
    const recent10 = seq.slice(0, 10);
    const t10 = recent10.filter(x => x === 'T').length;
    const momentum = (t10 - 5) / 5;

    let resistance = 0, support = 0;
    for (let i = 1; i < seq.length - 1; i++) {
        if (seq[i] === 'T' && seq[i-1] === 'X' && seq[i+1] === 'X') resistance++;
        if (seq[i] === 'X' && seq[i-1] === 'T' && seq[i+1] === 'T') support++;
    }

    let type = 'HỖN_HỢP', conf = 0.5;
    if (base.entropy > 0.95) { type = 'NHIỄU_CAO_B52'; conf = 0.9; }
    else if (base.maxStreak >= 6) { type = 'BỆT_DÀI_B52'; conf = 0.85; }
    else if (base.zigzagRatio > 0.88) { type = 'NHẢY_CÓC_B52'; conf = 0.9; }
    else if (Math.abs(momentum) > 0.6) { type = 'ĐỘNG_LƯỢNG_MẠNH'; conf = 0.8; }
    else if (resistance >= 3 || support >= 3) { type = 'KHÁNG_CỰ_HỖ_TRỢ'; conf = 0.75; }
    else if (base.zigzagRatio > 0.7 && base.entropy > 0.8) { type = 'ZIGZAG_B52'; conf = 0.8; }
    else if (Math.abs(base.bias) > 0.3) { type = 'LỆCH_NẶNG'; conf = 0.7; }

    const efs = (clamp(base.L / 60, 0, 1) * 0.2 + base.purity * 0.3 + conf * 0.3 + (1 - base.entropy) * 0.2) * 100;
    return { type, confidence: conf, efs: Math.round(efs * 10) / 10, momentum, resistance, support, stats: base };
}

// ============================================================
// 5. TOÀN BỘ THUẬT TOÁN CẦU (PHÂN BỔ THEO GAME)
// ============================================================

// --- 5.1 Cầu chung ---
function cauBet(seq, votes) {
    let len = 1; for (let i = 1; i < seq.length; i++) { if (seq[i] === seq[0]) len++; else break; }
    if (len >= 3) votes.push({ code: len >= 7 ? flip(seq[0]) : seq[0], name: `Bệt ${len}`, w: len >= 6 ? 1.3 : 1.8 });
}

function cauDao11(seq, votes) {
    let len = 1; for (let i = 1; i < Math.min(seq.length, 15); i++) { if (seq[i] !== seq[i-1]) len++; else break; }
    if (len >= 4) votes.push({ code: flip(seq[0]), name: `Đảo 1-1 (${len})`, w: 1.8 });
}

function cauRong(seq, votes) {
    let len = 1; for (let i = 1; i < seq.length; i++) { if (seq[i] === seq[0]) len++; else break; }
    if (len >= 6) votes.push({ code: flip(seq[0]), name: `Rồng ${len}`, w: 2.0 });
}

function cauTuNhien(seq, votes) {
    const t = seq.slice(0, 10).filter(x => x === 'T').length;
    if (t >= 8) votes.push({ code: 'X', name: 'Bẻ Tự Nhiên (T nhiều)', w: 1.3 });
    if (t <= 2) votes.push({ code: 'T', name: 'Bẻ Tự Nhiên (X nhiều)', w: 1.3 });
}

function markovChain(seq, votes) {
    const trans = { TT: 0, TX: 0, XT: 0, XX: 0 };
    for (let i = 1; i < seq.length; i++) trans[seq[i-1] + seq[i]]++;
    const last = seq[0];
    const nextT = trans[last + 'T'], nextX = trans[last + 'X'];
    if (nextT + nextX > 10) {
        votes.push({ code: nextT > nextX ? 'T' : 'X', name: 'Markov Chain', w: clamp(Math.abs(nextT - nextX) / (nextT + nextX) * 2, 0.5, 1.6) });
    }
}

// --- 5.2 Cầu MD5 ---
function cauSieuchuKyMD5(seq, votes) {
    for (let cLen = 2; cLen <= 6; cLen++) {
        if (seq.length < cLen * 3) continue;
        const p1 = seq.slice(0, cLen).join(''), p2 = seq.slice(cLen, cLen*2).join(''), p3 = seq.slice(cLen*2, cLen*3).join('');
        if (p1 === p2 && p1 === p3) votes.push({ code: seq[cLen*3], name: `Siêu Chu Kỳ ${cLen}`, w: 2.0 });
    }
}

function cauDoiXungMD5(seq, votes) {
    if (seq.length < 8) return;
    const p = seq.slice(0, 8).join('');
    if (p === 'TTXXTTXX' || p === 'XXTTXXTT') votes.push({ code: seq[0], name: 'Đối Xứng Kép', w: 1.6 });
    if (p === 'TXXTTXXT' || p === 'XTTXTTXX') votes.push({ code: flip(seq[0]), name: 'Đối Xứng Nghịch', w: 1.5 });
}

function cauGapMD5(seq, votes) {
    if (seq.length < 6) return;
    if (seq[0] === seq[2] && seq[1] !== seq[0] && seq[2] === seq[4]) votes.push({ code: seq[1], name: 'Cầu Khoảng Cách 1-1', w: 1.4 });
}

// --- 5.3 Cầu Tài Xỉu ---
function cau3Van1TX(seq, votes) {
    if (seq.length < 8) return;
    const p = seq.slice(0, 7).join('');
    if (p === 'TTTXXXX' || p === 'XXXTTTT') votes.push({ code: seq[0], name: '3 Ván 1 Chuẩn', w: 1.7 });
}

function fibonacciTX(seq, votes) {
    const fib = [1, 2, 3, 5, 8, 13];
    let cur = seq[0], len = 1, match = 0;
    for (let i = 1; i < seq.length; i++) {
        if (seq[i] === cur) len++;
        else { if (fib.includes(len)) match++; cur = seq[i]; len = 1; }
    }
    if (match >= 3) votes.push({ code: flip(seq[0]), name: 'Fibonacci', w: 1.5 });
}

function smartBetTX(seq, votes) {
    let t = 0, x = 0;
    for (let i = 0; i < 6; i++) { if (seq[i] === 'T') t++; else x++; }
    if (t === 6) votes.push({ code: 'X', name: 'Smart Bet (Bệt T)', w: 1.6 });
    if (x === 6) votes.push({ code: 'T', name: 'Smart Bet (Bệt X)', w: 1.6 });
}

// --- 5.4 Cầu B52 ---
function deepLearningB52(seq, votes) {
    if (seq.length < 30) return;
    const pattern = seq.slice(0, 5).join('');
    let match = 0, nextT = 0, nextX = 0;
    for (let i = 5; i < seq.length - 5; i++) {
        if (seq.slice(i, i+5).join('') === pattern) {
            match++;
            if (seq[i-1] === 'T') nextT++; else nextX++;
        }
    }
    if (match >= 2) votes.push({ code: nextT >= nextX ? 'T' : 'X', name: `DeepLearning B52 (${match})`, w: 2.0 });
}

function cauNhayCocB52(seq, votes) {
    if (seq.length < 8) return;
    let flips = 0; for (let i = 1; i < 8; i++) if (seq[i] !== seq[i-1]) flips++;
    if (flips >= 7) votes.push({ code: flip(seq[0]), name: 'Nhảy Cóc B52', w: 1.6 });
}

function resistanceSupportB52(seq, votes) {
    const last = seq[0];
    let touches = 0;
    for (let i = 1; i < Math.min(20, seq.length); i++) if (seq[i] === last) touches++;
    if (touches >= 6) votes.push({ code: flip(last), name: 'Kháng Cự B52', w: 1.4 });
}

function cauBeCauB52(seq, votes) {
    let len = 1; for (let i = 1; i < seq.length; i++) { if (seq[i] === seq[0]) len++; else break; }
    if (len >= 3 && seq[len] === flip(seq[0])) votes.push({ code: seq[0], name: 'Bẻ Cầu B52', w: 1.5 });
}

function momentumB52(seq, votes) {
    const recent = seq.slice(0, 10);
    let t = recent.filter(x => x === 'T').length;
    if (t >= 8) votes.push({ code: 'X', name: 'Đà Giảm Nhiệt', w: 1.3 });
    if (t <= 2) votes.push({ code: 'T', name: 'Đà Tăng Nhiệt', w: 1.3 });
}

// ============================================================
// 6. BỘ TỔNG HỢP SẮT (NO MERCY)
// ============================================================
function runFinalPrediction(game, seq, env) {
    // 1. Kiểm tra dữ liệu đầu vào
    if (seq.length < MIN_SESSIONS) {
        return { code: null, label: 'Đang chờ dữ liệu...', tiLe: '—', details: [], phase: 'WAITING' };
    }

    // 2. Kích hoạt cầu theo game
    let votes = [];
    if (game === 'md5') {
        cauSieuchuKyMD5(seq, votes);
        cauDoiXungMD5(seq, votes);
        cauGapMD5(seq, votes);
        cauBet(seq, votes);
        cauDao11(seq, votes);
        markovChain(seq, votes);
    } else if (game === 'taixiu') {
        cau3Van1TX(seq, votes);
        fibonacciTX(seq, votes);
        smartBetTX(seq, votes);
        cauDao11(seq, votes);
        cauBet(seq, votes);
        cauTuNhien(seq, votes);
        markovChain(seq, votes);
    } else if (game === 'b52') {
        deepLearningB52(seq, votes);
        cauNhayCocB52(seq, votes);
        resistanceSupportB52(seq, votes);
        cauBeCauB52(seq, votes);
        momentumB52(seq, votes);
        cauBet(seq, votes);
        cauDao11(seq, votes);
        markovChain(seq, votes);
    }

    // 3. TẦNG 2: KHÓA CỬA (LOCKOUT) - 8 phiên liên tiếp 1 cửa -> ép ngược
    const last8 = seq.slice(0, 8);
    if (last8.length === 8 && last8.every(x => x === 'T')) {
        return { code: 'X', label: 'Khóa Cửa (Ép Xỉu 8 phiên)', tiLe: '55.0%', details: [], phase: 'READY' };
    }
    if (last8.length === 8 && last8.every(x => x === 'X')) {
        return { code: 'T', label: 'Khóa Cửa (Ép Tài 8 phiên)', tiLe: '55.0%', details: [], phase: 'READY' };
    }

    // 4. TẦNG 1: ÉP CÂN BẰNG - Nếu lịch sử lệch > 20% -> ép ngược
    if (env.stats.bias > 0.2) {
        return { code: 'X', label: `Ép Cân Bằng (Lịch sử lệch Tài ${(env.stats.bias * 100).toFixed(0)}%)`, tiLe: '55.0%', details: [], phase: 'READY' };
    }
    if (env.stats.bias < -0.2) {
        return { code: 'T', label: `Ép Cân Bằng (Lịch sử lệch Xỉu ${(Math.abs(env.stats.bias) * 100).toFixed(0)}%)`, tiLe: '55.0%', details: [], phase: 'READY' };
    }

    // 5. TẦNG 3: TÍNH ĐIỂM BÌNH THƯỜNG
    if (votes.length === 0) {
        return { code: flip(seq[0]), label: 'Bẻ Cầu Nhẹ', tiLe: '51.5%', details: [], phase: 'READY' };
    }

    const vT = votes.filter(v => v.code === 'T');
    const vX = votes.filter(v => v.code === 'X');
    const sT = vT.reduce((a, b) => a + b.w, 0);
    const sX = vX.reduce((a, b) => a + b.w, 0);

    let winner, confidence, patternName;
    if (sT > sX * 1.25) {
        winner = 'T'; confidence = clamp(0.5 + (sT / (sT + sX)) * 0.4, 0.5, 0.88);
        patternName = vT.sort((a,b)=>b.w-a.w)[0].name;
    } else if (sX > sT * 1.25) {
        winner = 'X'; confidence = clamp(0.5 + (sX / (sT + sX)) * 0.4, 0.5, 0.88);
        patternName = vX.sort((a,b)=>b.w-a.w)[0].name;
    } else {
        // Hòa: Bẻ cầu thông minh
        const last = seq[0];
        const secondLast = seq[1] || last;
        if (last === secondLast) { winner = flip(last); patternName = 'Bẻ Cầu (Hòa)'; }
        else { winner = last; patternName = 'Theo Cầu (Hòa)'; }
        confidence = 0.52;
    }

    if (env.stats.L < 30) confidence = clamp(confidence * 0.9, 0.51, 0.6);
    else if (env.efs > 80) confidence = clamp(confidence + 0.05, 0.51, 0.90);
    else if (env.efs < 50) confidence = clamp(confidence - 0.03, 0.51, 0.60);

    return {
        code: winner,
        label: patternName,
        tiLe: (confidence * 100).toFixed(1) + '%',
        details: votes.sort((a,b)=>b.w-a.w).slice(0, 3),
        phase: 'READY'
    };
}

// ============================================================
// 7. FETCH & LƯU DB (CHẠY NGẦM)
// ============================================================
async function fetchApi(url) {
    try {
        const res = await axios.get(url, { timeout: 8000 });
        let arr = res.data?.data?.list || res.data?.list || res.data?.data || (Array.isArray(res.data) ? res.data : []);
        if (arr.length >= 2 && Number(arr[0].SessionId) > Number(arr[arr.length - 1].SessionId)) arr.reverse();
        return arr;
    } catch (e) { return []; }
}

async function fetchB52() {
    try {
        const res = await axios.get(API_B52, { timeout: 8000 });
        if (!res.data?.data || !Array.isArray(res.data.data) || res.data.data.length === 0) return null;
        return res.data.data[0];
    } catch (e) { return null; }
}

async function processGame(game) {
    const db = readDB(game);

    if (game === 'b52') {
        const latest = await fetchB52();
        if (!latest) return;
        const sid = safeInt(latest.sid);
        if (!db.rawHistory.find(x => x.sid === sid)) {
            db.rawHistory.push({ sid, d1: safeInt(latest.d1), d2: safeInt(latest.d2), d3: safeInt(latest.d3), result: getB52Result(latest) });
            if (db.rawHistory.length > 500) db.rawHistory.shift();
            saveDB(game, db);
        }
        return;
    }

    const list = await fetchApi(game === 'md5' ? API_MD5 : API_TX);
    if (!list.length) return;
    list.forEach(latest => {
        const session = safeInt(latest.SessionId);
        if (!db.rawHistory.find(x => x.sid === session)) {
            db.rawHistory.push({ 
                sid: session, d1: safeInt(latest.FirstDice), d2: safeInt(latest.SecondDice), d3: safeInt(latest.ThirdDice), 
                result: getResult(latest) 
            });
        }
    });
    if (db.rawHistory.length > 500) db.rawHistory = db.rawHistory.slice(-500);
    saveDB(game, db);
}

setInterval(() => { processGame('md5'); processGame('taixiu'); processGame('b52'); }, TICK_MS);

// ============================================================
// 8. ROUTERS (DỰ ĐOÁN NGAY TỪ DB)
// ============================================================
function buildResponse(game, db) {
    // Lấy lịch sử
    const seq = db.rawHistory.map(x => x.result).reverse();
    const env = game === 'md5' ? profileEnvMD5(seq) : (game === 'taixiu' ? profileEnvTX(seq) : profileEnvB52(seq));
    
    // 🔥 Dự đoán ngay lập tức
    const pred = runFinalPrediction(game, seq, env);
    const latestHist = db.history[db.history.length - 1] || {};

    return {
        status: "success",
        data: {
            game: game.toUpperCase(),
            phienHienTai: latestHist.phien || (seq.length > 0 ? db.rawHistory[db.rawHistory.length - 1].sid : "0"),
            phienDuDoan: latestHist.phienDuDoan || (seq.length > 0 ? db.rawHistory[db.rawHistory.length - 1].sid + 1 : "0"),
            duDoan: pred.code ? label(pred.code) : "ĐANG CHỜ...",
            tiLe: pred.tiLe,
            liDo: pred.code ? `⭐ ${pred.label} → ${label(pred.code)} (${pred.tiLe})` : pred.label,
            xucXac: latestHist.xucXac || (db.rawHistory.length > 0 ? [db.rawHistory[db.rawHistory.length - 1].d1, db.rawHistory[db.rawHistory.length - 1].d2, db.rawHistory[db.rawHistory.length - 1].d3] : []),
            tongDiem: latestHist.tong || (db.rawHistory.length > 0 ? db.rawHistory[db.rawHistory.length - 1].d1 + db.rawHistory[db.rawHistory.length - 1].d2 + db.rawHistory[db.rawHistory.length - 1].d3 : 0),
            moiTruong: {
                loai: env.type,
                efs: env.efs + "%",
                doLech: (env.stats.bias * 100).toFixed(1) + "%",
                nghieng: env.stats.bias > 0.1 ? "TÀI" : (env.stats.bias < -0.1 ? "XỈU" : "CÂN BẰNG")
            },
            chiTietModel: {
                pattern: pred.label,
                topAlgos: pred.details.map(d => d.name).join(' | ')
            }
        }
    };
}

app.get('/b52', (req, res) => { const db = readDB('b52'); res.json(buildResponse('b52', db)); });
app.get('/taixiu', (req, res) => { const db = readDB('taixiu'); res.json(buildResponse('taixiu', db)); });
app.get('/md5', (req, res) => { const db = readDB('md5'); res.json(buildResponse('md5', db)); });
app.get('/', (req, res) => res.redirect('/b52'));

app.listen(PORT, () => console.log(`🚀 V61 FULL TITAN INSTANT running on port ${PORT}`));
