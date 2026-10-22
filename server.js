'use strict';

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
const TICK_MS = safeInt(process.env.TICK_MS, 5000);

if (!fs.existsSync(DB_DIR)) { try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch (e) {} }

function safeInt(x, def = 0) { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
const label = c => c === 'T' ? 'Tài' : (c === 'X' ? 'Xỉu' : null);
const flip = c => c === 'T' ? 'X' : (c === 'X' ? 'T' : null);
const flipSeq = seq => seq.map(flip);

function readDB(g) {
    const p = path.join(DB_DIR, `db_${g}.json`);
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {}
    return { history: [], lastProcessedSession: null, algoStats: {}, weights: {}, calibration: { T: [], X: [] }, regime: null, recentVotes: [], biasLog: [] };
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

function entropy(arr) {
    const f = {}; for (const x of arr) f[x] = (f[x] || 0) + 1;
    let h = 0; const n = arr.length;
    for (const k in f) { const p = f[k] / n; if (p > 0) h -= p * Math.log2(p); }
    return h;
}

function detectRegime(seq) {
    const n = seq.length;
    if (n < 20) return { regime: 'UNKNOWN' };
    const w = seq.slice(-30); const h = entropy(w);
    let flips = 0; for (let i = 1; i < w.length; i++) if (w[i] !== w[i - 1]) flips++;
    const flipRate = flips / (w.length - 1);
    let maxStreak = 1, cur = 1;
    for (let i = 1; i < w.length; i++) { if (w[i] === w[i - 1]) cur++; else cur = 1; if (cur > maxStreak) maxStreak = cur; }
    if (maxStreak >= 5 && flipRate < 0.4) return { regime: 'STREAKING' };
    if (flipRate > 0.75) return { regime: 'BOUNCING' };
    if (h > 1.02) return { regime: 'CHAOTIC' };
    if (h < 0.55) return { regime: 'TRENDING' };
    return { regime: 'MIXED' };
}

// --- 18 ALGOS (Giữ nguyên logic đã fix bias) ---
function algoBet(seq) {
    const n = seq.length, last = seq[n - 1]; let len = 1;
    for (let i = n - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
    if (len < 3) return null;
    const tS = [], xS = []; let cur = 1;
    for (let i = 1; i < n; i++) {
        if (seq[i] === seq[i - 1]) cur++;
        else { if (cur >= 3) { if (seq[i - 1] === 'T') tS.push(cur); else xS.push(cur); } cur = 1; }
    }
    const sS = last === 'T' ? tS : xS;
    const avg = sS.length ? sS.reduce((a, b) => a + b, 0) / sS.length : 4.5;
    const pCont = clamp(1 - (len / (avg * 1.6)), 0.15, 0.85);
    if (1 - pCont > 0.55) return { code: flip(last), name: `BỆT-GÃY-${len}`, conf: clamp(1 - pCont, 0.6, 0.9) };
    if (pCont > 0.55) return { code: last, name: `BỆT-${len}`, conf: clamp(pCont, 0.6, 0.9) };
    return null;
}
function algoMarkov(seq) {
    const n = seq.length; let best = null;
    for (let k = 2; k <= Math.min(7, n - 1); k++) {
        const key = seq.slice(-k).join(''); let t = 0, x = 0;
        for (let i = k; i < n; i++) { if (seq.slice(i - k, i).join('') === key) { if (seq[i] === 'T') t++; else x++; } }
        const total = t + x; if (total < 3) continue;
        const pT = (t + 1) / (total + 2), pX = (x + 1) / (total + 2);
        const conf = Math.max(pT, pX); const score = conf * Math.log(k + 1) * (total / (total + 3));
        if (!best || score > best.score) best = { code: pT > pX ? 'T' : 'X', name: `MARKOV-${k}`, conf, score };
    }
    return best;
}
function algoNGramRepeat(seq) {
    const n = seq.length; if (n < 10) return null; let best = null;
    for (let len = 3; len <= Math.min(10, Math.floor(n / 3)); len++) {
        const tail = seq.slice(-len).join(''); let t = 0, x = 0, cnt = 0;
        for (let i = 0; i + len < n - 1; i++) {
            if (seq.slice(i, i + len).join('') === tail) {
                const nxt = seq[i + len]; if (nxt === 'T') t++; else if (nxt === 'X') x++; cnt++;
            }
        }
        if (cnt < 2) continue;
        const pT = (t + 1) / (cnt + 2), pX = (x + 1) / (cnt + 2); const conf = Math.max(pT, pX);
        if (!best || conf * Math.log(len + 1) > best.score) best = { code: pT > pX ? 'T' : 'X', name: `NGRAM-${len}`, conf, score: conf * Math.log(len + 1) };
    }
    return best;
}
function algoCycle(seq) {
    const n = seq.length; if (n < 12) return null; let best = null;
    for (let p = 2; p <= Math.min(14, Math.floor(n / 2)); p++) {
        let match = 0, total = 0;
        for (let i = p; i < n; i++) { total++; if (seq[i] === seq[i - p]) match++; }
        const ratio = match / total; if (ratio < 0.65) continue;
        if (!best || ratio > best.score) best = { code: seq[n - p], name: `CYCLE-${p}`, conf: clamp(ratio, 0.65, 0.9), score: ratio };
    }
    return best;
}
function algoPalindrome(seq) {
    const n = seq.length; if (n < 6) return null;
    for (let len = 4; len <= Math.min(10, n - 1); len++) {
        const tail = seq.slice(-len).join(''), rev = [...tail].reverse().join('');
        let t = 0, x = 0, cnt = 0;
        for (let i = 0; i + len < n - 1; i++) {
            if (seq.slice(i, i + len).join('') === rev || seq.slice(i, i + len).join('') === tail) {
                if (seq[i + len] === 'T') t++; else x++; cnt++;
            }
        }
        if (cnt >= 2) { const pT = (t + 1) / (cnt + 2), pX = (x + 1) / (cnt + 2); if (Math.max(pT, pX) > 0.65) return { code: pT > pX ? 'T' : 'X', name: `PALIN-${len}`, conf: Math.max(pT, pX) }; }
    }
    return null;
}
function algoFlip(seq) {
    const n = seq.length; if (n < 8) return null;
    let flips = 0; for (let i = n - 8; i < n; i++) if (seq[i] !== seq[i - 1]) flips++;
    if (flips / 7 > 0.78) return { code: flip(seq[n - 1]), name: 'FLIP-1-1', conf: 0.72 };
    return null;
}
function algoBlockTrend(seq) {
    const n = seq.length; if (n < 10) return null;
    const blks = []; let ct = seq[0], cl = 1;
    for (let i = 1; i < n; i++) { if (seq[i] === ct) cl++; else { blks.push(cl); ct = seq[i]; cl = 1; } }
    blks.push(cl); if (blks.length < 4) return null;
    const l4 = blks.slice(-4);
    if (l4[1] > l4[0] && l4[2] > l4[1] && l4[3] > l4[2]) return { code: flip(seq[n - 1]), name: 'BLOCK-INC', conf: 0.7 };
    if (l4[1] < l4[0] && l4[2] < l4[1] && l4[3] < l4[2]) return { code: flip(seq[n - 1]), name: 'BLOCK-DEC', conf: 0.7 };
    if (l4[0] === l4[2] && l4[1] === l4[3] && l4[0] !== l4[1]) return { code: seq[n - 1], name: 'BLOCK-ALT', conf: 0.65 };
    return null;
}
function algoSumPattern(seq, sums) {
    if (!sums || sums.length < 15) return null;
    const rec = sums.slice(-15);
    const m1 = rec.slice(0, 5).reduce((a, b) => a + b, 0) / 5, m2 = rec.slice(5, 10).reduce((a, b) => a + b, 0) / 5, m3 = rec.slice(10, 15).reduce((a, b) => a + b, 0) / 5;
    if (m1 < m2 && m2 < m3 && m3 - m1 > 2.5) return { code: 'X', name: 'SUM-UP', conf: 0.62 };
    if (m1 > m2 && m2 > m3 && m1 - m3 > 2.5) return { code: 'T', name: 'SUM-DOWN', conf: 0.62 };
    return null;
}
function algoTransition(seq) {
    const n = seq.length; if (n < 8) return null;
    const last = seq[n - 1]; let wt = 0, wx = 0, t = 0, x = 0;
    for (let i = 1; i < n; i++) {
        if (seq[i - 1] === last) {
            const w = Math.exp(-(n - i) / 20); if (seq[i] === 'T') { t++; wt += w; } else { x++; wx += w; }
        }
    }
    if (t + x < 4) return null;
    const pT = (wt + 0.5) / (wt + wx + 1), pX = (wx + 0.5) / (wt + wx + 1);
    if (Math.max(pT, pX) < 0.62) return null;
    return { code: pT > pX ? 'T' : 'X', name: 'TRANS-W', conf: Math.max(pT, pX) };
}
function algoStreakExhaust(seq) {
    const n = seq.length; if (n < 15) return null;
    const last = seq[n - 1]; let len = 1;
    for (let i = n - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
    const hist = []; let cur = 1;
    for (let i = 1; i < n; i++) {
        if (seq[i] === seq[i - 1]) cur++;
        else { if (seq[i - 1] === last && cur >= 2) hist.push(cur); cur = 1; }
    }
    if (!hist.length) return null;
    const maxH = Math.max(...hist), avgH = hist.reduce((a, b) => a + b, 0) / hist.length;
    if (len > maxH) return { code: flip(last), name: 'STREAK-MAX', conf: 0.75 };
    if (len > avgH * 1.5) return { code: flip(last), name: 'STREAK-AVG', conf: 0.65 };
    return null;
}
function algoGap(seq) {
    const n = seq.length; if (n < 20) return null;
    const tP = [], xP = []; for (let i = 0; i < n; i++) { if (seq[i] === 'T') tP.push(i); else xP.push(i); }
    if (tP.length < 3 || xP.length < 3) return null;
    const tG = []; for (let i = 1; i < tP.length; i++) tG.push(tP[i] - tP[i - 1]);
    const xG = []; for (let i = 1; i < xP.length; i++) xG.push(xP[i] - xP[i - 1]);
    const tAvg = tG.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, tG.length), xAvg = xG.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, xG.length);
    const tPress = (n - tP[tP.length - 1]) / Math.max(tAvg, 1), xPress = (n - xP[xP.length - 1]) / Math.max(xAvg, 1);
    const diff = tPress - xPress; if (Math.abs(diff) < 0.5) return null;
    if (diff > 0.5) return { code: 'T', name: 'GAP-T', conf: clamp(0.6 + diff * 0.05, 0.6, 0.82) };
    return { code: 'X', name: 'GAP-X', conf: clamp(0.6 + Math.abs(diff) * 0.05, 0.6, 0.82) };
}
function algoMultiTF(seq) {
    const n = seq.length; if (n < 24) return null;
    let tV = 0, xV = 0;
    for (const w of [5, 10, 20]) {
        const pT = seq.slice(-w).filter(x => x === 'T').length / w;
        if (pT > 0.68) xV += 1; else if (pT < 0.32) tV += 1;
    }
    if (tV + xV < 2) return null;
    return { code: tV > xV ? 'T' : 'X', name: 'MULTI-TF', conf: clamp(0.62 + Math.abs(tV - xV) * 0.08, 0.62, 0.85) };
}
function algoFractal(seq) {
    const n = seq.length; if (n < 30) return null;
    let t = 0, x = 0, cnt = 0;
    for (const sc of [4, 6, 8]) {
        if (n < sc * 2) continue; const lastB = seq.slice(-sc).join('');
        for (let i = 0; i + sc < n - sc; i += sc) {
            if (seq.slice(i, i + sc).join('') === lastB) {
                const nb = seq.slice(i + sc, i + sc * 2);
                if (nb.length === sc) { if (nb[0] === 'T') t++; else x++; cnt++; }
            }
        }
    }
    if (cnt < 2) return null;
    const pT = (t + 0.5) / (cnt + 1), pX = (x + 0.5) / (cnt + 1);
    if (Math.max(pT, pX) < 0.62) return null;
    return { code: pT > pX ? 'T' : 'X', name: 'FRACTAL', conf: Math.max(pT, pX) };
}
function algoMirror(seq) {
    const n = seq.length; if (n < 12) return null;
    for (let half = 3; half <= 6; half++) {
        if (n < half * 2 + 2) continue;
        const rec = seq.slice(-(half * 2));
        if (rec.slice(0, half).map(flip).join('') === rec.slice(half).join('')) return { code: flip(seq[n - 1]), name: `MIRROR-${half}`, conf: 0.7 };
    }
    return null;
}
function algoZigzag(seq) {
    const n = seq.length; if (n < 15) return null;
    for (let p = 2; p <= 6; p++) {
        if (n < p * 2 + 2) continue;
        let match = true;
        for (let i = n - p * 2; i < n - p; i++) if (seq[i] !== seq[i + p]) { match = false; break; }
        if (match) return { code: seq[n - p], name: `ZIGZAG-${p}`, conf: 0.72 };
    }
    return null;
}
function algoSuffixMotif(seq) {
    const n = seq.length; if (n < 12) return null;
    const sam = buildSuffixAutomaton(seq.join(''));
    let state = 0, matched = 0;
    for (let i = n - 1; i >= 0; i--) { const ns = sam.next[state][seq[i]]; if (!ns) break; state = ns; matched++; }
    if (matched < 2) return null;
    const ctx = seq.slice(-matched).join(''); let t = 0, x = 0;
    const s = seq.join('');
    for (let i = 0; i + matched < n; i++) {
        if (s.substr(i, matched) === ctx) { if (seq[i + matched] === 'T') t++; else x++; }
    }
    if (t + x < 3) return null;
    const pT = (t + 0.5) / (t + x + 1), pX = (x + 0.5) / (t + x + 1);
    if (Math.max(pT, pX) < 0.62) return null;
    return { code: pT > pX ? 'T' : 'X', name: `SAM-${matched}`, conf: Math.max(pT, pX) };
}
function algoLZSimilarity(seq) {
    const n = seq.length; if (n < 20) return null;
    const tail = seq.slice(-8).join(''); let t = 0, x = 0, cnt = 0, bestSim = 0;
    for (let i = 0; i + 8 < n - 1; i++) {
        const sim = similarity(seq.slice(i, i + 8).join(''), tail);
        if (sim > 0.75) { if (seq[i + 8] === 'T') t++; else x++; cnt++; bestSim = Math.max(bestSim, sim); }
    }
    if (cnt < 2) return null;
    const pT = (t + 0.5) / (cnt + 1), pX = (x + 0.5) / (cnt + 1);
    if (Math.max(pT, pX) * bestSim < 0.58) return null;
    return { code: pT > pX ? 'T' : 'X', name: 'LZ-SIM', conf: Math.max(pT, pX) * bestSim };
}
function algoSubsequence(seq) {
    const n = seq.length; if (n < 20) return null;
    const sub = [seq[n - 8], seq[n - 6], seq[n - 4], seq[n - 2]].join(''); let t = 0, x = 0, cnt = 0;
    for (let i = 0; i + 9 < n; i++) {
        if ([seq[i], seq[i + 2], seq[i + 4], seq[i + 6]].join('') === sub) { if (seq[i + 8] === 'T') t++; else x++; cnt++; }
    }
    if (cnt < 2) return null;
    const pT = (t + 0.5) / (cnt + 1), pX = (x + 0.5) / (cnt + 1);
    if (Math.max(pT, pX) < 0.62) return null;
    return { code: pT > pX ? 'T' : 'X', name: 'SUBSEQ', conf: Math.max(pT, pX) };
}

const ALGO_REGISTRY = [
    { id: 'bet', fn: algoBet, base: 1.0, family: 'streak' }, { id: 'markov', fn: algoMarkov, base: 1.2, family: 'markov' },
    { id: 'ngram', fn: algoNGramRepeat, base: 1.1, family: 'ngram' }, { id: 'cycle', fn: algoCycle, base: 1.0, family: 'cycle' },
    { id: 'palin', fn: algoPalindrome, base: 0.8, family: 'cycle' }, { id: 'flip', fn: algoFlip, base: 0.9, family: 'bounce' },
    { id: 'block', fn: algoBlockTrend, base: 0.9, family: 'block' }, { id: 'sum', fn: algoSumPattern, base: 0.7, family: 'sum' },
    { id: 'trans', fn: algoTransition, base: 1.0, family: 'markov' }, { id: 'streak', fn: algoStreakExhaust, base: 1.1, family: 'streak' },
    { id: 'gap', fn: algoGap, base: 0.8, family: 'pressure' }, { id: 'sam', fn: algoSuffixMotif, base: 1.15, family: 'motif' },
    { id: 'lz', fn: algoLZSimilarity, base: 1.0, family: 'similarity' }, { id: 'mtf', fn: algoMultiTF, base: 1.05, family: 'multi-tf' },
    { id: 'fractal', fn: algoFractal, base: 1.1, family: 'fractal' }, { id: 'subseq', fn: algoSubsequence, base: 1.0, family: 'subseq' },
    { id: 'mirror', fn: algoMirror, base: 1.1, family: 'mirror' }, { id: 'zigzag', fn: algoZigzag, base: 1.1, family: 'zigzag' }
];

function buildSuffixAutomaton(str) {
    const n = str.length, max = 2 * n + 5; const len = new Int32Array(max), link = new Int32Array(max).fill(-1), next = Array.from({ length: max }, () => ({}));
    let size = 1, last = 0;
    for (let i = 0; i < n; i++) {
        const c = str[i], cur = size++; len[cur] = len[last] + 1;
        let p = last;
        while (p !== -1 && !next[p][c]) { next[p][c] = cur; p = link[p]; }
        if (p === -1) link[cur] = 0;
        else { const q = next[p][c]; if (len[p] + 1 === len[q]) link[cur] = q; else { const clone = size++; len[clone] = len[p] + 1; link[clone] = link[q]; next[clone] = { ...next[q] }; while (p !== -1 && next[p][c] === q) { next[p][c] = clone; p = link[p]; } link[q] = clone; link[cur] = clone; } }
        last = cur;
    }
    return { next };
}
function lzComplexity(str) { const dict = new Set(); let i = 0, c = 0; while (i < str.length) { let p = ''; while (i < str.length) { p += str[i]; if (!dict.has(p)) { dict.add(p); i++; c++; break; } i++; } } return c; }
function similarity(a, b) { const ca = lzComplexity(a), cb = lzComplexity(b), cab = lzComplexity(a + b); return clamp(1 - (cab - Math.min(ca, cb)) / Math.max(ca, cb), 0, 1); }

function mirrorTest(algoFn, seq, sums) {
    try {
        const orig = algoFn(seq, sums), flipped = algoFn(flipSeq(seq), sums);
        if ((orig === null) !== (flipped === null)) return { valid: false };
        if (!orig || !flipped) return { valid: true };
        if (flipped.code !== flip(orig.code)) return { valid: false };
        return { valid: true };
    } catch (e) { return { valid: false }; }
}
function getWeight(db, algoId, baseWeight) { return clamp(baseWeight * (db.weights[algoId] ?? 1.0), 0.3, 2.2); }
function updateWeight(db, algoId, wasCorrect, lr = 0.03) { db.weights[algoId] = clamp((db.weights[algoId] ?? 1.0) + (wasCorrect ? lr : -lr), 0.3, 2.2); }
function getCalibration(db, side, rawConf) {
    const list = db.calibration[side] || []; const bin = Math.round(rawConf * 20) / 20;
    const rec = list.find(c => c.bin === bin);
    if (!rec || rec.total < 8) return 1.0;
    return clamp((rec.correct / rec.total) / rawConf, 0.7, 1.2);
}
function updateCalibration(db, side, rawConf, wasCorrect) {
    if (!db.calibration[side]) db.calibration[side] = [];
    const bin = Math.round(rawConf * 20) / 20;
    let rec = db.calibration[side].find(c => c.bin === bin);
    if (!rec) { rec = { bin, total: 0, correct: 0 }; db.calibration[side].push(rec); }
    rec.total++; if (wasCorrect) rec.correct++;
    if (rec.total > 200) { rec.total = 200; rec.correct = Math.round(rec.correct * 0.95); }
}
function auditBias(db) {
    const recent = (db.recentVotes || []).slice(-20);
    if (recent.length < 10) return { biased: false, action: 'NONE' };
    const t = recent.filter(v => v === 'T').length, x = recent.filter(v => v === 'X').length;
    const ratio = Math.max(t, x) / recent.length;
    if (ratio >= 0.85) return { biased: true, dominant: t > x ? 'T' : 'X', action: 'FORCE_REBALANCE', warning: `Lệch ${(ratio * 100).toFixed(0)}% về ${t > x ? 'Tài' : 'Xỉu'}` };
    if (ratio >= 0.75) return { biased: true, dominant: t > x ? 'T' : 'X', action: 'SOFT_REBALANCE', warning: `Lệch ${(ratio * 100).toFixed(0)}%` };
    return { biased: false, tCount: t, xCount: x, action: 'NONE' };
}

// ========================================================================
// META ENGINE V7 - FIX LỖI ẢO GIÁC CONFIDENCE
// ========================================================================
function runMetaEngine(seq, sums, db, session) {
    const regime = detectRegime(seq);
    db.regime = regime;

    const votes = { T: 0, X: 0 };
    const details = [];
    const families = { T: new Set(), X: new Set() };
    const entropy30 = entropy(seq.slice(-30));

    for (const algo of ALGO_REGISTRY) {
        if (!mirrorTest(algo.fn, seq, sums).valid) continue; // Loại algo bias
        let res = null; try { res = algo.fn(seq, sums, db); } catch (e) { res = null; }
        if (!res || !res.code) continue;

        const w = getWeight(db, algo.id, algo.base);
        let vote = (res.conf || 0.6) * w;
        const pen = entropy30 > 0.95 ? 0.7 : 1.0;

        let regimeBonus = 1.0;
        if (regime.regime === 'STREAKING' && (algo.family === 'streak' || algo.family === 'block')) regimeBonus = 1.2;
        if (regime.regime === 'BOUNCING' && (algo.family === 'bounce' || algo.family === 'cycle' || algo.family === 'zigzag')) regimeBonus = 1.2;
        if (regime.regime === 'CHAOTIC' && (algo.family === 'markov' || algo.family === 'ngram')) regimeBonus = 0.85;
        if (regime.regime === 'TRENDING' && (algo.family === 'motif' || algo.family === 'fractal' || algo.family === 'mirror')) regimeBonus = 1.15;

        const finalVote = vote * pen * regimeBonus;
        votes[res.code] += finalVote;
        families[res.code].add(algo.family);

        details.push({ algo: algo.id, family: algo.family, code: res.code, name: res.name, conf: +(res.conf || 0).toFixed(3), vote: +finalVote.toFixed(3) });
    }

    const total = votes.T + votes.X;
    let winner, confidence, pT, pX, gap, decisionPath;

    // NẾU TỔNG VOTE QUÁ THẤP (0 algo vote)
    if (total < 0.01) {
        const h = crypto.createHash('md5').update(String(session)).digest();
        winner = (h[0] % 2 === 0) ? 'T' : 'X';
        pT = 0.5; pX = 0.5; gap = 0; confidence = 0.50;
        decisionPath = 'TIEBREAK-HASH';
    } else {
        pT = votes.T / total;
        pX = votes.X / total;
        gap = Math.abs(pT - pX);

        if (gap < 0.02) { // Nếu 2 bên vote gần như bằng nhau (Lệch < 2%)
            const h = crypto.createHash('md5').update(String(session)).digest();
            winner = (h[0] % 2 === 0) ? 'T' : 'X';
            confidence = 0.50; // Cố định 50%
            decisionPath = 'TIEBREAK-BALANCE';
        } else if (gap < 0.05) {
            winner = pT > pX ? 'T' : 'X';
            confidence = 0.50 + gap * 2; // ~0.50 - 0.60
            decisionPath = 'WEAK-GAP';
        } else {
            winner = pT > pX ? 'T' : 'X';
            confidence = Math.max(pT, pX);
            decisionPath = 'NORMAL';
        }
    }

    // BIAS AUDITOR
    const biasAudit = auditBias(db);
    let biasForced = false;
    if (biasAudit.action === 'FORCE_REBALANCE' && winner === biasAudit.dominant) {
        winner = flip(winner); confidence = 0.50; // Bị ép đảo thì max 50%
        decisionPath = 'BIAS-REBALANCE'; biasForced = true;
    } else if (biasAudit.action === 'SOFT_REBALANCE' && winner === biasAudit.dominant) {
        confidence = confidence * 0.85;
    }

    // DIVERSITY BONUS (Chỉ cộng nếu gap > 0.05 và không bị force rebalance)
    if (decisionPath === 'NORMAL' && !biasForced) {
        const winnerFamilies = families[winner].size;
        if (winnerFamilies >= 4) confidence += 0.03;
        if (winnerFamilies >= 6) confidence += 0.02;
    }

    // CALIBRATION (Sửa lỗi vọt lên 92%)
    const calib = getCalibration(db, winner, confidence);
    confidence = confidence * calib;

    // ANTI-DOMINANCE
    const loser = flip(winner);
    const loserShare = total > 0 ? votes[loser] / total : 0.5;
    if (loserShare > 0.35) confidence *= 0.92;
    if (loserShare > 0.42) confidence *= 0.85;

    // CHỐT HẠ: Max confidence là 65% (Thực tế game 50/50 không thể cao hơn)
    confidence = clamp(confidence, 0.50, 0.65);

    const isWeak = confidence < 0.58; // < 58% là yếu
    const isVeryWeak = confidence <= 0.51; // <= 51% là rất yếu

    const topAlgo = details.filter(d => d.code === winner).sort((a, b) => b.vote - a.vote)[0];
    let labelName;
    if (decisionPath === 'TIEBREAK-HASH' || decisionPath === 'TIEBREAK-BALANCE') labelName = 'META·TIEBREAK';
    else if (decisionPath === 'BIAS-REBALANCE') labelName = `META·REBALANCE`;
    else if (isVeryWeak) labelName = `META·RẤT YẾU`;
    else if (isWeak) labelName = `META·YẾU·${topAlgo ? topAlgo.name : ''}`;
    else labelName = topAlgo ? `META·${topAlgo.name}` : 'META';

    return {
        code: winner, label: labelName, tiLe: (confidence * 100).toFixed(1) + '%',
        details, regime, entropy: +entropy30.toFixed(3),
        diversity: families[winner].size, weak: isWeak, veryWeak: isVeryWeak,
        decisionPath, biasForced, biasAudit,
        balance: { votesT: +votes.T.toFixed(2), votesX: +votes.X.toFixed(2), gap: +gap.toFixed(3), pT: +pT.toFixed(3), pX: +pX.toFixed(3), loserShare: +loserShare.toFixed(3) }
    };
}

function updateAllStats(db, prev, actual) {
    if (!prev || !actual) return;
    if (!db.algoStats) db.algoStats = {};
    for (const d of (prev.algoDetails || [])) {
        if (!db.algoStats[d.algo]) db.algoStats[d.algo] = { total: 0, correct: 0 };
        db.algoStats[d.algo].total++; if (d.code === actual) db.algoStats[d.algo].correct++;
        updateWeight(db, d.algo, d.code === actual, 0.03);
    }
    if (prev.DU_DOAN_CODE) {
        const rawConf = parseFloat(String(prev.TI_LE).replace('%', '')) / 100;
        if (Number.isFinite(rawConf)) updateCalibration(db, prev.DU_DOAN_CODE, rawConf, prev.DU_DOAN_CODE === actual);
    }
}

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

    const seq = list.map(getResult).filter(Boolean), sums = list.map(getSum).filter(s => s >= 3 && s <= 18);
    if (seq.length < 8) return;

    const prev = db.history[db.history.length - 1];
    if (prev && safeInt(prev.phienDuDoan) === session) {
        const actual = getResult(latest);
        prev.ketQua = actual; prev.ketQuaLabel = label(actual);
        prev.trangThai = !prev.DU_DOAN_CODE ? 'BỎ QUA' : (prev.DU_DOAN_CODE === actual ? 'ĐÚNG' : 'SAI');
        updateAllStats(db, prev, actual);
    }

    const pred = runMetaEngine(seq, sums, db, session + 1);
    if (!db.recentVotes) db.recentVotes = [];
    if (pred.code) db.recentVotes.push(pred.code);
    if (db.recentVotes.length > 50) db.recentVotes = db.recentVotes.slice(-50);

    db.history.push({
        phien: session, xucXac: getDice(latest), tong: getSum(latest), ketQua: getResult(latest), ketQuaLabel: label(getResult(latest)),
        phienDuDoan: session + 1, DU_DOAN_CODE: pred.code, DU_DOAN: label(pred.code), TI_LE: pred.tiLe, patternName: pred.label,
        algoDetails: pred.details, entropy: pred.entropy, regime: db.regime?.regime, diversity: pred.diversity, balance: pred.balance,
        weak: pred.weak, veryWeak: pred.veryWeak, decisionPath: pred.decisionPath, biasForced: pred.biasForced, trangThai: 'ĐANG CHỜ'
    });

    if (db.history.length > 600) db.history.shift();
    db.lastProcessedSession = session; saveDB(game, db);
}

setInterval(() => { processGame('md5'); processGame('taixiu'); }, TICK_MS);

// ================== ROUTES & UI ==================
app.get('/', (req, res) => res.redirect('/md5'));

app.get('/api/predict/:game', async (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.status(400).json({ success: false });
    const list = await fetchApi(game === 'md5' ? API_MD5 : API_TX);
    if (!list || !list.length) return res.status(500).json({ success: false });

    const latest = list[list.length - 1], session = safeInt(latest.SessionId);
    const seq = list.map(getResult).filter(Boolean), sums = list.map(getSum).filter(s => s >= 3 && s <= 18);
    const db = readDB(game), pred = runMetaEngine(seq, sums, db, session + 1);

    res.json({
        success: true, game, phien: session, xucXac: getDice(latest), tong: getSum(latest), ketQua: getResult(latest), ketQuaLabel: label(getResult(latest)),
        phienDuDoan: session + 1, duDoan: label(pred.code), duDoanCode: pred.code, tiLe: pred.tiLe, reason: pred.label,
        weak: pred.weak, veryWeak: pred.veryWeak, decisionPath: pred.decisionPath, biasForced: pred.biasForced,
        balance: pred.balance, algoVotes: pred.details
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

    const regime = db.regime?.regime || 'UNKNOWN';
    const audit = auditBias(db);

    const html = `<!DOCTYPE html>
    <html lang="vi">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
    <title>META V7 - ${game.toUpperCase()}</title>
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
        <h1>META V7 · ${game.toUpperCase()}</h1>
        <div class="stat">Chính xác: <strong>${acc}%</strong> (${settled.length} phiên)</div>
        <div class="split">
          <div>🔥 Mạnh: <strong>${sWR}%</strong> (${strong.length})</div>
          <div>⚠️ Yếu: <strong>${wWR}%</strong> (${weak.length})</div>
        </div>
        ${audit.biased ? `<div style="background:#7f1d1d;color:#fecaca;margin-top:8px;padding:8px;border-radius:8px;font-size:12px;">⚠️ ${audit.warning}</div>` : `<div style="background:#14532d;color:#bbf7d0;margin-top:8px;padding:8px;border-radius:8px;font-size:12px;">✅ Cân bằng</div>`}
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
                <td class="${dd}">${it.DU_DOAN || ''}${it.biasForced ? ' 🔄' : ''}</td>
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

app.listen(PORT, () => console.log(`🚀 Server V7 chạy port ${PORT}`));
