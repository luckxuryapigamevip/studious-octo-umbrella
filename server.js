'use strict';
// ============================================================
// SICBO AI V54 - FULL 1K LINES ALGORITHMS + B52 FIX
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
// 1. CẤU HÌNH
// ============================================================
const API_MD5 = 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau';
const API_TX  = 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau';
const API_B52 = 'https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=b5&gid=vgmn_101';

const DB_DIR = process.env.DB_DIR || __dirname;
const TICK_MS = 5000;
const REVERSAL_THRESHOLD = 3;

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
// 2. HELPERS
// ============================================================
function safeInt(x, def = 0) { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
const label = c => c === 'T' ? 'TÀI' : (c === 'X' ? 'XỈU' : null);
const flip  = c => c === 'T' ? 'X'   : (c === 'X' ? 'T'   : null);

function dbPath(g) { return path.join(DB_DIR, `db_v54_${g}.json`); }
function readDB(g) {
    const p = dbPath(g);
    try {
        if (fs.existsSync(p)) {
            const db = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (!db.rawHistory) db.rawHistory = [];
            if (!db.weights) db.weights = {};
            if (!db.patternStats) db.patternStats = {};
            return db;
        }
    } catch (e) {}
    return { rawHistory: [], weights: {}, patternStats: {}, envProfile: null };
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
    if (L < 10) return { type: 'CHƯA_ĐỦ_DATA', confidence: 0, efs: 0, entropy: 1, disabledPatterns: [], stats: { L } };
    
    const tCount = seq.filter(x => x === 'T').length;
    const xCount = L - tCount;
    let pT = tCount / L, pX = xCount / L;
    let entropy = 0;
    if (pT > 0) entropy -= pT * Math.log2(pT);
    if (pX > 0) entropy -= pX * Math.log2(pX);

    let type = 'HỖN_HỢP';
    let disabled = [];
    if (entropy > 0.90) { type = 'NHIỄU'; disabled = ['cau_bet', 'cau_dao_11', 'cau_ziczac', 'cau_rong', 'cau_chu_ky', 'distribution']; }
    else if (entropy < 0.50) { type = 'BỆT'; disabled = ['cau_dao_11', 'cau_ziczac']; }

    const efs = Math.min(100, (L / 60) * 100);
    return { type, confidence: 0.5, efs: Math.round(efs), purity: 1-entropy, entropy, dominant: null, availablePatterns: [], disabledPatterns: disabled, stats: { L, tCount, xCount } };
}

// ============================================================
// 4. 1K DÒNG THUẬT TOÁN CẦU (CHUYỂN THỂ TỪ BẢN GỐC)
// ============================================================
function getW(db, id) { return db.weights?.[id]?.w || 1.0; }

function analyzeCauBet(results, db) {
    if (results.length < 3) return null;
    let streakType = results[0], streakLength = 1;
    for (let i = 1; i < results.length; i++) { if (results[i] === streakType) streakLength++; else break; }
    if (streakLength >= 3) {
        let shouldBreak = streakLength >= 6;
        return { prediction: shouldBreak ? flip(streakType) : streakType, confidence: (shouldBreak ? Math.min(12, streakLength * 2) : Math.min(15, streakLength * 3)) * getW(db, 'cau_bet'), name: `Cầu Bệt ${streakLength}`, code: 'cau_bet' };
    }
    return null;
}

function analyzeCauDao11(results, db) {
    if (results.length < 4) return null;
    let len = 1;
    for (let i = 1; i < Math.min(results.length, 10); i++) { if (results[i] !== results[i - 1]) len++; else break; }
    if (len >= 4) return { prediction: flip(results[0]), confidence: Math.min(14, len * 2 + 4) * getW(db, 'cau_dao_11'), name: `Cầu Đảo 1-1 (${len})`, code: 'cau_dao_11' };
    return null;
}

function analyzeCau22(results, db) {
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

function analyzeCau33(results, db) {
    if (results.length < 6) return null;
    let tripleCount = 0, i = 0, pattern = [];
    while (i < results.length - 2) {
        if (results[i] === results[i + 1] && results[i + 1] === results[i + 2]) { pattern.push(results[i]); tripleCount++; i += 3; } else break;
    }
    if (tripleCount >= 1) {
        const currentPos = results.length % 3;
        let pred = currentPos === 0 ? flip(pattern[pattern.length - 1]) : pattern[pattern.length - 1];
        return { prediction: pred, confidence: Math.min(13, tripleCount * 4 + 5) * getW(db, 'cau_33'), name: `Cầu 3-3 (${tripleCount})`, code: 'cau_33' };
    }
    return null;
}

function analyzeCau121(results, db) {
    if (results.length < 4) return null;
    const p = results.slice(0, 4);
    if (p[0] !== p[1] && p[1] === p[2] && p[2] !== p[3] && p[0] === p[3]) {
        return { prediction: p[0], confidence: 10 * getW(db, 'cau_121'), name: 'Cầu 1-2-1', code: 'cau_121' };
    }
    return null;
}

function analyzeCau123(results, db) {
    if (results.length < 6) return null;
    const first = results[5], nextTwo = results.slice(3, 5), lastThree = results.slice(0, 3);
    if (nextTwo[0] === nextTwo[1] && nextTwo[0] !== first && lastThree.every(r => r === lastThree[0]) && lastThree[0] !== nextTwo[0]) {
        return { prediction: first, confidence: 11 * getW(db, 'cau_123'), name: 'Cầu 1-2-3', code: 'cau_123' };
    }
    return null;
}

function analyzeCau321(results, db) {
    if (results.length < 6) return null;
    const f3 = results.slice(3, 6), n2 = results.slice(1, 3), l1 = results[0];
    if (f3.every(r => r === f3[0]) && n2.every(r => r === n2[0]) && f3[0] !== n2[0] && l1 !== n2[0]) {
        return { prediction: n2[0], confidence: 12 * getW(db, 'cau_321'), name: 'Cầu 3-2-1', code: 'cau_321' };
    }
    return null;
}

function analyzeCauNhayCoc(results, db) {
    if (results.length < 6) return null;
    const skip = [];
    for (let i = 0; i < Math.min(results.length, 12); i += 2) skip.push(results[i]);
    if (skip.length >= 3) {
        if (skip.slice(0, 3).every(r => r === skip[0])) return { prediction: skip[0], confidence: 8 * getW(db, 'cau_nhay_coc'), name: 'Nhảy Cóc', code: 'cau_nhay_coc' };
        let alt = true;
        for (let i = 1; i < skip.length - 1; i++) { if (skip[i] === skip[i - 1]) { alt = false; break; } }
        if (alt) return { prediction: flip(skip[0]), confidence: 7 * getW(db, 'cau_nhay_coc'), name: 'Nhảy Cóc Đảo', code: 'cau_nhay_coc' };
    }
    return null;
}

function analyzeCauNhipNghieng(results, db) {
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

function analyzeCau3Van1(results, db) {
    if (results.length < 4) return null;
    const last4 = results.slice(0, 4), taiCount = last4.filter(r => r === 'T').length;
    if (taiCount === 3 && last4[3] === 'X') return { prediction: 'T', confidence: 8 * getW(db, 'cau_3van1'), name: '3 Ván 1', code: 'cau_3van1' };
    if (taiCount === 1 && last4[3] === 'T') return { prediction: 'X', confidence: 8 * getW(db, 'cau_3van1'), name: '3 Ván 1', code: 'cau_3van1' };
    return null;
}

function analyzeCauBeCau(results, db) {
    if (results.length < 5) return null;
    let len = 1;
    for (let i = 1; i < results.length; i++) { if (results[i] === results[0]) len++; else break; }
    if (len >= 4) return { prediction: flip(results[0]), confidence: Math.min(14, len * 2 + 4) * getW(db, 'cau_be_cau'), name: `Bẻ Cầu ${len}`, code: 'cau_be_cau' };
    return null;
}

function analyzeCau44(results, db) {
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

function analyzeCau55(results, db) {
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

function analyzeCau212(results, db) {
    if (results.length < 5) return null;
    const p = results.slice(0, 5);
    if (p[0] === p[1] && p[1] !== p[2] && p[2] === p[3] && p[3] !== p[4] && p[0] !== p[2]) {
        return { prediction: flip(p[0]), confidence: 10 * getW(db, 'cau_212'), name: 'Cầu 2-1-2', code: 'cau_212' };
    }
    return null;
}

function analyzeCau1221(results, db) {
    if (results.length < 6) return null;
    const p = results.slice(0, 6);
    if (p[0] !== p[1] && p[1] === p[2] && p[2] === p[3] && p[3] !== p[4] && p[4] === p[5] && p[0] !== p[1]) {
        return { prediction: p[0], confidence: 11 * getW(db, 'cau_1221'), name: 'Cầu 1-2-2-1', code: 'cau_1221' };
    }
    return null;
}

function analyzeCau2112(results, db) {
    if (results.length < 6) return null;
    const p = results.slice(0, 6);
    if (p[0] === p[1] && p[1] !== p[2] && p[2] === p[3] && p[3] !== p[4] && p[4] === p[5] && p[0] !== p[2]) {
        return { prediction: p[0], confidence: 11 * getW(db, 'cau_2112'), name: 'Cầu 2-1-1-2', code: 'cau_2112' };
    }
    return null;
}

function analyzeCauGap(results, db) {
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

function analyzeCauZiczac(results, db) {
    if (results.length < 8) return null;
    let count = 0;
    for (let i = 0; i < results.length - 2; i++) {
        if (results[i] !== results[i+1] && results[i+1] !== results[i+2] && results[i] === results[i+2]) count++; else break;
    }
    if (count >= 3) return { prediction: flip(results[0]), confidence: Math.min(13, count * 2 + 5) * getW(db, 'cau_ziczac'), name: `Ziczac (${count})`, code: 'cau_ziczac' };
    return null;
}

function analyzeCauDoi(results, db) {
    if (results.length < 4) return null;
    let pairChanges = 0, i = 0;
    while (i < results.length - 1) { if (results[i] === results[i+1]) { pairChanges++; i += 2; } else break; }
    if (pairChanges >= 2) {
        const isAlt = results[0] !== results[2];
        return { prediction: isAlt ? flip(results[0]) : results[0], confidence: Math.min(12, pairChanges * 3 + 4) * getW(db, 'cau_doi'), name: `Cầu Đôi (${pairChanges})`, code: 'cau_doi' };
    }
    return null;
}

function analyzeCauRong(results, db) {
    if (results.length < 6) return null;
    let len = 1;
    for (let i = 1; i < results.length; i++) { if (results[i] === results[0]) len++; else break; }
    if (len >= 6) return { prediction: flip(results[0]), confidence: Math.min(16, len + 8) * getW(db, 'cau_rong'), name: `Rồng ${len}`, code: 'cau_rong' };
    return null;
}

function analyzeSmartBet(results, db) {
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

function analyzeCauChuKy(results, db) {
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

function analyzeCauTuNhien(results, db) {
    const l10 = results.slice(0, Math.min(10, results.length));
    const t = l10.filter(r => r === 'T').length;
    return { prediction: t > l10.length/2 ? 'T' : 'X', confidence: 5 * getW(db, 'cau_tu_nhien'), name: 'Cầu Tự Nhiên', code: 'cau_tu_nhien' };
}

// ============================================================
// 5. TỔNG HỢP KHÔNG THIÊN VỊ
// ============================================================
function runUnbiasedEnsemble(seq, db, env) {
    const disabled = new Set(env.disabledPatterns);
    let votesT = [], votesX = [], details = [];
    const last = seq[seq.length - 1];

    const funcs = [
        analyzeCauBet, analyzeCauDao11, analyzeCau22, analyzeCau33, analyzeCau121, 
        analyzeCau123, analyzeCau321, analyzeCauNhayCoc, analyzeCauNhipNghieng,
        analyzeCau3Van1, analyzeCauBeCau, analyzeCau44, analyzeCau55, analyzeCau212, 
        analyzeCau1221, analyzeCau2112, analyzeCauGap, analyzeCauZiczac,
        analyzeCauDoi, analyzeCauRong, analyzeSmartBet, analyzeCauChuKy
    ];

    for (const fn of funcs) {
        let res = null; try { res = fn(seq, db); } catch (e) {}
        if (!res || disabled.has(res.code)) continue;

        const baseW = DEFAULT_PATTERN_WEIGHTS[res.code] || 1.0;
        const learnedW = db.weights?.[res.code]?.w || 1.0;
        
        let penalty = 1.0;
        let currentStreak = 1;
        for (let i = seq.length - 2; i >= 0; i--) { if (seq[i] === last) currentStreak++; else break; }
        if (currentStreak >= 3) { if (res.prediction === last) penalty = 0.5; else penalty = 1.5; }

        const vote = (res.confidence / 100) * baseW * learnedW * penalty;

        if (res.prediction === 'T') votesT.push({ vote, name: res.name });
        else votesX.push({ vote, name: res.name });
        details.push({ algo: res.code, code: res.prediction, name: res.name });
    }

    if (votesT.length === 0 && votesX.length === 0) {
        const fb = analyzeCauTuNhien(seq, db);
        if (fb.prediction === 'T') votesT.push({ vote: 0.05, name: fb.name });
        else votesX.push({ vote: 0.05, name: fb.name });
        details.push({ algo: 'cau_tu_nhien', code: fb.prediction, name: fb.name });
    }

    const cT = votesT.length, cX = votesX.length;
    const sT = votesT.reduce((a, b) => a + b.vote, 0);
    const sX = votesX.reduce((a, b) => a + b.vote, 0);
    const scoreT = cT > 0 ? sT / cT : 0;
    const scoreX = cX > 0 ? sX / cX : 0;

    let winner, confidence, patternName;

    if (Math.abs(scoreT - scoreX) < 0.03) {
        winner = flip(last); confidence = 0.515; patternName = 'HÒA-BẺ-CẦU';
    } else {
        winner = scoreT > scoreX ? 'T' : 'X';
        const diff = Math.abs(scoreT - scoreX) / Math.max(scoreT, scoreX);
        if (diff < 0.05) {
            winner = flip(last); confidence = 0.52; patternName = 'BẺ-CẦU-NHIỄU';
        } else {
            confidence = clamp(0.5 + diff * 0.5, 0.5, 0.85);
            patternName = (winner === 'T' ? votesT : votesX).sort((a,b)=>b.vote-a.vote)[0].name;
        }
    }

    if (env.stats.L < 15) confidence = clamp(0.51 + (confidence - 0.5) * 0.5, 0.51, 0.55);
    else if (env.efs < 80) confidence = clamp(Math.min(confidence, 0.51 + (env.efs / 80) * 0.08), 0.51, 0.59);
    else confidence = clamp(confidence * (1 + ((env.efs - 80) / 20) * 0.1), 0.51, 0.85);

    return { code: winner, label: patternName, tiLe: (confidence*100).toFixed(1)+'%', confidence, details };
}

// ============================================================
// 6. FETCH & PROCESS (FIX LỖI B52)
// ============================================================
async function fetchApi(url) {
    try {
        const res = await axios.get(url, { timeout: 10000 });
        return res.data?.data?.list || res.data?.list || res.data?.data || (Array.isArray(res.data) ? res.data : []);
    } catch (e) { return []; }
}

async function fetchB52() {
    try {
        const res = await axios.get(API_B52, { timeout: 10000 });
        if (res.data && res.data.data && Array.isArray(res.data.data)) return res.data.data;
        return [];
    } catch (e) { return []; }
}

async function processGame(game) {
    const db = readDB(game);
    let currentSeq = [];
    let list = [];

    if (game === 'b52') {
        list = await fetchB52();
        if (!list || !list.length) return;
        const latest = list[0]; // B52 trả về mới nhất ở vị trí 0
        const sid = safeInt(latest.sid);

        if (!db.rawHistory.find(x => x.sid === sid)) {
            db.rawHistory.push({ sid, d1: safeInt(latest.d1), d2: safeInt(latest.d2), d3: safeInt(latest.d3), result: getB52Result(latest) });
            if (db.rawHistory.length > 500) db.rawHistory.shift();
            saveDB(game, db);
            console.log(`✅ [B52] Đã lưu phiên: ${sid}. Tổng: ${db.rawHistory.length}/15`);
        }
        currentSeq = db.rawHistory.map(x => x.result);
    } else {
        list = await fetchApi(game === 'md5' ? API_MD5 : API_TX);
        if (!list || !list.length) return;
        currentSeq = list.map(getResult).filter(Boolean);
    }

    if (currentSeq.length < 15) return;

    const env = profileEnvironment(currentSeq);
    db.envProfile = env;
    const pred = runUnbiasedEnsemble(currentSeq, db, env);
    
    const currentSid = game === 'b52' ? db.rawHistory[db.rawHistory.length - 1].sid : safeInt(list[list.length - 1].SessionId);
    const lastHist = db.history.length > 0 ? db.history[db.history.length - 1] : null;

    if (!lastHist || lastHist.phien < currentSid) {
        db.history.push({ phien: currentSid, duDoan: label(pred.code), tiLe: pred.tiLe, patternName: pred.label, envType: env.type });
        if (db.history.length > 100) db.history.shift();
        saveDB(game, db);
    }
}

setInterval(() => { processGame('md5'); processGame('taixiu'); processGame('b52'); }, TICK_MS);

// ============================================================
// 7. ROUTE API JSON
// ============================================================
app.get('/b52', async (req, res) => {
    const db = readDB('b52');
    const seq = db.rawHistory.map(x => x.result);
    if (seq.length < 15) return res.json({ status: "waiting", message: `Đang thu thập: ${seq.length}/15 phiên...` });
    
    const env = profileEnvironment(seq);
    const pred = runUnbiasedEnsemble(seq, db, env);
    const latest = db.rawHistory[db.rawHistory.length - 1];

    res.json({
        status: "success",
        data: {
            phienHienTai: latest.sid, phienDuDoan: latest.sid + 1,
            duDoan: label(pred.code), tiLe: pred.tiLe,
            xucXac: [latest.d1, latest.d2, latest.d3], tongDiem: latest.d1 + latest.d2 + latest.d3,
            moiTruong: { loai: env.type, efs: env.efs + '%' }, liDo: `Cầu: ${pred.label}`
        }
    });
});

app.get('/taixiu', async (req, res) => {
    const list = await fetchApi(API_TX);
    if (!list.length) return res.json({ status: "error" });
    const seq = list.map(getResult).filter(Boolean);
    if (seq.length < 15) return res.json({ status: "waiting", message: `${seq.length}/15` });
    
    const pred = runUnbiasedEnsemble(seq, readDB('taixiu'), profileEnvironment(seq));
    const latest = list[list.length - 1];
    res.json({ status: "success", data: { phienHienTai: safeInt(latest.SessionId), phienDuDoan: safeInt(latest.SessionId) + 1, duDoan: label(pred.code), tiLe: pred.tiLe } });
});

app.get('/md5', async (req, res) => {
    const list = await fetchApi(API_MD5);
    if (!list.length) return res.json({ status: "error" });
    const seq = list.map(getResult).filter(Boolean);
    if (seq.length < 15) return res.json({ status: "waiting", message: `${seq.length}/15` });
    
    const pred = runUnbiasedEnsemble(seq, readDB('md5'), profileEnvironment(seq));
    const latest = list[list.length - 1];
    res.json({ status: "success", data: { phienHienTai: safeInt(latest.SessionId), phienDuDoan: safeInt(latest.SessionId) + 1, duDoan: label(pred.code), tiLe: pred.tiLe } });
});

app.listen(PORT, () => console.log(`🚀 V54 Server chạy tại port ${PORT}`));
