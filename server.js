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
// 1. CẤU HÌNH API & HỆ THỐNG
// ============================================================
const API_MD5 = 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau';
const API_TX  = 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau';
const API_B52 = 'https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=b5&gid=vgmn_101';

const DB_DIR = process.env.DB_DIR || __dirname;
const TICK_MS = 5000;

const CONFIG = {
    WARMUP: { MIN_SESSIONS: 15, FULL_SESSIONS: 60, EFS_TARGET: 80 },
    ENV: { MIN_SAMPLES: 10 }
};

// Trọng số mặc định cho TẤT CẢ các loại cầu
const DEFAULT_PATTERN_WEIGHTS = {
    // Nhóm cầu cơ bản
    'cau_bet': 1.0, 'cau_dao_11': 1.0, 'cau_rong': 1.0, 'cau_tu_nhien': 1.0,
    // Nhóm cầu đối xứng & chu kỳ
    'cau_22': 1.0, 'cau_33': 1.0, 'cau_44': 1.0, 'cau_55': 1.0,
    'cau_121': 1.0, 'cau_212': 1.0, 'cau_123': 1.0, 'cau_321': 1.0,
    'cau_1221': 1.0, 'cau_2112': 1.0, 'cau_chu_ky': 1.0,
    // Nhóm cầu phức tạp
    'cau_nhay_coc': 1.0, 'cau_nhip_nghieng': 1.0, 'cau_3van1': 1.0,
    'cau_be_cau': 1.0, 'cau_gap': 1.0, 'cau_ziczac': 1.0,
    'cau_doi': 1.0, 'cau_rong_bat_tan': 1.0, 'cau_bet_gay': 1.0,
    // Nhóm thuật toán & thống kê
    'markov_chain': 1.2, 'moving_avg_drift': 1.1, 'sum_pressure': 1.1,
    'volatility': 1.0, 'distribution': 1.0, 'dice_pattern': 1.0,
    'sum_trend': 1.0, 'edge_cases': 1.0, 'momentum': 1.0,
    'dice_trend_line': 1.0, 'break_pattern': 1.0, 'fibonacci': 1.0,
    'resistance_support': 1.0, 'wave': 1.0, 'golden_ratio': 1.0,
    'smart_bet': 1.0
};

if (!fs.existsSync(DB_DIR)) { try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch (e) {} }

// ============================================================
// 2. HELPERS & DATABASE
// ============================================================
function safeInt(x, def = 0) { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
const label = c => c === 'T' ? 'TÀI' : (c === 'X' ? 'XỈU' : null);
const flip  = c => c === 'T' ? 'X'   : (c === 'X' ? 'T'   : null);

function dbPath(g) { return path.join(DB_DIR, `db_v52_${g}.json`); }
function readDB(g) {
    const p = dbPath(g);
    try {
        if (fs.existsSync(p)) {
            const db = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (!db.weights) db.weights = {};
            if (!db.streakStats) db.streakStats = { T: {}, X: {} };
            if (!db.rawHistory) db.rawHistory = [];
            if (!db.patternPerformance) db.patternPerformance = {};
            return db;
        }
    } catch (e) {}
    return { history: [], lastSession: null, weights: {}, streakStats: { T: {}, X: {} }, envProfile: null, rawHistory: [], patternPerformance: {} };
}
function saveDB(g, db) { try { fs.writeFileSync(dbPath(g), JSON.stringify(db, null, 2)); } catch (e) {} }

function getDice(it) { return [safeInt(it?.FirstDice), safeInt(it?.SecondDice), safeInt(it?.ThirdDice)]; }
function getSum(it) { const s = getDice(it).reduce((a, b) => a + b, 0); return (s >= 3 && s <= 18) ? s : safeInt(it?.DiceSum); }
function getResult(it) { const s = getSum(it); return (s >= 3 && s <= 18) ? (s >= 11 ? 'T' : 'X') : null; }

// B52 Helpers
function getB52Dice(it) { return [safeInt(it?.d1), safeInt(it?.d2), safeInt(it?.d3)]; }
function getB52Sum(it) { return getB52Dice(it).reduce((a, b) => a + b, 0); }
function getB52Result(it) {
    const s = getB52Sum(it);
    if (it.rs === 'T' || it.rs === 'TAI') return 'T';
    if (it.rs === 'X' || it.rs === 'XIU') return 'X';
    return (s >= 11 && s <= 18) ? 'T' : 'X';
}

function updateStreakStats(seq, db) {
    if (!db.streakStats) db.streakStats = { T: {}, X: {} };
    let cur = seq[0], len = 1;
    for (let i = 1; i < seq.length; i++) {
        if (seq[i] === cur) len++;
        else {
            if (!db.streakStats[cur][len]) db.streakStats[cur][len] = { cont: 0, stop: 0 };
            db.streakStats[cur][len].stop++;
            for (let l = 1; l < len; l++) {
                if (!db.streakStats[cur][l]) db.streakStats[cur][l] = { cont: 0, stop: 0 };
                db.streakStats[cur][l].cont++;
            }
            cur = seq[i]; len = 1;
        }
    }
}

// ============================================================
// 3. NHẬN DIỆN MÔI TRƯỜNG CỤC MẠNH (ENVIRONMENT PROFILER)
// ============================================================
function profileEnvironment(seq) {
    const L = seq.length;
    if (L < CONFIG.ENV.MIN_SAMPLES) {
        return { type: 'CHƯA_ĐỦ_DATA', confidence: 0, efs: 0, purity: 0, entropy: 1, dominant: null, availablePatterns: [], disabledPatterns: [], stats: { L: L } };
    }

    // 1. Phân tích phân phối & Entropy
    const tCount = seq.filter(x => x === 'T').length;
    const xCount = L - tCount;
    const balance = Math.abs(tCount - xCount) / L;
    let pT = tCount / L, pX = xCount / L;
    let entropy = 0;
    if (pT > 0) entropy -= pT * Math.log2(pT);
    if (pX > 0) entropy -= pX * Math.log2(pX);

    // 2. Phân tích Chuỗi (Streak)
    let streaks = [], cur = seq[0], len = 1;
    for (let i = 1; i < L; i++) {
        if (seq[i] === cur) len++;
        else { streaks.push({ type: cur, len: len }); cur = seq[i]; len = 1; }
    }
    streaks.push({ type: cur, len: len });
    const maxStreak = Math.max(...streaks.map(s => s.len));
    const streakRatio = streaks.filter(s => s.len >= 3).length / streaks.length;

    // 3. Phân tích Zigzag (Đảo nhịp)
    const rec20 = seq.slice(-Math.min(30, L));
    let flips20 = 0;
    for (let i = 1; i < rec20.length; i++) if (rec20[i] !== rec20[i-1]) flips20++;
    const zigzagRatio = rec20.length > 1 ? flips20 / (rec20.length - 1) : 0;

    // 4. Phân tích Chu kỳ (Pattern Repeating)
    let maxCycle = 0;
    for (let cycleLen = 2; cycleLen <= 6; cycleLen++) {
        let match = 0;
        for (let i = seq.length - cycleLen; i >= cycleLen; i--) {
            if (seq[i] === seq[i - cycleLen]) match++; else break;
        }
        if (match > maxCycle) maxCycle = match;
    }

    // 5. Đánh giá Trạng thái Môi trường
    let type = 'HỖN_HỢP', confidence = 0.5;
    const purity = 1 - entropy;

    if (entropy > 0.95) { 
        type = 'NHIỄU_CAO'; confidence = clamp((entropy - 0.95) * 20, 0, 1); 
    } else if (maxCycle >= 5) { 
        type = 'CHU_KY'; confidence = clamp(maxCycle / 10, 0.6, 0.95); 
    } else if (entropy < 0.45 && (streakRatio > 0.4 || maxStreak >= 5)) { 
        type = 'BỆT_NẶNG'; confidence = clamp((0.5 - entropy) * 3, 0.6, 1); 
    } else if (zigzagRatio > 0.8 && entropy > 0.85) { 
        type = 'ZIGZAG'; confidence = clamp((zigzagRatio - 0.8) * 5, 0.6, 1); 
    } else if (Math.abs(tCount - xCount) > L * 0.25) { 
        type = 'XU_HUONG'; confidence = clamp(balance * 2, 0.5, 0.8); 
    } else if (entropy < 0.7 && streakRatio > 0.2) { 
        type = 'BỆT_NHẸ'; confidence = 0.6; 
    }

    // 6. Thiết lập Available/Disabled Patterns
    const allPatterns = Object.keys(DEFAULT_PATTERN_WEIGHTS);
    let available = [...allPatterns], disabled = [];

    if (type === 'NHIỄU_CAO') {
        disabled = ['cau_bet', 'cau_dao_11', 'cau_rong', 'cau_22', 'cau_33'];
        available = ['markov_chain', 'break_pattern', 'smart_bet', 'distribution'];
    } else if (type === 'BỆT_NẶNG' || type === 'BỆT_NHẸ') {
        disabled = ['cau_dao_11', 'cau_ziczac', 'cau_121'];
        available = ['cau_bet', 'cau_rong', 'cau_rong_bat_tan', 'cau_bet_gay'];
    } else if (type === 'ZIGZAG') {
        disabled = ['cau_bet', 'cau_rong', 'cau_3van1'];
        available = ['cau_dao_11', 'cau_121', 'cau_212', 'cau_ziczac'];
    } else if (type === 'CHU_KY') {
        available = ['cau_chu_ky', 'cau_22', 'cau_33', 'cau_121', 'cau_123', 'cau_1221'];
    }

    // 7. Tính EFS (Environment Favorability Score)
    const dataVolume = clamp(L / CONFIG.WARMUP.FULL_SESSIONS, 0, 1);
    const efs = (dataVolume * 0.35 + purity * 0.30 + confidence * 0.20 + (1 - entropy) * 0.15) * 100;

    const dominant = balance > 0.15 ? (tCount > xCount ? 'T' : 'X') : null;

    return { 
        type, confidence, efs: Math.round(efs*10)/10, purity, entropy, dominant, 
        availablePatterns: available, disabledPatterns: disabled, 
        stats: { L, tCount, xCount, maxStreak, zigzagRatio, maxCycle, streakRatio } 
    };
}

// ============================================================
// 4. TOÀN BỘ THUẬT TOÁN NHẬN DIỆN CẦU (PATTERN RECOGNITION)
// ============================================================
function getW(db, id) { return db.weights?.[id]?.w || 1.0; }

// 4.1 Nhóm Cầu Cơ Bản
function cauBet(results, db) {
    if (results.length < 3) return null;
    let streakType = results[0], len = 1;
    for (let i = 1; i < results.length; i++) { if (results[i] === streakType) len++; else break; }
    if (len >= 3) return { prediction: len >= 6 ? flip(streakType) : streakType, confidence: (len >= 6 ? 12 : 15) * getW(db, 'cau_bet'), name: `Bệt ${len}`, code: 'cau_bet' };
    return null;
}

function cauDao11(results, db) {
    if (results.length < 4) return null;
    let len = 1;
    for (let i = 1; i < Math.min(results.length, 10); i++) { if (results[i] !== results[i - 1]) len++; else break; }
    if (len >= 4) return { prediction: flip(results[0]), confidence: 14 * getW(db, 'cau_dao_11'), name: `Đảo 1-1`, code: 'cau_dao_11' };
    return null;
}

function cauRong(results, db) {
    if (results.length < 6) return null;
    let len = 1;
    for (let i = 1; i < results.length; i++) { if (results[i] === results[0]) len++; else break; }
    if (len >= 6) return { prediction: flip(results[0]), confidence: Math.min(16, len + 8) * getW(db, 'cau_rong'), name: `Rồng ${len}`, code: 'cau_rong' };
    return null;
}

function cauTuNhien(results, db) {
    const l10 = results.slice(0, Math.min(10, results.length));
    const t = l10.filter(r => r === 'T').length;
    return { prediction: t > l10.length/2 ? 'T' : 'X', confidence: 5 * getW(db, 'cau_tu_nhien'), name: 'Tự Nhiên', code: 'cau_tu_nhien' };
}

// 4.2 Nhóm Cầu Đối Xứng & Chu Kỳ
function cau22(results, db) {
    if (results.length < 5) return null;
    const p = results.slice(0, 4).join('');
    if (p === 'TTTT' || p === 'XXXX') return { prediction: p[0], confidence: 12 * getW(db, 'cau_22'), name: `Cầu 2-2`, code: 'cau_22' };
    if (p === 'TTXX' || p === 'XXTT') return { prediction: p[0], confidence: 12 * getW(db, 'cau_22'), name: `Cầu 2-2 Đảo`, code: 'cau_22' };
    return null;
}

function cau33(results, db) {
    if (results.length < 6) return null;
    const p = results.slice(0, 6).join('');
    if (p === 'TTTXXX' || p === 'XXXTTT') return { prediction: p[0], confidence: 12 * getW(db, 'cau_33'), name: `Cầu 3-3`, code: 'cau_33' };
    return null;
}

function cau121(results, db) {
    if (results.length < 5) return null;
    const p = results.slice(0, 5).join('');
    if (p === 'TXXTT' || p === 'XTTXX') return { prediction: flip(results[0]), confidence: 13 * getW(db, 'cau_121'), name: `Cầu 1-2-1`, code: 'cau_121' };
    return null;
}

function cauChuKy(results, db) {
    if (results.length < 6) return null;
    for (let cLen = 2; cLen <= 4; cLen++) {
        if (results.length < cLen * 2) continue;
        const p1 = results.slice(0, cLen).join('');
        const p2 = results.slice(cLen, cLen * 2).join('');
        if (p1 === p2) {
            return { prediction: results[cLen * 2], confidence: 14 * getW(db, 'cau_chu_ky'), name: `Chu Kỳ ${cLen}`, code: 'cau_chu_ky' };
        }
    }
    return null;
}

// 4.3 Nhóm Cầu Phức Tạp
function cauNhayCoc(results, db) {
    if (results.length < 5) return null;
    let flips = 0;
    for (let i = 1; i < results.length; i++) if (results[i] !== results[i-1]) flips++;
    if (flips >= results.length - 1) return { prediction: flip(results[0]), confidence: 10 * getW(db, 'cau_nhay_coc'), name: 'Nhảy Cóc', code: 'cau_nhay_coc' };
    return null;
}

function cau3Van1(results, db) {
    if (results.length < 6) return null;
    const p = results.slice(0, 6).join('');
    if (p === 'TTTXXX' || p === 'XXXTTT') return { prediction: p[0], confidence: 13 * getW(db, 'cau_3van1'), name: '3 Ván 1', code: 'cau_3van1' };
    return null;
}

function cauBeCau(results, db) {
    if (results.length < 8) return null;
    let streak = results[0], len = 1;
    for (let i = 1; i < results.length; i++) { if (results[i] === streak) len++; else break; }
    if (len >= 4 && results[len] === flip(streak)) {
        return { prediction: streak, confidence: 11 * getW(db, 'cau_be_cau'), name: 'Bẻ Cầu', code: 'cau_be_cau' };
    }
    return null;
}

// 4.4 Nhóm Thuật Toán & Thống Kê
function markovChain(results, db) {
    if (results.length < 5) return null;
    const transitions = { TT: 0, TX: 0, XT: 0, XX: 0 };
    for (let i = 1; i < results.length; i++) {
        const key = results[i-1] + results[i];
        if (transitions[key] !== undefined) transitions[key]++;
    }
    const last = results[0];
    const nextT = transitions[last + 'T'];
    const nextX = transitions[last + 'X'];
    const pred = nextT > nextX ? 'T' : (nextX > nextT ? 'X' : last);
    const conf = clamp(Math.abs(nextT - nextX) / Math.max(nextT + nextX, 1) * 15, 5, 18);
    return { prediction: pred, confidence: conf * getW(db, 'markov_chain'), name: 'Markov Chain', code: 'markov_chain' };
}

function movingAvgDrift(results, db) {
    if (results.length < 10) return null;
    const last5 = results.slice(0, 5);
    const next5 = results.slice(5, 10);
    const avgLast = last5.filter(r => r === 'T').length / 5;
    const avgNext = next5.filter(r => r === 'T').length / 5;
    const drift = avgLast - avgNext;
    if (Math.abs(drift) > 0.4) {
        const pred = drift > 0 ? 'X' : 'T';
        return { prediction: pred, confidence: 9 * getW(db, 'moving_avg_drift'), name: 'Moving Avg Drift', code: 'moving_avg_drift' };
    }
    return null;
}

function fibonacciPattern(results, db) {
    if (results.length < 8) return null;
    const fib = [1, 2, 3, 5, 8];
    let match = 0;
    let curType = results[0], curLen = 1;
    for (let i = 1; i < results.length; i++) {
        if (results[i] === curType) curLen++;
        else {
            if (fib.includes(curLen)) match++;
            curType = results[i]; curLen = 1;
        }
    }
    if (match >= 2) return { prediction: flip(results[0]), confidence: 8 * getW(db, 'fibonacci'), name: 'Fibonacci', code: 'fibonacci' };
    return null;
}

function resistanceSupport(results, db) {
    if (results.length < 6) return null;
    const last = results[0];
    let touches = 0;
    for (let i = 1; i < results.length; i++) if (results[i] === last) touches++;
    if (touches >= 3) return { prediction: flip(last), confidence: 10 * getW(db, 'resistance_support'), name: 'Kháng Cự/Hỗ Trợ', code: 'resistance_support' };
    return null;
}

function goldenRatio(results, db) {
    if (results.length < 10) return null;
    const t = results.filter(r => r === 'T').length;
    const ratio = t / results.length;
    if (ratio > 0.618) return { prediction: 'X', confidence: 7 * getW(db, 'golden_ratio'), name: 'Tỷ Lệ Vàng', code: 'golden_ratio' };
    if (ratio < 0.382) return { prediction: 'T', confidence: 7 * getW(db, 'golden_ratio'), name: 'Tỷ Lệ Vàng', code: 'golden_ratio' };
    return null;
}

function smartBet(results, db) {
    if (results.length < 15) return null;
    let tCount = 0, xCount = 0;
    for (let i = 0; i < results.length; i++) {
        if (results[i] === 'T') tCount++; else xCount++;
        if (i >= 3 && tCount === 3 && xCount === 0) return { prediction: 'X', confidence: 12 * getW(db, 'smart_bet'), name: 'Smart Bet', code: 'smart_bet' };
        if (i >= 3 && xCount === 3 && tCount === 0) return { prediction: 'T', confidence: 12 * getW(db, 'smart_bet'), name: 'Smart Bet', code: 'smart_bet' };
    }
    return null;
}

// ============================================================
// 5. TỔNG HỢP ENSEMBLE (TRỌNG SỐ ĐỘNG)
// ============================================================
function runUnbiasedEnsemble(seq, sums, db, env) {
    const disabled = new Set(env.disabledPatterns);
    let votesT = [], votesX = [], details = [];
    const last = seq[0]; // Mảng seq được truyền vào đã đảo ngược (mới nhất ở đầu)

    // Đăng ký tất cả các hàm cầu
    const funcs = [
        cauBet, cauDao11, cauRong, cau22, cau33, cau121, cauChuKy,
        cauNhayCoc, cau3Van1, cauBeCau, markovChain, movingAvgDrift,
        fibonacciPattern, resistanceSupport, goldenRatio, smartBet
    ];

    for (const fn of funcs) {
        let res = null; 
        try { res = fn(seq, db); } catch (e) {}
        if (!res || disabled.has(res.code)) continue;
        
        // Lấy trọng số động từ DB (nếu có), nếu không dùng mặc định
        const dynW = db.patternPerformance?.[res.code]?.w || 1.0;
        const baseW = DEFAULT_PATTERN_WEIGHTS[res.code] || 1.0;
        const finalW = dynW * baseW;
        
        const vote = (res.confidence / 100) * finalW;
        if (res.prediction === 'T') votesT.push({ vote, name: res.name, code: res.code });
        else votesX.push({ vote, name: res.name, code: res.code });
        details.push({ algo: res.code, code: res.prediction, name: res.name, vote });
    }

    // Fallback nếu không có cầu nào hoạt động
    if (votesT.length === 0 && votesX.length === 0) {
        const fb = cauTuNhien(seq, db);
        if (fb.prediction === 'T') votesT.push({ vote: 0.05, name: fb.name, code: fb.code });
        else votesX.push({ vote: 0.05, name: fb.name, code: fb.code });
        details.push({ algo: 'cau_tu_nhien', code: fb.prediction, name: fb.name, vote: 0.05 });
    }

    const cT = votesT.length, cX = votesX.length;
    const sT = votesT.reduce((a, b) => a + b.vote, 0);
    const sX = votesX.reduce((a, b) => a + b.vote, 0);
    const scoreT = cT > 0 ? sT / cT : 0;
    const scoreX = cX > 0 ? sX / cX : 0;

    let winner, confidence, patternName;

    if (Math.abs(scoreT - scoreX) < 0.02) {
        winner = flip(last); confidence = 0.515; patternName = 'HÒA-BẺ-CẦU';
    } else {
        winner = scoreT > scoreX ? 'T' : 'X';
        const diff = Math.abs(scoreT - scoreX) / Math.max(scoreT, scoreX);
        if (diff < 0.05) {
            winner = flip(last); confidence = 0.52; patternName = 'BẺ-CẦU-NHIỄU';
        } else {
            confidence = clamp(0.5 + diff * 0.5, 0.5, 0.88);
            patternName = (winner === 'T' ? votesT : votesX).sort((a,b)=>b.vote-a.vote)[0].name;
        }
    }

    // Áp dụng Warm-up / EFS
    if (env.stats.L < CONFIG.WARMUP.MIN_SESSIONS) confidence = clamp(0.51 + (confidence - 0.5) * 0.5, 0.51, 0.55);
    else if (env.efs < CONFIG.WARMUP.EFS_TARGET) confidence = clamp(Math.min(confidence, 0.51 + (env.efs / 80) * 0.08), 0.51, 0.59);
    else confidence = clamp(confidence * (1 + ((env.efs - 80) / 20) * 0.1), 0.51, 0.88);

    return { code: winner, label: patternName, tiLe: (confidence*100).toFixed(1)+'%', confidence, details, phase: confidence < 0.60 ? 'WARMING_UP' : 'READY' };
}

// ============================================================
// 6. FETCH & PROCESS
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
        if (!res.data || !res.data.data || !Array.isArray(res.data.data) || res.data.data.length === 0) return null;
        return res.data.data[0];
    } catch (e) { return null; }
}

async function processGame(game) {
    const db = readDB(game);
    let currentSeq = [];
    let currentSums = [];
    let latest = null;

    if (game === 'b52') {
        const latestB52 = await fetchB52();
        if (!latestB52) return;
        
        latest = latestB52;
        const sid = safeInt(latest.sid);
        
        // 1. Cập nhật DB nếu có phiên mới
        if (!db.rawHistory.find(x => x.sid === sid)) {
            db.rawHistory.push({
                sid: sid,
                d1: safeInt(latest.d1), d2: safeInt(latest.d2), d3: safeInt(latest.d3),
                result: getB52Result(latest)
            });
            if (db.rawHistory.length > 500) db.rawHistory.shift();
            saveDB(game, db);
        }

        // 2. Chuẩn bị dữ liệu cho dự đoán (Đảo ngược để mới nhất ở đầu)
        currentSeq = db.rawHistory.map(x => x.result).reverse();
        currentSums = db.rawHistory.map(x => x.d1 + x.d2 + x.d3).reverse();

        // 3. Chấm điểm phiên trước
        const prev = db.history[db.history.length - 1];
        if (prev && prev.DU_DOAN_CODE && prev.trangThai === 'ĐANG CHỜ' && prev.phien < sid) {
            const actual = getB52Result(latest);
            prev.trangThai = prev.DU_DOAN_CODE === actual ? 'ĐÚNG' : 'SAI';
            
            // Cập nhật hiệu suất động cho các cầu đã vote
            if (prev.algoDetails) {
                for (const algo of prev.algoDetails) {
                    if (!db.patternPerformance[algo.algo]) db.patternPerformance[algo.algo] = { win: 0, lose: 0, w: 1.0 };
                    if (algo.code === actual) db.patternPerformance[algo.algo].win++;
                    else db.patternPerformance[algo.algo].lose++;
                    
                    const pp = db.patternPerformance[algo.algo];
                    const total = pp.win + pp.lose;
                    if (total >= 10) {
                        const winrate = pp.win / total;
                        // Trọng số dao động từ 0.5 đến 1.5 dựa trên winrate
                        pp.w = clamp(0.5 + (winrate - 0.5) * 2, 0.5, 1.5);
                    }
                }
            }
            saveDB(game, db);
        }

        // 4. Dự đoán nếu đủ dữ liệu
        if (currentSeq.length >= 15) {
            updateStreakStats(currentSeq, db);
            const env = profileEnvironment(currentSeq);
            db.envProfile = env;
            const pred = runUnbiasedEnsemble(currentSeq, currentSums, db, env);

            const lastHistory = db.history[db.history.length - 1];
            if (!lastHistory || lastHistory.phien < sid) {
                db.history.push({
                    phien: sid,
                    xucXac: getB52Dice(latest),
                    tong: getB52Sum(latest),
                    ketQua: getB52Result(latest),
                    ketQuaLabel: label(getB52Result(latest)),
                    phienDuDoan: sid + 1,
                    DU_DOAN_CODE: pred.code, DU_DOAN: label(pred.code),
                    TI_LE: pred.tiLe, patternName: pred.label, algoDetails: pred.details,
                    phase: pred.phase, envType: env.type, trangThai: 'ĐANG CHỜ'
                });
                if (db.history.length > 500) db.history.shift();
                saveDB(game, db);
            }
        }
        return;
    }

    // Xử lý MD5 & TAIXIU
    const list = await fetchApi(game === 'md5' ? API_MD5 : API_TX);
    if (!list || !list.length) return;
    latest = list[list.length - 1];
    currentSeq = list.map(getResult).filter(Boolean).reverse(); // Đảo ngược
    currentSums = list.map(getSum).filter(s => s >= 3 && s <= 18).reverse();
    
    const session = safeInt(latest.SessionId);
    if (db.lastSession === session) return;
    db.lastSession = session;

    if (currentSeq.length < 15) { saveDB(game, db); return; }

    updateStreakStats(currentSeq, db);
    const env = profileEnvironment(currentSeq);
    db.envProfile = env;

    const pred = runUnbiasedEnsemble(currentSeq, currentSums, db, env);

    const prev = db.history[db.history.length - 1];
    if (prev && prev.DU_DOAN_CODE && prev.trangThai === 'ĐANG CHỜ' && prev.phien < session) {
        const actual = getResult(latest);
        prev.trangThai = prev.DU_DOAN_CODE === actual ? 'ĐÚNG' : 'SAI';
        
        if (prev.algoDetails) {
            for (const algo of prev.algoDetails) {
                if (!db.patternPerformance[algo.algo]) db.patternPerformance[algo.algo] = { win: 0, lose: 0, w: 1.0 };
                if (algo.code === actual) db.patternPerformance[algo.algo].win++;
                else db.patternPerformance[algo.algo].lose++;
                
                const pp = db.patternPerformance[algo.algo];
                const total = pp.win + pp.lose;
                if (total >= 10) {
                    const winrate = pp.win / total;
                    pp.w = clamp(0.5 + (winrate - 0.5) * 2, 0.5, 1.5);
                }
            }
        }
    }

    db.history.push({
        phien: session,
        xucXac: getDice(latest),
        tong: getSum(latest),
        ketQua: getResult(latest),
        ketQuaLabel: label(getResult(latest)),
        phienDuDoan: session + 1,
        DU_DOAN_CODE: pred.code, DU_DOAN: label(pred.code),
        TI_LE: pred.tiLe, patternName: pred.label, algoDetails: pred.details,
        phase: pred.phase, envType: env.type, trangThai: 'ĐANG CHỜ'
    });

    if (db.history.length > 500) db.history.shift();
    saveDB(game, db);
}

setInterval(() => { 
    processGame('md5'); 
    processGame('taixiu'); 
    processGame('b52'); 
}, TICK_MS);

// ============================================================
// 7. ROUTERS & API
// ============================================================
function buildJsonResponse(game, db, env, pred) {
    const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const win = settled.filter(h => h.trangThai === 'ĐÚNG').length;
    const lose = settled.filter(h => h.trangThai === 'SAI').length;
    const duDoanText = pred ? label(pred.code) : null;
    const latestHist = db.history[db.history.length - 1] || {};

    return {
        status: "success",
        data: {
            phienHienTai: latestHist.phien || "0",
            phienDuDoan: latestHist.phienDuDoan || "0",
            duDoan: duDoanText, 
            tiLe: pred ? pred.tiLe : "—",
            liDo: pred ? `⭐ ${pred.label} → ${duDoanText} (${pred.tiLe})` : `⏳ Đang quét ${env.stats?.L || 0}/15 phiên...`,
            xucXac: latestHist.xucXac || [],
            tongDiem: latestHist.tong || 0,
            moiTruong: {
                loai: env.type,
                doTinCay: (env.confidence || 0).toFixed(2),
                efs: (env.efs || 0) + "%",
                doTinhKhiet: ((env.purity || 0)*100).toFixed(1) + "%",
                doNhieu: ((env.entropy || 1)*100).toFixed(1) + "%",
                nghieng: env.dominant ? label(env.dominant) : "CÂN BẰNG"
            },
            chiTietModel: {
                pattern: pred ? pred.label : '—',
                phase: pred ? pred.phase : 'WARMUP'
            },
            thongKe: { win, lose, winrate: settled.length ? ((win/settled.length)*100).toFixed(1)+'%' : '—', bankroll: (1000 + win*10 - lose*10) + '$' }
        }
    };
}

app.get('/b52', async (req, res) => {
    const db = readDB('b52');
    const seq = db.rawHistory.map(x => x.result).reverse();
    const env = db.envProfile || profileEnvironment(seq);
    const pred = seq.length >= 15 ? runUnbiasedEnsemble(seq, [], db, env) : null;
    res.json(buildJsonResponse('b52', db, env, pred));
});

app.get('/taixiu', async (req, res) => {
    const db = readDB('taixiu');
    const env = db.envProfile || { type: 'CHƯA CÓ', confidence: 0, efs: 0, purity: 0, entropy: 1, dominant: null, stats: {L:0} };
    const seq = (db.rawHistory || []).map(x => x.result).reverse();
    const pred = db.history.length >= 15 ? runUnbiasedEnsemble(seq, [], db, env) : null;
    res.json(buildJsonResponse('taixiu', db, env, pred));
});

app.get('/md5', async (req, res) => {
    const db = readDB('md5');
    const env = db.envProfile || { type: 'CHƯA CÓ', confidence: 0, efs: 0, purity: 0, entropy: 1, dominant: null, stats: {L:0} };
    const seq = (db.rawHistory || []).map(x => x.result).reverse();
    const pred = db.history.length >= 15 ? runUnbiasedEnsemble(seq, [], db, env) : null;
    res.json(buildJsonResponse('md5', db, env, pred));
});

app.get('/', (req, res) => res.redirect('/ui/b52'));

app.listen(PORT, () => console.log(`🚀 V52 Server running on port ${PORT}`));
