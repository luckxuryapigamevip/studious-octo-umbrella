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
const TICK_MS = safeInt(process.env.TICK_MS, 5000);

if (!fs.existsSync(DB_DIR)) { try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch (e) {} }

// ========================================================================
// 3. HELPERS
// ========================================================================
function safeInt(x, def = 0) { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
const label = c => c === 'T' ? 'Tài' : (c === 'X' ? 'Xỉu' : null);
const flip = c => c === 'T' ? 'X' : (c === 'X' ? 'T' : null);
const flipSeq = seq => seq.map(flip);

function readDB(g) {
    const p = path.join(DB_DIR, `db_${g}.json`);
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {}
    return {
        history: [],
        lastProcessedSession: null,
        algoStats: {},
        weights: {},
        calibration: { T: [], X: [] },
        regime: null,
        recentVotes: [],
        biasLog: []
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
// 4. MATH
// ========================================================================
function entropy(arr) {
    const f = {};
    for (const x of arr) f[x] = (f[x] || 0) + 1;
    const n = arr.length;
    let h = 0;
    for (const k in f) { const p = f[k] / n; if (p > 0) h -= p * Math.log2(p); }
    return h;
}

// ========================================================================
// 5. REGIME
// ========================================================================
function detectRegime(seq) {
    const n = seq.length;
    if (n < 20) return { regime: 'UNKNOWN', confidence: 0 };
    const w = seq.slice(-30);
    const h = entropy(w);
    let flips = 0;
    for (let i = 1; i < w.length; i++) if (w[i] !== w[i - 1]) flips++;
    const flipRate = flips / (w.length - 1);
    let maxStreak = 1, cur = 1;
    for (let i = 1; i < w.length; i++) {
        if (w[i] === w[i - 1]) cur++; else cur = 1;
        if (cur > maxStreak) maxStreak = cur;
    }
    if (maxStreak >= 5 && flipRate < 0.4) return { regime: 'STREAKING', confidence: 0.8, flipRate, maxStreak, entropy: h };
    if (flipRate > 0.75) return { regime: 'BOUNCING', confidence: 0.8, flipRate, maxStreak, entropy: h };
    if (h > 1.02) return { regime: 'CHAOTIC', confidence: 0.75, flipRate, maxStreak, entropy: h };
    if (h < 0.55) return { regime: 'TRENDING', confidence: 0.7, flipRate, maxStreak, entropy: h };
    return { regime: 'MIXED', confidence: 0.5, flipRate, maxStreak, entropy: h };
}

// ========================================================================
// 6. SUFFIX AUTOMATON
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
        if (p === -1) link[cur] = 0;
        else {
            const q = next[p][c];
            if (len[p] + 1 === len[q]) link[cur] = q;
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
    const order = Array.from({ length: size }, (_, i) => i).sort((a, b) => len[b] - len[a]);
    for (const s of order) if (link[s] >= 0) occ[link[s]] += occ[s];
    return { size, len, link, next, occ };
}

// ========================================================================
// 7. 18 ALGOS (ĐÃ FIX BIAS TRIỆT ĐỂ)
// ========================================================================

function algoBet(seq) {
    const n = seq.length, last = seq[n - 1];
    let len = 1;
    for (let i = n - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
    if (len < 3) return null;
    const tStreaks = [], xStreaks = [];
    let cur = 1;
    for (let i = 1; i < n; i++) {
        if (seq[i] === seq[i - 1]) cur++;
        else {
            if (cur >= 3) {
                if (seq[i - 1] === 'T') tStreaks.push(cur);
                else xStreaks.push(cur);
            }
            cur = 1;
        }
    }
    const sameSide = last === 'T' ? tStreaks : xStreaks;
    const avg = sameSide.length ? sameSide.reduce((a, b) => a + b, 0) / sameSide.length : 4.5;
    const pCont = clamp(1 - (len / (avg * 1.6)), 0.15, 0.85);
    if (1 - pCont > 0.55) return { code: flip(last), name: `BỆT-GÃY-${len}`, conf: clamp(1 - pCont, 0.6, 0.9) };
    if (pCont > 0.55) return { code: last, name: `BỆT-${len}`, conf: clamp(pCont, 0.6, 0.9) };
    return null;
}

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
        if (total < 3) continue;
        const pT = (t + 1) / (total + 2), pX = (x + 1) / (total + 2);
        const conf = Math.max(pT, pX);
        const score = conf * Math.log(k + 1) * (total / (total + 3));
        if (!best || score > best.score) best = { code: pT > pX ? 'T' : 'X', name: `MARKOV-${k}`, conf, score };
    }
    return best;
}

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
        const pT = (t + 1) / (cnt + 2), pX = (x + 1) / (cnt + 2);
        const conf = Math.max(pT, pX);
        const score = conf * Math.log(len + 1) * Math.log(cnt + 1);
        if (!best || score > best.score) best = { code: pT > pX ? 'T' : 'X', name: `NGRAM-${len}`, conf, score };
    }
    return best;
}

function algoCycle(seq) {
    const n = seq.length;
    if (n < 12) return null;
    let best = null;
    for (let p = 2; p <= Math.min(14, Math.floor(n / 2)); p++) {
        let match = 0, total = 0;
        for (let i = p; i < n; i++) { total++; if (seq[i] === seq[i - p]) match++; }
        const ratio = match / total;
        if (ratio < 0.65) continue;
        const pred = seq[n - p];
        const conf = clamp(ratio, 0.65, 0.9);
        const score = conf * Math.log(p + 1);
        if (!best || score > best.score) best = { code: pred, name: `CYCLE-${p}`, conf, score };
    }
    return best;
}

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
            if (conf > 0.65) return { code: pT > pX ? 'T' : 'X', name: `PALIN-${len}`, conf, score: conf * cnt };
        }
    }
    return null;
}

function algoFlip(seq) {
    const n = seq.length;
    if (n < 8) return null;
    let flips = 0;
    for (let i = n - 8; i < n; i++) if (seq[i] !== seq[i - 1]) flips++;
    if (flips / 7 > 0.78) return { code: flip(seq[n - 1]), name: 'FLIP-1-1', conf: 0.72, score: flips / 7 };
    return null;
}

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

// SUM - ĐÃ FIX HOÀN TOÀN (bỏ ngưỡng cứng, chỉ dùng xu hướng đối xứng)
function algoSumPattern(seq, sums) {
    if (!sums || sums.length < 15) return null;
    const recent = sums.slice(-15);
    const m1 = recent.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    const m2 = recent.slice(5, 10).reduce((a, b) => a + b, 0) / 5;
    const m3 = recent.slice(10, 15).reduce((a, b) => a + b, 0) / 5;
    if (m1 < m2 && m2 < m3 && m3 - m1 > 2.5) return { code: 'X', name: 'SUM-UP', conf: 0.62, score: m3 - m1 };
    if (m1 > m2 && m2 > m3 && m1 - m3 > 2.5) return { code: 'T', name: 'SUM-DOWN', conf: 0.62, score: m1 - m3 };
    return null;
}

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
    if (t + x < 4) return null;
    const pT = (wt + 0.5) / (wt + wx + 1), pX = (wx + 0.5) / (wt + wx + 1);
    const conf = Math.max(pT, pX);
    if (conf < 0.62) return null;
    return { code: pT > pX ? 'T' : 'X', name: 'TRANS-W', conf, score: conf * (t + x) };
}

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
    if (len > maxH) return { code: flip(last), name: 'STREAK-MAX', conf: 0.75, score: len / maxH };
    if (len > avgH * 1.5) return { code: flip(last), name: 'STREAK-AVG', conf: 0.65, score: 1 };
    return null;
}

// GAP - ĐÃ FIX ĐỐI XỨNG HOÀN TOÀN
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
    const diff = tPress - xPress;
    if (Math.abs(diff) < 0.5) return null;
    if (diff > 0.5) return { code: 'T', name: 'GAP-T', conf: clamp(0.6 + diff * 0.05, 0.6, 0.82), score: diff };
    return { code: 'X', name: 'GAP-X', conf: clamp(0.6 + Math.abs(diff) * 0.05, 0.6, 0.82), score: Math.abs(diff) };
}

function algoSuffixMotif(seq) {
    const n = seq.length;
    if (n < 12) return null;
    const sam = buildSuffixAutomaton(seq.join(''));
    let state = 0, matched = 0;
    for (let i = n - 1; i >= 0; i--) {
        const ns = sam.next[state][seq[i]];
        if (ns === undefined) break;
        state = ns; matched++;
    }
    if (matched < 2) return null;
    const ctx = seq.slice(-matched).join('');
    let t = 0, x = 0;
    const s = seq.join('');
    for (let i = 0; i + matched < n; i++) {
        if (s.substr(i, matched) === ctx) {
            const nxt = seq[i + matched];
            if (nxt === 'T') t++; else if (nxt === 'X') x++;
        }
    }
    if (t + x < 3) return null;
    const pT = (t + 0.5) / (t + x + 1), pX = (x + 0.5) / (t + x + 1);
    const conf = Math.max(pT, pX);
    if (conf < 0.62) return null;
    return { code: pT > pX ? 'T' : 'X', name: `SAM-${matched}`, conf, score: conf * Math.log(matched + 1) };
}

function lzComplexity(str) {
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
function algoLZSimilarity(seq) {
    const n = seq.length;
    if (n < 20) return null;
    const tail = seq.slice(-8).join('');
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
    if (conf < 0.58) return null;
    return { code: pT > pX ? 'T' : 'X', name: 'LZ-SIM', conf, score: conf * cnt };
}

function algoMultiTF(seq) {
    const n = seq.length;
    if (n < 24) return null;
    const windows = [5, 10, 20];
    let tVotes = 0, xVotes = 0;
    for (const w of windows) {
        const s = seq.slice(-w);
        const t = s.filter(x => x === 'T').length;
        const pT = t / s.length;
        if (pT > 0.68) xVotes += 1;
        else if (pT < 0.32) tVotes += 1;
    }
    if (tVotes + xVotes < 2) return null;
    const code = tVotes > xVotes ? 'T' : 'X';
    const conf = clamp(0.62 + Math.abs(tVotes - xVotes) * 0.08, 0.62, 0.85);
    return { code, name: 'MULTI-TF', conf, score: Math.abs(tVotes - xVotes) };
}

function algoFractal(seq) {
    const n = seq.length;
    if (n < 30) return null;
    const scales = [4, 6, 8];
    let t = 0, x = 0, cnt = 0;
    for (const sc of scales) {
        if (n < sc * 2) continue;
        const lastBlk = seq.slice(-sc).join('');
        for (let i = 0; i + sc < n - sc; i += sc) {
            const blk = seq.slice(i, i + sc).join('');
            if (blk === lastBlk) {
                const nb = seq.slice(i + sc, i + sc * 2);
                if (nb.length === sc) {
                    const first = nb[0];
                    if (first === 'T') t++; else x++;
                    cnt++;
                }
            }
        }
    }
    if (cnt < 2) return null;
    const pT = (t + 0.5) / (cnt + 1), pX = (x + 0.5) / (cnt + 1);
    const conf = Math.max(pT, pX);
    if (conf < 0.62) return null;
    return { code: pT > pX ? 'T' : 'X', name: 'FRACTAL', conf, score: conf * cnt };
}

function algoSubsequence(seq) {
    const n = seq.length;
    if (n < 20) return null;
    const sub = [seq[n - 8], seq[n - 6], seq[n - 4], seq[n - 2]].join('');
    let t = 0, x = 0, cnt = 0;
    for (let i = 0; i + 9 < n; i++) {
        const s = [seq[i], seq[i + 2], seq[i + 4], seq[i + 6]].join('');
        if (s === sub) {
            const nxt = seq[i + 8];
            if (nxt === 'T') t++; else if (nxt === 'X') x++;
            cnt++;
        }
    }
    if (cnt < 2) return null;
    const pT = (t + 0.5) / (cnt + 1), pX = (x + 0.5) / (cnt + 1);
    const conf = Math.max(pT, pX);
    if (conf < 0.62) return null;
    return { code: pT > pX ? 'T' : 'X', name: 'SUBSEQ', conf, score: conf * cnt };
}

// ---------- 17. MIRROR (cầu gương) ----------
function algoMirror(seq) {
    const n = seq.length;
    if (n < 12) return null;
    // Cầu gương: nửa đầu của chuỗi gần đây = đảo của nửa sau
    for (let half = 3; half <= 6; half++) {
        if (n < half * 2 + 2) continue;
        const recent = seq.slice(-(half * 2));
        const first = recent.slice(0, half);
        const second = recent.slice(half);
        const firstFlip = first.map(flip).join('');
        const secondStr = second.join('');
        if (firstFlip === secondStr) {
            // Mirror hoàn hảo → predict = first của chu kỳ tiếp
            const pred = flip(seq[n - 1]);
            return { code: pred, name: `MIRROR-${half}`, conf: 0.7, score: half };
        }
    }
    return null;
}

// ---------- 18. PATTERN-Z (Zigzag 3+) ----------
function algoZigzag(seq) {
    const n = seq.length;
    if (n < 15) return null;
    // Đếm độ dài pattern zigzag: ABAB, ABCABC, ABCDABCD...
    for (let p = 2; p <= 6; p++) {
        if (n < p * 2 + 2) continue;
        let match = true;
        for (let i = n - p * 2; i < n - p; i++) {
            if (seq[i] !== seq[i + p]) { match = false; break; }
        }
        if (!match) continue;
        // pattern đúng → predict = seq[n - p]
        const pred = seq[n - p];
        return { code: pred, name: `ZIGZAG-${p}`, conf: 0.72, score: p };
    }
    return null;
}

// ========================================================================
// 8. REGISTRY
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
    { id: 'mtf', fn: algoMultiTF, base: 1.05, family: 'multi-tf' },
    { id: 'fractal', fn: algoFractal, base: 1.1, family: 'fractal' },
    { id: 'subseq', fn: algoSubsequence, base: 1.0, family: 'subseq' },
    { id: 'mirror', fn: algoMirror, base: 1.1, family: 'mirror' },
    { id: 'zigzag', fn: algoZigzag, base: 1.1, family: 'zigzag' }
];

// ========================================================================
// 9. MIRROR TEST — kiểm tra algo có thiên vị không
// ========================================================================
function mirrorTest(algoFn, seq, sums) {
    try {
        // Chạy algo với sequence gốc
        const orig = algoFn(seq, sums);
        // Chạy algo với sequence flip (T↔X)
        const flipped = algoFn(flipSeq(seq), sums);
        // Nếu 1 bên null và bên kia có → algo KHÔNG đối xứng → loại
        if ((orig === null) !== (flipped === null)) return { valid: false, reason: 'ASYMMETRIC_NULL' };
        if (!orig || !flipped) return { valid: true };
        // Nếu cả 2 cùng predict → phải là 2 code ĐỐI NHAU
        const expectedFlipped = flip(orig.code);
        if (flipped.code !== expectedFlipped) {
            return { valid: false, reason: 'ASYMMETRIC_CODE', orig: orig.code, flipped: flipped.code, expected: expectedFlipped };
        }
        return { valid: true };
    } catch (e) {
        return { valid: false, reason: 'ERROR' };
    }
}

// ========================================================================
// 10. WEIGHT
// ========================================================================
function getWeight(db, algoId, baseWeight) {
    const learned = db.weights[algoId];
    if (learned === undefined) return baseWeight;
    return clamp(baseWeight * learned, 0.3, 2.2);
}
function updateWeight(db, algoId, wasCorrect, lr = 0.03) {
    const cur = db.weights[algoId] ?? 1.0;
    db.weights[algoId] = clamp(cur + (wasCorrect ? lr : -lr), 0.3, 2.2);
}

// ========================================================================
// 11. CALIBRATION
// ========================================================================
function getCalibration(db, side, rawConf) {
    const list = db.calibration[side] || [];
    const bin = Math.round(rawConf * 20) / 20;
    const rec = list.find(c => c.bin === bin);
    if (!rec || rec.total < 8) return 1.0;
    const actualAcc = rec.correct / rec.total;
    return clamp(actualAcc / rawConf, 0.7, 1.2);
}
function updateCalibration(db, side, rawConf, wasCorrect) {
    if (!db.calibration[side]) db.calibration[side] = [];
    const bin = Math.round(rawConf * 20) / 20;
    let rec = db.calibration[side].find(c => c.bin === bin);
    if (!rec) { rec = { bin, total: 0, correct: 0 }; db.calibration[side].push(rec); }
    rec.total++;
    if (wasCorrect) rec.correct++;
    if (rec.total > 200) { rec.total = 200; rec.correct = Math.round(rec.correct * 0.95); }
    if (db.calibration[side].length > 40) db.calibration[side] = db.calibration[side].slice(-40);
}

// ========================================================================
// 12. BIAS AUDITOR RUNTIME
// ========================================================================
function auditBias(db) {
    // Lấy 20 phiên gần nhất
    const recent = (db.recentVotes || []).slice(-20);
    if (recent.length < 10) return { biased: false, action: 'NONE' };
    const t = recent.filter(v => v === 'T').length;
    const x = recent.filter(v => v === 'X').length;
    const ratio = Math.max(t, x) / recent.length;
    if (ratio >= 0.85) {
        return {
            biased: true,
            dominant: t > x ? 'T' : 'X',
            tCount: t, xCount: x,
            action: 'FORCE_REBALANCE',
            warning: `Model vote ${(ratio * 100).toFixed(0)}% về ${t > x ? 'Tài' : 'Xỉu'} trong ${recent.length} phiên gần nhất`
        };
    }
    if (ratio >= 0.75) {
        return {
            biased: true,
            dominant: t > x ? 'T' : 'X',
            tCount: t, xCount: x,
            action: 'SOFT_REBALANCE',
            warning: `Model vote ${(ratio * 100).toFixed(0)}% về ${t > x ? 'Tài' : 'Xỉu'}`
        };
    }
    return { biased: false, tCount: t, xCount: x, action: 'NONE' };
}

// ========================================================================
// 13. META ENGINE V6
// ========================================================================
function runMetaEngine(seq, sums, db, session) {
    const regime = detectRegime(seq);
    db.regime = regime;

    const votes = { T: 0, X: 0 };
    const details = [];
    const families = { T: new Set(), X: new Set() };
    const entropy30 = entropy(seq.slice(-30));
    const mirrorRejects = [];

    for (const algo of ALGO_REGISTRY) {
        // ============================================
        // MIRROR TEST: chỉ chấp nhận algo đối xứng
        // ============================================
        const test = mirrorTest(algo.fn, seq, sums);
        if (!test.valid) {
            mirrorRejects.push({ id: algo.id, reason: test.reason });
            continue; // BỎ QUA algo bias
        }

        let res = null;
        try { res = algo.fn(seq, sums, db); } catch (e) { res = null; }
        if (!res || !res.code) continue;

        const w = getWeight(db, algo.id, algo.base);
        let vote = (res.conf || 0.6) * w;
        const pen = entropy30 > 0.95 ? 0.7 : 1.0;

        // Regime bonus đối xứng
        let regimeBonus = 1.0;
        if (regime.regime === 'STREAKING' && (algo.family === 'streak' || algo.family === 'block')) regimeBonus = 1.2;
        if (regime.regime === 'BOUNCING' && (algo.family === 'bounce' || algo.family === 'cycle' || algo.family === 'zigzag')) regimeBonus = 1.2;
        if (regime.regime === 'CHAOTIC' && (algo.family === 'markov' || algo.family === 'ngram')) regimeBonus = 0.85;
        if (regime.regime === 'TRENDING' && (algo.family === 'motif' || algo.family === 'fractal' || algo.family === 'mirror')) regimeBonus = 1.15;

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
    let winner, confidence, pT, pX, gap, decisionPath;

    if (total < 0.01) {
        const h = crypto.createHash('md5').update(String(session)).digest();
        winner = (h[0] % 2 === 0) ? 'T' : 'X';
        pT = 0.5; pX = 0.5; gap = 0; confidence = 0.5;
        decisionPath = 'TIEBREAK-HASH';
    } else {
        pT = votes.T / total;
        pX = votes.X / total;
        gap = Math.abs(pT - pX);
        if (gap < 0.0001) {
            const h = crypto.createHash('md5').update(String(session)).digest();
            winner = (h[0] % 2 === 0) ? 'T' : 'X';
            confidence = 0.5;
            decisionPath = 'TIEBREAK-HASH';
        } else if (gap < 0.05) {
            winner = pT > pX ? 'T' : 'X';
            confidence = 0.5 + gap * 2;
            decisionPath = 'WEAK-GAP';
        } else {
            winner = pT > pX ? 'T' : 'X';
            confidence = Math.max(pT, pX);
            decisionPath = 'NORMAL';
        }
    }

    // ================================================================
    // BIAS AUDITOR: nếu model vote lệch > 75% trong 20 phiên → rebalance
    // ================================================================
    const biasAudit = auditBias(db);
    let biasForced = false;
    if (biasAudit.action === 'FORCE_REBALANCE' && winner === biasAudit.dominant) {
        // Đang bias + winner trùng với bên bias → ĐẢO (đối xứng: 1 lần đảo)
        winner = flip(winner);
        confidence = Math.max(0.5, confidence * 0.7); // Giảm confidence vì forced
        decisionPath = 'BIAS-REBALANCE';
        biasForced = true;
    } else if (biasAudit.action === 'SOFT_REBALANCE' && winner === biasAudit.dominant) {
        // Giảm confidence nhưng không đảo
        confidence = confidence * 0.85;
    }

    // Diversity bonus
    const winnerFamilies = families[winner].size;
    if (winnerFamilies >= 4) confidence = clamp(confidence + 0.04, 0, 0.92);
    if (winnerFamilies >= 6) confidence = clamp(confidence + 0.02, 0, 0.92);

    // Calibration
    const calib = getCalibration(db, winner, confidence);
    confidence = clamp(confidence * calib, 0, 0.92);

    // Anti-dominance
    const loser = flip(winner);
    const loserShare = total > 0 ? votes[loser] / total : 0.5;
    let antiDomPenalty = 1.0;
    if (loserShare > 0.35) antiDomPenalty = 0.92;
    if (loserShare > 0.42) antiDomPenalty = 0.85;
    confidence = clamp(confidence * antiDomPenalty, 0.5, 0.92);

    // Đánh dấu weak
    const isWeak = confidence < 0.62;
    const isVeryWeak = confidence < 0.55;

    const topAlgo = details.filter(d => d.code === winner).sort((a, b) => b.vote - a.vote)[0];
    let labelName;
    if (decisionPath === 'TIEBREAK-HASH') labelName = 'META·TIEBREAK';
    else if (decisionPath === 'BIAS-REBALANCE') labelName = `META·REBALANCE`;
    else if (isVeryWeak) labelName = `META·RẤT YẾU`;
    else if (isWeak) labelName = `META·YẾU${topAlgo ? '·' + topAlgo.name : ''}`;
    else labelName = topAlgo ? `META·${topAlgo.name}` : 'META';

    return {
        code: winner,
        label: labelName,
        tiLe: (confidence * 100).toFixed(1) + '%',
        details,
        regime,
        entropy: +entropy30.toFixed(3),
        diversity: winnerFamilies,
        weak: isWeak,
        veryWeak: isVeryWeak,
        decisionPath,
        biasForced,
        biasAudit,
        mirrorRejects,
        balance: {
            votesT: +votes.T.toFixed(2),
            votesX: +votes.X.toFixed(2),
            gap: +gap.toFixed(3),
            pT: +pT.toFixed(3),
            pX: +pX.toFixed(3),
            loserShare: +loserShare.toFixed(3)
        }
    };
}

// ========================================================================
// 14. UPDATE STATS
// ========================================================================
function updateAllStats(db, prevRecord, actual) {
    if (!prevRecord || !actual) return;
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
        updateWeight(db, d.algo, d.code === actual, 0.03);
    }
    if (prevRecord.DU_DOAN_CODE) {
        const side = prevRecord.DU_DOAN_CODE;
        const rawConf = parseFloat(String(prevRecord.TI_LE).replace('%', '')) / 100;
        if (Number.isFinite(rawConf)) updateCalibration(db, side, rawConf, side === actual);
    }
}

// ========================================================================
// 15. FETCH
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
// 16. PROCESS GAME
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

    const prev = db.history[db.history.length - 1];
    if (prev && safeInt(prev.phienDuDoan) === session) {
        const actual = getResult(latest);
        prev.ketQua = actual;
        prev.ketQuaLabel = label(actual);
        prev.trangThai = !prev.DU_DOAN_CODE ? 'BỎ QUA' : (prev.DU_DOAN_CODE === actual ? 'ĐÚNG' : 'SAI');
        updateAllStats(db, prev, actual);
    }

    const pred = runMetaEngine(seq, sums, db, session + 1);
    const regime = db.regime || { regime: 'UNKNOWN' };

    // Lưu vote gần đây để audit bias
    if (!db.recentVotes) db.recentVotes = [];
    if (pred.code) db.recentVotes.push(pred.code);
    if (db.recentVotes.length > 50) db.recentVotes = db.recentVotes.slice(-50);

    // Lưu bias log
    if (pred.biasForced && pred.biasAudit) {
        if (!db.biasLog) db.biasLog = [];
        db.biasLog.push({ ts: Date.now(), session, audit: pred.biasAudit });
        if (db.biasLog.length > 30) db.biasLog = db.biasLog.slice(-30);
    }

    db.history.push({
        phien: session,
        xucXac: getDice(latest),
        tong: getSum(latest),
        ketQua: getResult(latest),
        ketQuaLabel: label(getResult(latest)),
        phienDuDoan: session + 1,
        DU_DOAN_CODE: pred.code,
        DU_DOAN: pred.code ? label(pred.code) : null,
        TI_LE: pred.tiLe,
        patternName: pred.label,
        algoDetails: pred.details || [],
        entropy: pred.entropy,
        regime: regime.regime,
        diversity: pred.diversity || 0,
        balance: pred.balance || null,
        weak: pred.weak || false,
        veryWeak: pred.veryWeak || false,
        decisionPath: pred.decisionPath,
        biasForced: pred.biasForced || false,
        trangThai: 'ĐANG CHỜ'
    });

    if (db.history.length > 600) db.history.shift();
    db.lastProcessedSession = session;
    saveDB(game, db);
}

setInterval(() => { processGame('md5'); processGame('taixiu'); }, TICK_MS);

// ========================================================================
// 17. ROUTES
// ========================================================================
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family:sans-serif; padding:20px; background:#0a0e27; color:#e6eef6; min-height:100vh;">
            <h2 style="color:#22c55e;">🎯 META ENGINE V6 — ANTI-BIAS + 18 ALGOS</h2>
            <p>18 thuật toán · Mirror Test · Bias Auditor · Luôn dự đoán</p>
            <p style="color:#fbbf24;">⚠️ Không bao giờ chắc Tài/Xỉu — confidence ≤ 92%</p>
            <ul style="line-height:1.8;">
                <li><a href="/api/predict/md5" style="color:#60a5fa;">/api/predict/md5</a></li>
                <li><a href="/api/predict/taixiu" style="color:#60a5fa;">/api/predict/taixiu</a></li>
                <li><a href="/api/stats/md5" style="color:#60a5fa;">/api/stats/md5</a></li>
                <li><a href="/api/bias/md5" style="color:#60a5fa;">/api/bias/md5</a></li>
                <li><a href="/api/health" style="color:#60a5fa;">/api/health</a></li>
                <li><a href="/md5" style="color:#60a5fa;">/md5</a> · <a href="/taixiu" style="color:#60a5fa;">/taixiu</a></li>
            </ul>
        </div>
    `);
});

app.get('/api/health', (req, res) => {
    const out = {};
    for (const g of ['md5', 'taixiu']) {
        const db = readDB(g);
        const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
        const correct = settled.filter(h => h.trangThai === 'ĐÚNG').length;
        const recent = db.recentVotes || [];
        const t = recent.filter(v => v === 'T').length;
        const x = recent.filter(v => v === 'X').length;
        out[g] = {
            sessions: db.history.length,
            lastSession: db.lastProcessedSession,
            regime: db.regime?.regime || 'UNKNOWN',
            recentWR: settled.length ? +(correct / settled.length * 100).toFixed(1) : null,
            voteBalance: { T: t, X: x, ratio: recent.length ? +(Math.max(t, x) / recent.length).toFixed(2) : null }
        };
    }
    res.json({ ok: true, ts: Date.now(), status: out });
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
    const pred = runMetaEngine(seq, sums, db, session + 1);

    res.json({
        success: true,
        game, phien: session,
        xucXac: getDice(latest), tong: getSum(latest),
        ketQua: getResult(latest), ketQuaLabel: label(getResult(latest)),
        phienDuDoan: session + 1,
        duDoan: label(pred.code),
        duDoanCode: pred.code,
        tiLe: pred.tiLe,
        reason: pred.label,
        regime: pred.regime,
        entropy: pred.entropy,
        diversity: pred.diversity,
        weak: pred.weak,
        veryWeak: pred.veryWeak,
        decisionPath: pred.decisionPath,
        biasForced: pred.biasForced,
        biasAudit: pred.biasAudit,
        mirrorRejects: pred.mirrorRejects,
        balance: pred.balance,
        algoVotes: pred.details
    });
});

app.get('/api/bias/:game', (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.status(400).json({ success: false });
    const db = readDB(game);
    const audit = auditBias(db);
    const recent = (db.recentVotes || []).slice(-30);
    const t = recent.filter(v => v === 'T').length;
    const x = recent.filter(v => v === 'X').length;
    res.json({
        success: true, game,
        audit,
        recentVotes: { T: t, X: x, total: recent.length },
        biasLog: (db.biasLog || []).slice(-10),
        recentSequence: recent
    });
});

app.get('/api/stats/:game', (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.status(400).json({ success: false });
    const db = readDB(game);

    const stats = {};
    for (const id in db.algoStats) {
        const s = db.algoStats[id];
        stats[id] = {
            ...s,
            accuracy: s.total ? +(s.correct / s.total * 100).toFixed(1) : 0,
            weight: +(db.weights?.[id] ?? 1.0).toFixed(3)
        };
    }

    const recent = db.history.slice(-100);
    const settled = recent.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const correct = settled.filter(h => h.trangThai === 'ĐÚNG').length;
    const weak = recent.filter(h => h.weak).length;
    const veryWeak = recent.filter(h => h.veryWeak).length;

    const strongSettled = settled.filter(h => !h.weak);
    const weakSettled = settled.filter(h => h.weak);
    const strongWR = strongSettled.length ? (strongSettled.filter(h => h.trangThai === 'ĐÚNG').length / strongSettled.length * 100).toFixed(1) : null;
    const weakWR = weakSettled.length ? (weakSettled.filter(h => h.trangThai === 'ĐÚNG').length / weakSettled.length * 100).toFixed(1) : null;

    // Đếm dự đoán T vs X
    const predT = recent.filter(h => h.DU_DOAN_CODE === 'T').length;
    const predX = recent.filter(h => h.DU_DOAN_CODE === 'X').length;

    res.json({
        success: true, game,
        overall: {
            total: settled.length, correct,
            accuracy: settled.length ? +(correct / settled.length * 100).toFixed(1) : 0,
            weakCount: weak, veryWeakCount: veryWeak
        },
        split: { strongWR, weakWR, strongCount: strongSettled.length, weakCount: weakSettled.length },
        predictions: { T: predT, X: predX, balance: predT + predX ? +(Math.abs(predT - predX) / (predT + predX)).toFixed(2) : 0 },
        regime: db.regime,
        bias: auditBias(db),
        perAlgo: stats
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
                entropy: it.entropy, regime: it.regime, diversity: it.diversity,
                weak: it.weak, biasForced: it.biasForced, balance: it.balance
            }))
        };
    }
    res.json({ success: true, games: out });
});

// ========================================================================
// 18. WEB UI
// ========================================================================
app.get('/:game', (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.send('Trang không tồn tại');

    const db = readDB(game);
    const rows = db.history.slice(-50).reverse();
    const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const correct = settled.filter(h => h.trangThai === 'ĐÚNG').length;
    const accuracy = settled.length ? (correct / settled.length * 100).toFixed(1) : '0.0';

    const strongSettled = settled.filter(h => !h.weak);
    const weakSettled = settled.filter(h => h.weak);
    const strongWR = strongSettled.length ? (strongSettled.filter(h => h.trangThai === 'ĐÚNG').length / strongSettled.length * 100).toFixed(1) : '-';
    const weakWR = weakSettled.length ? (weakSettled.filter(h => h.trangThai === 'ĐÚNG').length / weakSettled.length * 100).toFixed(1) : '-';

    const regime = db.regime?.regime || 'UNKNOWN';
    const audit = auditBias(db);
    const recent = (db.recentVotes || []).slice(-30);
    const tCnt = recent.filter(v => v === 'T').length;
    const xCnt = recent.filter(v => v === 'X').length;

    const regimeColor = {
        STREAKING: '#f59e0b', BOUNCING: '#3b82f6', CHAOTIC: '#ef4444',
        TRENDING: '#22c55e', MIXED: '#94a3b8', UNKNOWN: '#64748b'
    }[regime] || '#64748b';

    const getBadge = (type) => {
        if (!type) return 'badge-default';
        if (/YẾU|TIEBREAK|REBALANCE/.test(type)) return 'badge-weak';
        if (/MIRROR/.test(type)) return 'badge-mirror';
        if (/ZIGZAG/.test(type)) return 'badge-zigzag';
        if (/BỆT|STREAK/.test(type)) return 'badge-bet';
        if (/MARKOV|NGRAM|TRANS/.test(type)) return 'badge-markov';
        if (/CYCLE|PALIN|FLIP/.test(type)) return 'badge-cycle';
        if (/SAM|LZ|MOTIF/.test(type)) return 'badge-motif';
        if (/MULTI|MTF/.test(type)) return 'badge-mtf';
        if (/FRACTAL/.test(type)) return 'badge-fractal';
        if (/SUBSEQ/.test(type)) return 'badge-subseq';
        return 'badge-default';
    };

    const html = `<!DOCTYPE html>
    <html lang="vi">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
    <title>META V6 - ${game.toUpperCase()}</title>
    <style>
      *{box-sizing:border-box}
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0e27;color:#e6eef6;padding:12px;margin:0;}
      .header{background:linear-gradient(135deg,#7c3aed,#3b82f6,#10b981);padding:16px;border-radius:14px;margin-bottom:14px;box-shadow:0 8px 24px rgba(124,58,237,.4);text-align:center;}
      h1{color:#fff;font-size:20px;margin:0;font-weight:800;text-transform:uppercase}
      .stat-line{margin-top:8px;font-size:13px;color:#fff}
      .split{display:flex;gap:8px;margin-top:8px;justify-content:center;font-size:12px}
      .split > div{background:rgba(0,0,0,.25);padding:6px 10px;border-radius:8px;}
      .regime{display:inline-block;padding:4px 10px;border-radius:6px;background:${regimeColor};color:#fff;font-weight:700;font-size:11px;margin-top:6px;}
      .balance{background:rgba(0,0,0,.25);padding:8px;border-radius:8px;margin-top:8px;font-size:12px}
      .balance-bar{display:inline-block;height:8px;border-radius:2px;vertical-align:middle;}
      .bias-warn{background:#7f1d1d;color:#fecaca;padding:8px;border-radius:8px;margin-top:8px;font-size:12px;}
      .bias-ok{background:#14532d;color:#bbf7d0;padding:8px;border-radius:8px;margin-top:8px;font-size:12px;}
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
      .ti-le.weak{color:#fbbf24;background:#78350f;padding:2px 6px;border-radius:4px;}
      .ti-le.veryweak{color:#fca5a5;background:#7f1d1d;padding:2px 6px;border-radius:4px;}
      .badge{display:inline-block;padding:4px 8px;border-radius:6px;font-size:10px;font-weight:700;white-space:nowrap;}
      .badge-bet{background:#78350f;color:#fcd34d}
      .badge-markov{background:#1e3a8a;color:#93c5fd}
      .badge-cycle{background:#1e40af;color:#93c5fd}
      .badge-motif{background:#134e4a;color:#5eead4}
      .badge-mtf{background:#7c2d12;color:#fdba74}
      .badge-fractal{background:#4c1d95;color:#c4b5fd}
      .badge-subseq{background:#0c4a6e;color:#7dd3fc}
      .badge-mirror{background:#831843;color:#f9a8d4}
      .badge-zigzag{background:#365314;color:#bef264}
      .badge-weak{background:#78350f;color:#fef3c7}
      .badge-default{background:#334155;color:#cbd5e1}
    </style>
    <script>setTimeout(()=>location.reload(), 10000);</script>
    </head>
    <body>
      <div class="header">
        <h1>🎯 META ENGINE V6 · ${game.toUpperCase()}</h1>
        <div class="stat-line">Tổng chính xác: <strong>${accuracy}%</strong> (${settled.length} phiên)</div>
        <div class="split">
          <div>🔥 Mạnh: <strong>${strongWR}%</strong> (${strongSettled.length})</div>
          <div>⚠️ Yếu: <strong>${weakWR}%</strong> (${weakSettled.length})</div>
        </div>
        <div class="regime">REGIME: ${regime}</div>
        <div class="balance">
          Vote 30 phiên: <strong style="color:#22c55e">Tài ${tCnt}</strong> ·
          <strong style="color:#ef4444">Xỉu ${xCnt}</strong>
          ${tCnt + xCnt ? `<span class="balance-bar" style="width:${tCnt / (tCnt + xCnt) * 100}px;background:#22c55e"></span><span class="balance-bar" style="width:${xCnt / (tCnt + xCnt) * 100}px;background:#ef4444"></span>` : ''}
        </div>
        ${audit.biased
            ? `<div class="bias-warn">⚠️ ${audit.warning}</div>`
            : `<div class="bias-ok">✅ Cân bằng · Không thiên vị</div>`}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>PHIÊN</th><th>XX</th><th>TỔNG</th><th>KQ</th><th>PHIÊN DĐ</th><th>DỰ ĐOÁN</th><th>TỈ LỆ</th><th>LOẠI CẦU</th><th>TT</th>
          </tr></thead>
          <tbody>
            ${rows.map(it => {
              const dice = (it.xucXac || []).join('-').replace(/-/g, '-<br>');
              const kqCls = it.ketQua === 'T' ? 'tai' : (it.ketQua === 'X' ? 'xiu' : '');
              const ddCls = it.DU_DOAN_CODE === 'T' ? 'tai' : (it.DU_DOAN_CODE === 'X' ? 'xiu' : 'cho');
              const ttCls = it.trangThai === 'ĐÚNG' ? 'dung' : (it.trangThai === 'SAI' ? 'sai' : 'cho');
              const ttText = it.trangThai === 'ĐANG CHỜ' ? '...' : (it.trangThai || '');
              const badgeCls = getBadge(it.patternName);
              const tiLeCls = it.veryWeak ? 'veryweak' : (it.weak ? 'weak' : '');
              return `<tr>
                <td class="session">${it.phien}</td><td class="dice">${dice}</td>
                <td><span class="sum">${it.tong || ''}</span></td><td class="${kqCls}">${it.ketQuaLabel || ''}</td>
                <td class="session">${it.phienDuDoan}</td><td class="${ddCls}">${it.DU_DOAN || ''}${it.biasForced ? ' 🔄' : ''}</td>
                <td><span class="ti-le ${tiLeCls}">${it.TI_LE}</span></td>
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
// 19. START
// ========================================================================
app.listen(PORT, () => console.log(`🎯 META ENGINE V6 chạy port ${PORT}`));
