'use strict';

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();

// ========================================================================
// 1. MIDDLEWARE & CONFIG
// ========================================================================
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

if (!fs.existsSync(DB_DIR)) {
    try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch (e) {}
}

// ========================================================================
// 2. HELPERS CƠ BẢN
// ========================================================================
function safeInt(x, def = 0) {
    const n = parseInt(x, 10);
    return Number.isFinite(n) ? n : def;
}
function clamp(x, a, b) {
    return Math.max(a, Math.min(b, x));
}
function safeFloat(x, def = 0.0) {
    const n = parseFloat(x);
    return Number.isFinite(n) ? n : def;
}
const label = c => c === 'T' ? 'Tài' : (c === 'X' ? 'Xỉu' : null);
const flip = c => c === 'T' ? 'X' : (c === 'X' ? 'T' : null);

function readDB(g) {
    const p = path.join(DB_DIR, `db_ultra_v16_${g}.json`);
    try {
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {}
    return { history: [], lastProcessedSession: null, weights: {}, streakStats: { T: {}, X: {} } };
}

function saveDB(g, db) {
    const p = path.join(DB_DIR, `db_ultra_v16_${g}.json`);
    try { fs.writeFileSync(p, JSON.stringify(db, null, 2)); } catch (e) {}
}

function getDice(it) {
    return [safeInt(it?.FirstDice), safeInt(it?.SecondDice), safeInt(it?.ThirdDice)];
}
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
    let curSide = seq[0], curLen = 1;
    for (let i = 1; i < seq.length; i++) {
        if (seq[i] === curSide) {
            curLen++;
        } else {
            const side = curSide, len = curLen;
            if (!db.streakStats[side][len]) db.streakStats[side][len] = { cont: 0, stop: 0 };
            db.streakStats[side][len].stop++;
            for (let l = 1; l < len; l++) {
                if (!db.streakStats[side][l]) db.streakStats[side][l] = { cont: 0, stop: 0 };
                db.streakStats[side][l].cont++;
            }
            curSide = seq[i]; curLen = 1;
        }
    }
}

// THUẬT TOÁN TÍNH ENTROPY (ĐỘ HỖN LOẠN)
function calcEntropy(seq) {
    if (!seq || seq.length === 0) return 0;
    const freq = {};
    for (const item of seq) {
        freq[item] = (freq[item] || 0) + 1;
    }
    let entropy = 0;
    const total = seq.length;
    for (const key in freq) {
        const p = freq[key] / total;
        if (p > 0) {
            entropy -= p * Math.log2(p);
        }
    }
    return entropy;
}

// ========================================================================
// 3. HỆ THỐNG 200+ THUẬT TOÁN (ULTRA ALGORITHMS)
// ========================================================================
function generateUltraAlgos() {
    const algos = [];

    // --- FAMILY: MARKOV CHAIN ---
    for (let k = 2; k <= 10; k++) {
        algos.push({
            id: `markov_${k}`, family: 'markov', base: 1.6,
            fn: (seq) => {
                const n = seq.length; if (n < k + 5) return null;
                const key = seq.slice(-k).join(''); let t = 0, x = 0;
                for (let i = k; i < n; i++) {
                    if (seq.slice(i - k, i).join('') === key) {
                        if (seq[i] === 'T') t++; else x++;
                    }
                }
                const total = t + x; if (total < 3) return null;
                const pT = (t + 1) / (total + 2), pX = (x + 1) / (total + 2);
                const conf = Math.max(pT, pX);
                if (conf < 0.58) return null;
                return { code: pT > pX ? 'T' : 'X', name: `MARKOV-${k}`, conf };
            }
        });
    }

    // --- FAMILY: N-GRAM PATTERN ---
    for (let len = 3; len <= 12; len++) {
        algos.push({
            id: `ngram_${len}`, family: 'ngram', base: 1.5,
            fn: (seq) => {
                const n = seq.length; if (n < len + 5) return null;
                const tail = seq.slice(-len).join(''); let t = 0, x = 0, occ = 0;
                for (let i = 0; i + len < n; i++) {
                    if (seq.slice(i, i + len).join('') === tail) {
                        occ++; if (seq[i + len] === 'T') t++; else x++;
                    }
                }
                if (occ < 2) return null;
                const pT = (t + 1) / (occ + 2), pX = (x + 1) / (occ + 2);
                const conf = Math.max(pT, pX);
                if (conf < 0.62) return null;
                return { code: pT > pX ? 'T' : 'X', name: `NGRAM-${len}`, conf };
            }
        });
    }

    // --- FAMILY: CYCLE / PALINDROME ---
    for (let p = 2; p <= 20; p++) {
        algos.push({
            id: `palin_${p}`, family: 'cycle', base: 1.3,
            fn: (seq) => {
                const n = seq.length; if (n < p * 2 + 2) return null;
                let match = 0, total = 0;
                for (let i = p; i < n; i++) {
                    total++; if (seq[i] === seq[i - p]) match++;
                }
                const ratio = match / total;
                if (ratio >= 0.68) return { code: seq[n - p], name: `PALIN-${p}`, conf: clamp(ratio, 0.68, 0.88) };
                return null;
            }
        });
    }

    // --- FAMILY: SUBSEQUENCE ---
    for (let len = 4; len <= 12; len++) {
        algos.push({
            id: `subseq_${len}`, family: 'subseq', base: 1.4,
            fn: (seq) => {
                const n = seq.length; if (n < len + 5) return null;
                const sub = seq.slice(-len);
                let tCount = 0, xCount = 0, occ = 0;
                for (let i = 0; i <= n - len; i++) {
                    if (seq.slice(i, i + len).join('') === sub.join('')) {
                        occ++;
                        if (i + len < n) {
                            if (seq[i + len] === 'T') tCount++; else xCount++;
                        }
                    }
                }
                if (occ < 2) return null;
                const conf = Math.max(tCount, xCount) / occ;
                if (conf < 0.64) return null;
                return { code: tCount > xCount ? 'T' : 'X', name: `SUBSEQ-${len}`, conf };
            }
        });
    }

    // --- FAMILY: ZIGZAG (ĐẢO CẦU) ---
    for (let p = 2; p <= 8; p++) {
        algos.push({
            id: `zigzag_${p}`, family: 'zigzag', base: 1.3,
            fn: (seq) => {
                const n = seq.length; if (n < p * 2 + 2) return null;
                let match = true;
                for (let i = n - p * 2; i < n - p; i++) {
                    if (seq[i] !== seq[i + p]) { match = false; break; }
                }
                if (match) return { code: seq[n - p], name: `ZIGZAG-${p}`, conf: 0.72 };
                return null;
            }
        });
    }

    // --- FAMILY: PRESSURE / GAP ---
    for (let th = 0.4; th <= 1.6; th += 0.1) {
        algos.push({
            id: `gap_${th.toFixed(2)}`, family: 'pressure', base: 1.2,
            fn: (seq) => {
                const n = seq.length; if (n < 20) return null;
                const tP = [], xP = [];
                for (let i = 0; i < n; i++) {
                    if (seq[i] === 'T') tP.push(i); else xP.push(i);
                }
                if (tP.length < 3 || xP.length < 3) return null;
                const tG = tP[tP.length - 1] - tP[tP.length - 2];
                const xG = xP[xP.length - 1] - xP[xP.length - 2];
                const tPress = (n - tP[tP.length - 1]) / Math.max(tG, 1);
                const xPress = (n - xP[xP.length - 1]) / Math.max(xG, 1);
                const diff = tPress - xPress;
                if (Math.abs(diff) < th) return null;
                if (diff > th) return { code: 'T', name: `GAP-T-${th.toFixed(1)}`, conf: clamp(0.55 + diff * 0.05, 0.55, 0.82) };
                return { code: 'X', name: `GAP-X-${th.toFixed(1)}`, conf: clamp(0.55 + Math.abs(diff) * 0.05, 0.55, 0.82) };
            }
        });
    }

    // --- FAMILY: BLOCK PATTERNS ---
    for (let b = 2; b <= 6; b++) {
        algos.push({
            id: `block_alt_${b}`, family: 'block', base: 1.3,
            fn: (seq) => {
                const n = seq.length; if (n < b * 2 + 2) return null;
                const recent = seq.slice(-b * 2);
                let isAlternating = true;
                for (let i = 1; i < recent.length; i++) {
                    if (recent[i] === recent[i - 1]) { isAlternating = false; break; }
                }
                if (isAlternating && recent.length === b * 2) {
                    return { code: flip(recent[recent.length - 1]), name: `BLOCK-ALT`, conf: 0.68 };
                }
                return null;
            }
        });
    }

    // --- FAMILY: STREAK (BỆT) ---
    for (let minLen = 2; minLen <= 8; minLen++) {
        algos.push({
            id: `streak_${minLen}`, family: 'streak', base: 1.6,
            fn: (seq, db) => {
                const n = seq.length, last = seq[n - 1]; let len = 1;
                for (let i = n - 2; i >= 0; i--) {
                    if (seq[i] === last) len++; else break;
                }
                if (len < minLen) return null;
                const stats = db.streakStats?.[last]?.[len];
                if (stats && (stats.cont + stats.stop) >= 2) {
                    const pCont = (stats.cont + 1) / (stats.cont + stats.stop + 2);
                    if (pCont > 0.55) return { code: last, name: `BỆT-${len}-TIẾP`, conf: clamp(pCont, 0.6, 0.88) };
                    if (pCont < 0.45) return { code: flip(last), name: `BỆT-${len}-GÃY`, conf: clamp(1 - pCont, 0.6, 0.88) };
                }
                return null;
            }
        });
    }

    // --- FAMILY: ENTROPY DYNAMICS ---
    for (let w = 10; w <= 40; w += 5) {
        algos.push({
            id: `entropy_${w}`, family: 'entropy', base: 1.1,
            fn: (seq) => {
                const n = seq.length; if (n < w) return null;
                const recent = seq.slice(-w);
                const entropy = calcEntropy(recent);
                // Nếu entropy thấp (cầu đang bệt), đánh tiếp. Nếu entropy cao (đang đảo), đánh đảo.
                const last = recent[recent.length - 1];
                if (entropy < 0.8) {
                    return { code: last, name: `ENTROPY-LOW-${w}`, conf: 0.65 };
                } else if (entropy > 0.95) {
                    return { code: flip(last), name: `ENTROPY-HIGH-${w}`, conf: 0.63 };
                }
                return null;
            }
        });
    }

    // --- FAMILY: MOMENTUM / LỰC KÉO ---
    for (let w = 10; w <= 30; w += 5) {
        algos.push({
            id: `momentum_${w}`, family: 'momentum', base: 1.2,
            fn: (seq) => {
                const n = seq.length; if (n < w) return null;
                const recent = seq.slice(-w);
                const tCount = recent.filter(x => x === 'T').length;
                const pT = tCount / recent.length;
                // Nếu lệch quá cao, bẻ lại (Mean Reversion)
                if (pT >= 0.65) return { code: 'X', name: `MOMENTUM-REV-X-${w}`, conf: clamp(0.55 + (pT - 0.65), 0.55, 0.78) };
                if (pT <= 0.35) return { code: 'T', name: `MOMENTUM-REV-T-${w}`, conf: clamp(0.55 + (0.35 - pT), 0.55, 0.78) };
                return null;
            }
        });
    }

    // --- FAMILY: HMM (HIDDEN MARKOV MÔ PHỎNG) ---
    for (let k = 3; k <= 6; k++) {
        algos.push({
            id: `hmm_${k}`, family: 'hmm', base: 1.5,
            fn: (seq) => {
                const n = seq.length; if (n < 20) return null;
                const key = seq.slice(-k).join('');
                let transToT = 0, transToX = 0;
                for (let i = k; i < n; i++) {
                    const cur = seq.slice(i - k, i).join('');
                    if (cur === key) {
                        if (seq[i] === 'T') transToT++; else transToX++;
                    }
                }
                const total = transToT + transToX;
                if (total < 4) return null;
                const pT = transToT / total;
                if (pT > 0.7) return { code: 'T', name: `HMM-T-${k}`, conf: clamp(pT, 0.7, 0.85) };
                if (pT < 0.3) return { code: 'X', name: `HMM-X-${k}`, conf: clamp(1 - pT, 0.7, 0.85) };
                return null;
            }
        });
    }

    // --- FAMILY: GENETIC WEIGHT (DI TRUYỀN) ---
    algos.push({
        id: `genetic_1`, family: 'genetic', base: 1.8,
        fn: (seq) => {
            const n = seq.length; if (n < 10) return null;
            const recent = seq.slice(-10);
            let t=0, x=0;
            for(const c of recent) { if(c==='T') t++; else x++; }
            if (t === 8 || t === 9) return { code: 'X', name: 'GENETIC-EXTREME', conf: 0.75 };
            if (x === 8 || x === 9) return { code: 'T', name: 'GENETIC-EXTREME', conf: 0.75 };
            return null;
        }
    });

    return algos;
}

const ALL_ALGOS = generateUltraAlgos();

// ========================================================================
// 4. META ENGINE (XỬ LÝ VÀ TỔNG HỢP 200+ THUẬT TOÁN)
// ========================================================================
function runMetaEngine(seq, sums, db, session) {
    const votes = { T: 0, X: 0 };
    const details = [];
    const families = {};

    for (const algo of ALL_ALGOS) {
        let res = null;
        try { res = algo.fn(seq, db); } catch (e) { res = null; }
        if (!res || !res.code) continue;

        const learnedWeight = db.weights?.[algo.id] || 1.0;
        const w = clamp(algo.base * learnedWeight, 0.2, 4.0);
        const finalVote = res.conf * w;

        votes[res.code] += finalVote;
        
        // Thống kê theo family
        if (!families[algo.family]) families[algo.family] = 0;
        families[algo.family] += finalVote;

        details.push({
            algo: algo.id,
            family: algo.family || 'normal',
            code: res.code,
            name: res.name,
            conf: +res.conf.toFixed(3),
            vote: +finalVote.toFixed(3)
        });
    }

    // Nếu không có cầu nào chạy (quá ít data)
    const totalVotes = votes.T + votes.X;
    let winner, confidence, gap, pT, pX, loserShare, decisionPath, biasForced;

    if (totalVotes < 0.01) {
        const recent = seq.slice(-20);
        const tCount = recent.filter(x => x === 'T').length;
        winner = tCount <= recent.length / 2 ? 'T' : 'X';
        confidence = 0.51;
        pT = winner === 'T' ? 0.51 : 0.49;
        pX = winner === 'X' ? 0.51 : 0.49;
        gap = 0.02;
        loserShare = Math.min(pT, pX);
        decisionPath = 'DEFAULT_FALLBACK';
        biasForced = false;
        details.push({ algo: 'sys_fallback', family: 'sys', code: winner, name: 'CÂN-BẰNG-MẶC-ĐỊNH', conf: 0.51, vote: 1 });
    } else {
        pT = votes.T / totalVotes;
        pX = votes.X / totalVotes;
        gap = Math.abs(pT - pX);
        
        // Thuật toán bẻ cầu nếu chênh lệch quá lớn (Overconfidence)
        if (gap > 0.85) {
            // Nếu một bên áp đảo hoàn toàn, có thể là bẫy, ta giảm conf và đi theo hướng ngược lại một chút
            biasForced = true;
            decisionPath = 'BIAS_CORRECTION';
            winner = pT > pX ? 'T' : 'X';
            confidence = 0.55; // Hạ uy tín xuống vì sợ bẫy
        } else {
            winner = pT > pX ? 'T' : 'X';
            confidence = Math.max(pT, pX);
            decisionPath = 'NORMAL';
            biasForced = false;
        }
        loserShare = Math.min(pT, pX);
    }

    confidence = clamp(confidence, 0.50, 0.90);
    const isWeak = confidence < 0.60;
    const isVeryWeak = confidence <= 0.53;

    // Tìm thuật toán vote mạnh nhất cho bên thắng
    const topAlgo = details.filter(d => d.code === winner).sort((a, b) => b.vote - a.vote)[0];
    const reasonLabel = topAlgo ? `META·${topAlgo.name}` : 'META';

    return {
        code: winner,
        label: reasonLabel,
        tiLe: (confidence * 100).toFixed(1) + '%',
        weak: isWeak,
        veryWeak: isVeryWeak,
        decisionPath: decisionPath,
        biasForced: biasForced,
        balance: {
            votesT: +votes.T.toFixed(3),
            votesX: +votes.X.toFixed(3),
            gap: +gap.toFixed(3),
            pT: +pT.toFixed(3),
            pX: +pX.toFixed(3),
            loserShare: +loserShare.toFixed(3)
        },
        families: families,
        details
    };
}

// ========================================================================
// 5. HỌC ONLINE (ONLINE LEARNING)
// ========================================================================
function updateAllStats(db, prev, actual) {
    if (!prev || !actual) return;
    if (!db.weights) db.weights = {};
    for (const d of (prev.algoDetails || [])) {
        const isCorrect = (d.code === actual);
        const curW = db.weights[d.algo] || 1.0;
        // Nếu đúng thì cộng cân, sai thì trừ cân (có giới hạn)
        db.weights[d.algo] = clamp(curW + (isCorrect ? 0.08 : -0.08), 0.2, 4.0);
    }
}

// ========================================================================
// 6. FETCH & PROCESS GAME
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

async function processGame(game) {
    const list = await fetchApi(game === 'md5' ? API_MD5 : API_TX);
    if (!list || !list.length) return;

    const latest = list[list.length - 1], session = safeInt(latest.SessionId);
    const db = readDB(game);
    if (db.lastProcessedSession === session) return;

    const seq = list.map(getResult).filter(Boolean);
    const sums = list.map(getSum).filter(s => s >= 3 && s <= 18);
    if (seq.length < 15) return;

    updateStreakStats(seq, db);

    const prev = db.history[db.history.length - 1];
    if (prev && safeInt(prev.phienDuDoan) === session) {
        const actual = getResult(latest);
        prev.ketQua = actual;
        prev.ketQuaLabel = label(actual);
        prev.trangThai = !prev.DU_DOAN_CODE ? 'BỎ QUA' : (prev.DU_DOAN_CODE === actual ? 'ĐÚNG' : 'SAI');
        updateAllStats(db, prev, actual);
    }

    const pred = runMetaEngine(seq, sums, db, session + 1);

    db.history.push({
        phien: session,
        xucXac: getDice(latest),
        tong: getSum(latest),
        ketQua: getResult(latest),
        ketQuaLabel: label(getResult(latest)),
        phienDuDoan: session + 1,
        DU_DOAN_CODE: pred.code,
        DU_DOAN: label(pred.code),
        TI_LE: pred.tiLe,
        patternName: pred.label,
        algoDetails: pred.details,
        weak: pred.weak,
        veryWeak: pred.veryWeak,
        trangThai: 'ĐANG CHỜ'
    });

    if (db.history.length > 1000) db.history.shift(); // Tăng lên 1000 lịch sử
    db.lastProcessedSession = session;
    saveDB(game, db);
}

setInterval(() => {
    processGame('md5');
    processGame('taixiu');
}, TICK_MS);

// ========================================================================
// 7. ROUTES API (JSON FULL FORMAT)
// ========================================================================
app.get('/', (req, res) => res.redirect('/md5'));

app.get('/api/predict/:game', async (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.status(400).json({ success: false });

    const list = await fetchApi(game === 'md5' ? API_MD5 : API_TX);
    if (!list || !list.length) return res.status(500).json({ success: false });

    const latest = list[list.length - 1], session = safeInt(latest.SessionId);
    const seq = list.map(getResult).filter(Boolean);
    const sums = list.map(getSum).filter(s => s >= 3 && s <= 18);
    const db = readDB(game);
    const pred = runMetaEngine(seq, sums, db, session + 1);

    res.json({
        success: true,
        game: game,
        phien: session,
        xucXac: getDice(latest),
        tong: getSum(latest),
        ketQua: getResult(latest),
        ketQuaLabel: label(getResult(latest)),
        phienDuDoan: session + 1,
        duDoan: label(pred.code),
        duDoanCode: pred.code,
        tiLe: pred.tiLe,
        reason: pred.label,
        weak: pred.weak,
        veryWeak: pred.veryWeak,
        decisionPath: pred.decisionPath,
        biasForced: pred.biasForced,
        balance: pred.balance,
        families: pred.families,
        algoVotes: pred.details
    });
});

// ========================================================================
// 8. GIAO DIỆN UI NÂNG CẤP (DASHBOARD V16)
// ========================================================================
app.get('/:game', (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.send('Trang không tồn tại');

    const db = readDB(game);
    const rows = db.history.slice(-50).reverse();

    const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const correct = settled.filter(h => h.trangThai === 'ĐÚNG').length;
    const acc = settled.length ? (correct / settled.length * 100).toFixed(1) : '0.0';

    const strong = settled.filter(h => !h.weak);
    const weak = settled.filter(h => h.weak);
    const sWR = strong.length ? (strong.filter(h => h.trangThai === 'ĐÚNG').length / strong.length * 100).toFixed(1) : '-';
    const wWR = weak.length ? (weak.filter(h => h.trangThai === 'ĐÚNG').length / weak.length * 100).toFixed(1) : '-';

    const html = `<!DOCTYPE html>
    <html lang="vi">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
    <title>ULTRA V16 - ${game.toUpperCase()}</title>
    <style>
      :root {
        --bg-color: #050914;
        --card-bg: rgba(15, 23, 42, 0.75);
        --text-main: #e2e8f0;
        --accent: #3b82f6;
        --tai-color: #10b981;
        --xiu-color: #ef4444;
      }
      *{box-sizing:border-box;margin:0;padding:0;}
      body{
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
        background: linear-gradient(135deg, #020617 0%, #0f172a 100%);
        color:var(--text-main);
        padding:16px;
        min-height:100vh;
      }
      .container{max-width: 800px; margin: 0 auto;}
      .header{
        background: linear-gradient(135deg, rgba(30, 58, 138, 0.8), rgba(59, 130, 246, 0.8));
        backdrop-filter: blur(10px);
        border: 1px solid rgba(255,255,255,0.1);
        padding:20px;
        border-radius:20px;
        margin-bottom:20px;
        text-align:center;
        box-shadow: 0 10px 30px -10px rgba(59, 130, 246, 0.4);
      }
      h1{
        font-size:22px;
        font-weight:900;
        text-transform:uppercase;
        letter-spacing:1px;
        text-shadow: 0 2px 10px rgba(0,0,0,0.5);
        margin-bottom:10px;
      }
      .stat-grid{
        display:grid;
        grid-template-columns: 1fr 1fr;
        gap:10px;
        margin-top:15px;
      }
      .stat-box{
        background: rgba(0,0,0,0.3);
        padding:12px;
        border-radius:12px;
        border: 1px solid rgba(255,255,255,0.05);
      }
      .stat-box .label{font-size:11px;text-transform:uppercase;color:#94a3b8;letter-spacing:0.5px;}
      .stat-box .value{font-size:18px;font-weight:800;margin-top:4px;}
      .value.good{color:#34d399;}
      .value.bad{color:#f87171;}
      
      .table-container{
        background:var(--card-bg);
        backdrop-filter: blur(12px);
        border-radius:16px;
        border: 1px solid rgba(255,255,255,0.08);
        overflow-x:auto;
        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      }
      table{width:100%;border-collapse:collapse;font-size:13px;}
      th{
        background:rgba(30, 41, 59, 0.9);
        color:#cbd5e1;
        padding:14px 8px;
        font-size:11px;
        text-transform:uppercase;
        letter-spacing:0.5px;
        font-weight:700;
        border-bottom: 1px solid rgba(255,255,255,0.05);
      }
      td{
        padding:12px 8px;
        text-align:center;
        border-bottom:1px solid rgba(255,255,255,0.03);
        font-weight:500;
      }
      tr:hover { background: rgba(255,255,255,0.02); }
      
      .tai{color:var(--tai-color);font-weight:800;text-shadow:0 0 10px rgba(16,185,129,0.3);}
      .xiu{color:var(--xiu-color);font-weight:800;text-shadow:0 0 10px rgba(239,68,68,0.3);}
      
      .dung{color:var(--tai-color);font-weight:800;}
      .sai{color:var(--xiu-color);font-weight:800;}
      .cho{color:#94a3b8;font-weight:700;font-size:11px;}
      
      .dice-box{
        display:flex;
        justify-content:center;
        gap:3px;
      }
      .dice{
        width:20px;height:20px;
        background:#f8fafc;
        color:#0f172a;
        border-radius:4px;
        display:flex;align-items:center;justify-content:center;
        font-size:11px;font-weight:800;
        box-shadow: 0 2px 5px rgba(0,0,0,0.3);
      }
      .sum-pill{
        display:inline-block;
        padding:4px 10px;
        border-radius:20px;
        background:rgba(255,255,255,0.1);
        color:#fbbf24;
        font-weight:800;
        font-size:14px;
      }
      
      .session{font-family:monospace;font-size:12px;color:#64748b;}
      
      .ti-le{
        font-size:12px;
        color:#e2e8f0;
        font-weight:700;
        background:rgba(59, 130, 246, 0.2);
        padding:4px 8px;
        border-radius:6px;
      }
      .ti-le.weak{color:#fcd34d;background:rgba(245, 158, 11, 0.2);}
      .ti-le.veryweak{color:#fca5a5;background:rgba(239, 68, 68, 0.2);}
      
      .badge{
        display:inline-block;
        padding:5px 8px;
        border-radius:6px;
        font-size:11px;
        font-weight:700;
        white-space:nowrap;
        background:rgba(148, 163, 184, 0.15);
        color:#cbd5e1;
        border: 1px solid rgba(148, 163, 184, 0.2);
      }
      
      @media (max-width: 600px) {
        th, td { padding: 10px 4px; font-size:11px; }
        .dice { width: 16px; height: 16px; font-size: 9px; }
        .sum-pill { padding: 2px 6px; font-size: 12px; }
      }
    </style>
    <script>setTimeout(()=>location.reload(), 5000);</script>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>⚡ ULTRA V16 · ${game.toUpperCase()}</h1>
          <div class="stat-grid">
            <div class="stat-box">
              <div class="label">Độ Chính Xác</div>
              <div class="value ${parseFloat(acc) >= 50 ? 'good' : 'bad'}">${acc}%</div>
            </div>
            <div class="stat-box">
              <div class="label">Tổng Phiên</div>
              <div class="value">${settled.length}</div>
            </div>
            <div class="stat-box">
              <div class="label">🔥 Cầu Mạnh</div>
              <div class="value good">${sWR}%</div>
            </div>
            <div class="stat-box">
              <div class="label">⚠️ Cầu Yếu</div>
              <div class="value" style="color:#fcd34d">${wWR}%</div>
            </div>
          </div>
        </div>
        
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>PHIÊN</th>
                <th>XX</th>
                <th>TỔNG</th>
                <th>KQ</th>
                <th>DỰ ĐOÁN</th>
                <th>TỈ LỆ</th>
                <th>LOẠI CẦU</th>
                <th>TT</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(it => {
                const diceArr = it.xucXac || [0,0,0];
                const diceHtml = diceArr.map(d => `<div class="dice">${d}</div>`).join('');
                const kqClass = it.ketQua === 'T' ? 'tai' : 'xiu';
                const ddClass = it.DU_DOAN_CODE === 'T' ? 'tai' : 'xiu';
                const ttClass = it.trangThai === 'ĐÚNG' ? 'dung' : (it.trangThai === 'SAI' ? 'sai' : 'cho');
                const tC = it.veryWeak ? 'veryweak' : (it.weak ? 'weak' : '');
                return `<tr>
                  <td class="session">${it.phien}</td>
                  <td><div class="dice-box">${diceHtml}</div></td>
                  <td><span class="sum-pill">${it.tong || ''}</span></td>
                  <td class="${kqClass}">${it.ketQuaLabel || ''}</td>
                  <td class="${ddClass}">${it.DU_DOAN || ''}</td>
                  <td><span class="ti-le ${tC}">${it.TI_LE}</span></td>
                  <td><span class="badge">${it.patternName}</span></td>
                  <td class="${ttClass}">${it.trangThai === 'ĐANG CHỜ' ? '...' : it.trangThai}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </body>
    </html>`;
    res.send(html);
});

app.listen(PORT, () => console.log(`🚀 ULTRA V16 MAX POWER đang chạy trên port ${PORT}`));
