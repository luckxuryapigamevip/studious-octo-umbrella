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

// ========================================================================
// CONFIG — TẤT CẢ NGƯỠNG ĐỀU CHỈNH ĐƯỢC
// ========================================================================
const CONFIG = {
    WARMUP: {
        MIN_SESSIONS: 20,       // Dưới mức này = warm-up hoàn toàn (confidence 51-55%)
        FULL_SESSIONS: 60,      // Trên mức này = EFS dataVolume = 100%
        EFS_TARGET: 80          // Ngưỡng EFS để thoát warm-up hoàn toàn
    },
    ENV: {
        PURITY_HIGH: 0.65,      // entropy thấp + streak dài → môi trường tinh khiết
        PURITY_LOW: 0.35,       // entropy cao → môi trường nhiễu
        MIN_SAMPLES: 20
    },
    UNBIASED: {
        MIN_CONSENSUS: 3,       // Số cầu tối thiểu mỗi phía để tin
        TIE_MARGIN: 0.02        // Nếu |score_T - score_X| < margin → coi như hòa, dùng env
    },
    CONFIDENCE: {
        WARMUP_FLOOR: 0.51,
        WARMUP_CEIL: 0.59,
        READY_FLOOR: 0.51,
        READY_CEIL: 0.85,
        EFS_BOOST_MAX: 0.12
    }
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
    return h; // 0..1 cho binary
}

// ========================================================================
// 1. DATABASE LAYER
// ========================================================================
function dbPath(g) { return path.join(DB_DIR, `db_v40_${g}.json`); }
function readDB(g) {
    const p = dbPath(g);
    try {
        if (fs.existsSync(p)) {
            const db = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (!db.weights) db.weights = {};
            if (!db.streakStats) db.streakStats = { T: {}, X: {} };
            if (!db.history) db.history = [];
            if (!db.envProfile) db.envProfile = null;
            return db;
        }
    } catch (e) {}
    return {
        history: [],
        lastProcessedSession: null,
        weights: {},
        streakStats: { T: {}, X: {} },
        envProfile: null
    };
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

// ========================================================================
// 2. ENV PROFILER — NHẬN DIỆN MÔI TRƯỜNG CẦU (KHÔNG CỨNG)
// ========================================================================
/**
 * Phân tích chuỗi history và trả về profile môi trường.
 * Các chỉ số:
 *  - entropy: độ ngẫu nhiên của chuỗi (0=đồng nhất, 1=ngẫu nhiên hoàn toàn)
 *  - streakRatio: tỉ lệ phiên thuộc "bệt dài" (>=3)
 *  - zigzagRatio: tỉ lệ đảo 1-1 trong 20 phiên gần
 *  - cycleStrength: độ mạnh của chu kỳ (tự tương quan)
 *  - balance: |T - X| / tổng (0=cân bằng, 1=lệch hoàn toàn)
 *  - purity: độ tinh khiết của môi trường (0=nhiễu, 1=rõ)
 *  - type: BỆT | ZIGZAG | CHU_KỲ | HỖN_HỢP | NHIỄU
 *  - dominant: 'T' | 'X' | null (nếu môi trường nghiêng hẳn)
 *  - availablePatterns: danh sách cầu CÓ THỂ xuất hiện
 *  - disabledPatterns: danh sách cầu KHÔNG THỂ xuất hiện
 */
function profileEnvironment(seq) {
    const L = seq.length;
    if (L < CONFIG.ENV.MIN_SAMPLES) {
        return {
            type: 'INSUFFICIENT', confidence: 0, efs: 0,
            dominant: null, purity: 0, entropy: 1,
            availablePatterns: [], disabledPatterns: [],
            stats: {}
        };
    }

    const tCount = seq.filter(x => x === 'T').length;
    const xCount = L - tCount;
    const balance = Math.abs(tCount - xCount) / L; // 0..1
    const entropy = entropyBits(seq) / 1;          // 0..1 (binary)

    // Streak analysis
    let streaks = [];
    let cur = seq[0], len = 1;
    for (let i = 1; i < L; i++) {
        if (seq[i] === cur) len++;
        else { streaks.push(len); cur = seq[i]; len = 1; }
    }
    streaks.push(len);
    const longStreaks = streaks.filter(s => s >= 3).length;
    const streakRatio = longStreaks / streaks.length;
    const maxStreak = Math.max(...streaks);
    const avgStreak = streaks.reduce((a, b) => a + b, 0) / streaks.length;

    // Zigzag analysis (20 phiên gần)
    const recent20 = seq.slice(-Math.min(20, L));
    let flips20 = 0;
    for (let i = 1; i < recent20.length; i++) if (recent20[i] !== recent20[i-1]) flips20++;
    const zigzagRatio = recent20.length > 1 ? flips20 / (recent20.length - 1) : 0;

    // Cycle analysis (auto-correlation cho các lag 2..8)
    let bestCycleLag = 0, bestCycleScore = 0;
    for (let lag = 2; lag <= 8; lag++) {
        if (L < lag * 2) continue;
        let matches = 0;
        for (let i = lag; i < L; i++) if (seq[i] === seq[i - lag]) matches++;
        const score = matches / (L - lag);
        if (score > bestCycleScore) { bestCycleScore = score; bestCycleLag = lag; }
    }

    // Purity: môi trường tinh khiết khi entropy thấp hoặc zigzagRatio rất cao/thấp
    let purity;
    if (streakRatio >= 0.5 || zigzagRatio >= 0.85) purity = 1 - entropy * 0.3;
    else if (bestCycleScore >= 0.7) purity = bestCycleScore;
    else purity = 1 - entropy;

    // Phân loại môi trường
    let type = 'NHIỄU';
    let confidence = 0;
    if (entropy < 0.4 && (streakRatio >= 0.4 || maxStreak >= 5)) {
        type = 'BỆT';
        confidence = clamp((0.4 - entropy) / 0.4, 0.6, 1);
    } else if (zigzagRatio >= 0.75 && entropy > 0.7) {
        type = 'ZIGZAG';
        confidence = clamp((zigzagRatio - 0.75) / 0.25 + 0.6, 0.6, 1);
    } else if (bestCycleScore >= 0.65) {
        type = 'CHU_KỲ';
        confidence = clamp((bestCycleScore - 0.65) / 0.35 + 0.6, 0.6, 1);
    } else if (entropy >= 0.85 && Math.abs(zigzagRatio - 0.5) < 0.15 && bestCycleScore < 0.6) {
        type = 'NHIỄU';
        confidence = clamp((entropy - 0.85) / 0.15 + 0.5, 0.5, 1);
    } else {
        type = 'HỖN_HỢP';
        confidence = 0.5;
    }

    // Dominant (nếu lệch rõ)
    const dominant = balance > 0.15 ? (tCount > xCount ? 'T' : 'X') : null;

    // Xác định cầu nào available / disabled theo loại môi trường
    const availablePatterns = [];
    const disabledPatterns = [];

    const enable = id => { if (!availablePatterns.includes(id)) availablePatterns.push(id); };
    const disable = id => { if (!disabledPatterns.includes(id)) disabledPatterns.push(id); };

    // Tất cả cầu đều "có thể" xuất hiện — nhưng ưu tiên theo môi trường
    // Cầu nào KHÔNG THỂ xuất hiện thì disable
    if (type === 'NHIỄU') {
        // Môi trường nhiễu: bệt, zigzag, chu kỳ đều không đáng tin
        disable('streak'); disable('zigzag'); disable('cycle');
        disable('mirror'); disable('palindrome');
        enable('markov'); enable('ngram'); enable('gap'); enable('pull');
    } else if (type === 'BỆT') {
        enable('streak'); enable('pull');
        // Zigzag hiếm khi xuất hiện trong môi trường bệt
        disable('zigzag');
    } else if (type === 'ZIGZAG') {
        enable('zigzag'); enable('mirror'); enable('palindrome');
        disable('streak');
    } else if (type === 'CHU_KỲ') {
        enable('cycle'); enable('ngram'); enable('markov');
    } else if (type === 'HỖN_HỢP') {
        // Hỗn hợp: cầu nào cũng có thể — không disable gì
    }

    // EFS: dataVolume * 0.35 + purity * 0.30 + confidence * 0.20 + (1-entropy) * 0.15
    const dataVolume = clamp(L / CONFIG.WARMUP.FULL_SESSIONS, 0, 1);
    const efs = (
        dataVolume         * 0.35 +
        purity             * 0.30 +
        confidence         * 0.20 +
        (1 - entropy)      * 0.15
    ) * 100;

    return {
        type,
        confidence: Math.round(confidence * 1000) / 1000,
        efs: Math.round(efs * 10) / 10,
        dominant,
        purity: Math.round(purity * 1000) / 1000,
        entropy: Math.round(entropy * 1000) / 1000,
        availablePatterns,
        disabledPatterns,
        stats: {
            sessions: L,
            tCount, xCount,
            balance: Math.round(balance * 1000) / 1000,
            streakRatio: Math.round(streakRatio * 1000) / 1000,
            maxStreak,
            avgStreak: Math.round(avgStreak * 100) / 100,
            zigzagRatio: Math.round(zigzagRatio * 1000) / 1000,
            bestCycleLag, bestCycleScore: Math.round(bestCycleScore * 1000) / 1000
        }
    };
}

// ========================================================================
// 3. GENERATE ALL PATTERNS — phân nhóm theo FAMILY
// ========================================================================
function generateAllPatterns() {
    const A = [];

    // FAMILY streak
    for (let minLen = 2; minLen <= 8; minLen++) {
        A.push({
            id: `streak_learn_${minLen}`, family: 'streak', base: 1.5,
            fn: (seq, sums, db) => {
                const n = seq.length, last = seq[n - 1]; let len = 1;
                for (let i = n - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
                if (len < minLen) return null;
                const st = db.streakStats?.[last]?.[len];
                if (!st || (st.cont + st.stop) < 2) return null;
                const pCont = (st.cont + 1) / (st.cont + st.stop + 2);
                if (pCont > 0.55) return { code: last, name: `BỆT-${len}-TIẾP`, conf: clamp(pCont, 0.6, 0.85) };
                if (pCont < 0.45) return { code: flip(last), name: `BỆT-${len}-GÃY`, conf: clamp(1 - pCont, 0.6, 0.85) };
                return null;
            }
        });
    }
    for (let minLen = 3; minLen <= 8; minLen++) {
        A.push({
            id: `streak_pure_${minLen}`, family: 'streak', base: 1.2,
            fn: (seq) => {
                const n = seq.length, last = seq[n - 1]; let len = 1;
                for (let i = n - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
                return len >= minLen ? { code: last, name: `BỆT-THUẦN-${len}`, conf: 0.65 } : null;
            }
        });
    }

    // FAMILY zigzag
    for (let win = 4; win <= 10; win++) {
        A.push({
            id: `bounce_${win}`, family: 'zigzag', base: 1.4,
            fn: (seq) => {
                const n = seq.length; if (n < win + 1) return null;
                let flips = 0;
                for (let i = n - win; i < n; i++) if (seq[i] !== seq[i - 1]) flips++;
                return flips === win ? { code: flip(seq[n - 1]), name: `ĐẢO-1-1-W${win}`, conf: 0.75 } : null;
            }
        });
    }
    for (let p = 2; p <= 8; p++) {
        A.push({
            id: `zigzag_${p}`, family: 'zigzag', base: 1.3,
            fn: (seq) => {
                const n = seq.length; if (n < p * 2 + 2) return null;
                for (let i = n - p * 2; i < n - p; i++) if (seq[i] !== seq[i + p]) return null;
                return { code: seq[n - p], name: `ZIGZAG-${p}`, conf: 0.72 };
            }
        });
    }

    // FAMILY mirror / palindrome
    for (let half = 3; half <= 8; half++) {
        A.push({
            id: `mirror_${half}`, family: 'mirror', base: 1.3,
            fn: (seq) => {
                const n = seq.length; if (n < half * 2 + 2) return null;
                const rec = seq.slice(-(half * 2));
                if (rec.slice(0, half).map(flip).join('') === rec.slice(half).join(''))
                    return { code: flip(seq[n - 1]), name: `GƯƠNG-${half}`, conf: 0.7 };
                return null;
            }
        });
    }
    for (const n of [5, 7]) {
        A.push({
            id: `palin_${n}`, family: 'mirror', base: 1.2,
            fn: (seq) => {
                const L = seq.length; if (L < n + 1) return null;
                const w = seq.slice(-n);
                if (w.join('') === w.slice().reverse().join(''))
                    return { code: seq[L - n - 1], name: `PALIN-${n}`, conf: 0.74 };
                return null;
            }
        });
    }

    // FAMILY ngram
    for (let len = 3; len <= 10; len++) {
        A.push({
            id: `ngram_${len}`, family: 'ngram', base: 1.4,
            fn: (seq) => {
                const n = seq.length; if (n < len + 5) return null;
                const tail = seq.slice(-len).join(''); let t = 0, x = 0, occ = 0;
                for (let i = 0; i + len < n; i++) {
                    if (seq.slice(i, i + len).join('') === tail) { occ++; if (seq[i + len] === 'T') t++; else x++; }
                }
                if (occ < 2) return null;
                const pT = (t + 1) / (occ + 2), pX = (x + 1) / (occ + 2);
                if (Math.max(pT, pX) < 0.65) return null;
                return { code: pT > pX ? 'T' : 'X', name: `NGRAM-${len}`, conf: Math.max(pT, pX) };
            }
        });
    }
    for (let len = 3; len <= 6; len++) {
        A.push({
            id: `ngram_skip_${len}`, family: 'ngram', base: 1.2,
            fn: (seq) => {
                const n = seq.length; if (n < len * 2 + 5) return null;
                const tail = []; for (let k = 0; k < len; k++) tail.push(seq[n - 1 - 2 * k]);
                const tailStr = tail.join('');
                let t = 0, x = 0, occ = 0;
                for (let i = 0; i + 2 * len < n; i++) {
                    const block = []; for (let k = 0; k < len; k++) block.push(seq[i + 2 * k]);
                    if (block.join('') === tailStr) { occ++; if (seq[i + 2 * len] === 'T') t++; else x++; }
                }
                if (occ < 2) return null;
                const pT = (t + 1) / (occ + 2), pX = (x + 1) / (occ + 2);
                if (Math.max(pT, pX) < 0.65) return null;
                return { code: pT > pX ? 'T' : 'X', name: `NGRAM-SKIP-${len}`, conf: Math.max(pT, pX) };
            }
        });
    }

    // FAMILY markov
    for (let k = 2; k <= 10; k++) {
        A.push({
            id: `markov_${k}`, family: 'markov', base: 1.5,
            fn: (seq) => {
                const n = seq.length; if (n < k + 6) return null;
                const key = seq.slice(-k).join(''); let t = 0, x = 0;
                for (let i = k; i < n; i++) if (seq.slice(i - k, i).join('') === key) { if (seq[i] === 'T') t++; else x++; }
                const tot = t + x; if (tot < 3) return null;
                const pT = (t + 1) / (tot + 2), pX = (x + 1) / (tot + 2);
                if (Math.max(pT, pX) < 0.6) return null;
                return { code: pT > pX ? 'T' : 'X', name: `MARKOV-${k}`, conf: Math.max(pT, pX) };
            }
        });
    }

    // FAMILY cycle
    for (let p = 2; p <= 20; p++) {
        A.push({
            id: `cycle_${p}`, family: 'cycle', base: 1.2,
            fn: (seq) => {
                const n = seq.length; if (n < p * 2 + 2) return null;
                let m = 0, tot = 0;
                for (let i = p; i < n; i++) { tot++; if (seq[i] === seq[i - p]) m++; }
                const r = m / tot;
                if (r >= 0.7) return { code: seq[n - p], name: `CHU-KỲ-${p}`, conf: clamp(r, 0.7, 0.9) };
                return null;
            }
        });
    }

    // FAMILY gap
    for (let th = 0.5; th <= 1.5; th += 0.15) {
        A.push({
            id: `gap_${th.toFixed(2)}`, family: 'gap', base: 1.1,
            fn: (seq) => {
                const n = seq.length; if (n < 20) return null;
                const tP = [], xP = [];
                for (let i = 0; i < n; i++) seq[i] === 'T' ? tP.push(i) : xP.push(i);
                if (tP.length < 3 || xP.length < 3) return null;
                const tG = tP[tP.length - 1] - tP[tP.length - 2];
                const xG = xP[xP.length - 1] - xP[xP.length - 2];
                const tP2 = (n - tP[tP.length - 1]) / Math.max(tG, 1);
                const xP2 = (n - xP[xP.length - 1]) / Math.max(xG, 1);
                const diff = tP2 - xP2;
                if (Math.abs(diff) < th) return null;
                if (diff > th) return { code: 'T', name: `GAP-T-${th.toFixed(1)}`, conf: clamp(0.55 + diff * 0.05, 0.55, 0.8) };
                return { code: 'X', name: `GAP-X-${th.toFixed(1)}`, conf: clamp(0.55 + Math.abs(diff) * 0.05, 0.55, 0.8) };
            }
        });
    }

    // FAMILY fractal
    for (let sc = 3; sc <= 9; sc++) {
        A.push({
            id: `fractal_${sc}`, family: 'fractal', base: 1.3,
            fn: (seq) => {
                const n = seq.length; if (n < sc * 3) return null;
                const last = seq.slice(-sc).join('');
                let t = 0, x = 0, cnt = 0;
                for (let i = 0; i + sc < n - sc; i++) {
                    if (seq.slice(i, i + sc).join('') === last) { if (seq[i + sc] === 'T') t++; else x++; cnt++; }
                }
                if (cnt < 2) return null;
                const pT = (t + 0.5) / (cnt + 1), pX = (x + 0.5) / (cnt + 1);
                if (Math.max(pT, pX) < 0.65) return null;
                return { code: pT > pX ? 'T' : 'X', name: `FRACTAL-${sc}`, conf: Math.max(pT, pX) };
            }
        });
    }

    // FAMILY mtf (momentum)
    for (let w = 5; w <= 25; w += 3) {
        A.push({
            id: `mtf_${w}`, family: 'mtf', base: 1.1,
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

    // FAMILY pull
    for (let w = 20; w <= 60; w += 5) {
        A.push({
            id: `pull_${w}`, family: 'pull', base: 1.0,
            fn: (seq) => {
                const n = seq.length; if (n < w) return null;
                const rec = seq.slice(-w), pT = rec.filter(x => x === 'T').length / w;
                if (pT >= 0.6) return { code: 'X', name: `KÉO-CB-X-${w}`, conf: clamp(0.52 + (pT - 0.6), 0.52, 0.75) };
                if (pT <= 0.4) return { code: 'T', name: `KÉO-CB-T-${w}`, conf: clamp(0.52 + (0.4 - pT), 0.52, 0.75) };
                return null;
            }
        });
    }

    // FAMILY sum
    for (let w = 10; w <= 30; w += 5) {
        A.push({
            id: `sum_${w}`, family: 'sum', base: 1.0,
            fn: (seq, sums) => {
                if (!sums || sums.length < w) return null;
                const rec = sums.slice(-w), half = Math.floor(w / 2);
                const m1 = rec.slice(0, half).reduce((a, b) => a + b, 0) / half;
                const m2 = rec.slice(half).reduce((a, b) => a + b, 0) / half;
                if (m2 - m1 > 2) return { code: 'X', name: `SUM-DOWN-${w}`, conf: 0.62 };
                if (m1 - m2 > 2) return { code: 'T', name: `SUM-UP-${w}`, conf: 0.62 };
                return null;
            }
        });
    }

    // FAMILY cusum
    for (let w = 10; w <= 30; w += 5) {
        for (let th = 3; th <= 6; th += 1) {
            A.push({
                id: `cusum_${w}_${th}`, family: 'cusum', base: 1.2,
                fn: (seq) => {
                    const n = seq.length; if (n < w) return null;
                    const rec = seq.slice(-w);
                    let sp = 0, sn = 0;
                    for (const x of rec) {
                        const v = x === 'T' ? 1 : -1;
                        sp = Math.max(0, sp + v);
                        sn = Math.min(0, sn + v);
                    }
                    if (sp >= th) return { code: 'X', name: `CUSUM-DOWN-${w}-${th}`, conf: 0.66 };
                    if (sn <= -th) return { code: 'T', name: `CUSUM-UP-${w}-${th}`, conf: 0.66 };
                    return null;
                }
            });
        }
    }

    // FAMILY bayes
    for (let k = 2; k <= 5; k++) {
        A.push({
            id: `bayes_${k}`, family: 'bayes', base: 1.4,
            fn: (seq) => {
                const n = seq.length; if (n < k + 10) return null;
                const key = seq.slice(-k).join('');
                let t = 0, x = 0;
                for (let i = k; i < n; i++) {
                    if (seq.slice(i - k, i).join('') === key) {
                        if (seq[i] === 'T') t++; else x++;
                    }
                }
                const tot = t + x; if (tot < 4) return null;
                const pT = (t + 1) / (tot + 2);
                const conf = Math.max(pT, 1 - pT);
                if (conf < 0.62) return null;
                return { code: pT > 0.5 ? 'T' : 'X', name: `BAYES-${k}`, conf };
            }
        });
    }

    // FAMILY transmat
    for (let w = 30; w <= 100; w += 20) {
        A.push({
            id: `transmat_${w}`, family: 'transmat', base: 1.0,
            fn: (seq) => {
                const n = seq.length; if (n < w) return null;
                const rec = seq.slice(-w);
                let TT = 0, TX = 0, XT = 0, XX = 0;
                for (let i = 1; i < rec.length; i++) {
                    if (rec[i - 1] === 'T') rec[i] === 'T' ? TT++ : TX++;
                    else rec[i] === 'T' ? XT++ : XX++;
                }
                const last = rec[rec.length - 1];
                let pT;
                if (last === 'T') pT = (TT + 1) / (TT + TX + 2);
                else pT = (XT + 1) / (XT + XX + 2);
                const conf = Math.max(pT, 1 - pT);
                if (conf < 0.58) return null;
                return { code: pT > 0.5 ? 'T' : 'X', name: `TRANS-${w}`, conf };
            }
        });
    }

    return A;
}
const ALL_ALGOS = generateAllPatterns();
console.log(`✅ Đã sinh ${ALL_ALGOS.length} cầu thuộc ${new Set(ALL_ALGOS.map(a=>a.family)).size} family`);

// ========================================================================
// 4. UNBIASED ENSEMBLE — KHÔNG THIÊN VỊ
// ========================================================================
/**
 * Chạy tất cả cầu available cho môi trường hiện tại.
 * Bỏ phiếu ĐỐI XỨNG:
 *   score_T = sum(vote của cầu đoán T) / count_T
 *   score_X = sum(vote của cầu đoán X) / count_X
 * → 1 cầu T mạnh KHÔNG bị 10 cầu X yếu đè bẹp (vì chia count)
 *
 * Fallback (không cầu nào khớp):
 *   - Nếu envProfile.dominant != null → theo dominant NHƯNG chỉ 51.5%
 *   - Nếu không → dùng 50/50 THUẦN (không ép cân bằng nhân tạo)
 */
function runUnbiasedEnsemble(seq, sums, db, envProfile) {
    const available = new Set(envProfile.availablePatterns);
    const disabled = new Set(envProfile.disabledPatterns);

    const votesT = [];
    const votesX = [];
    const details = [];

    for (const algo of ALL_ALGOS) {
        // Bỏ qua cầu bị disable bởi môi trường
        if (disabled.has(algo.family)) continue;
        // Nếu môi trường chỉ định availablePatterns, chỉ chạy những family đó
        if (available.size > 0 && !available.has(algo.family)) {
            // Nhưng vẫn cho chạy nếu family là 'markov', 'ngram', 'pull' (universal)
            if (!['markov', 'ngram', 'pull', 'bayes', 'transmat'].includes(algo.family)) continue;
        }

        let res = null;
        try { res = algo.fn(seq, sums, db); } catch (e) { res = null; }
        if (!res || !res.code) continue;

        const learnedW = db.weights?.[algo.id]?.w ?? 1.0;
        const w = clamp(algo.base * learnedW, 0.3, 3.5);
        const vote = res.conf * w;

        if (res.code === 'T') votesT.push({ vote, algo: algo.id, name: res.name, conf: res.conf });
        else votesX.push({ vote, algo: algo.id, name: res.name, conf: res.conf });

        details.push({ algo: algo.id, code: res.code, name: res.name, conf: +res.conf.toFixed(3), vote: +vote.toFixed(2), family: algo.family });
    }

    const countT = votesT.length, countX = votesX.length;
    const sumT = votesT.reduce((a, b) => a + b.vote, 0);
    const sumX = votesX.reduce((a, b) => a + b.vote, 0);

    // Unbiased: chia trung bình mỗi phía
    const scoreT = countT > 0 ? sumT / countT : 0;
    const scoreX = countX > 0 ? sumX / countX : 0;

    let winner, confidence, patternName, method;

    if (countT + countX === 0) {
        // KHÔNG có cầu nào khớp → fallback trung lập, không thiên vị
        if (envProfile.dominant) {
            winner = envProfile.dominant;
            confidence = 0.515; // chỉ 51.5%, không tự tin giả
            patternName = `ENV-DOMINANT-${envProfile.type}`;
            method = 'env_dominant';
        } else {
            winner = 'T'; // mặt định 50/50, không ép cân bằng
            confidence = 0.50;
            patternName = 'TRUNG-LẬP-50-50';
            method = 'neutral_50';
        }
    } else {
        const diff = scoreT - scoreX;
        if (Math.abs(diff) < CONFIG.UNBIASED.TIE_MARGIN) {
            // Hòa → dùng env dominant nếu có, else theo score cao hơn
            if (envProfile.dominant) {
                winner = envProfile.dominant;
                confidence = 0.51 + Math.abs(diff) * 0.5;
                patternName = `HÒA-ENV-${envProfile.dominant}`;
                method = 'tie_env';
            } else {
                winner = scoreT >= scoreX ? 'T' : 'X';
                confidence = 0.505;
                patternName = 'HÒA-TRUNG-LẬP';
                method = 'tie_neutral';
            }
        } else {
            winner = diff > 0 ? 'T' : 'X';
            // Confidence = |score_T - score_X| / max(score_T, score_X) * boost
            const maxScore = Math.max(scoreT, scoreX);
            const relDiff = maxScore > 0 ? Math.abs(diff) / maxScore : 0;
            confidence = clamp(0.5 + relDiff * 0.5, 0.5, 0.85);
            patternName = `${winner === 'T' ? 'TÀI' : 'XỈU'}-${countT + countX}-CẦU`;
            method = 'score';
        }
    }

    // Áp dụng EFS + warm-up phase → confidence thích ứng
    confidence = adaptiveConfidence(confidence, envProfile);

    // Xác định top pattern
    const topList = (winner === 'T' ? votesT : votesX).sort((a, b) => b.vote - a.vote);
    const topName = topList.length > 0 ? topList[0].name : patternName;

    return {
        code: winner,
        label: topName,
        tiLe: (confidence * 100).toFixed(1) + '%',
        confidence,
        method,
        envProfile,
        details,
        counts: { countT, countX, sumT: +sumT.toFixed(2), sumX: +sumX.toFixed(2), scoreT: +scoreT.toFixed(3), scoreX: +scoreX.toFixed(3) },
        phase: confidence < 0.60 ? 'WARMING_UP' : 'READY'
    };
}

/**
 * Confidence thích ứng:
 *  - Khi EFS < 80 → ép 51-59%
 *  - Khi EFS >= 80 → bắt đầu tăng dần tới 85%
 *  - Warm-up (L < MIN_SESSIONS) → ép 51-55%
 */
function adaptiveConfidence(rawConf, env) {
    const L = env.stats?.sessions || 0;
    const efs = env.efs;

    // Phase 1: warm-up hoàn toàn (L < MIN)
    if (L < CONFIG.WARMUP.MIN_SESSIONS) {
        return clamp(0.51 + (rawConf - 0.5) * 0.5, 0.51, 0.55);
    }

    // Phase 2: EFS < TARGET → ép 51-59%
    if (efs < CONFIG.WARMUP.EFS_TARGET) {
        const ratio = efs / CONFIG.WARMUP.EFS_TARGET; // 0..1
        const floor = CONFIG.CONFIDENCE.WARMUP_FLOOR; // 0.51
        const ceil = CONFIG.CONFIDENCE.WARMUP_CEIL;   // 0.59
        const target = floor + (ceil - floor) * ratio;
        // Blend: rawConf bị ép vào [floor, target]
        return clamp(Math.min(rawConf, target), floor, ceil);
    }

    // Phase 3: EFS >= TARGET → bắt đầu tăng dần
    const boost = ((efs - CONFIG.WARMUP.EFS_TARGET) / (100 - CONFIG.WARMUP.EFS_TARGET)) * CONFIG.CONFIDENCE.EFS_BOOST_MAX;
    const boosted = rawConf * (1 + boost);
    return clamp(boosted, CONFIG.CONFIDENCE.READY_FLOOR, CONFIG.CONFIDENCE.READY_CEIL);
}

// ========================================================================
// 5. HỌC ONLINE
// ========================================================================
function updateOnlineLearning(db, prev, actual) {
    if (!prev || !actual) return;
    if (!db.weights) db.weights = {};
    for (const d of (prev.algoDetails || [])) {
        const cur = db.weights[d.algo] ?? { w: 1.0, win: 0, lose: 0, streak: 0 };
        const correct = (d.code === actual);
        if (correct) { cur.win++; cur.streak = Math.max(0, cur.streak) + 1; }
        else { cur.lose++; cur.streak = Math.min(0, cur.streak) - 1; }

        const p = (cur.win + 1) / (cur.win + cur.lose + 2);
        const decay = 0.995;
        const streakBonus = cur.streak >= 3 ? 0.05 : (cur.streak <= -3 ? -0.05 : 0);
        cur.w = clamp((p * 2) * decay + streakBonus, 0.2, 3.5);
        db.weights[d.algo] = cur;
    }
}

// ========================================================================
// 6. FETCH
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

// ========================================================================
// 7. PROCESS GAME
// ========================================================================
async function processGame(game) {
    const list = await fetchApi(game === 'md5' ? API_MD5 : API_TX);
    if (!list || !list.length) return;

    const latest = list[list.length - 1];
    const session = safeInt(latest.SessionId);
    const db = readDB(game);
    if (db.lastProcessedSession === session) return;

    const seq = list.map(getResult).filter(Boolean);
    const sums = list.map(getSum).filter(s => s >= 3 && s <= 18);

    // Luôn cần ít nhất 5 phiên để bắt đầu warm-up
    if (seq.length < 5) return;

    updateStreakStats(seq, db);

    // Cập nhật kết quả phiên trước
    const prev = db.history[db.history.length - 1];
    if (prev && safeInt(prev.phienDuDoan) === session) {
        const actual = getResult(latest);
        prev.ketQua = actual;
        prev.ketQuaLabel = label(actual);
        prev.trangThai = !prev.DU_DOAN_CODE ? 'BỎ QUA' : (prev.DU_DOAN_CODE === actual ? 'ĐÚNG' : 'SAI');
        updateOnlineLearning(db, prev, actual);
    }

    // NHẬN DIỆN MÔI TRƯỜNG (luôn chạy từ phiên thứ 5)
    const envProfile = profileEnvironment(seq);
    db.envProfile = envProfile;

    // CHỈ DỰ ĐOÁN KHI ĐÃ CÓ ĐỦ DATA (>= 10 phiên cho warm-up nhận biết)
    // Trước 10 phiên: vẫn ghi vào history nhưng DU_DOAN = null (không thiên vị)
    let pred;
    if (seq.length < 10) {
        pred = {
            code: null, label: 'WARM-UP-NHẬN-DIỆN', tiLe: '-', confidence: 0,
            method: 'warmup_no_predict', envProfile, details: [], phase: 'WARMUP_NO_PREDICT'
        };
    } else {
        pred = runUnbiasedEnsemble(seq, sums, db, envProfile);
    }

    db.history.push({
        phien: session, xucXac: getDice(latest), tong: getSum(latest),
        ketQua: getResult(latest), ketQuaLabel: label(getResult(latest)),
        phienDuDoan: session + 1,
        DU_DOAN_CODE: pred.code,
        DU_DOAN: pred.code ? label(pred.code) : null,
        TI_LE: pred.tiLe,
        patternName: pred.label,
        algoDetails: pred.details,
        method: pred.method,
        phase: pred.phase,
        envType: envProfile.type,
        envEfs: envProfile.efs,
        envPurity: envProfile.purity,
        envConfidence: envProfile.confidence,
        envDominant: envProfile.dominant,
        envAvailable: envProfile.availablePatterns,
        envDisabled: envProfile.disabledPatterns,
        counts: pred.counts,
        trangThai: 'ĐANG CHỜ'
    });

    if (db.history.length > 1000) db.history.shift();
    db.lastProcessedSession = session;
    saveDB(game, db);
}

setInterval(() => { processGame('md5'); processGame('taixiu'); }, TICK_MS);

// ========================================================================
// 8. API JSON
// ========================================================================
app.get('/', (req, res) => res.redirect('/md5'));

app.get('/api/predict/:game', async (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu')
        return res.status(400).json({ status: 'error', message: 'Game không hợp lệ' });

    const list = await fetchApi(game === 'md5' ? API_MD5 : API_TX);
    if (!list || !list.length)
        return res.status(500).json({ status: 'error', message: 'Không lấy được dữ liệu' });

    const latest = list[list.length - 1];
    const session = safeInt(latest.SessionId);
    const seq = list.map(getResult).filter(Boolean);
    const sums = list.map(getSum).filter(s => s >= 3 && s <= 18);
    const db = readDB(game);

    const envProfile = profileEnvironment(seq);

    // Nếu chưa đủ 10 phiên → không dự đoán
    let pred;
    if (seq.length < 10) {
        pred = {
            code: null, label: 'WARM-UP-NHẬN-DIỆN', tiLe: '-', confidence: 0,
            method: 'warmup_no_predict', envProfile, details: [], phase: 'WARMUP_NO_PREDICT'
        };
    } else {
        pred = runUnbiasedEnsemble(seq, sums, db, envProfile);
    }

    const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const correct = settled.filter(h => h.trangThai === 'ĐÚNG').length;
    const winrate = settled.length ? ((correct / settled.length) * 100).toFixed(2) + '%' : '-';

    let bankroll = 1000, maxBr = 1000, maxDD = 0;
    for (const h of settled) {
        bankroll += h.trangThai === 'ĐÚNG' ? 10 : -10;
        if (bankroll > maxBr) maxBr = bankroll;
        const dd = maxBr - bankroll;
        if (dd > maxDD) maxDD = dd;
    }

    res.json({
        status: 'success',
        data: {
            phienHienTai: String(session),
            phienDuDoan: String(session + 1),
            duDoan: pred.code,
            tiLe: pred.tiLe,
            liDo: pred.code
                ? `Model chọn ${label(pred.code)} (${pred.label} - Xác suất: ${pred.tiLe} - Phase: ${pred.phase})`
                : `Đang nhận diện môi trường (chưa dự đoán) - EFS: ${envProfile.efs}%`,
            xucXac: getDice(latest),
            tongDiem: getSum(latest),
            moiTruong: {
                loai: envProfile.type,
                doTinCay: (envProfile.confidence * 100).toFixed(1) + '%',
                efs: envProfile.efs + '%',
                doTinhKhiet: (envProfile.purity * 100).toFixed(1) + '%',
                doNhieu: (envProfile.entropy * 100).toFixed(1) + '%',
                nghieng: envProfile.dominant ? label(envProfile.dominant) : 'CÂN BẰNG',
                cauCoThe: envProfile.availablePatterns,
                cauKhongThe: envProfile.disabledPatterns,
                thongKe: envProfile.stats
            },
            chiTietModel: {
                pattern: pred.label,
                phuongPhap: pred.method,
                phase: pred.phase,
                soCauTai: pred.counts?.countT || 0,
                soCauXiu: pred.counts?.countX || 0,
                diemTai: pred.counts?.scoreT || 0,
                diemXiu: pred.counts?.scoreX || 0
            },
            thongKe: {
                win: correct,
                lose: settled.length - correct,
                winrate,
                bankroll: bankroll + '$',
                maxDD: maxDD + '$'
            }
        }
    });
});

// Endpoint debug môi trường
app.get('/api/env/:game', async (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu')
        return res.status(400).json({ status: 'error', message: 'Game không hợp lệ' });

    const list = await fetchApi(game === 'md5' ? API_MD5 : API_TX);
    if (!list || !list.length)
        return res.status(500).json({ status: 'error', message: 'Không lấy được dữ liệu' });

    const seq = list.map(getResult).filter(Boolean);
    const env = profileEnvironment(seq);

    res.json({
        status: 'success',
        game,
        sessions: seq.length,
        moiTruong: {
            loai: env.type,
            doTinCay: env.confidence,
            efs: env.efs,
            purity: env.purity,
            entropy: env.entropy,
            nghieng: env.dominant,
            cauCoThe: env.availablePatterns,
            cauKhongThe: env.disabledPatterns
        },
        thongKe: env.stats
    });
});

// ========================================================================
// 9. UI
// ========================================================================
app.get('/:game', (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.send('Trang không tồn tại');
    const db = readDB(game);
    const rows = db.history.slice(-80).reverse();
    const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const correct = settled.filter(h => h.trangThai === 'ĐÚNG').length;
    const acc = settled.length ? (correct / settled.length * 100).toFixed(1) : '0.0';
    const env = db.envProfile;

    const html = `<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>V40 - ${game.toUpperCase()}</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0e27;color:#e6eef6;padding:12px;margin:0;}
.header{background:linear-gradient(135deg,#1e3a8a,#3b82f6);padding:16px;border-radius:14px;margin-bottom:14px;}
h1{color:#fff;font-size:20px;margin:0 0 8px;font-weight:800;text-transform:uppercase;text-align:center}
.env-box{background:rgba(0,0,0,.3);padding:10px;border-radius:10px;font-size:12px;margin-bottom:8px}
.env-row{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.1)}
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
.badge{display:inline-block;padding:2px 5px;border-radius:4px;font-size:9px;font-weight:700;white-space:nowrap;background:#334155;color:#cbd5e1}
.env-tag{display:inline-block;padding:2px 5px;border-radius:4px;font-size:9px;font-weight:700;background:#1e40af;color:#fff}
</style>
<script>setTimeout(()=>location.reload(), 5000);</script>
</head><body>
<div class="header">
  <h1>V40 · ${game.toUpperCase()}</h1>
  ${env ? `
  <div class="env-box">
    <div class="env-row"><span>🌍 Môi trường</span><span class="env-val">${env.type}</span></div>
    <div class="env-row"><span>🎯 Độ tin cậy</span><span class="env-val">${(env.confidence*100).toFixed(1)}%</span></div>
    <div class="env-row"><span>📊 EFS</span><span class="env-val">${env.efs}%</span></div>
    <div class="env-row"><span>💎 Tinh khiết</span><span class="env-val">${(env.purity*100).toFixed(1)}%</span></div>
    <div class="env-row"><span>🌫️ Nhiễu</span><span class="env-val">${(env.entropy*100).toFixed(1)}%</span></div>
    <div class="env-row"><span>⚖️ Nghiêng</span><span class="env-val">${env.dominant ? label(env.dominant) : 'CÂN BẰNG'}</span></div>
    <div class="efs-bar"><div class="efs-fill" style="width:${env.efs}%"></div></div>
  </div>` : '<div class="env-box">Đang nhận diện môi trường...</div>'}
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
</body></html>`;
    res.send(html);
});

app.listen(PORT, () => console.log(`🚀 V40 - ${ALL_ALGOS.length} cầu - port ${PORT}`));
