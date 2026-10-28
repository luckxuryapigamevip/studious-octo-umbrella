'use strict';
// ============================================================
// SICBO AI V50 ULTIMATE - ALL 1000+ LINES ALGORITHMS + B52
// ============================================================
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
// 1. CẤU HÌNH API & DATABASE
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

const DEFAULT_PATTERN_WEIGHTS = {
  'cau_bet': 1.0, 'cau_dao_11': 1.0, 'cau_22': 1.0, 'cau_33': 1.0,
  'cau_121': 1.0, 'cau_123': 1.0, 'cau_321': 1.0, 'cau_nhay_coc': 1.0,
  'cau_nhip_nghieng': 1.0, 'cau_3van1': 1.0, 'cau_be_cau': 1.0, 'cau_chu_ky': 1.0,
  'distribution': 1.0, 'dice_pattern': 1.0, 'sum_trend': 1.0, 'edge_cases': 1.0,
  'momentum': 1.0, 'cau_tu_nhien': 1.0, 'dice_trend_line': 1.0, 'break_pattern': 1.0,
  'fibonacci': 1.0, 'resistance_support': 1.0, 'wave': 1.0, 'golden_ratio': 1.0,
  'day_gay': 1.0, 'cau_44': 1.0, 'cau_55': 1.0, 'cau_212': 1.0,
  'cau_1221': 1.0, 'cau_2112': 1.0, 'cau_gap': 1.0, 'cau_ziczac': 1.0,
  'cau_doi': 1.0, 'cau_rong': 1.0, 'smart_bet': 1.0, 'markov_chain': 1.2,
  'moving_avg_drift': 1.1, 'sum_pressure': 1.1, 'volatility': 1.0
};

if (!fs.existsSync(DB_DIR)) { try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch (e) {} }

// ============================================================
// 2. HELPERS & DATA NORMALIZE
// ============================================================
function safeInt(x, def = 0) { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
const label = c => c === 'T' ? 'TÀI' : (c === 'X' ? 'XỈU' : null);
const flip  = c => c === 'T' ? 'X'   : (c === 'X' ? 'T'   : null);

function entropyBits(arr) {
    if (!arr.length) return 0;
    const f = {};
    for (const x of arr) f[x] = (f[x] || 0) + 1;
    let h = 0;
    for (const k in f) { const p = f[k] / arr.length; if (p > 0) h -= p * Math.log2(p); }
    return h;
}

function dbPath(g) { return path.join(DB_DIR, `db_v50_${g}.json`); }
function readDB(g) {
    const p = dbPath(g);
    try {
        if (fs.existsSync(p)) {
            const db = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (!db.weights) db.weights = {};
            if (!db.streakStats) db.streakStats = { T: {}, X: {} };
            return db;
        }
    } catch (e) {}
    return { history: [], lastSession: null, weights: {}, streakStats: { T: {}, X: {} }, envProfile: null };
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
// 3. NHẬN DIỆN MÔI TRƯỜNG
// ============================================================
function profileEnvironment(seq) {
    const L = seq.length;
    if (L < CONFIG.ENV.MIN_SAMPLES) {
        return { type: 'CHƯA_ĐỦ_DATA', confidence: 0, efs: 0, purity: 0, entropy: 1, dominant: null, availablePatterns: [], disabledPatterns: [], stats: { sessions: L } };
    }
    const tCount = seq.filter(x => x === 'T').length;
    const xCount = L - tCount;
    const balance = Math.abs(tCount - xCount) / L;
    const entropy = entropyBits(seq);
    let streaks = [], cur = seq[0], len = 1;
    for (let i = 1; i < L; i++) {
        if (seq[i] === cur) len++;
        else { streaks.push(len); cur = seq[i]; len = 1; }
    }
    streaks.push(len);
    const maxStreak = Math.max(...streaks);
    const streakRatio = streaks.filter(s => s >= 3).length / streaks.length;
    const rec20 = seq.slice(-Math.min(20, L));
    let flips20 = 0;
    for (let i = 1; i < rec20.length; i++) if (rec20[i] !== rec20[i-1]) flips20++;
    const zigzagRatio = rec20.length > 1 ? flips20 / (rec20.length - 1) : 0;

    let type = 'HỖN_HỢP', confidence = 0.5;
    const purity = 1 - entropy;
    if (entropy > 0.90) { type = 'NHIỄU'; confidence = clamp((entropy - 0.90) * 10, 0, 1); }
    else if (entropy < 0.50 && (streakRatio > 0.3 || maxStreak >= 4)) { type = 'BỆT'; confidence = clamp((0.5 - entropy) * 2, 0.5, 1); }
    else if (zigzagRatio > 0.75 && entropy > 0.7) { type = 'ZIGZAG'; confidence = clamp((zigzagRatio - 0.75) * 4, 0.5, 1); }

    const dominant = balance > 0.15 ? (tCount > xCount ? 'T' : 'X') : null;
    const dataVolume = clamp(L / CONFIG.WARMUP.FULL_SESSIONS, 0, 1);
    const efs = (dataVolume * 0.35 + purity * 0.30 + confidence * 0.20 + (1 - entropy) * 0.15) * 100;

    const available = [], disabled = [];
    if (type === 'NHIỄU') {
        disabled.push('cau_bet', 'cau_dao_11', 'cau_ziczac', 'cau_rong', 'cau_chu_ky', 'distribution');
        available.push('markov_chain', 'dice_pattern', 'edge_cases', 'break_pattern');
    } else if (type === 'BỆT') {
        available.push('cau_bet', 'day_gay', 'cau_rong', 'smart_bet');
        disabled.push('cau_dao_11', 'cau_ziczac');
    } else if (type === 'ZIGZAG') {
        available.push('cau_dao_11', 'cau_ziczac', 'cau_nhay_coc', 'cau_nhip_nghieng');
        disabled.push('cau_bet', 'cau_rong', 'cau_chu_ky');
    } else {
        available.push(...Object.keys(DEFAULT_PATTERN_WEIGHTS));
    }
    return { type, confidence, efs: Math.round(efs*10)/10, purity, entropy, dominant, availablePatterns: available, disabledPatterns: disabled, stats: { L, tCount, xCount, maxStreak, zigzagRatio } };
}

// ============================================================
// 4. SIÊU THUẬT TOÁN (TÍCH HỢP TỪ BẢN V11 1K DÒNG)
// ============================================================
// Hàm lấy trọng số học online
function getW(db, id) { return db.weights?.[id]?.w || 1.0; }

// 1. Cầu Bệt
function cauBet(results, db) {
    if (results.length < 3) return null;
    let streakType = results[0], streakLength = 1;
    for (let i = 1; i < results.length; i++) {
        if (results[i] === streakType) streakLength++; else break;
    }
    if (streakLength >= 3) {
        let shouldBreak = streakLength >= 6;
        return { prediction: shouldBreak ? flip(streakType) : streakType, confidence: (shouldBreak ? Math.min(12, streakLength * 2) : Math.min(15, streakLength * 3)) * getW(db, 'cau_bet'), name: `Cầu Bệt ${streakLength}`, code: 'cau_bet' };
    }
    return null;
}

// 2. Cầu Đảo 1-1
function cauDao11(results, db) {
    if (results.length < 4) return null;
    let alternatingLength = 1;
    for (let i = 1; i < Math.min(results.length, 10); i++) {
        if (results[i] !== results[i - 1]) alternatingLength++; else break;
    }
    if (alternatingLength >= 4) {
        return { prediction: flip(results[0]), confidence: Math.min(14, alternatingLength * 2 + 4) * getW(db, 'cau_dao_11'), name: `Đảo 1-1 (${alternatingLength})`, code: 'cau_dao_11' };
    }
    return null;
}

// 3. Cầu 2-2
function cau22(results, db) {
    if (results.length < 6) return null;
    let pairCount = 0, i = 0, pattern = [];
    while (i < results.length - 1 && pairCount < 4) {
        if (results[i] === results[i + 1]) { pattern.push(results[i]); pairCount++; i += 2; } else break;
    }
    if (pairCount >= 2) {
        let isAlt = true;
        for (let j = 1; j < pattern.length; j++) { if (pattern[j] === pattern[j - 1]) { isAlt = false; break; } }
        if (isAlt) return { prediction: flip(pattern[pattern.length - 1]), confidence: Math.min(12, pairCount * 3 + 3) * getW(db, 'cau_22'), name: `Cầu 2-2 (${pairCount})`, code: 'cau_22' };
    }
    return null;
}

// 4. Cầu 3-3
function cau33(results, db) {
    if (results.length < 6) return null;
    let tripleCount = 0, i = 0, pattern = [];
    while (i < results.length - 2) {
        if (results[i] === results[i + 1] && results[i + 1] === results[i + 2]) { pattern.push(results[i]); tripleCount++; i += 3; } else break;
    }
    if (tripleCount >= 1) {
        const currentPos = results.length % 3;
        let prediction = currentPos === 0 ? flip(pattern[pattern.length - 1]) : pattern[pattern.length - 1];
        return { prediction, confidence: Math.min(13, tripleCount * 4 + 5) * getW(db, 'cau_33'), name: `Cầu 3-3 (${tripleCount})`, code: 'cau_33' };
    }
    return null;
}

// 5. Cầu 1-2-1
function cau121(results, db) {
    if (results.length < 4) return null;
    const p = results.slice(0, 4);
    if (p[0] !== p[1] && p[1] === p[2] && p[2] !== p[3] && p[0] === p[3]) {
        return { prediction: p[0], confidence: 10 * getW(db, 'cau_121'), name: 'Cầu 1-2-1', code: 'cau_121' };
    }
    return null;
}

// 6. Cầu 1-2-3
function cau123(results, db) {
    if (results.length < 6) return null;
    const first = results[5], nextTwo = results.slice(3, 5), lastThree = results.slice(0, 3);
    if (nextTwo[0] === nextTwo[1] && nextTwo[0] !== first && lastThree.every(r => r === lastThree[0]) && lastThree[0] !== nextTwo[0]) {
        return { prediction: first, confidence: 11 * getW(db, 'cau_123'), name: 'Cầu 1-2-3', code: 'cau_123' };
    }
    return null;
}

// 7. Cầu 3-2-1
function cau321(results, db) {
    if (results.length < 6) return null;
    const f3 = results.slice(3, 6), n2 = results.slice(1, 3), l1 = results[0];
    if (f3.every(r => r === f3[0]) && n2.every(r => r === n2[0]) && f3[0] !== n2[0] && l1 !== n2[0]) {
        return { prediction: n2[0], confidence: 12 * getW(db, 'cau_321'), name: 'Cầu 3-2-1', code: 'cau_321' };
    }
    return null;
}

// 8. Cầu Nhảy Cóc
function cauNhayCoc(results, db) {
    if (results.length < 6) return null;
    const skipPattern = [];
    for (let i = 0; i < Math.min(results.length, 12); i += 2) skipPattern.push(results[i]);
    if (skipPattern.length >= 3) {
        if (skipPattern.slice(0, 3).every(r => r === skipPattern[0])) return { prediction: skipPattern[0], confidence: 8 * getW(db, 'cau_nhay_coc'), name: 'Nhảy Cóc', code: 'cau_nhay_coc' };
        let alt = true;
        for (let i = 1; i < skipPattern.length - 1; i++) { if (skipPattern[i] === skipPattern[i - 1]) { alt = false; break; } }
        if (alt && skipPattern.length >= 3) return { prediction: flip(skipPattern[0]), confidence: 7 * getW(db, 'cau_nhay_coc'), name: 'Nhảy Cóc Đảo', code: 'cau_nhay_coc' };
    }
    return null;
}

// 9. Cầu Nhịp Nghiêng
function cauNhipNghieng(results, db) {
    if (results.length < 5) return null;
    const last5 = results.slice(0, 5), tai5 = last5.filter(r => r === 'T').length;
    if (tai5 >= 4) return { prediction: 'T', confidence: 9 * getW(db, 'cau_nhip_nghieng'), name: `Nghiêng 5 (${tai5}T)`, code: 'cau_nhip_nghieng' };
    if (tai5 <= 1) return { prediction: 'X', confidence: 9 * getW(db, 'cau_nhip_nghieng'), name: `Nghiêng 5 (${5-tai5}X)`, code: 'cau_nhip_nghieng' };
    if (results.length >= 7) {
        const last7 = results.slice(0, 7), tai7 = last7.filter(r => r === 'T').length;
        if (tai7 >= 5) return { prediction: 'T', confidence: 10 * getW(db, 'cau_nhip_nghieng'), name: `Nghiêng 7 (${tai7}T)`, code: 'cau_nhip_nghieng' };
        if (tai7 <= 2) return { prediction: 'X', confidence: 10 * getW(db, 'cau_nhip_nghieng'), name: `Nghiêng 7 (${7-tai7}X)`, code: 'cau_nhip_nghieng' };
    }
    return null;
}

// 10. Cầu 3 Ván 1
function cau3Van1(results, db) {
    if (results.length < 4) return null;
    const last4 = results.slice(0, 4), taiCount = last4.filter(r => r === 'T').length;
    if (taiCount === 3 && last4[3] === 'X') return { prediction: 'T', confidence: 8 * getW(db, 'cau_3van1'), name: '3 Ván 1', code: 'cau_3van1' };
    if (taiCount === 1 && last4[3] === 'T') return { prediction: 'X', confidence: 8 * getW(db, 'cau_3van1'), name: '3 Ván 1', code: 'cau_3van1' };
    return null;
}

// 11. Cầu Bẻ
function cauBeCau(results, db) {
    if (results.length < 5) return null;
    let len = 1;
    for (let i = 1; i < results.length; i++) { if (results[i] === results[0]) len++; else break; }
    if (len >= 4) return { prediction: flip(results[0]), confidence: Math.min(14, len * 2 + 4) * getW(db, 'cau_be_cau'), name: `Bẻ Cầu ${len}`, code: 'cau_be_cau' };
    return null;
}

// 12. Cầu 4-4
function cau44(results, db) {
    if (results.length < 8) return null;
    let qCount = 0, i = 0, pattern = [];
    while (i < results.length - 3) {
        if (results[i] === results[i+1] && results[i+1] === results[i+2] && results[i+2] === results[i+3]) { pattern.push(results[i]); qCount++; i += 4; } else break;
    }
    if (qCount >= 1) {
        const curPos = results.length - (qCount * 4);
        let pred = curPos >= 3 ? flip(pattern[pattern.length - 1]) : pattern[pattern.length - 1];
        return { prediction: pred, confidence: Math.min(14, qCount * 4 + 6) * getW(db, 'cau_44'), name: `Cầu 4-4`, code: 'cau_44' };
    }
    return null;
}

// 13. Cầu 5-5
function cau55(results, db) {
    if (results.length < 10) return null;
    let qCount = 0, i = 0, pattern = [];
    while (i < results.length - 4) {
        if (results[i] === results[i+1] && results[i+1] === results[i+2] && results[i+2] === results[i+3] && results[i+3] === results[i+4]) { pattern.push(results[i]); qCount++; i += 5; } else break;
    }
    if (qCount >= 1) {
        const curPos = results.length - (qCount * 5);
        let pred = curPos >= 4 ? flip(pattern[pattern.length - 1]) : pattern[pattern.length - 1];
        return { prediction: pred, confidence: Math.min(15, qCount * 5 + 7) * getW(db, 'cau_55'), name: `Cầu 5-5`, code: 'cau_55' };
    }
    return null;
}

// 14. Cầu 2-1-2
function cau212(results, db) {
    if (results.length < 5) return null;
    const p = results.slice(0, 5);
    if (p[0] === p[1] && p[1] !== p[2] && p[2] === p[3] && p[3] !== p[4] && p[0] !== p[2]) {
        return { prediction: flip(p[0]), confidence: 10 * getW(db, 'cau_212'), name: 'Cầu 2-1-2', code: 'cau_212' };
    }
    return null;
}

// 15. Cầu 1-2-2-1
function cau1221(results, db) {
    if (results.length < 6) return null;
    const p = results.slice(0, 6);
    if (p[0] !== p[1] && p[1] === p[2] && p[2] === p[3] && p[3] !== p[4] && p[4] === p[5] && p[0] !== p[1]) {
        return { prediction: p[0], confidence: 11 * getW(db, 'cau_1221'), name: 'Cầu 1-2-2-1', code: 'cau_1221' };
    }
    return null;
}

// 16. Cầu 2-1-1-2
function cau2112(results, db) {
    if (results.length < 6) return null;
    const p = results.slice(0, 6);
    if (p[0] === p[1] && p[1] !== p[2] && p[2] === p[3] && p[3] !== p[4] && p[4] === p[5] && p[0] !== p[2]) {
        return { prediction: p[0], confidence: 11 * getW(db, 'cau_2112'), name: 'Cầu 2-1-1-2', code: 'cau_2112' };
    }
    return null;
}

// 17. Cầu Gấp
function cauGap(results, db) {
    if (results.length < 6) return null;
    for (let gap = 2; gap <= 3; gap++) {
        let found = true, ref = results[0];
        for (let i = 0; i < Math.min(results.length, 12); i += (gap + 1)) {
            if (results[i] !== ref) { found = false; break; }
        }
        if (found) return { prediction: ref, confidence: 9 * getW(db, 'cau_gap'), name: `Cầu Gấp ${gap+1}`, code: 'cau_gap' };
    }
    return null;
}

// 18. Cầu Ziczac
function cauZiczac(results, db) {
    if (results.length < 8) return null;
    let count = 0;
    for (let i = 0; i < results.length - 2; i++) {
        if (results[i] !== results[i+1] && results[i+1] !== results[i+2] && results[i] === results[i+2]) count++; else break;
    }
    if (count >= 3) return { prediction: flip(results[0]), confidence: Math.min(13, count * 2 + 5) * getW(db, 'cau_ziczac'), name: `Ziczac (${count})`, code: 'cau_ziczac' };
    return null;
}

// 19. Cầu Đôi
function cauDoi(results, db) {
    if (results.length < 4) return null;
    let pairChanges = 0, i = 0;
    while (i < results.length - 1) { if (results[i] === results[i+1]) { pairChanges++; i += 2; } else break; }
    if (pairChanges >= 2) {
        const isAlt = results[0] !== results[2];
        return { prediction: isAlt ? flip(results[0]) : results[0], confidence: Math.min(12, pairChanges * 3 + 4) * getW(db, 'cau_doi'), name: `Cầu Đôi (${pairChanges})`, code: 'cau_doi' };
    }
    return null;
}

// 20. Cầu Rồng
function cauRong(results, db) {
    if (results.length < 6) return null;
    let len = 1;
    for (let i = 1; i < results.length; i++) { if (results[i] === results[0]) len++; else break; }
    if (len >= 6) return { prediction: flip(results[0]), confidence: Math.min(16, len + 8) * getW(db, 'cau_rong'), name: `Rồng ${len}`, code: 'cau_rong' };
    return null;
}

// 21. Smart Bet
function smartBet(results, db) {
    if (results.length < 10) return null;
    const l5 = results.slice(0, 5), p5 = results.slice(5, 10);
    const t5 = l5.filter(r => r === 'T').length, tp5 = p5.filter(r => r === 'T').length;
    if ((t5 >= 4 && tp5 <= 1) || (t5 <= 1 && tp5 >= 4)) {
        const dom = t5 >= 4 ? 'T' : 'X';
        return { prediction: flip(dom), confidence: 13 * getW(db, 'smart_bet'), name: 'Đảo Xu Hướng', code: 'smart_bet' };
    }
    const t10 = results.slice(0, 10).filter(r => r === 'T').length;
    if (t10 >= 8 || t10 <= 2) {
        const dom = t10 >= 8 ? 'T' : 'X';
        return { prediction: flip(dom), confidence: 12 * getW(db, 'smart_bet'), name: 'Xu Hướng Cực', code: 'smart_bet' };
    }
    return null;
}

// 22. Chu Kỳ
function cauChuKy(results, db) {
    if (results.length < 12) return null;
    for (let len = 2; len <= 6; len++) {
        let ok = true, pattern = results.slice(0, len);
        for (let i = len; i < Math.min(len * 3, results.length); i++) {
            if (results[i] !== pattern[i % len]) { ok = false; break; }
        }
        if (ok) return { prediction: pattern[results.length % len], confidence: 9 * getW(db, 'cau_chu_ky'), name: `Chu Kỳ ${len}`, code: 'cau_chu_ky' };
    }
    return null;
}

// 23. Cầu Tự Nhiên (Fallback)
function cauTuNhien(results, db) {
    const l10 = results.slice(0, Math.min(10, results.length));
    const t = l10.filter(r => r === 'T').length;
    return { prediction: t > l10.length/2 ? 'T' : 'X', confidence: 5 * getW(db, 'cau_tu_nhien'), name: 'Cầu Tự Nhiên', code: 'cau_tu_nhien' };
}

// ============================================================
// 5. TỔNG HỢP KHÔNG THIÊN VỊ (GỌI TẤT CẢ 23+ CẦU TRÊN)
// ============================================================
function runUnbiasedEnsemble(seq, sums, db, env) {
    const disabled = new Set(env.disabledPatterns);
    let votesT = [], votesX = [], details = [];

    const last = seq[seq.length - 1];
    let currentStreak = 1;
    for (let i = seq.length - 2; i >= 0; i--) {
        if (seq[i] === last) currentStreak++; else break;
    }

    // Danh sách 23+ cầu
    const funcs = [
        cauBet, cauDao11, cau22, cau33, cau121, cau123, cau321, cauNhayCoc, cauNhipNghieng,
        cau3Van1, cauBeCau, cau44, cau55, cau212, cau1221, cau2112, cauGap, cauZiczac,
        cauDoi, cauRong, smartBet, cauChuKy
    ];

    for (const fn of funcs) {
        let res = null; try { res = fn(seq, db); } catch (e) {}
        if (!res || disabled.has(res.code)) continue;

        const baseW = DEFAULT_PATTERN_WEIGHTS[res.code] || 1.0;
        const learnedW = db.weights?.[res.code]?.w || 1.0;
        
        let penalty = 1.0;
        if (currentStreak >= 3) { if (res.prediction === last) penalty = 0.5; else penalty = 1.5; }

        const vote = (res.confidence / 100) * baseW * learnedW * penalty;

        if (res.prediction === 'T') votesT.push({ vote, name: res.name });
        else votesX.push({ vote, name: res.name });
        details.push({ algo: res.code, family: res.code, code: res.prediction, name: res.name });
    }

    // Fallback nếu không có cầu nào khớp
    if (votesT.length === 0 && votesX.length === 0) {
        const fallback = cauTuNhien(seq, db);
        if (fallback.prediction === 'T') votesT.push({ vote: 0.05, name: fallback.name });
        else votesX.push({ vote: 0.05, name: fallback.name });
        details.push({ algo: 'cau_tu_nhien', family: 'cau_tu_nhien', code: fallback.prediction, name: fallback.name });
    }

    const cT = votesT.length, cX = votesX.length;
    const sT = votesT.reduce((a, b) => a + b.vote, 0);
    const sX = votesX.reduce((a, b) => a + b.vote, 0);
    const scoreT = cT > 0 ? sT / cT : 0;
    const scoreX = cX > 0 ? sX / cX : 0;

    let winner, confidence, patternName, method;

    if (Math.abs(scoreT - scoreX) < 0.03) {
        winner = flip(last); confidence = 0.515; patternName = 'HÒA-BẺ-CẦU'; method = 'tie_break';
    } else {
        winner = scoreT > scoreX ? 'T' : 'X';
        const maxS = Math.max(scoreT, scoreX);
        const diff = Math.abs(scoreT - scoreX) / maxS;
        if (diff < 0.05) {
            winner = flip(last); confidence = 0.52; patternName = 'BẺ-CẦU-NHIỄU'; method = 'low_diff_break';
        } else {
            confidence = clamp(0.5 + diff * 0.5, 0.5, 0.85);
            const top = (winner === 'T' ? votesT : votesX).sort((a,b)=>b.vote-a.vote)[0];
            patternName = top ? top.name : 'META';
            method = 'score';
        }
    }

    const efs = env.efs;
    if (env.stats.L < CONFIG.WARMUP.MIN_SESSIONS) confidence = clamp(0.51 + (confidence - 0.5) * 0.5, 0.51, 0.55);
    else if (efs < CONFIG.WARMUP.EFS_TARGET) confidence = clamp(Math.min(confidence, 0.51 + (efs / CONFIG.WARMUP.EFS_TARGET) * 0.08), 0.51, 0.59);
    else confidence = clamp(confidence * (1 + ((efs - 80) / 20) * 0.1), 0.51, 0.85);

    return {
        code: winner, label: patternName, tiLe: (confidence*100).toFixed(1)+'%', confidence, method,
        details, counts: { cT, cX, scoreT: +scoreT.toFixed(2), scoreX: +scoreX.toFixed(2) },
        phase: confidence < 0.60 ? 'WARMING_UP' : 'READY'
    };
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
        return res.data?.data || [];
    } catch (e) { return []; }
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

async function processGame(game) {
    let list = [];
    if (game === 'b52') list = await fetchB52();
    else list = await fetchApi(game === 'md5' ? API_MD5 : API_TX);
    
    if (!list || !list.length) return;

    const latest = list[list.length - 1];
    const session = game === 'b52' ? safeInt(latest.sid) : safeInt(latest.SessionId);
    const db = readDB(game);
    if (db.lastSession === session) return;

    let seq, sums, pred, currentResult;
    
    if (game === 'b52') {
        seq = list.map(getB52Result).filter(Boolean);
        sums = list.map(getB52Sum).filter(s => s >= 3 && s <= 18);
        currentResult = getB52Result(latest);
    } else {
        seq = list.map(getResult).filter(Boolean);
        sums = list.map(getSum).filter(s => s >= 3 && s <= 18);
        currentResult = getResult(latest);
    }

    if (seq.length < 15) { db.lastSession = session; saveDB(game, db); return; }

    updateStreakStats(seq, db);
    const env = profileEnvironment(seq);
    db.envProfile = env;

    pred = runUnbiasedEnsemble(seq, sums, db, env);

    const prev = db.history[db.history.length - 1];
    if (prev && safeInt(prev.phienDuDoan) === session && prev.DU_DOAN_CODE) {
        prev.trangThai = prev.DU_DOAN_CODE === currentResult ? 'ĐÚNG' : 'SAI';
        for (const d of (prev.algoDetails || [])) {
            if (!db.weights[d.algo]) db.weights[d.algo] = { w: 1.0 };
            if (d.code === currentResult) db.weights[d.algo].w = clamp(db.weights[d.algo].w + 0.05, 0.5, 2.0);
            else db.weights[d.algo].w = clamp(db.weights[d.algo].w - 0.05, 0.5, 2.0);
        }
    }

    db.history.push({
        phien: session, 
        xucXac: game === 'b52' ? getB52Dice(latest) : getDice(latest), 
        tong: game === 'b52' ? getB52Sum(latest) : getSum(latest),
        ketQua: currentResult, ketQuaLabel: label(currentResult),
        phienDuDoan: session + 1,
        DU_DOAN_CODE: pred.code, DU_DOAN: label(pred.code), 
        TI_LE: pred.tiLe, patternName: pred.label, algoDetails: pred.details,
        method: pred.method, phase: pred.phase, envType: env.type, trangThai: 'ĐANG CHỜ'
    });

    if (db.history.length > 500) db.history.shift();
    db.lastSession = session;
    saveDB(game, db);
}

setInterval(() => { processGame('md5'); processGame('taixiu'); processGame('b52'); }, TICK_MS);

// ============================================================
// 7. ROUTERS
// ============================================================
function buildJsonResponse(game, list, db, env, pred) {
    const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const win = settled.filter(h => h.trangThai === 'ĐÚNG').length;
    const lose = settled.filter(h => h.trangThai === 'SAI').length;
    const duDoanText = pred ? label(pred.code) : null;
    const latest = list[list.length - 1];
    
    let phienHienTai = game === 'b52' ? String(safeInt(latest.sid)) : String(safeInt(latest.SessionId));
    let xucXac = game === 'b52' ? getB52Dice(latest) : getDice(latest);
    let tongDiem = game === 'b52' ? getB52Sum(latest) : getSum(latest);

    return {
        status: "success",
        data: {
            phienHienTai, phienDuDoan: String(safeInt(phienHienTai) + 1),
            duDoan: duDoanText, tiLe: pred ? pred.tiLe : "—",
            liDo: pred ? `⭐ ${pred.label} → ${duDoanText} (${pred.tiLe})` : `⏳ Đang quét ${env.stats.L}/15 phiên...`,
            xucXac, tongDiem,
            moiTruong: {
                loai: env.type, doTinCay: env.confidence.toFixed(2), efs: env.efs + "%",
                doTinhKhiet: (env.purity*100).toFixed(1) + "%", doNhieu: (env.entropy*100).toFixed(1) + "%",
                nghieng: env.dominant ? label(env.dominant) : "CÂN BẰNG"
            },
            chiTietModel: { pattern: pred ? pred.label : '—', phase: pred ? pred.phase : 'WARMUP' },
            thongKe: { win, lose, winrate: settled.length ? ((win/settled.length)*100).toFixed(1)+'%' : '—', bankroll: (1000 + win*10 - lose*10) + '$' }
        }
    };
}

app.get('/taixiu', async (req, res) => {
    const list = await fetchApi(API_TX); const db = readDB('taixiu');
    if (!list || !list.length) return res.status(500).json({ status: "error" });
    const seq = list.map(getResult).filter(Boolean); const sums = list.map(getSum).filter(s => s >= 3 && s <= 18);
    const env = profileEnvironment(seq); const pred = seq.length >= 15 ? runUnbiasedEnsemble(seq, sums, db, env) : null;
    res.json(buildJsonResponse('taixiu', list, db, env, pred));
});

app.get('/md5', async (req, res) => {
    const list = await fetchApi(API_MD5); const db = readDB('md5');
    if (!list || !list.length) return res.status(500).json({ status: "error" });
    const seq = list.map(getResult).filter(Boolean); const sums = list.map(getSum).filter(s => s >= 3 && s <= 18);
    const env = profileEnvironment(seq); const pred = seq.length >= 15 ? runUnbiasedEnsemble(seq, sums, db, env) : null;
    res.json(buildJsonResponse('md5', list, db, env, pred));
});

app.get('/b52', async (req, res) => {
    const list = await fetchB52(); const db = readDB('b52');
    if (!list || !list.length) return res.status(500).json({ status: "error" });
    const seq = list.map(getB52Result).filter(Boolean); const sums = list.map(getB52Sum).filter(s => s >= 3 && s <= 18);
    const env = profileEnvironment(seq); const pred = seq.length >= 15 ? runUnbiasedEnsemble(seq, sums, db, env) : null;
    res.json(buildJsonResponse('b52', list, db, env, pred));
});

// ============================================================
// 8. UI
// ============================================================
app.get('/ui/:game', (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu' && game !== 'b52') return res.send('Game không hợp lệ');
    const db = readDB(game);
    const rows = db.history.slice(-80).reverse();
    const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const correct = settled.filter(h => h.trangThai === 'ĐÚNG').length;
    const acc = settled.length ? (correct / settled.length * 100).toFixed(1) : '0.0';
    const env = db.envProfile || { type: 'CHƯA CÓ', confidence: 0, efs: 0, purity: 0, entropy: 1, dominant: null };

    res.send(`<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>V50 - ${game.toUpperCase()}</title>
<style>
*{box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#0a0e27;color:#e6eef6;padding:12px;margin:0}
.header{background:linear-gradient(135deg,#1e3a8a,#3b82f6);padding:16px;border-radius:14px;margin-bottom:14px}
h1{color:#fff;font-size:20px;margin:0 0 8px;font-weight:800;text-align:center}
.env-box{background:rgba(0,0,0,.3);padding:10px;border-radius:10px;font-size:13px;margin-bottom:8px}
.env-row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.1)}
.env-row:last-child{border:none}.env-val{color:#fbbf24;font-weight:700}
.efs-bar{height:6px;background:#1e293b;border-radius:3px;overflow:hidden;margin-top:6px}
.efs-fill{height:100%;background:linear-gradient(90deg,#ef4444,#fbbf24,#22c55e);transition:width .3s}
.table-wrap{background:#0f172a;border-radius:12px;overflow-x:auto;border:1px solid #334155}
table{width:100%;border-collapse:collapse;font-size:11px}
th{background:#1e40af;color:#fff;padding:8px 4px;font-size:10px;text-transform:uppercase}
td{padding:8px 3px;text-align:center;border-bottom:1px solid #1e293b}
.tai{color:#22c55e;font-weight:700}.xiu{color:#ef4444;font-weight:700}
.dung{color:#22c55e;font-weight:700}.sai{color:#ef4444;font-weight:700}.cho{color:#94a3b8;font-weight:600}
.dice{color:#fbbf24;font-weight:700;line-height:1.2;font-size:10px}
.sum{display:inline-block;padding:2px 5px;border-radius:4px;background:#334155;color:#fbbf24;font-weight:800;font-size:11px}
.session{font-family:monospace;font-size:10px;color:#64748b}
.ti-le{font-size:11px;color:#cbd5e1;font-weight:600}
.phase-warm{color:#fbbf24;background:#78350f;padding:2px 5px;border-radius:4px}
.phase-ready{color:#22c55e;background:#14532d;padding:2px 5px;border-radius:4px}
.env-tag{display:inline-block;padding:2px 5px;border-radius:4px;font-size:9px;font-weight:700;background:#1e40af;color:#fff}
</style><script>setTimeout(()=>location.reload(), 5000);</script></head><body>
<div class="header"><h1>V50 · ${game.toUpperCase()}</h1>
<div class="env-box">
<div class="env-row"><span>🌍 Môi trường</span><span class="env-val">${env.type}</span></div>
<div class="env-row"><span>🎯 Độ tin cậy</span><span class="env-val">${(env.confidence*100).toFixed(1)}%</span></div>
<div class="env-row"><span>📊 EFS</span><span class="env-val">${env.efs}%</span></div>
<div class="env-row"><span>💎 Tinh khiết</span><span class="env-val">${(env.purity*100).toFixed(1)}%</span></div>
<div class="env-row"><span>🌫️ Nhiễu</span><span class="env-val">${(env.entropy*100).toFixed(1)}%</span></div>
<div class="env-row"><span>⚖️ Nghiêng</span><span class="env-val">${env.dominant ? label(env.dominant) : 'CÂN BẰNG'}</span></div>
<div class="efs-bar"><div class="efs-fill" style="width:${env.efs}%"></div></div></div>
<div style="text-align:center;font-size:13px;color:#fff">Chính xác: <strong>${acc}%</strong> (${settled.length} phiên)</div></div>
<div class="table-wrap"><table><thead><tr><th>PHIÊN</th><th>XX</th><th>TỔNG</th><th>KQ</th><th>DỰ ĐOÁN</th><th>TỈ LỆ</th><th>MÔI TRƯỜNG</th><th>PHASE</th><th>TT</th></tr></thead><tbody>
${rows.map(it => {
    const dice = (it.xucXac || []).join('-');
    const kq = it.ketQua === 'T' ? 'tai' : 'xiu';
    const dd = it.DU_DOAN_CODE === 'T' ? 'tai' : (it.DU_DOAN_CODE === 'X' ? 'xiu' : '');
    const tt = it.trangThai === 'ĐÚNG' ? 'dung' : (it.trangThai === 'SAI' ? 'sai' : 'cho');
    const phaseCls = it.phase === 'READY' ? 'phase-ready' : 'phase-warm';
    return `<tr><td class="session">${it.phien}</td><td class="dice">${dice}</td>
        <td><span class="sum">${it.tong || ''}</span></td><td class="${kq}">${it.ketQuaLabel || ''}</td>
        <td class="${dd}">${it.DU_DOAN || '—'}</td><td><span class="ti-le">${it.TI_LE}</span></td>
        <td><span class="env-tag">${it.envType || '—'}</span></td><td><span class="${phaseCls}">${it.phase || '—'}</span></td>
        <td class="${tt}">${it.trangThai === 'ĐANG CHỜ' ? '...' : it.trangThai}</td></tr>`;
}).join('')}</tbody></table></div></body></html>`);
});

app.get('/', (req, res) => res.redirect('/ui/md5'));
app.listen(PORT, () => console.log(`🚀 V50 Server running on port ${PORT}`));
