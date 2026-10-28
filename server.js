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
// 2. HELPERS & DATABASE
// ============================================================
function safeInt(x, def = 0) { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
const label = c => c === 'T' ? 'TÀI' : (c === 'X' ? 'XỈU' : null);
const flip  = c => c === 'T' ? 'X'   : (c === 'X' ? 'T'   : null);

function dbPath(g) { return path.join(DB_DIR, `db_v55_${g}.json`); }
function readDB(g) {
    const p = dbPath(g);
    try {
        if (fs.existsSync(p)) {
            const db = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (!db.rawHistory) db.rawHistory = [];
            if (!db.weights) db.weights = {};
            if (!db.history) db.history = [];
            return db;
        }
    } catch (e) {}
    return { history: [], lastSession: null, rawHistory: [], weights: {} };
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

// Hàm lấy thống kê cơ bản dùng chung
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

    return { L, tCount, xCount, entropy, maxStreak, zigzagRatio, purity: 1 - entropy };
}

// ============================================================
// 3. NHẬN DIỆN MÔI TRƯỜNG RIÊNG BIỆT CHO TỪNG GAME
// ============================================================

// --- 3.1 MÔI TRƯỜNG MD5 (Chu kỳ & Đối xứng) ---
function profileEnvMD5(seq) {
    if (seq.length < 10) return { type: 'CHƯA_ĐỦ_DATA', confidence: 0, efs: 0, purity: 0, entropy: 1, dominant: null, stats: { L: seq.length } };
    const base = getBaseStats(seq);
    
    // Tìm chu kỳ lặp lại
    let maxCycle = 0, cyclePattern = '';
    for (let cLen = 2; cLen <= 6; cLen++) {
        if (seq.length < cLen * 2) continue;
        let match = 0;
        for (let i = cLen; i < seq.length; i++) {
            if (seq[i] === seq[i - cLen]) match++; else break;
        }
        if (match > maxCycle) { maxCycle = match; cyclePattern = seq.slice(0, cLen).join(''); }
    }

    let type = 'HỖN_HỢP', conf = 0.5;
    
    if (maxCycle >= 8) { type = 'CHU_KY_MANH'; conf = 0.9; }
    else if (maxCycle >= 5) { type = 'CHU_KY_VUA'; conf = 0.75; }
    else if (base.entropy > 0.95) { type = 'NHIỄU_CAO'; conf = 0.85; }
    else if (base.zigzagRatio > 0.85) { type = 'ZIGZAG_1_1'; conf = 0.8; }
    else if (base.maxStreak >= 5) { type = 'BỆT_MD5'; conf = 0.75; }
    else if (Math.abs(base.tCount - base.xCount) > base.L * 0.3) { type = 'XU_HUONG_MD5'; conf = 0.7; }

    const efs = (clamp(base.L / 60, 0, 1) * 0.3 + base.purity * 0.3 + conf * 0.2 + (1 - base.entropy) * 0.2) * 100;
    const dominant = Math.abs(base.tCount - base.xCount) > 0.15 * base.L ? (base.tCount > base.xCount ? 'T' : 'X') : null;

    return { type, confidence: conf, efs: Math.round(efs * 10) / 10, purity: base.purity, entropy: base.entropy, dominant, maxCycle, cyclePattern, stats: base };
}

// --- 3.2 MÔI TRƯỜNG TÀI XỈU (Xác suất & Cân bằng) ---
function profileEnvTX(seq) {
    if (seq.length < 10) return { type: 'CHƯA_ĐỦ_DATA', confidence: 0, efs: 0, purity: 0, entropy: 1, dominant: null, stats: { L: seq.length } };
    const base = getBaseStats(seq);

    // Phân tích 20 phiên gần nhất để xem xu hướng ngắn hạn
    const recent = seq.slice(0, Math.min(20, seq.length));
    const rT = recent.filter(x => x === 'T').length;
    const rX = recent.length - rT;
    const recentBalance = Math.abs(rT - rX) / recent.length;

    let type = 'HỖN_HỢP', conf = 0.5;

    if (base.entropy > 0.98) { type = 'NHIỄU_TUYỆT_ĐỐI'; conf = 0.95; }
    else if (base.entropy > 0.93) { type = 'NHIỄU_CAO'; conf = 0.85; }
    else if (base.maxStreak >= 7) { type = 'BỆT_TRƯỜNG'; conf = 0.9; }
    else if (base.maxStreak >= 4 && base.zigzagRatio < 0.4) { type = 'BỆT_NHẸ'; conf = 0.75; }
    else if (base.zigzagRatio > 0.85) { type = 'ZIGZAG_ĐẢO_1_1'; conf = 0.85; }
    else if (recentBalance > 0.4) { type = 'XU_HUONG_NGẮN'; conf = 0.75; }
    else if (base.entropy < 0.6) { type = 'CÂN_BẰNG_TỐT'; conf = 0.7; }

    const efs = (clamp(base.L / 60, 0, 1) * 0.25 + base.purity * 0.35 + conf * 0.2 + (1 - base.entropy) * 0.2) * 100;
    const dominant = Math.abs(base.tCount - base.xCount) > 0.15 * base.L ? (base.tCount > base.xCount ? 'T' : 'X') : null;

    return { type, confidence: conf, efs: Math.round(efs * 10) / 10, purity: base.purity, entropy: base.entropy, dominant, recentBalance, stats: base };
}

// --- 3.3 MÔI TRƯỜNG B52 (Động lượng & Biến động mạnh) ---
function profileEnvB52(seq) {
    if (seq.length < 10) return { type: 'CHƯA_ĐỦ_DATA', confidence: 0, efs: 0, purity: 0, entropy: 1, dominant: null, stats: { L: seq.length } };
    const base = getBaseStats(seq);

    // Phân tích động lượng 10 phiên
    const recent10 = seq.slice(0, 10);
    const t10 = recent10.filter(x => x === 'T').length;
    const momentum = (t10 - 5) / 5; // Từ -1 đến 1

    // Phân tích đỉnh/đáy (Kháng cự/Hỗ trợ)
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

    const efs = (clamp(base.L / 60, 0, 1) * 0.2 + base.purity * 0.3 + conf * 0.3 + (1 - base.entropy) * 0.2) * 100;
    const dominant = Math.abs(base.tCount - base.xCount) > 0.15 * base.L ? (base.tCount > base.xCount ? 'T' : 'X') : null;

    return { type, confidence: conf, efs: Math.round(efs * 10) / 10, purity: base.purity, entropy: base.entropy, dominant, momentum, resistance, support, stats: base };
}

// ============================================================
// 4. TOÀN BỘ THUẬT TOÁN CẦU (PHÂN BỔ THEO GAME)
// ============================================================

// --- 4.1 CẦU DÀNH CHO MD5 (Siêu chu kỳ, Đối xứng, Markov) ---
const MD5_ALGOS = {
    cauSieuchuKyMD5(seq, votes) {
        for (let cLen = 2; cLen <= 6; cLen++) {
            if (seq.length < cLen * 3) continue;
            const p1 = seq.slice(0, cLen).join(''), p2 = seq.slice(cLen, cLen*2).join(''), p3 = seq.slice(cLen*2, cLen*3).join('');
            if (p1 === p2 && p1 === p3) votes.push({ code: seq[cLen*3], name: `Siêu Chu Kỳ ${cLen}`, w: 2.0 });
        }
    },
    cauDoiXungMD5(seq, votes) {
        if (seq.length < 8) return;
        const p = seq.slice(0, 8).join('');
        if (p === 'TTXXTTXX' || p === 'XXTTXXTT') votes.push({ code: seq[0], name: 'Đối Xứng Kép', w: 1.6 });
        if (p === 'TXXTTXXT' || p === 'XTTXTTXX') votes.push({ code: flip(seq[0]), name: 'Đối Xứng Nghịch', w: 1.5 });
    },
    cauBetMD5(seq, votes) {
        let len = 1; for (let i = 1; i < seq.length; i++) { if (seq[i] === seq[0]) len++; else break; }
        if (len >= 4) votes.push({ code: len >= 8 ? flip(seq[0]) : seq[0], name: `Bệt Dài ${len}`, w: 1.8 });
    },
    cauGapMD5(seq, votes) {
        if (seq.length < 6) return;
        // Cầu khoảng cách 1-1-1
        if (seq[0] === seq[2] && seq[1] !== seq[0] && seq[2] === seq[4]) votes.push({ code: seq[1], name: 'Cầu Khoảng Cách 1-1', w: 1.4 });
    },
    markovMD5(seq, votes) {
        const trans = { TT: 0, TX: 0, XT: 0, XX: 0 };
        for (let i = 1; i < seq.length; i++) trans[seq[i-1] + seq[i]]++;
        const last = seq[0];
        const nextT = trans[last + 'T'], nextX = trans[last + 'X'];
        if (nextT + nextX > 10) {
            votes.push({ code: nextT > nextX ? 'T' : 'X', name: 'Markov MD5', w: clamp(Math.abs(nextT - nextX) / (nextT + nextX) * 2, 0.5, 1.6) });
        }
    }
};

// --- 4.2 CẦU DÀNH CHO TÀI XỈU (Đảo, Bệt, Fibonacci) ---
const TAIXIU_ALGOS = {
    cauDao11TX(seq, votes) {
        let len = 1; for (let i = 1; i < Math.min(seq.length, 15); i++) { if (seq[i] !== seq[i-1]) len++; else break; }
        if (len >= 5) votes.push({ code: flip(seq[0]), name: `Đảo 1-1 Cấp Cao (${len})`, w: 1.8 });
    },
    cau3Van1TX(seq, votes) {
        if (seq.length < 8) return;
        const p = seq.slice(0, 7).join('');
        if (p === 'TTTXXXX' || p === 'XXXTTTT') votes.push({ code: seq[0], name: '3 Ván 1 Chuẩn', w: 1.7 });
    },
    cauTuNhienTX(seq, votes) {
        const t = seq.slice(0, 20).filter(x => x === 'T').length;
        if (t > 14) votes.push({ code: 'X', name: 'Bẻ Tự Nhiên (T nhiều)', w: 1.3 });
        if (t < 6) votes.push({ code: 'T', name: 'Bẻ Tự Nhiên (X nhiều)', w: 1.3 });
    },
    fibonacciTX(seq, votes) {
        const fib = [1, 2, 3, 5, 8, 13];
        let cur = seq[0], len = 1, match = 0;
        for (let i = 1; i < seq.length; i++) {
            if (seq[i] === cur) len++;
            else { if (fib.includes(len)) match++; cur = seq[i]; len = 1; }
        }
        if (match >= 3) votes.push({ code: flip(seq[0]), name: 'Fibonacci TX', w: 1.5 });
    },
    smartBetTX(seq, votes) {
        let t = 0, x = 0;
        for (let i = 0; i < 6; i++) { if (seq[i] === 'T') t++; else x++; }
        if (t === 6) votes.push({ code: 'X', name: 'Smart Bet (Bệt T)', w: 1.6 });
        if (x === 6) votes.push({ code: 'T', name: 'Smart Bet (Bệt X)', w: 1.6 });
    }
};

// --- 4.3 CẦU DÀNH CHO B52 (Deep Learning, Momentum, Kháng cự) ---
const B52_ALGOS = {
    deepLearningB52(seq, votes) {
        if (seq.length < 30) return;
        const pattern = seq.slice(0, 5).join('');
        let match = 0, nextT = 0, nextX = 0;
        for (let i = 5; i < seq.length - 5; i++) {
            if (seq.slice(i, i+5).join('') === pattern) {
                match++;
                if (seq[i-1] === 'T') nextT++; else nextX++;
            }
        }
        if (match >= 2) votes.push({ code: nextT >= nextX ? 'T' : 'X', name: `DeepLearning B52 (${match} lần)`, w: 2.0 });
    },
    cauNhayCocB52(seq, votes) {
        if (seq.length < 8) return;
        let flips = 0; for (let i = 1; i < 8; i++) if (seq[i] !== seq[i-1]) flips++;
        if (flips >= 7) votes.push({ code: flip(seq[0]), name: 'Nhảy Cóc B52', w: 1.6 });
    },
    resistanceSupportB52(seq, votes) {
        const last = seq[0];
        let touches = 0;
        for (let i = 1; i < Math.min(20, seq.length); i++) if (seq[i] === last) touches++;
        if (touches >= 6) votes.push({ code: flip(last), name: 'Kháng Cự B52', w: 1.4 });
    },
    cauBeCauB52(seq, votes) {
        let len = 1; for (let i = 1; i < seq.length; i++) { if (seq[i] === seq[0]) len++; else break; }
        if (len >= 3 && seq[len] === flip(seq[0])) votes.push({ code: seq[0], name: 'Bẻ Cầu B52', w: 1.5 });
    },
    momentumB52(seq, votes) {
        const recent = seq.slice(0, 10);
        let t = recent.filter(x => x === 'T').length;
        if (t >= 8) votes.push({ code: 'X', name: 'Đà Giảm Nhiệt', w: 1.3 });
        if (t <= 2) votes.push({ code: 'T', name: 'Đà Tăng Nhiệt', w: 1.3 });
    }
};

// ============================================================
// 5. BỘ TỔNG HỢP ENSEMBLE (CHỌN CẦU THEO MÔI TRƯỜNG)
// ============================================================
function runEnsemble(game, seq, env) {
    let votes = [];
    let disabledPatterns = [];

    // Lọc cầu dựa trên môi trường (Environment Filter)
    if (game === 'md5') {
        if (env.type === 'NHIỄU_CAO') disabledPatterns = ['Bệt', 'Đối Xứng'];
        if (env.type === 'BỆT_MD5') disabledPatterns = ['Đảo', 'Zigzag'];
        MD5_ALGOS.cauSieuchuKyMD5(seq, votes);
        MD5_ALGOS.cauDoiXungMD5(seq, votes);
        MD5_ALGOS.cauBetMD5(seq, votes);
        MD5_ALGOS.cauGapMD5(seq, votes);
        MD5_ALGOS.markovMD5(seq, votes);
    } else if (game === 'taixiu') {
        if (env.type === 'NHIỄU_TUYỆT_ĐỐI') disabledPatterns = ['Bệt', 'Đảo', '3 Ván'];
        if (env.type === 'BỆT_TRƯỜNG') disabledPatterns = ['Đảo', 'Zigzag'];
        TAIXIU_ALGOS.cauDao11TX(seq, votes);
        TAIXIU_ALGOS.cau3Van1TX(seq, votes);
        TAIXIU_ALGOS.cauTuNhienTX(seq, votes);
        TAIXIU_ALGOS.fibonacciTX(seq, votes);
        TAIXIU_ALGOS.smartBetTX(seq, votes);
    } else if (game === 'b52') {
        if (env.type === 'NHIỄU_CAO_B52') disabledPatterns = ['Bệt', 'Kháng Cự'];
        if (env.type === 'BỆT_DÀI_B52') disabledPatterns = ['Nhảy Cóc', 'Bẻ Cầu'];
        B52_ALGOS.deepLearningB52(seq, votes);
        B52_ALGOS.cauNhayCocB52(seq, votes);
        B52_ALGOS.resistanceSupportB52(seq, votes);
        B52_ALGOS.cauBeCauB52(seq, votes);
        B52_ALGOS.momentumB52(seq, votes);
    }

    // Lọc bỏ cầu bị disable
    votes = votes.filter(v => !disabledPatterns.some(dp => v.name.includes(dp)));

    // Fallback nếu bị disable hết
    if (votes.length === 0) {
        return { code: flip(seq[0]), label: 'Cứu Cánh (Bẻ Cầu)', tiLe: '51.5%', details: [], phase: 'READY' };
    }

    const vT = votes.filter(v => v.code === 'T');
    const vX = votes.filter(v => v.code === 'X');
    const sT = vT.reduce((a, b) => a + b.w, 0);
    const sX = vX.reduce((a, b) => a + b.w, 0);
    
    let winner, confidence, patternName;

    if (sT > sX * 1.2) {
        winner = 'T'; confidence = clamp(0.5 + (sT / (sT + sX)) * 0.4, 0.5, 0.88);
        patternName = vT.sort((a,b)=>b.w-a.w)[0].name;
    } else if (sX > sT * 1.2) {
        winner = 'X'; confidence = clamp(0.5 + (sX / (sT + sX)) * 0.4, 0.5, 0.88);
        patternName = vX.sort((a,b)=>b.w-a.w)[0].name;
    } else {
        winner = flip(seq[0]); confidence = 0.52; patternName = 'Bẻ Cầu (Nhiễu)';
    }

    // Điều chỉnh tỉ lệ
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
// 6. FETCH & XỬ LÝ CHÍNH
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
    let seq = [], latest = null;

    if (game === 'b52') {
        const latestB52 = await fetchB52();
        if (!latestB52) return;
        latest = latestB52;
        const sid = safeInt(latest.sid);

        if (!db.rawHistory.find(x => x.sid === sid)) {
            db.rawHistory.push({ sid, d1: safeInt(latest.d1), d2: safeInt(latest.d2), d3: safeInt(latest.d3), result: getB52Result(latest) });
            if (db.rawHistory.length > 500) db.rawHistory.shift();
            saveDB(game, db);
        }

        seq = db.rawHistory.map(x => x.result).reverse();
        const prev = db.history[db.history.length - 1];

        if (prev && prev.trangThai === 'ĐANG CHỜ' && prev.phien < sid) {
            prev.trangThai = prev.DU_DOAN_CODE === getB52Result(latest) ? 'ĐÚNG' : 'SAI';
            saveDB(game, db);
        }

        if (seq.length >= MIN_SESSIONS) {
            const env = profileEnvB52(seq); // Nhận diện riêng B52
            db.envProfile = env;
            const pred = runEnsemble('b52', seq, env);
            
            if (!prev || prev.phien < sid) {
                db.history.push({
                    phien: sid, xucXac: getB52Dice(latest), tong: getB52Sum(latest),
                    ketQua: getB52Result(latest), ketQuaLabel: label(getB52Result(latest)),
                    phienDuDoan: sid + 1, DU_DOAN_CODE: pred.code, DU_DOAN: label(pred.code),
                    TI_LE: pred.tiLe, patternName: pred.label, details: pred.details,
                    envType: env.type, trangThai: 'ĐANG CHỜ'
                });
                if (db.history.length > 500) db.history.shift();
                saveDB(game, db);
            }
        }
        return;
    }

    // MD5 & TAIXIU
    const list = await fetchApi(game === 'md5' ? API_MD5 : API_TX);
    if (!list.length) return;
    latest = list[list.length - 1];
    seq = list.map(getResult).filter(Boolean).reverse();
    
    const session = safeInt(latest.SessionId);
    if (db.lastSession === session) return;
    db.lastSession = session;

    if (seq.length >= MIN_SESSIONS) {
        const env = game === 'md5' ? profileEnvMD5(seq) : profileEnvTX(seq);
        db.envProfile = env;
        const pred = runEnsemble(game, seq, env);

        const prev = db.history[db.history.length - 1];
        if (prev && prev.trangThai === 'ĐANG CHỜ' && prev.phien < session) {
            prev.trangThai = prev.DU_DOAN_CODE === getResult(latest) ? 'ĐÚNG' : 'SAI';
        }

        db.history.push({
            phien: session, xucXac: getDice(latest), tong: getSum(latest),
            ketQua: getResult(latest), ketQuaLabel: label(getResult(latest)),
            phienDuDoan: session + 1, DU_DOAN_CODE: pred.code, DU_DOAN: label(pred.code),
            TI_LE: pred.tiLe, patternName: pred.label, details: pred.details,
            envType: env.type, trangThai: 'ĐANG CHỜ'
        });
        if (db.history.length > 500) db.history.shift();
        saveDB(game, db);
    }
}

setInterval(() => { processGame('md5'); processGame('taixiu'); processGame('b52'); }, TICK_MS);

// ============================================================
// 7. ROUTERS API
// ============================================================
function buildResponse(game, db) {
    const latest = db.history[db.history.length - 1] || {};
    const env = db.envProfile || { type: 'ĐANG TẢI', confidence: 0, efs: 0, purity: 0, entropy: 1, dominant: null, stats: { L: 0 } };
    
    const pred = latest.DU_DOAN_CODE ? {
        code: latest.DU_DOAN_CODE, label: latest.patternName, tiLe: latest.TI_LE, details: latest.details || []
    } : null;

    const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const win = settled.filter(h => h.trangThai === 'ĐÚNG').length;
    const lose = settled.filter(h => h.trangThai === 'SAI').length;

    return {
        status: "success",
        data: {
            game: game.toUpperCase(),
            phienHienTai: latest.phien || "0",
            phienDuDoan: latest.phienDuDoan || "0",
            duDoan: pred ? label(pred.code) : "ĐANG CHỜ...",
            tiLe: pred ? pred.tiLe : "—",
            liDo: pred ? `⭐ ${pred.label} → ${label(pred.code)} (${pred.tiLe})` : `⏳ Cần thêm ${MIN_SESSIONS - (db.rawHistory.length || 0)} phiên...`,
            xucXac: latest.xucXac || [],
            tongDiem: latest.tong || 0,
            moiTruong: {
                loai: env.type,
                doTinCay: (env.confidence || 0).toFixed(2),
                efs: (env.efs || 0) + "%",
                doTinhKhiet: ((env.purity || 0) * 100).toFixed(1) + "%",
                doNhieu: ((env.entropy || 1) * 100).toFixed(1) + "%",
                nghieng: env.dominant ? label(env.dominant) : "CÂN BẰNG"
            },
            chiTietModel: {
                pattern: pred ? pred.label : '—',
                topAlgos: pred ? pred.details.map(d => `${d.name}`).join(' | ') : '—'
            },
            thongKe: {
                win, lose,
                winrate: settled.length ? ((win / settled.length) * 100).toFixed(1) + '%' : '—',
                bankroll: (1000 + win * 10 - lose * 10) + '$'
            }
        }
    };
}

app.get('/b52', (req, res) => { const db = readDB('b52'); res.json(buildResponse('b52', db)); });
app.get('/taixiu', (req, res) => { const db = readDB('taixiu'); res.json(buildResponse('taixiu', db)); });
app.get('/md5', (req, res) => { const db = readDB('md5'); res.json(buildResponse('md5', db)); });
app.get('/', (req, res) => res.redirect('/b52'));

app.listen(PORT, () => console.log(`🚀 V55 ENVIRONMENT MASTER running on port ${PORT}`));
