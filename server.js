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

// ========================================================================
// 0. UTILS
// ========================================================================
function safeInt(x, def = 0) { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
const label = c => c === 'T' ? 'TÀI' : (c === 'X' ? 'XỈU' : null);
const flip = c => c === 'T' ? 'X' : (c === 'X' ? 'T' : null);
function entropy(arr) {
    const f = {}; for (const x of arr) f[x] = (f[x] || 0) + 1;
    let h = 0; const n = arr.length;
    for (const k in f) { const p = f[k] / n; if (p > 0) h -= p * Math.log2(p); }
    return h;
}

// ========================================================================
// 1. DATABASE LAYER (Lưu lịch sử + trọng số học của TỪNG cầu)
// ========================================================================
function dbPath(g) { return path.join(DB_DIR, `db_v15_${g}.json`); }
function readDB(g) {
    const p = dbPath(g);
    try {
        if (fs.existsSync(p)) {
            const db = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (!db.weights) db.weights = {};
            if (!db.streakStats) db.streakStats = { T: {}, X: {} };
            if (!db.history) db.history = [];
            return db;
        }
    } catch (e) {}
    return { history: [], lastProcessedSession: null, weights: {}, streakStats: { T: {}, X: {} } };
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

// Cập nhật phân phối độ dài bệt (học có điều kiện cho cầu bệt)
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
// 2. SINH TOÀN BỘ CẦU (200+ VARIANTS - 15 HỌ)
// ========================================================================
function generateAllPatterns() {
    const A = [];

    // ------------------------------------------------------------------
    // FAMILY 1: BỆT (STREAK) — kết hợp thống kê cont/stop
    // ------------------------------------------------------------------
    for (let minLen = 2; minLen <= 8; minLen++) {
        A.push({
            id: `streak_learn_${minLen}`, base: 1.5,
            fn: (seq, db) => {
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
    // Bệt thuần
    for (let minLen = 3; minLen <= 8; minLen++) {
        A.push({
            id: `streak_pure_${minLen}`, base: 1.2,
            fn: (seq) => {
                const n = seq.length, last = seq[n - 1]; let len = 1;
                for (let i = n - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
                if (len >= minLen) return { code: last, name: `BỆT-THUẦN-${len}`, conf: 0.65 };
                return null;
            }
        });
    }

    // ------------------------------------------------------------------
    // FAMILY 2: ĐẢO 1-1 (BOUNCE)
    // ------------------------------------------------------------------
    for (let win = 4; win <= 10; win++) {
        A.push({
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

    // ------------------------------------------------------------------
    // FAMILY 3: ZIGZAG (A-B-A-B)
    // ------------------------------------------------------------------
    for (let p = 2; p <= 8; p++) {
        A.push({
            id: `zigzag_${p}`, base: 1.3,
            fn: (seq) => {
                const n = seq.length; if (n < p * 2 + 2) return null;
                let ok = true;
                for (let i = n - p * 2; i < n - p; i++) if (seq[i] !== seq[i + p]) { ok = false; break; }
                if (ok) return { code: seq[n - p], name: `ZIGZAG-${p}`, conf: 0.72 };
                return null;
            }
        });
    }

    // ------------------------------------------------------------------
    // FAMILY 4: GƯƠNG (MIRROR)
    // ------------------------------------------------------------------
    for (let half = 3; half <= 8; half++) {
        A.push({
            id: `mirror_${half}`, base: 1.3,
            fn: (seq) => {
                const n = seq.length; if (n < half * 2 + 2) return null;
                const rec = seq.slice(-(half * 2));
                if (rec.slice(0, half).map(flip).join('') === rec.slice(half).join('')) return { code: flip(seq[n - 1]), name: `GƯƠNG-${half}`, conf: 0.7 };
                return null;
            }
        });
    }

    // ------------------------------------------------------------------
    // FAMILY 5: N-GRAM
    // ------------------------------------------------------------------
    for (let len = 3; len <= 10; len++) {
        A.push({
            id: `ngram_${len}`, base: 1.4,
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
    // N-Gram Skip (lấy cách quãng)
    for (let len = 3; len <= 6; len++) {
        A.push({
            id: `ngram_skip_${len}`, base: 1.2,
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

    // ------------------------------------------------------------------
    // FAMILY 6: MARKOV BẬC K
    // ------------------------------------------------------------------
    for (let k = 2; k <= 10; k++) {
        A.push({
            id: `markov_${k}`, base: 1.5,
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

    // ------------------------------------------------------------------
    // FAMILY 7: CHU KỲ (CYCLE)
    // ------------------------------------------------------------------
    for (let p = 2; p <= 20; p++) {
        A.push({
            id: `cycle_${p}`, base: 1.2,
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

    // ------------------------------------------------------------------
    // FAMILY 8: GAP (KHOẢNG CÁCH)
    // ------------------------------------------------------------------
    for (let th = 0.5; th <= 1.5; th += 0.15) {
        A.push({
            id: `gap_${th.toFixed(2)}`, base: 1.1,
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

    // ------------------------------------------------------------------
    // FAMILY 9: FRACTAL (KHỐI LẶP)
    // ------------------------------------------------------------------
    for (let sc = 3; sc <= 9; sc++) {
        A.push({
            id: `fractal_${sc}`, base: 1.3,
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

    // ------------------------------------------------------------------
    // FAMILY 10: MOMENTUM ĐA KHUNG
    // ------------------------------------------------------------------
    for (let w = 5; w <= 25; w += 3) {
        A.push({
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

    // ------------------------------------------------------------------
    // FAMILY 11: PULL (KÉO CÂN BẰNG)
    // ------------------------------------------------------------------
    for (let w = 20; w <= 60; w += 5) {
        A.push({
            id: `pull_${w}`, base: 1.0,
            fn: (seq) => {
                const n = seq.length; if (n < w) return null;
                const rec = seq.slice(-w), pT = rec.filter(x => x === 'T').length / w;
                if (pT >= 0.6) return { code: 'X', name: `KÉO-CB-X-${w}`, conf: clamp(0.52 + (pT - 0.6), 0.52, 0.75) };
                if (pT <= 0.4) return { code: 'T', name: `KÉO-CB-T-${w}`, conf: clamp(0.52 + (0.4 - pT), 0.52, 0.75) };
                return null;
            }
        });
    }

    // ------------------------------------------------------------------
    // FAMILY 12: SUM PATTERN
    // ------------------------------------------------------------------
    for (let w = 10; w <= 30; w += 5) {
        A.push({
            id: `sum_${w}`, base: 1.0,
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

    // ------------------------------------------------------------------
    // FAMILY 13: CUSUM (PHÁT HIỆN GÃY XU HƯỚNG)
    // ------------------------------------------------------------------
    for (let w = 10; w <= 30; w += 5) {
        for (let th = 3; th <= 6; th += 1) {
            A.push({
                id: `cusum_${w}_${th}`, base: 1.2,
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

    // ------------------------------------------------------------------
    // FAMILY 14: BAYESIAN TRANSITION (chuyển đổi 2 bước)
    // ------------------------------------------------------------------
    for (let k = 2; k <= 5; k++) {
        A.push({
            id: `bayes_${k}`, base: 1.4,
            fn: (seq) => {
                const n = seq.length; if (n < k + 10) return null;
                const key = seq.slice(-k).join('');
                let t = 0, x = 0;
                for (let i = k; i < n; i++) {
                    if (seq.slice(i - k, i).join('') === key) {
                        if (seq[i] === 'T') t++; else x++;
                    }
                }
                const tot = t + x;
                if (tot < 4) return null;
                // Bayesian smoothing
                const pT = (t + 1) / (tot + 2);
                const conf = Math.max(pT, 1 - pT);
                if (conf < 0.62) return null;
                return { code: pT > 0.5 ? 'T' : 'X', name: `BAYES-${k}`, conf };
            }
        });
    }

    // ------------------------------------------------------------------
    // FAMILY 15: TRANSITION MATRIX TOÀN CỤC
    // ------------------------------------------------------------------
    for (let w = 30; w <= 100; w += 20) {
        A.push({
            id: `transmat_${w}`, base: 1.0,
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
console.log(`✅ Đã sinh ${ALL_ALGOS.length} cầu`);

// ========================================================================
// 3. META ENGINE — VOTING CÓ TRỌNG SỐ HỌC
// ========================================================================
function runMetaEngine(seq, sums, db) {
    const votes = { T: 0, X: 0 };
    const details = [];

    for (const algo of ALL_ALGOS) {
        let res = null;
        try { res = algo.fn(seq, sums, db); } catch (e) { res = null; }
        if (!res || !res.code) continue;

        const learnedW = db.weights?.[algo.id] || 1.0;
        const w = clamp(algo.base * learnedW, 0.3, 3.5);
        const vote = res.conf * w;
        votes[res.code] += vote;
        details.push({ algo: algo.id, code: res.code, name: res.name, conf: +res.conf.toFixed(2), vote: +vote.toFixed(2) });
    }

    const total = votes.T + votes.X;
    let winner, confidence, patternName;
    let consensus = 0;

    if (total < 0.01) {
        // Không có cầu → dùng Kéo Cân Bằng thuần theo dữ liệu (KHÔNG random)
        const rec = seq.slice(-20);
        const tC = rec.filter(x => x === 'T').length;
        winner = tC <= rec.length / 2 ? 'T' : 'X';
        confidence = 0.51;
        patternName = 'CÂN-BẰNG-MẶC-ĐỊNH';
        details.push({ algo: 'default_pull', code: winner, name: patternName, conf: 0.51, vote: 1 });
        consensus = 1;
    } else {
        const pT = votes.T / total, pX = votes.X / total;
        winner = pT > pX ? 'T' : 'X';
        confidence = Math.max(pT, pX);

        const topAlgo = details.filter(d => d.code === winner).sort((a, b) => b.vote - a.vote)[0];
        patternName = topAlgo ? topAlgo.name : 'META-V15';
        consensus = details.filter(d => d.code === winner).length;
        if (consensus >= 15) patternName += ` (${consensus} cầu)`;
    }

    confidence = clamp(confidence, 0.50, 0.85);
    const isWeak = confidence < 0.58;
    const isVeryWeak = confidence <= 0.52;

    return { code: winner, label: patternName, tiLe: (confidence * 100).toFixed(1) + '%', details, weak: isWeak, veryWeak: isVeryWeak, consensus };
}

// ========================================================================
// 4. HỌC ONLINE — CẬP NHẬT TRỌNG SỐ TỪNG CẦU
// ========================================================================
function updateOnlineLearning(db, prev, actual) {
    if (!prev || !actual) return;
    if (!db.weights) db.weights = {};
    for (const d of (prev.algoDetails || [])) {
        const cur = db.weights[d.algo] ?? { w: 1.0, win: 0, lose: 0, streak: 0 };
        const correct = (d.code === actual);
        if (correct) { cur.win++; cur.streak = Math.max(0, cur.streak) + 1; }
        else { cur.lose++; cur.streak = Math.min(0, cur.streak) - 1; }

        // Bayesian confidence
        const p = (cur.win + 1) / (cur.win + cur.lose + 2);
        // Decay để tránh cầu lỗi thời
        const decay = 0.995;
        // Streak bonus
        const streakBonus = cur.streak >= 3 ? 0.05 : (cur.streak <= -3 ? -0.05 : 0);
        // Trọng số cuối = base * bayes * decay + streak bonus
        cur.w = clamp((p * 2) * decay + streakBonus, 0.2, 3.5);
        db.weights[d.algo] = cur;
    }
}

// ========================================================================
// 5. FETCH API
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
// 6. XỬ LÝ CHÍNH
// ========================================================================
async function processGame(game) {
    const list = await fetchApi(game === 'md5' ? API_MD5 : API_TX);
    if (!list || !list.length) return;
    const latest = list[list.length - 1], session = safeInt(latest.SessionId), db = readDB(game);
    if (db.lastProcessedSession === session) return;

    const seq = list.map(getResult).filter(Boolean);
    const sums = list.map(getSum).filter(s => s >= 3 && s <= 18);
    if (seq.length < 20) return;

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

    // Dự đoán
    const pred = runMetaEngine(seq, sums, db);

    db.history.push({
        phien: session, xucXac: getDice(latest), tong: getSum(latest),
        ketQua: getResult(latest), ketQuaLabel: label(getResult(latest)),
        phienDuDoan: session + 1, DU_DOAN_CODE: pred.code, DU_DOAN: label(pred.code),
        TI_LE: pred.tiLe, patternName: pred.label, algoDetails: pred.details,
        weak: pred.weak, veryWeak: pred.veryWeak, consensus: pred.consensus,
        trangThai: 'ĐANG CHỜ'
    });

    if (db.history.length > 1000) db.history.shift();
    db.lastProcessedSession = session;
    saveDB(game, db);
}

setInterval(() => { processGame('md5'); processGame('taixiu'); }, TICK_MS);

// ========================================================================
// 7. API JSON
// ========================================================================
app.get('/', (req, res) => res.redirect('/md5'));

app.get('/api/predict/:game', async (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.status(400).json({ status: "error", message: "Game không hợp lệ" });

    const list = await fetchApi(game === 'md5' ? API_MD5 : API_TX);
    if (!list || !list.length) return res.status(500).json({ status: "error", message: "Không lấy được dữ liệu" });

    const latest = list[list.length - 1], session = safeInt(latest.SessionId);
    const seq = list.map(getResult).filter(Boolean);
    const sums = list.map(getSum).filter(s => s >= 3 && s <= 18);
    const db = readDB(game);
    const pred = runMetaEngine(seq, sums, db);

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
        status: "success",
        data: {
            phienHienTai: String(session),
            phienDuDoan: String(session + 1),
            duDoan: pred.code,
            tiLe: pred.tiLe,
            liDo: `Model chọn ${label(pred.code)} (${pred.label} - Xác suất: ${pred.tiLe})`,
            xucXac: getDice(latest),
            tongDiem: getSum(latest),
            chiTietModel: {
                pattern: pred.label,
                vua: pred.tiLe,
                ppm: pred.weak ? "YẾU" : "MẠNH",
                learner: `${pred.consensus} cầu`,
                cusumGay: pred.veryWeak ? "CÓ" : "KHÔNG"
            },
            thongKe: {
                win: correct,
                lose: settled.length - correct,
                winrate: winrate,
                bankroll: bankroll + "$",
                maxDD: maxDD + "$"
            }
        }
    });
});

// ========================================================================
// 8. UI
// ========================================================================
app.get('/:game', (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.send('Trang không tồn tại');
    const db = readDB(game), rows = db.history.slice(-80).reverse();
    const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const correct = settled.filter(h => h.trangThai === 'ĐÚNG').length;
    const acc = settled.length ? (correct / settled.length * 100).toFixed(1) : '0.0';
    const strong = settled.filter(h => !h.weak), weak = settled.filter(h => h.weak);
    const sWR = strong.length ? (strong.filter(h => h.trangThai === 'ĐÚNG').length / strong.length * 100).toFixed(1) : '-';
    const wWR = weak.length ? (weak.filter(h => h.trangThai === 'ĐÚNG').length / weak.length * 100).toFixed(1) : '-';

    const html = `<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>META V15 - ${game.toUpperCase()}</title>
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
</head><body>
<div class="header">
  <h1>META V15 · ${game.toUpperCase()}</h1>
  <div class="stat">Chính xác: <strong>${acc}%</strong> (${settled.length} phiên)</div>
  <div class="split">
    <div>🔥 Mạnh: <strong>${sWR}%</strong> (${strong.length})</div>
    <div>⚠️ Yếu: <strong>${wWR}%</strong> (${weak.length})</div>
  </div>
</div>
<div class="table-wrap"><table>
<thead><tr><th>PHIÊN</th><th>XX</th><th>TỔNG</th><th>KQ</th><th>DỰ ĐOÁN</th><th>TỈ LỆ</th><th>LOẠI CẦU</th><th>TT</th></tr></thead>
<tbody>
${rows.map(it => {
    const dice = (it.xucXac || []).join('-');
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
</tbody></table></div>
</body></html>`;
    res.send(html);
});

app.listen(PORT, () => console.log(`🚀 META V15 - ${ALL_ALGOS.length} cầu - port ${PORT}`));
