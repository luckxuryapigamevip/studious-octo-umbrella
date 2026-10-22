'use strict';

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

// ========================================================================
// 1. MIDDLEWARE
// ========================================================================
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.json());

// ========================================================================
// 2. CONFIG
// ========================================================================
const PORT = process.env.PORT || 3000;
const API_MD5 = 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau';
const API_TX = 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau';
const DB_DIR = process.env.DB_DIR || __dirname;
const WEBHOOK_URL = process.env.WEBHOOK_URL || null;
const TICK_MS = safeInt(process.env.TICK_MS, 5000);

if (!fs.existsSync(DB_DIR)) { try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch (e) {} }

// ========================================================================
// 3. HELPERS
// ========================================================================
function safeInt(x, def = 0) { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
const label = c => c === 'T' ? 'Tài' : (c === 'X' ? 'Xỉu' : null);
const flip = c => c === 'T' ? 'X' : (c === 'X' ? 'T' : null);

function readDB(g) {
    const p = path.join(DB_DIR, `db_${g}.json`);
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {}
    return {
        history: [],
        lastProcessedSession: null,
        algoStats: {},
        weights: {},           // neural weights per algo
        calibration: [],       // calibration bins
        regime: null,
        walkForward: []        // backtest results
    };
}
function saveDB(g, db) {
    const p = path.join(DB_DIR, `db_${g}.json`);
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
// 4. MATH CORE
// ========================================================================
function entropy(arr) {
    const f = {};
    for (const x of arr) f[x] = (f[x] || 0) + 1;
    const n = arr.length;
    let h = 0;
    for (const k in f) { const p = f[k] / n; if (p > 0) h -= p * Math.log2(p); }
    return h;
}
function variance(arr) {
    if (!arr.length) return 0;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length;
}
function zscore(x, arr) {
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    const v = variance(arr);
    return v > 0 ? (x - m) / Math.sqrt(v) : 0;
}

// ========================================================================
// 5. SUFFIX AUTOMATON - Motif Mining O(n)
// ========================================================================
function buildSuffixAutomaton(str) {
    const n = str.length;
    const maxStates = 2 * n + 5;
    const len = new Int32Array(maxStates);
    const link = new Int32Array(maxStates).fill(-1);
    const next = Array.from({ length: maxStates }, () => ({}));
    const occ = new Int32Array(maxStates);
    let size = 1, lastState = 0;
    for (let i = 0; i < n; i++) {
        const c = str[i];
        const cur = size++;
        len[cur] = len[lastState] + 1;
        occ[cur] = 1;
        let p = lastState;
        while (p !== -1 && !next[p][c]) { next[p][c] = cur; p = link[p]; }
        if (p === -1) { link[cur] = 0; }
        else {
            const q = next[p][c];
            if (len[p] + 1 === len[q]) { link[cur] = q; }
            else {
                const clone = size++;
                len[clone] = len[p] + 1;
                link[clone] = link[q];
                next[clone] = { ...next[q] };
                while (p !== -1 && next[p][c] === q) { next[p][c] = clone; p = link[p]; }
                link[q] = clone; link[cur] = clone;
            }
        }
        lastState = cur;
    }
    // Topo sort by len descending → propagate occ
    const order = Array.from({ length: size }, (_, i) => i).sort((a, b) => len[b] - len[a]);
    for (const s of order) {
        if (link[s] >= 0) occ[link[s]] += occ[s];
    }
    return { size, len, link, next, occ, lastState };
}

function getSuffixContext(sam, seq) {
    // Duyệt suffix automaton theo seq từ trạng thái gốc → tìm context tốt nhất
    let state = 0;
    let matched = 0;
    let bestContext = { state: 0, length: 0 };
    for (let i = seq.length - 1; i >= 0; i--) {
        const c = seq[i];
        const ns = sam.next[state][c];
        if (ns === undefined) break;
        state = ns; matched++;
        bestContext = { state, length: matched };
    }
    return bestContext;
}

// ========================================================================
// 6. LZ COMPRESSION DISTANCE (similarity)
// ========================================================================
function lzComplexity(str) {
    // Số "phrase" khi nén LZ78
    const dict = new Set();
    let i = 0, count = 0;
    while (i < str.length) {
        let phrase = '';
        while (i < str.length) {
            phrase += str[i];
            if (!dict.has(phrase)) { dict.add(phrase); i++; count++; break; }
            i++;
        }
    }
    return count;
}
function similarity(a, b) {
    if (!a.length || !b.length) return 0;
    const ca = lzComplexity(a), cb = lzComplexity(b), cab = lzComplexity(a + b);
    const denom = Math.max(ca, cb);
    if (denom === 0) return 0;
    return clamp(1 - (cab - Math.min(ca, cb)) / denom, 0, 1);
}

// ========================================================================
// 7. REGIME DETECTION
// ========================================================================
function detectRegime(seq) {
    const n = seq.length;
    if (n < 20) return { regime: 'UNKNOWN', confidence: 0 };
    const w = seq.slice(-30);
    const h = entropy(w);
    // Đếm flips & streak
    let flips = 0;
    for (let i = 1; i < w.length; i++) if (w[i] !== w[i - 1]) flips++;
    const flipRate = flips / (w.length - 1);
    // Streak max
    let maxStreak = 1, cur = 1;
    for (let i = 1; i < w.length; i++) {
        if (w[i] === w[i - 1]) cur++; else cur = 1;
        if (cur > maxStreak) maxStreak = cur;
    }
    // Phân loại
    if (maxStreak >= 5 && flipRate < 0.4) return { regime: 'STREAKING', confidence: 0.8, flipRate, maxStreak, entropy: h };
    if (flipRate > 0.75) return { regime: 'BOUNCING', confidence: 0.8, flipRate, maxStreak, entropy: h };
    if (h > 1.02) return { regime: 'CHAOTIC', confidence: 0.75, flipRate, maxStreak, entropy: h };
    if (h < 0.55) return { regime: 'TRENDING', confidence: 0.7, flipRate, maxStreak, entropy: h };
    return { regime: 'MIXED', confidence: 0.5, flipRate, maxStreak, entropy: h };
}

// ========================================================================
// 8. ALGO MODULES (12+)
// ========================================================================

// ---------- BET ----------
function algoBet(seq) {
    const n = seq.length, last = seq[n - 1];
    let len = 1;
    for (let i = n - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
    if (len < 3) return null;
    const breaks = []; let cur = 1;
    for (let i = 1; i < n; i++) {
        if (seq[i] === seq[i - 1]) cur++;
        else { if (cur >= 3) breaks.push(cur); cur = 1; }
    }
    const avg = breaks.length ? breaks.reduce((a, b) => a + b, 0) / breaks.length : 4.5;
    const pCont = clamp(1 - (len / (avg * 1.6)), 0.15, 0.85);
    if (1 - pCont > 0.55) return { code: flip(last), name: `BỆT-GÃY-${len}`, conf: clamp(1 - pCont, 0.6, 0.95) };
    if (pCont > 0.55) return { code: last, name: `BỆT-${len}`, conf: clamp(pCont, 0.6, 0.95) };
    return null;
}

// ---------- MARKOV ----------
function algoMarkov(seq) {
    const n = seq.length;
    let best = null;
    for (let k = 2; k <= Math.min(7, n - 1); k++) {
        const key = seq.slice(-k).join('');
        let t = 0, x = 0;
        for (let i = k; i < n; i++) {
            if (seq.slice(i - k, i).join('') === key) {
                if (seq[i] === 'T') t++; else x++;
            }
        }
        const total = t + x;
        if (total < 2) continue;
        const pT = (t + 1) / (total + 2);
        const pX = (x + 1) / (total + 2);
        const conf = Math.max(pT, pX);
        const weight = Math.log(k + 1) * (total / (total + 3));
        const score = conf * weight;
        if (!best || score > best.score) {
            best = { code: pT > pX ? 'T' : 'X', name: `MARKOV-${k}`, conf, score, samples: total };
        }
    }
    return best;
}

// ---------- NGRAM ----------
function algoNGramRepeat(seq) {
    const n = seq.length;
    if (n < 10) return null;
    let best = null;
    for (let len = 3; len <= Math.min(10, Math.floor(n / 3)); len++) {
        const tail = seq.slice(-len).join('');
        let t = 0, x = 0, cnt = 0;
        for (let i = 0; i + len < n - 1; i++) {
            if (seq.slice(i, i + len).join('') === tail) {
                const nxt = seq[i + len];
                if (nxt === 'T') t++; else if (nxt === 'X') x++;
                cnt++;
            }
        }
        if (cnt < 2) continue;
        const pT = (t + 1) / (cnt + 2);
        const pX = (x + 1) / (cnt + 2);
        const conf = Math.max(pT, pX);
        const score = conf * Math.log(len + 1) * Math.log(cnt + 1);
        if (!best || score > best.score) {
            best = { code: pT > pX ? 'T' : 'X', name: `NGRAM-${len}`, conf, score, samples: cnt };
        }
    }
    return best;
}

// ---------- CYCLE ----------
function algoCycle(seq) {
    const n = seq.length;
    if (n < 12) return null;
    let best = null;
    for (let p = 2; p <= Math.min(14, Math.floor(n / 2)); p++) {
        let match = 0, total = 0;
        for (let i = p; i < n; i++) { total++; if (seq[i] === seq[i - p]) match++; }
        const ratio = match / total;
        if (ratio < 0.62) continue;
        const pred = seq[n - p];
        const conf = clamp(ratio, 0.62, 0.95);
        const score = conf * Math.log(p + 1);
        if (!best || score > best.score) best = { code: pred, name: `CYCLE-${p}`, conf, score, period: p };
    }
    return best;
}

// ---------- PALINDROME ----------
function algoPalindrome(seq) {
    const n = seq.length;
    if (n < 6) return null;
    for (let len = 4; len <= Math.min(10, n - 1); len++) {
        const tail = seq.slice(-len).join('');
        const rev = [...tail].reverse().join('');
        let t = 0, x = 0, cnt = 0;
        for (let i = 0; i + len < n - 1; i++) {
            const seg = seq.slice(i, i + len).join('');
            if (seg === rev || seg === tail) {
                const nxt = seq[i + len];
                if (nxt === 'T') t++; else if (nxt === 'X') x++;
                cnt++;
            }
        }
        if (cnt >= 2) {
            const pT = (t + 1) / (cnt + 2), pX = (x + 1) / (cnt + 2);
            const conf = Math.max(pT, pX);
            if (conf > 0.62) return { code: pT > pX ? 'T' : 'X', name: `PALIN-${len}`, conf, score: conf * cnt };
        }
    }
    return null;
}

// ---------- FLIP ----------
function algoFlip(seq) {
    const n = seq.length;
    if (n < 8) return null;
    let flips = 0;
    for (let i = n - 8; i < n; i++) if (seq[i] !== seq[i - 1]) flips++;
    if (flips / 7 > 0.75) return { code: flip(seq[n - 1]), name: 'FLIP-HIGH', conf: 0.72, score: flips / 7 };
    return null;
}

// ---------- BLOCK TREND ----------
function algoBlockTrend(seq) {
    const n = seq.length;
    if (n < 10) return null;
    const blks = []; let ct = seq[0], cl = 1;
    for (let i = 1; i < n; i++) { if (seq[i] === ct) cl++; else { blks.push(cl); ct = seq[i]; cl = 1; } }
    blks.push(cl);
    if (blks.length < 4) return null;
    const l4 = blks.slice(-4);
    if (l4[1] > l4[0] && l4[2] > l4[1] && l4[3] > l4[2]) return { code: flip(seq[n - 1]), name: 'BLOCK-INC', conf: 0.7, score: 1 };
    if (l4[1] < l4[0] && l4[2] < l4[1] && l4[3] < l4[2]) return { code: flip(seq[n - 1]), name: 'BLOCK-DEC', conf: 0.7, score: 1 };
    if (l4[0] === l4[2] && l4[1] === l4[3] && l4[0] !== l4[1]) return { code: seq[n - 1], name: 'BLOCK-ALT', conf: 0.65, score: 1 };
    return null;
}

// ---------- SUM PATTERN ----------
function algoSumPattern(seq, sums) {
    if (!sums || sums.length < 10) return null;
    const recent = sums.slice(-10);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (avg >= 13.5) return { code: 'X', name: 'SUM-HIGH', conf: 0.62, score: 1 };
    if (avg <= 7.5) return { code: 'T', name: 'SUM-LOW', conf: 0.62, score: 1 };
    const d1 = recent[recent.length - 1] - recent[recent.length - 2];
    const d2 = recent[recent.length - 1] - 2 * recent[recent.length - 2] + recent[recent.length - 3];
    if (d1 > 3 && d2 < 0) return { code: 'X', name: 'SUM-PEAK', conf: 0.65, score: 1 };
    if (d1 < -3 && d2 > 0) return { code: 'T', name: 'SUM-TROUGH', conf: 0.65, score: 1 };
    return null;
}

// ---------- WEIGHTED TRANSITION ----------
function algoTransition(seq) {
    const n = seq.length;
    if (n < 8) return null;
    const last = seq[n - 1];
    let wt = 0, wx = 0, t = 0, x = 0;
    for (let i = 1; i < n; i++) {
        if (seq[i - 1] === last) {
            const w = Math.exp(-(n - i) / 20);
            if (seq[i] === 'T') { t++; wt += w; } else { x++; wx += w; }
        }
    }
    if (t + x < 3) return null;
    const pT = (wt + 0.5) / (wt + wx + 1), pX = (wx + 0.5) / (wt + wx + 1);
    const conf = Math.max(pT, pX);
    if (conf < 0.58) return null;
    return { code: pT > pX ? 'T' : 'X', name: 'TRANS-W', conf, score: conf * (t + x) };
}

// ---------- STREAK EXHAUST ----------
function algoStreakExhaust(seq) {
    const n = seq.length;
    if (n < 15) return null;
    const last = seq[n - 1];
    let len = 1;
    for (let i = n - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
    const hist = []; let cur = 1;
    for (let i = 1; i < n; i++) {
        if (seq[i] === seq[i - 1]) cur++;
        else { if (seq[i - 1] === last && cur >= 2) hist.push(cur); cur = 1; }
    }
    if (!hist.length) return null;
    const maxH = Math.max(...hist);
    const avgH = hist.reduce((a, b) => a + b, 0) / hist.length;
    if (len > maxH) return { code: flip(last), name: 'STREAK-MAX', conf: 0.78, score: len / maxH };
    if (len > avgH * 1.5) return { code: flip(last), name: 'STREAK-AVG', conf: 0.65, score: 1 };
    return null;
}

// ---------- GAP PRESSURE ----------
function algoGap(seq) {
    const n = seq.length;
    if (n < 20) return null;
    const tP = [], xP = [];
    for (let i = 0; i < n; i++) { if (seq[i] === 'T') tP.push(i); else xP.push(i); }
    if (tP.length < 3 || xP.length < 3) return null;
    const tG = []; for (let i = 1; i < tP.length; i++) tG.push(tP[i] - tP[i - 1]);
    const xG = []; for (let i = 1; i < xP.length; i++) xG.push(xP[i] - xP[i - 1]);
    const tAvg = tG.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, tG.length);
    const xAvg = xG.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, xG.length);
    const sinceT = n - tP[tP.length - 1];
    const sinceX = n - xP[xP.length - 1];
    const tPress = sinceT / Math.max(tAvg, 1);
    const xPress = sinceX / Math.max(xAvg, 1);
    if (tPress > xPress * 1.4) return { code: 'T', name: 'GAP-T', conf: clamp(0.6 + tPress * 0.05, 0.6, 0.85), score: tPress };
    if (xPress > tPress * 1.4) return { code: 'X', name: 'GAP-X', conf: clamp(0.6 + xPress * 0.05, 0.6, 0.85), score: xPress };
    return null;
}

// ---------- SUFFIX AUTOMATON (motif) ----------
function algoSuffixMotif(seq) {
    const n = seq.length;
    if (n < 12) return null;
    const sam = buildSuffixAutomaton(seq.join(''));
    const ctx = getSuffixContext(sam, seq);
    if (ctx.length < 2) return null;
    // Đếm next-char sau mỗi lần xuất hiện context
    const ctxStr = seq.slice(-ctx.length).join('');
    let t = 0, x = 0;
    const s = seq.join('');
    for (let i = 0; i + ctx.length < n; i++) {
        if (s.substr(i, ctx.length) === ctxStr) {
            const nxt = seq[i + ctx.length];
            if (nxt === 'T') t++; else if (nxt === 'X') x++;
        }
    }
    if (t + x < 2) return null;
    const pT = (t + 0.5) / (t + x + 1), pX = (x + 0.5) / (t + x + 1);
    const conf = Math.max(pT, pX);
    if (conf < 0.6) return null;
    return { code: pT > pX ? 'T' : 'X', name: `SAM-${ctx.length}`, conf, score: conf * Math.log(ctx.length + 1) };
}

// ---------- LZ SIMILARITY ----------
function algoLZSimilarity(seq) {
    const n = seq.length;
    if (n < 20) return null;
    const tail = seq.slice(-8).join('');
    // Tìm các cửa sổ 8 trước đó có độ tương đồng cao
    let t = 0, x = 0, cnt = 0, bestSim = 0;
    for (let i = 0; i + 8 < n - 1; i++) {
        const win = seq.slice(i, i + 8).join('');
        const sim = similarity(win, tail);
        if (sim > 0.75) {
            const nxt = seq[i + 8];
            if (nxt === 'T') t++; else if (nxt === 'X') x++;
            cnt++;
            bestSim = Math.max(bestSim, sim);
        }
    }
    if (cnt < 2) return null;
    const pT = (t + 0.5) / (cnt + 1), pX = (x + 0.5) / (cnt + 1);
    const conf = Math.max(pT, pX) * bestSim;
    if (conf < 0.55) return null;
    return { code: pT > pX ? 'T' : 'X', name: 'LZ-SIM', conf, score: conf * cnt };
}

// ---------- MULTI-TIMEFRAME MOMENTUM ----------
function algoMultiTF(seq) {
    const n = seq.length;
    if (n < 24) return null;
    const windows = [5, 10, 20];
    let tVotes = 0, xVotes = 0;
    for (const w of windows) {
        const s = seq.slice(-w);
        const t = s.filter(x => x === 'T').length;
        const x = s.length - t;
        const pT = t / s.length;
        // Momentum: nếu pT rất cao (>0.65) → có thể đảo; nếu gần 0.5 → dùng 50/50
        if (pT > 0.68) xVotes += 1;
        else if (pT < 0.32) tVotes += 1;
        else if (pT > 0.55) tVotes += 0.5;
        else if (pT < 0.45) xVotes += 0.5;
    }
    if (tVotes + xVotes < 0.8) return null;
    const code = tVotes > xVotes ? 'T' : 'X';
    const conf = clamp(0.6 + Math.abs(tVotes - xVotes) * 0.08, 0.6, 0.85);
    return { code, name: 'MULTI-TF', conf, score: Math.abs(tVotes - xVotes) };
}

// ========================================================================
// 9. REGISTRY WITH FAMILY TAGS
// ========================================================================
const ALGO_REGISTRY = [
    { id: 'bet', fn: algoBet, base: 1.0, family: 'streak' },
    { id: 'markov', fn: algoMarkov, base: 1.2, family: 'markov' },
    { id: 'ngram', fn: algoNGramRepeat, base: 1.1, family: 'ngram' },
    { id: 'cycle', fn: algoCycle, base: 1.0, family: 'cycle' },
    { id: 'palin', fn: algoPalindrome, base: 0.8, family: 'cycle' },
    { id: 'flip', fn: algoFlip, base: 0.9, family: 'bounce' },
    { id: 'block', fn: algoBlockTrend, base: 0.9, family: 'block' },
    { id: 'sum', fn: algoSumPattern, base: 0.7, family: 'sum' },
    { id: 'trans', fn: algoTransition, base: 1.0, family: 'markov' },
    { id: 'streak', fn: algoStreakExhaust, base: 1.1, family: 'streak' },
    { id: 'gap', fn: algoGap, base: 0.8, family: 'pressure' },
    { id: 'sam', fn: algoSuffixMotif, base: 1.15, family: 'motif' },
    { id: 'lz', fn: algoLZSimilarity, base: 1.0, family: 'similarity' },
    { id: 'mtf', fn: algoMultiTF, base: 1.05, family: 'multi-tf' }
];

// ========================================================================
// 10. NEURAL-INSPIRED WEIGHT NETWORK (Perceptron-based)
// ========================================================================
function getWeight(db, algoId, baseWeight) {
    // Trọng số học online
    const learned = db.weights[algoId];
    if (learned === undefined) return baseWeight;
    return clamp(baseWeight * learned, 0.3, 2.2);
}

function updateWeight(db, algoId, wasCorrect, learningRate = 0.05) {
    const cur = db.weights[algoId] ?? 1.0;
    // Perceptron-style: tăng nếu đúng, giảm nếu sai
    const delta = wasCorrect ? learningRate : -learningRate;
    db.weights[algoId] = clamp(cur + delta, 0.3, 2.2);
}

// ========================================================================
// 11. CONFIDENCE CALIBRATION
// ========================================================================
function getCalibrationFactor(db, rawConf) {
    // Bin theo 0.05
    const bin = Math.round(rawConf * 20) / 20;
    // Tìm bin trong db.calibration
    const rec = db.calibration.find(c => c.bin === bin);
    if (!rec || rec.total < 10) return 1.0;
    const actualAcc = rec.correct / rec.total;
    // Nếu bin này được dự đoán conf cao nhưng thực tế đúng ít → giảm
    return clamp(actualAcc / rawConf, 0.6, 1.3);
}
function updateCalibration(db, rawConf, wasCorrect) {
    const bin = Math.round(rawConf * 20) / 20;
    let rec = db.calibration.find(c => c.bin === bin);
    if (!rec) { rec = { bin, total: 0, correct: 0 }; db.calibration.push(rec); }
    rec.total++;
    if (wasCorrect) rec.correct++;
    // Rolling window
    if (rec.total > 200) { rec.total = 200; rec.correct = Math.round(rec.correct * 0.95); }
    // Trim calibration list
    if (db.calibration.length > 40) db.calibration = db.calibration.slice(-40);
}

// ========================================================================
// 12. META ENSEMBLE V3
// ========================================================================
function runMetaEngine(seq, sums, db) {
    const regime = detectRegime(seq);
    db.regime = regime;

    const votes = { T: 0, X: 0 };
    const details = [];
    const families = { T: new Set(), X: new Set() };
    const entropy30 = entropy(seq.slice(-30));

    for (const algo of ALGO_REGISTRY) {
        let res = null;
        try { res = algo.fn(seq, sums, db); } catch (e) { res = null; }
        if (!res || !res.code) continue;

        const w = getWeight(db, algo.id, algo.base);
        const vote = (res.conf || 0.6) * w;

        // Entropy penalty
        const pen = entropy30 > 0.95 ? 0.7 : 1.0;
        // Regime bonus
        let regimeBonus = 1.0;
        if (regime.regime === 'STREAKING' && (algo.family === 'streak' || algo.family === 'block')) regimeBonus = 1.25;
        if (regime.regime === 'BOUNCING' && (algo.family === 'bounce' || algo.family === 'cycle')) regimeBonus = 1.25;
        if (regime.regime === 'CHAOTIC' && (algo.family === 'markov' || algo.family === 'ngram')) regimeBonus = 0.85;
        if (regime.regime === 'TRENDING' && algo.family === 'motif') regimeBonus = 1.15;

        const finalVote = vote * pen * regimeBonus;
        votes[res.code] += finalVote;
        families[res.code].add(algo.family);

        details.push({
            algo: algo.id, family: algo.family,
            code: res.code, name: res.name,
            conf: +(res.conf || 0).toFixed(3),
            vote: +finalVote.toFixed(3),
            weight: +w.toFixed(3)
        });
    }

    const total = votes.T + votes.X;
    if (total < 0.5) return { code: null, label: 'CHỜ', tiLe: 'CHỜ', details, regime, entropy: +entropy30.toFixed(3) };

    const pT = votes.T / total, pX = votes.X / total;
    const winner = pT > pX ? 'T' : 'X';
    let confidence = Math.max(pT, pX);

    // Diversity bonus: nếu nhiều family đồng thuận
    const winnerFamilies = families[winner].size;
    const totalFamilies = families.T.size + families.X.size;
    if (winnerFamilies >= 4) confidence = clamp(confidence + 0.05, 0, 0.97);
    if (winnerFamilies >= 6) confidence = clamp(confidence + 0.03, 0, 0.97);

    // Calibration
    const calib = getCalibrationFactor(db, confidence);
    confidence = clamp(confidence * calib, 0, 0.97);

    // Dynamic threshold theo regime
    let threshold = 0.58;
    if (regime.regime === 'CHAOTIC') threshold = 0.68;
    else if (regime.regime === 'MIXED') threshold = 0.62;
    else if (regime.regime === 'TRENDING' || regime.regime === 'STREAKING') threshold = 0.55;

    if (confidence < threshold) {
        return { code: null, label: `ENTROPY-${regime.regime}`, tiLe: 'CHỜ', details, regime, entropy: +entropy30.toFixed(3) };
    }

    const topAlgo = details.filter(d => d.code === winner).sort((a, b) => b.vote - a.vote)[0];
    return {
        code: winner,
        label: topAlgo ? `META·${topAlgo.name}` : 'META',
        tiLe: (confidence * 100).toFixed(1) + '%',
        details,
        regime,
        entropy: +entropy30.toFixed(3),
        diversity: winnerFamilies,
        kellyStake: +(2 * confidence - 1).toFixed(3) // Kelly đơn giản
    };
}

// ========================================================================
// 13. BALANCE GUARD
// ========================================================================
function applyBalanceGuard(pred, db) {
    if (!pred.code) return pred;
    let gt = 0, gx = 0;
    for (const h of db.history.slice(-60)) {
        if (h.DU_DOAN_CODE === 'T') gt++;
        else if (h.DU_DOAN_CODE === 'X') gx++;
    }
    if (gt + gx < 25) return pred;
    const pT = gt / (gt + gx);
    if (pT > 0.65 && pred.code === 'T') return { ...pred, code: 'X', label: 'GUARD-REBALANCE', tiLe: '65.0%' };
    if (pT < 0.35 && pred.code === 'X') return { ...pred, code: 'T', label: 'GUARD-REBALANCE', tiLe: '65.0%' };
    return pred;
}

// ========================================================================
// 14. UPDATE STATS + WEIGHTS + CALIBRATION
// ========================================================================
function updateAllStats(db, prevRecord, actual) {
    if (!prevRecord || !actual) return;

    // Algo stats
    const details = prevRecord.algoDetails || [];
    if (!db.algoStats) db.algoStats = {};
    for (const d of details) {
        if (!db.algoStats[d.algo]) db.algoStats[d.algo] = { total: 0, correct: 0 };
        db.algoStats[d.algo].total++;
        if (d.code === actual) db.algoStats[d.algo].correct++;
        if (db.algoStats[d.algo].total > 200) {
            db.algoStats[d.algo].total = 200;
            db.algoStats[d.algo].correct = Math.round(db.algoStats[d.algo].correct * 0.9);
        }
        // Neural weight update
        updateWeight(db, d.algo, d.code === actual, 0.03);
    }

    // Calibration
    if (prevRecord.DU_DOAN_CODE) {
        const rawConf = parseFloat(String(prevRecord.TI_LE).replace('%', '')) / 100;
        if (Number.isFinite(rawConf)) {
            updateCalibration(db, rawConf, prevRecord.DU_DOAN_CODE === actual);
        }
    }
}

// ========================================================================
// 15. WALK-FORWARD BACKTEST (mỗi 20 phiên)
// ========================================================================
function runWalkForward(db) {
    const hist = db.history;
    if (hist.length < 30) return;
    const recent = hist.slice(-20).filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    if (recent.length < 10) return;
    const correct = recent.filter(h => h.trangThai === 'ĐÚNG').length;
    const wr = correct / recent.length;
    db.walkForward.push({
        ts: Date.now(),
        window: recent.length,
        winRate: +(wr * 100).toFixed(2)
    });
    if (db.walkForward.length > 50) db.walkForward.shift();

    // Webhook alert nếu winrate < 45%
    if (WEBHOOK_URL && wr < 0.45) {
        sendWebhook({ type: 'LOW_WINRATE', winRate: wr, window: recent.length })
            .catch(() => {});
    }
}

async function sendWebhook(payload) {
    if (!WEBHOOK_URL) return;
    try { await axios.post(WEBHOOK_URL, payload, { timeout: 5000 }); } catch (e) {}
}

// ========================================================================
// 16. FETCH
// ========================================================================
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

// ========================================================================
// 17. PROCESS GAME
// ========================================================================
async function processGame(game) {
    const url = game === 'md5' ? API_MD5 : API_TX;
    const list = await fetchApi(url);
    if (!list || !list.length) return;

    const latest = list[list.length - 1];
    const session = safeInt(latest.SessionId);
    const db = readDB(game);
    if (db.lastProcessedSession === session) return;

    const seq = list.map(getResult).filter(Boolean);
    const sums = list.map(getSum).filter(s => s >= 3 && s <= 18);
    if (seq.length < 8) return;

    // Chấm điểm phiên trước
    const prev = db.history[db.history.length - 1];
    if (prev && safeInt(prev.phienDuDoan) === session) {
        const actual = getResult(latest);
        prev.ketQua = actual;
        prev.ketQuaLabel = label(actual);
        prev.trangThai = !prev.DU_DOAN_CODE ? 'BỎ QUA' : (prev.DU_DOAN_CODE === actual ? 'ĐÚNG' : 'SAI');
        updateAllStats(db, prev, actual);
    }

    let pred = runMetaEngine(seq, sums, db);
    pred = applyBalanceGuard(pred, db);

    // Auto-detect regime cho report
    const regime = db.regime || { regime: 'UNKNOWN' };

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
        algoDetails: pred.details || [],
        entropy: pred.entropy,
        regime: regime.regime,
        diversity: pred.diversity || 0,
        kellyStake: pred.kellyStake || 0,
        trangThai: 'ĐANG CHỜ'
    });

    if (db.history.length > 600) db.history.shift();
    db.lastProcessedSession = session;

    // Mỗi 20 phiên chạy walk-forward backtest
    if (db.history.length % 20 === 0) runWalkForward(db);

    saveDB(game, db);
}

setInterval(() => { processGame('md5'); processGame('taixiu'); }, TICK_MS);

// ========================================================================
// 18. ROUTES
// ========================================================================
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family:sans-serif; padding:20px; background:#0a0e27; color:#e6eef6; min-height:100vh;">
            <h2 style="color:#22c55e;">🚀 META ENGINE V3 - DEEP LEARNING ONLINE</h2>
            <p>14 thuật toán + Neural Weight + Regime Detection + Calibration</p>
            <ul>
                <li><a href="/api/predict/md5" style="color:#60a5fa;">/api/predict/md5</a></li>
                <li><a href="/api/predict/taixiu" style="color:#60a5fa;">/api/predict/taixiu</a></li>
                <li><a href="/api/history/all" style="color:#60a5fa;">/api/history/all</a></li>
                <li><a href="/api/stats/md5" style="color:#60a5fa;">/api/stats/md5</a></li>
                <li><a href="/api/health" style="color:#60a5fa;">/api/health</a></li>
                <li><a href="/api/backtest/md5" style="color:#60a5fa;">/api/backtest/md5</a></li>
                <li><a href="/md5" style="color:#60a5fa;">/md5</a> · <a href="/taixiu" style="color:#60a5fa;">/taixiu</a></li>
            </ul>
        </div>
    `);
});

app.get('/api/health', (req, res) => {
    const status = {};
    for (const g of ['md5', 'taixiu']) {
        const db = readDB(g);
        const recent = db.history.slice(-50).filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
        const correct = recent.filter(h => h.trangThai === 'ĐÚNG').length;
        status[g] = {
            sessions: db.history.length,
            lastSession: db.lastProcessedSession,
            regime: db.regime?.regime || 'UNKNOWN',
            recentWR: recent.length ? +(correct / recent.length * 100).toFixed(1) : null
        };
    }
    res.json({ ok: true, ts: Date.now(), status });
});

app.get('/api/predict/:game', async (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.status(400).json({ success: false, error: 'Game không hợp lệ' });

    const url = game === 'md5' ? API_MD5 : API_TX;
    const list = await fetchApi(url);
    if (!list || !list.length) return res.status(500).json({ success: false, error: 'Không lấy được dữ liệu' });

    const latest = list[list.length - 1];
    const session = safeInt(latest.SessionId);
    const seq = list.map(getResult).filter(Boolean);
    const sums = list.map(getSum).filter(s => s >= 3 && s <= 18);

    const db = readDB(game);
    let pred = runMetaEngine(seq, sums, db);
    pred = applyBalanceGuard(pred, db);

    res.json({
        success: true,
        game, phien: session,
        xucXac: getDice(latest), tong: getSum(latest),
        ketQua: getResult(latest), ketQuaLabel: label(getResult(latest)),
        phienDuDoan: session + 1,
        duDoan: pred.code ? label(pred.code) : 'CHỜ',
        duDoanCode: pred.code,
        tiLe: pred.tiLe,
        reason: pred.label,
        entropy: pred.entropy,
        regime: pred.regime,
        diversity: pred.diversity,
        kellyStake: pred.kellyStake,
        algoVotes: pred.details,
        confidence: pred.tiLe
    });
});

app.get('/api/stats/:game', (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.status(400).json({ success: false });
    const db = readDB(game);

    const stats = {};
    for (const algoId in db.algoStats) {
        const s = db.algoStats[algoId];
        stats[algoId] = {
            ...s,
            accuracy: s.total ? +(s.correct / s.total * 100).toFixed(1) : 0,
            weight: +(db.weights?.[algoId] ?? 1.0).toFixed(3)
        };
    }

    const recent = db.history.slice(-100);
    const settled = recent.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const correct = settled.filter(h => h.trangThai === 'ĐÚNG').length;

    res.json({
        success: true, game,
        overall: {
            total: settled.length, correct,
            accuracy: settled.length ? +(correct / settled.length * 100).toFixed(1) : 0
        },
        regime: db.regime,
        perAlgo: stats,
        calibration: db.calibration,
        walkForward: db.walkForward.slice(-10)
    });
});

app.get('/api/backtest/:game', (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.status(400).json({ success: false });
    const db = readDB(game);
    const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');

    // Rolling window 20
    const windows = [];
    for (let i = 20; i <= settled.length; i += 20) {
        const w = settled.slice(i - 20, i);
        const c = w.filter(h => h.trangThai === 'ĐÚNG').length;
        windows.push({ window: `${i - 20}→${i}`, wr: +(c / w.length * 100).toFixed(1) });
    }

    res.json({
        success: true, game,
        totalSettled: settled.length,
        overall: settled.length ? +(settled.filter(h => h.trangThai === 'ĐÚNG').length / settled.length * 100).toFixed(1) : 0,
        windows,
        walkForwardLog: db.walkForward
    });
});

app.get('/api/history/all', (req, res) => {
    const out = {};
    for (const g of ['md5', 'taixiu']) {
        const db = readDB(g);
        out[g] = {
            items: db.history.slice(-100).reverse().map(it => ({
                phien: it.phien, phienDuDoan: it.phienDuDoan, tong: it.tong, xucXac: it.xucXac,
                ketQua: it.ketQua, ketQuaLabel: it.ketQuaLabel,
                duDoanCode: it.DU_DOAN_CODE, duDoan: it.DU_DOAN, tiLe: it.TI_LE,
                pattern: { type: it.patternName }, trangThai: it.trangThai,
                entropy: it.entropy, regime: it.regime, diversity: it.diversity
            }))
        };
    }
    res.json({ success: true, games: out });
});

// ========================================================================
// 19. WEB UI V3
// ========================================================================
app.get('/:game', (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.send('Trang không tồn tại');

    const db = readDB(game);
    const rows = db.history.slice(-50).reverse();
    const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const correct = settled.filter(h => h.trangThai === 'ĐÚNG').length;
    const accuracy = settled.length ? (correct / settled.length * 100).toFixed(1) : '0.0';
    const regime = db.regime?.regime || 'UNKNOWN';

    // Regime color
    const regimeColor = {
        STREAKING: '#f59e0b', BOUNCING: '#3b82f6', CHAOTIC: '#ef4444',
        TRENDING: '#22c55e', MIXED: '#94a3b8', UNKNOWN: '#64748b'
    }[regime] || '#64748b';

    // Top algos
    const topAlgos = Object.entries(db.algoStats || {})
        .map(([id, s]) => ({ id, acc: s.total ? s.correct / s.total * 100 : 0, total: s.total }))
        .filter(a => a.total >= 5)
        .sort((a, b) => b.acc - a.acc)
        .slice(0, 5);

    const getBadge = (type) => {
        if (!type) return 'badge-default';
        if (/BỆT|STREAK/.test(type)) return 'badge-bet';
        if (/MARKOV|NGRAM|TRANS/.test(type)) return 'badge-markov';
        if (/CYCLE|PALIN|FLIP/.test(type)) return 'badge-cycle';
        if (/GUARD|ENTROPY/.test(type)) return 'badge-guard';
        if (/SAM|LZ|MOTIF/.test(type)) return 'badge-motif';
        if (/MULTI|MTF/.test(type)) return 'badge-mtf';
        return 'badge-default';
    };

    const html = `<!DOCTYPE html>
    <html lang="vi">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
    <title>META V3 - ${game.toUpperCase()}</title>
    <style>
      *{box-sizing:border-box}
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0e27;color:#e6eef6;padding:12px;margin:0;}
      .header{background:linear-gradient(135deg,#7c3aed,#3b82f6,#10b981);padding:16px;border-radius:14px;margin-bottom:14px;box-shadow:0 8px 24px rgba(124,58,237,.4);text-align:center;}
      h1{color:#fff;font-size:20px;margin:0;font-weight:800;text-transform:uppercase}
      .acc{margin-top:8px;font-size:13px;color:#fff}
      .regime{display:inline-block;padding:4px 10px;border-radius:6px;background:${regimeColor};color:#fff;font-weight:700;font-size:11px;margin-top:6px;}
      .algo-list{background:#0f172a;border-radius:12px;padding:12px;margin-bottom:14px;border:1px solid #334155;}
      .algo-list h3{margin:0 0 10px;font-size:13px;color:#60a5fa;text-transform:uppercase}
      .algo-item{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #1e293b;font-size:12px;}
      .algo-item:last-child{border:none}
      .algo-name{color:#cbd5e1;font-weight:600}
      .algo-acc{color:#22c55e;font-weight:700}
      .table-wrap{background:#0f172a;border-radius:12px;overflow-x:auto;border:1px solid #334155;}
      table{width:100%;border-collapse:collapse;font-size:12px}
      th{background:#7c3aed;color:#fff;padding:10px 4px;font-weight:600;text-transform:uppercase;font-size:10px;}
      td{padding:10px 4px;text-align:center;border-bottom:1px solid #1e293b;}
      .tai{color:#22c55e;font-weight:700}.xiu{color:#ef4444;font-weight:700}
      .dung{color:#22c55e;font-weight:700;text-transform:uppercase}.sai{color:#ef4444;font-weight:700;text-transform:uppercase}.cho{color:#94a3b8;font-weight:600;font-style:italic}
      .dice{color:#fbbf24;font-weight:700;line-height:1.2}
      .sum{display:inline-block;padding:4px 10px;border-radius:6px;background:#334155;color:#fbbf24;font-weight:800;font-size:14px}
      .session{font-family:monospace;font-size:11px;color:#64748b}
      .ti-le{font-size:12px;color:#cbd5e1;font-weight:600}
      .badge{display:inline-block;padding:4px 8px;border-radius:6px;font-size:10px;font-weight:700;white-space:nowrap;}
      .badge-bet{background:#78350f;color:#fcd34d}
      .badge-markov{background:#1e3a8a;color:#93c5fd}
      .badge-cycle{background:#1e40af;color:#93c5fd}
      .badge-guard{background:#581c87;color:#e9d5ff}
      .badge-motif{background:#134e4a;color:#5eead4}
      .badge-mtf{background:#7c2d12;color:#fdba74}
      .badge-default{background:#334155;color:#cbd5e1}
    </style>
    <script>setTimeout(()=>location.reload(), 10000);</script>
    </head>
    <body>
      <div class="header">
        <h1>🎯 META ENGINE V3 - ${game.toUpperCase()}</h1>
        <div class="acc">Độ chính xác ${settled.length} phiên: <strong>${accuracy}%</strong></div>
        <div class="regime">REGIME: ${regime}</div>
      </div>
      ${topAlgos.length ? `<div class="algo-list"><h3>🏆 Top Algorithms</h3>${topAlgos.map(a => `<div class="algo-item"><span class="algo-name">${a.id.toUpperCase()}</span><span class="algo-acc">${a.acc.toFixed(1)}% (${a.total})</span></div>`).join('')}</div>` : ''}
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

// ========================================================================
// 20. START
// ========================================================================
app.listen(PORT, () => console.log(`🚀 META ENGINE V3 chạy port ${PORT}`));
