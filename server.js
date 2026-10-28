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
// CONFIG & BASE WEIGHTS
// ========================================================================
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
    return h;
}

// ========================================================================
// 1. DATABASE
// ========================================================================
function dbPath(g) { return path.join(DB_DIR, `db_v45_${g}.json`); }
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
// 2. NHẬN DIỆN MÔI TRƯỜNG
// ========================================================================
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

// ========================================================================
// 3. TẠO ALL PATTERNS
// ========================================================================
function generateAllPatterns() {
    const A = [];
    for (let minLen = 2; minLen <= 8; minLen++) {
        A.push({ id: `streak_learn_${minLen}`, baseFamily: 'cau_bet', fn: (seq, sums, db) => {
            const n = seq.length, last = seq[n - 1]; let len = 1;
            for (let i = n - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
            if (len < minLen) return null;
            const st = db.streakStats?.[last]?.[len];
            if (!st || (st.cont + st.stop) < 2) return null;
            const pCont = (st.cont + 1) / (st.cont + st.stop + 2);
            if (pCont > 0.55) return { code: last, name: `BỆT-${len}-TIẾP`, conf: clamp(pCont, 0.6, 0.85) };
            if (pCont < 0.45) return { code: flip(last), name: `BỆT-${len}-GÃY`, conf: clamp(1 - pCont, 0.6, 0.85) };
            return null;
        }});
    }
    for (let win = 4; win <= 10; win++) {
        A.push({ id: `bounce_${win}`, baseFamily: 'cau_dao_11', fn: (seq) => {
            const n = seq.length; if (n < win + 1) return null;
            let flips = 0;
            for (let i = n - win; i < n; i++) if (seq[i] !== seq[i - 1]) flips++;
            return flips === win ? { code: flip(seq[n - 1]), name: `ĐẢO-1-1-W${win}`, conf: 0.75 } : null;
        }});
    }
    for (let p = 2; p <= 8; p++) {
        A.push({ id: `zigzag_${p}`, baseFamily: p===2?'cau_22':(p===3?'cau_33':'cau_ziczac'), fn: (seq) => {
            const n = seq.length; if (n < p * 2 + 2) return null;
            for (let i = n - p * 2; i < n - p; i++) if (seq[i] !== seq[i + p]) return null;
            return { code: seq[n - p], name: `ZIGZAG-${p}`, conf: 0.72 };
        }});
    }
    for (let k = 2; k <= 10; k++) {
        A.push({ id: `markov_${k}`, baseFamily: 'markov_chain', fn: (seq) => {
            const n = seq.length; if (n < k + 6) return null;
            const key = seq.slice(-k).join(''); let t = 0, x = 0;
            for (let i = k; i < n; i++) if (seq.slice(i - k, i).join('') === key) { if (seq[i] === 'T') t++; else x++; }
            const tot = t + x; if (tot < 3) return null;
            const pT = (t + 1) / (tot + 2), pX = (x + 1) / (tot + 2);
            if (Math.max(pT, pX) < 0.6) return null;
            return { code: pT > pX ? 'T' : 'X', name: `MARKOV-${k}`, conf: Math.max(pT, pX) };
        }});
    }
    for (let len = 3; len <= 10; len++) {
        A.push({ id: `ngram_${len}`, baseFamily: 'distribution', fn: (seq) => {
            const n = seq.length; if (n < len + 5) return null;
            const tail = seq.slice(-len).join(''); let t = 0, x = 0, occ = 0;
            for (let i = 0; i + len < n; i++) {
                if (seq.slice(i, i + len).join('') === tail) { occ++; if (seq[i + len] === 'T') t++; else x++; }
            }
            if (occ < 2) return null;
            const pT = (t + 1) / (occ + 2), pX = (x + 1) / (occ + 2);
            if (Math.max(pT, pX) < 0.65) return null;
            return { code: pT > pX ? 'T' : 'X', name: `NGRAM-${len}`, conf: Math.max(pT, pX) };
        }});
    }
    for (let p = 2; p <= 20; p++) {
        A.push({ id: `cycle_${p}`, baseFamily: 'cau_chu_ky', fn: (seq) => {
            const n = seq.length; if (n < p * 2 + 2) return null;
            let m = 0, tot = 0;
            for (let i = p; i < n; i++) { tot++; if (seq[i] === seq[i - p]) m++; }
            const r = m / tot;
            if (r >= 0.7) return { code: seq[n - p], name: `CHU-KỲ-${p}`, conf: clamp(r, 0.7, 0.9) };
            return null;
        }});
    }
    for (let w = 20; w <= 60; w += 10) {
        A.push({ id: `pull_${w}`, baseFamily: 'resistance_support', fn: (seq) => {
            const n = seq.length; if (n < w) return null;
            const pT = seq.slice(-w).filter(x => x === 'T').length / w;
            if (pT >= 0.65) return { code: 'X', name: `KÉO-CB-X`, conf: 0.6 };
            if (pT <= 0.35) return { code: 'T', name: `KÉO-CB-T`, conf: 0.6 };
            return null;
        }});
    }
    for (let sc = 3; sc <= 9; sc++) {
        A.push({ id: `fractal_${sc}`, baseFamily: 'cau_tu_nhien', fn: (seq) => {
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
        }});
    }
    for (let half = 3; half <= 8; half++) {
        A.push({ id: `mirror_${half}`, baseFamily: 'cau_doi', fn: (seq) => {
            const n = seq.length; if (n < half * 2 + 2) return null;
            const rec = seq.slice(-(half * 2));
            if (rec.slice(0, half).map(flip).join('') === rec.slice(half).join(''))
                return { code: flip(seq[n - 1]), name: `GƯƠNG-${half}`, conf: 0.7 };
            return null;
        }});
    }
    for (let w = 10; w <= 30; w += 10) {
        A.push({ id: `cusum_${w}`, baseFamily: 'break_pattern', fn: (seq) => {
            const n = seq.length; if (n < w) return null;
            const rec = seq.slice(-w);
            let sp = 0, sn = 0;
            for (const x of rec) { const v = x === 'T' ? 1 : -1; sp = Math.max(0, sp + v); sn = Math.min(0, sn + v); }
            if (sp >= 4) return { code: 'X', name: `CUSUM-DOWN`, conf: 0.66 };
            if (sn <= -4) return { code: 'T', name: `CUSUM-UP`, conf: 0.66 };
            return null;
        }});
    }
    return A;
}

const ALL_ALGOS = generateAllPatterns();
console.log(`✅ Đã nạp ${ALL_ALGOS.length} thuật toán.`);

// ========================================================================
// 4. TỔNG HỢP KHÔNG THIÊN VỊ (FIX LỖI RA TÀI BỪA)
// ========================================================================
function runUnbiasedEnsemble(seq, sums, db, env) {
    const disabled = new Set(env.disabledPatterns);
    let votesT = [], votesX = [], details = [];

    const last = seq[seq.length - 1];
    let currentStreak = 1;
    for (let i = seq.length - 2; i >= 0; i--) {
        if (seq[i] === last) currentStreak++;
        else break;
    }

    for (const algo of ALL_ALGOS) {
        if (disabled.has(algo.baseFamily)) continue;
        let res = null; try { res = algo.fn(seq, sums, db); } catch (e) {}
        if (!res || !res.code) continue;

        const baseW = DEFAULT_PATTERN_WEIGHTS[algo.baseFamily] || 1.0;
        const learnedW = db.weights?.[algo.id]?.w || 1.0;
        
        let streakPenalty = 1.0;
        if (currentStreak >= 3) {
            if (res.code === last) streakPenalty = 0.5;
            else streakPenalty = 1.5;
        }

        const vote = res.conf * baseW * learnedW * streakPenalty;

        if (res.code === 'T') votesT.push({ vote, name: res.name });
        else votesX.push({ vote, name: res.name });
        details.push({ algo: algo.id, family: algo.baseFamily, code: res.code, name: res.name });
    }

    const cT = votesT.length, cX = votesX.length;
    const sT = votesT.reduce((a, b) => a + b.vote, 0);
    const sX = votesX.reduce((a, b) => a + b.vote, 0);

    const scoreT = cT > 0 ? sT / cT : 0;
    const scoreX = cX > 0 ? sX / cX : 0;

    let winner, confidence, patternName, method;

    if (cT + cX === 0) {
        winner = flip(last); confidence = 0.51; patternName = 'BẺ-CẦU-NHIỄU'; method = 'anti_noise';
    } else if (Math.abs(scoreT - scoreX) < 0.03) {
        winner = flip(last); confidence = 0.515; patternName = 'HÒA-BẺ-CẦU'; method = 'tie_break';
    } else {
        winner = scoreT > scoreX ? 'T' : 'X';
        const maxS = Math.max(scoreT, scoreX);
        const diff = Math.abs(scoreT - scoreX) / maxS;
        
        if (diff < 0.05) {
            winner = flip(last);
            confidence = 0.52;
            patternName = 'BẺ-CẦU-DO-NHIỄU';
            method = 'low_diff_break';
        } else {
            confidence = clamp(0.5 + diff * 0.5, 0.5, 0.85);
            const top = (winner === 'T' ? votesT : votesX).sort((a,b)=>b.vote-a.vote)[0];
            patternName = top ? top.name : 'META';
            method = 'score';
        }
    }

    const efs = env.efs;
    if (env.stats.L < CONFIG.WARMUP.MIN_SESSIONS) {
        confidence = clamp(0.51 + (confidence - 0.5) * 0.5, 0.51, 0.55);
    } else if (efs < CONFIG.WARMUP.EFS_TARGET) {
        const ratio = efs / CONFIG.WARMUP.EFS_TARGET;
        const target = 0.51 + 0.08 * ratio;
        confidence = clamp(Math.min(confidence, target), 0.51, 0.59);
    } else {
        const boost = ((efs - CONFIG.WARMUP.EFS_TARGET) / 20) * 0.1;
        confidence = clamp(confidence * (1 + boost), 0.51, 0.85);
    }

    return {
        code: winner, label: patternName, tiLe: (confidence*100).toFixed(1)+'%', confidence, method,
        details, counts: { cT, cX, scoreT: +scoreT.toFixed(2), scoreX: +scoreX.toFixed(2) },
        phase: confidence < 0.60 ? 'WARMING_UP' : 'READY'
    };
}

// ========================================================================
// 5. FETCH & PROCESS
// ========================================================================
async function fetchApi(url) {
    try {
        const res = await axios.get(url, { timeout: 8000 });
        let arr = res.data?.data?.list || res.data?.list || res.data?.data || (Array.isArray(res.data) ? res.data : []);
        if (arr.length >= 2 && Number(arr[0].SessionId) > Number(arr[arr.length - 1].SessionId)) arr.reverse();
        return arr;
    } catch (e) { return []; }
}

async function processGame(game) {
    const list = await fetchApi(game === 'md5' ? API_MD5 : API_TX);
    if (!list || !list.length) return;

    const latest = list[list.length - 1];
    const session = safeInt(latest.SessionId);
    const db = readDB(game);
    if (db.lastSession === session) return;

    const seq = list.map(getResult).filter(Boolean);
    if (seq.length < 15) {
        db.lastSession = session;
        saveDB(game, db);
        return;
    }

    updateStreakStats(seq, db);
    const env = profileEnvironment(seq);
    db.envProfile = env;

    const sums = list.map(getSum).filter(s => s >= 3 && s <= 18);
    const pred = runUnbiasedEnsemble(seq, sums, db, env);

    const prev = db.history[db.history.length - 1];
    if (prev && safeInt(prev.phienDuDoan) === session && prev.DU_DOAN_CODE) {
        const actual = getResult(latest);
        prev.trangThai = prev.DU_DOAN_CODE === actual ? 'ĐÚNG' : 'SAI';
        for (const d of (prev.algoDetails || [])) {
            if (!db.weights[d.algo]) db.weights[d.algo] = { w: 1.0 };
            if (d.code === actual) db.weights[d.algo].w = clamp(db.weights[d.algo].w + 0.05, 0.5, 2.0);
            else db.weights[d.algo].w = clamp(db.weights[d.algo].w - 0.05, 0.5, 2.0);
        }
    }

    db.history.push({
        phien: session, xucXac: getDice(latest), tong: getSum(latest),
        ketQua: getResult(latest), ketQuaLabel: label(getResult(latest)),
        phienDuDoan: session + 1,
        DU_DOAN_CODE: pred.code, 
        DU_DOAN: label(pred.code), // Lưu TÀI/XỈU
        TI_LE: pred.tiLe,
        patternName: pred.label,
        algoDetails: pred.details,
        method: pred.method,
        phase: pred.phase,
        envType: env.type,
        trangThai: 'ĐANG CHỜ'
    });

    if (db.history.length > 500) db.history.shift();
    db.lastSession = session;
    saveDB(game, db);
}

setInterval(() => { processGame('md5'); processGame('taixiu'); }, TICK_MS);

// ========================================================================
// 6. ROUTE JSON (FIX LỖI TRẢ RA TÀI/XỈU)
// ========================================================================
function buildJsonResponse(game, list, db, env, pred) {
    const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const win = settled.filter(h => h.trangThai === 'ĐÚNG').length;
    const lose = settled.filter(h => h.trangThai === 'SAI').length;

    const duDoanText = pred ? label(pred.code) : null;

    return {
        status: "success",
        data: {
            phienHienTai: String(safeInt(list[list.length-1].SessionId)),
            phienDuDoan: String(safeInt(list[list.length-1].SessionId) + 1),
            duDoan: duDoanText, // FIX: Trả ra TÀI hoặc XỈU
            tiLe: pred ? pred.tiLe : "—",
            liDo: pred ? `⭐ ${pred.label} → ${duDoanText} (${pred.tiLe})` : `⏳ Đang quét ${env.stats.L}/15 phiên...`,
            xucXac: getDice(list[list.length-1]),
            tongDiem: getSum(list[list.length-1]),
            moiTruong: {
                loai: env.type,
                doTinCay: env.confidence.toFixed(2),
                efs: env.efs + "%",
                doTinhKhiet: (env.purity*100).toFixed(1) + "%",
                doNhieu: (env.entropy*100).toFixed(1) + "%",
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

app.get('/taixiu', async (req, res) => {
    const list = await fetchApi(API_TX); const db = readDB('taixiu');
    if (!list || !list.length) return res.status(500).json({ status: "error" });
    const seq = list.map(getResult).filter(Boolean);
    const sums = list.map(getSum).filter(s => s >= 3 && s <= 18);
    const env = profileEnvironment(seq);
    const pred = seq.length >= 15 ? runUnbiasedEnsemble(seq, sums, db, env) : null;
    res.json(buildJsonResponse('taixiu', list, db, env, pred));
});

app.get('/md5', async (req, res) => {
    const list = await fetchApi(API_MD5); const db = readDB('md5');
    if (!list || !list.length) return res.status(500).json({ status: "error" });
    const seq = list.map(getResult).filter(Boolean);
    const sums = list.map(getSum).filter(s => s >= 3 && s <= 18);
    const env = profileEnvironment(seq);
    const pred = seq.length >= 15 ? runUnbiasedEnsemble(seq, sums, db, env) : null;
    res.json(buildJsonResponse('md5', list, db, env, pred));
});

// ========================================================================
// 7. ROUTE UI
// ========================================================================
app.get('/ui/:game', (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.send('Game không hợp lệ');
    const db = readDB(game);
    const rows = db.history.slice(-80).reverse();
    const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const correct = settled.filter(h => h.trangThai === 'ĐÚNG').length;
    const acc = settled.length ? (correct / settled.length * 100).toFixed(1) : '0.0';
    const env = db.envProfile || { type: 'CHƯA CÓ', confidence: 0, efs: 0, purity: 0, entropy: 1, dominant: null };

    res.send(`<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>V45 - ${game.toUpperCase()}</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#0a0e27;color:#e6eef6;padding:12px;margin:0;}
.header{background:linear-gradient(135deg,#1e3a8a,#3b82f6);padding:16px;border-radius:14px;margin-bottom:14px;}
h1{color:#fff;font-size:20px;margin:0 0 8px;font-weight:800;text-align:center}
.env-box{background:rgba(0,0,0,.3);padding:10px;border-radius:10px;font-size:13px;margin-bottom:8px}
.env-row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.1)}
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
.env-tag{display:inline-block;padding:2px 5px;border-radius:4px;font-size:9px;font-weight:700;background:#1e40af;color:#fff}
</style>
<script>setTimeout(()=>location.reload(), 5000);</script>
</head><body>
<div class="header">
  <h1>V45 · ${game.toUpperCase()}</h1>
  <div class="env-box">
    <div class="env-row"><span>🌍 Môi trường</span><span class="env-val">${env.type}</span></div>
    <div class="env-row"><span>🎯 Độ tin cậy</span><span class="env-val">${(env.confidence*100).toFixed(1)}%</span></div>
    <div class="env-row"><span>📊 EFS</span><span class="env-val">${env.efs}%</span></div>
    <div class="env-row"><span>💎 Tinh khiết</span><span class="env-val">${(env.purity*100).toFixed(1)}%</span></div>
    <div class="env-row"><span>🌫️ Nhiễu</span><span class="env-val">${(env.entropy*100).toFixed(1)}%</span></div>
    <div class="env-row"><span>⚖️ Nghiêng</span><span class="env-val">${env.dominant ? label(env.dominant) : 'CÂN BẰNG'}</span></div>
    <div class="efs-bar"><div class="efs-fill" style="width:${env.efs}%"></div></div>
  </div>
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
</body></html>`);
});

app.get('/', (req, res) => res.redirect('/ui/md5'));

app.listen(PORT, () => console.log(`🚀 V45 Server running on port ${PORT}`));
