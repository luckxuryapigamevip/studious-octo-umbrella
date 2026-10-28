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
// 1. CẤU HÌNH HỆ THỐNG VIP
// ============================================================
const API_MD5 = 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau';
const API_TX  = 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau';
const API_B52 = 'https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=b5&gid=vgmn_101';

const DB_DIR = process.env.DB_DIR || __dirname;
const TICK_MS = 5000;

const CONFIG = {
    MIN_SESSIONS: 15, // Chỉ cần 15 phiên là phang
    WARMUP_SESSIONS: 30,
    EFS_TARGET: 80
};

// Toàn bộ Trọng số Cầu (Base Weights)
const BASE_WEIGHTS = {
    // Cầu Cơ Bản
    'cau_bet': 1.2, 'cau_dao_11': 1.1, 'cau_rong': 1.2, 'cau_tu_nhien': 0.8,
    // Cầu Đối Xứng
    'cau_22': 1.1, 'cau_33': 1.1, 'cau_44': 1.1, 'cau_55': 1.1,
    'cau_121': 1.1, 'cau_212': 1.1, 'cau_1221': 1.0, 'cau_2112': 1.0,
    'cau_123': 1.0, 'cau_321': 1.0, 'cau_chu_ky': 1.3,
    // Cầu Phức Tạp
    'cau_nhay_coc': 1.0, 'cau_nhip_nghieng': 1.0, 'cau_3van1': 1.1, 'cau_3van2': 1.1,
    'cau_be_cau': 1.0, 'cau_gap': 1.0, 'cau_ziczac': 1.2, 'cau_doi': 1.0,
    'cau_rong_bat_tan': 1.0, 'cau_bet_gay': 1.0, 'cau_1_1_1': 1.0,
    // Thuật Toán & Thống Kê
    'markov_chain': 1.5, 'moving_avg_drift': 1.2, 'sum_pressure': 1.2,
    'volatility': 1.0, 'distribution': 1.0, 'dice_pattern': 1.0,
    'sum_trend': 1.1, 'edge_cases': 1.0, 'momentum': 1.1,
    'break_pattern': 1.2, 'fibonacci': 1.0, 'resistance_support': 1.1,
    'wave': 1.0, 'golden_ratio': 1.0, 'smart_bet': 1.3, 'deep_learning': 1.5
};

if (!fs.existsSync(DB_DIR)) { try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch (e) {} }

// ============================================================
// 2. DATABASE & HELPERS
// ============================================================
function safeInt(x, def = 0) { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
const label = c => c === 'T' ? 'TÀI' : (c === 'X' ? 'XỈU' : null);
const flip  = c => c === 'T' ? 'X'   : (c === 'X' ? 'T'   : null);

function dbPath(g) { return path.join(DB_DIR, `db_v53_${g}.json`); }
function readDB(g) {
    const p = dbPath(g);
    try {
        if (fs.existsSync(p)) {
            const db = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (!db.rawHistory) db.rawHistory = [];
            if (!db.weights) db.weights = {};
            if (!db.streakStats) db.streakStats = { T: {}, X: {} };
            return db;
        }
    } catch (e) {}
    return { history: [], lastSession: null, rawHistory: [], weights: {}, streakStats: { T: {}, X: {} } };
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
// 3. NHẬN DIỆN MÔI TRƯỜNG (ENVIRONMENT PROFILER)
// ============================================================
function profileEnvironment(seq) {
    const L = seq.length;
    if (L < 10) return { type: 'CHƯA_ĐỦ_DATA', confidence: 0, efs: 0, disabled: [], stats: { L } };

    const tCount = seq.filter(x => x === 'T').length;
    const xCount = L - tCount;
    const balance = Math.abs(tCount - xCount) / L;
    
    let pT = tCount / L, pX = xCount / L, entropy = 0;
    if (pT > 0) entropy -= pT * Math.log2(pT);
    if (pX > 0) entropy -= pX * Math.log2(pX);

    let maxStreak = 1, curStreak = 1;
    for (let i = 1; i < L; i++) {
        if (seq[i] === seq[i-1]) { curStreak++; if (curStreak > maxStreak) maxStreak = curStreak; }
        else curStreak = 1;
    }

    let flips = 0;
    for (let i = 1; i < Math.min(30, L); i++) if (seq[i] !== seq[i-1]) flips++;
    const zigzagRatio = flips / Math.min(30, L);

    let type = 'HỖN_HỢP', conf = 0.5, disabled = [];
    const purity = 1 - entropy;

    if (entropy > 0.95) { type = 'NHIỄU_CAO'; conf = 0.9; disabled = ['cau_bet', 'cau_rong', 'cau_22', 'cau_33']; }
    else if (maxStreak >= 6) { type = 'BỆT_NẶNG'; conf = 0.85; disabled = ['cau_dao_11', 'cau_ziczac', 'cau_121']; }
    else if (zigzagRatio > 0.85) { type = 'ZIGZAG'; conf = 0.8; disabled = ['cau_bet', 'cau_rong', 'cau_3van1']; }
    else if (balance > 0.3) { type = 'XU_HUONG'; conf = 0.7; }
    else if (entropy < 0.5 && maxStreak >= 4) { type = 'BỆT_NHẸ'; conf = 0.7; disabled = ['cau_dao_11', 'cau_ziczac']; }

    const efs = (clamp(L / 60, 0, 1) * 0.3 + purity * 0.3 + conf * 0.2 + (1 - entropy) * 0.2) * 100;
    const dominant = balance > 0.15 ? (tCount > xCount ? 'T' : 'X') : null;

    return { type, confidence: conf, efs: Math.round(efs * 10) / 10, purity, entropy, dominant, disabled, stats: { L, tCount, xCount, maxStreak, zigzagRatio } };
}

// ============================================================
// 4. BỘ THUẬT TOÁN NHẬN DIỆN CẦU VIP (40+ ALGORITHMS)
// ============================================================
function getW(db, id) { return db.weights?.[id]?.w || BASE_WEIGHTS[id] || 1.0; }
const pushVote = (votes, pred, conf, name, code, db) => {
    if (!pred) return;
    const w = getW(db, code);
    const vote = (conf / 100) * w;
    votes.push({ code: pred, name, vote, rawCode: code });
};

// --- Nhóm 1: Cầu Cơ Bản ---
function cauBet(seq, db, votes) {
    let len = 1; for (let i = 1; i < seq.length; i++) { if (seq[i] === seq[0]) len++; else break; }
    if (len >= 3) pushVote(votes, len >= 6 ? flip(seq[0]) : seq[0], len >= 6 ? 12 : 15, `Bệt ${len}`, 'cau_bet', db);
}
function cauDao11(seq, db, votes) {
    let len = 1; for (let i = 1; i < Math.min(seq.length, 12); i++) { if (seq[i] !== seq[i-1]) len++; else break; }
    if (len >= 4) pushVote(votes, flip(seq[0]), 14, `Đảo 1-1 (${len})`, 'cau_dao_11', db);
}
function cauRong(seq, db, votes) {
    let len = 1; for (let i = 1; i < seq.length; i++) { if (seq[i] === seq[0]) len++; else break; }
    if (len >= 6) pushVote(votes, flip(seq[0]), Math.min(16, len + 8), `Rồng ${len}`, 'cau_rong', db);
}
function cauTuNhien(seq, db, votes) {
    const t = seq.slice(0, 10).filter(x => x === 'T').length;
    pushVote(votes, t > 5 ? 'T' : 'X', 5, 'Tự Nhiên', 'cau_tu_nhien', db);
}

// --- Nhóm 2: Cầu Đối Xứng & Chu Kỳ ---
function cauChuKy(seq, db, votes) {
    for (let cLen = 2; cLen <= 5; cLen++) {
        if (seq.length < cLen * 2) continue;
        const p1 = seq.slice(0, cLen).join(''), p2 = seq.slice(cLen, cLen * 2).join('');
        if (p1 === p2) { pushVote(votes, seq[cLen * 2], 14, `Chu Kỳ ${cLen}`, 'cau_chu_ky', db); return; }
    }
}
function cau121(seq, db, votes) {
    if (seq.length < 6) return;
    const p = seq.slice(0, 6).join('');
    if (p === 'TXXTTX' || p === 'XTTXXT') pushVote(votes, flip(seq[0]), 13, 'Cầu 1-2-1-2', 'cau_121', db);
}
function cau22(seq, db, votes) {
    if (seq.length < 5) return;
    const p = seq.slice(0, 5).join('');
    if (p === 'TTXXT' || p === 'XXTTX') pushVote(votes, seq[0], 12, 'Cầu 2-2-1', 'cau_22', db);
}
function cau33(seq, db, votes) {
    if (seq.length < 7) return;
    const p = seq.slice(0, 6).join('');
    if (p === 'TTTXXX' || p === 'XXXTTT') pushVote(votes, seq[0], 13, 'Cầu 3-3', 'cau_33', db);
}

// --- Nhóm 3: Cầu Phức Tạp ---
function cauNhayCoc(seq, db, votes) {
    if (seq.length < 6) return;
    let flips = 0; for (let i = 1; i < 6; i++) if (seq[i] !== seq[i-1]) flips++;
    if (flips >= 5) pushVote(votes, flip(seq[0]), 11, 'Nhảy Cóc', 'cau_nhay_coc', db);
}
function cauBeCau(seq, db, votes) {
    let len = 1; for (let i = 1; i < seq.length; i++) { if (seq[i] === seq[0]) len++; else break; }
    if (len >= 4 && seq[len] === flip(seq[0])) pushVote(votes, seq[0], 12, 'Bẻ Cầu', 'cau_be_cau', db);
}
function cau3van1(seq, db, votes) {
    if (seq.length < 8) return;
    const p = seq.slice(0, 7).join('');
    if (p === 'TTTXXXX' || p === 'XXXTTTT') pushVote(votes, seq[0], 13, '3 Ván 1', 'cau_3van1', db);
}

// --- Nhóm 4: Thuật Toán & Xác Suất ---
function markovChain(seq, db, votes) {
    const trans = { TT: 0, TX: 0, XT: 0, XX: 0 };
    for (let i = 1; i < seq.length; i++) trans[seq[i-1] + seq[i]]++;
    const last = seq[0];
    const nextT = trans[last + 'T'], nextX = trans[last + 'X'];
    if (nextT + nextX > 5) {
        const pred = nextT > nextX ? 'T' : 'X';
        const conf = clamp(Math.abs(nextT - nextX) / (nextT + nextX) * 20, 5, 18);
        pushVote(votes, pred, conf, 'Markov Chain', 'markov_chain', db);
    }
}
function smartBet(seq, db, votes) {
    if (seq.length < 15) return;
    let t = 0, x = 0;
    for (let i = 0; i < 5; i++) { if (seq[i] === 'T') t++; else x++; }
    if (t === 5) pushVote(votes, 'X', 14, 'Smart Bet (Bệt T)', 'smart_bet', db);
    if (x === 5) pushVote(votes, 'T', 14, 'Smart Bet (Bệt X)', 'smart_bet', db);
}
function deepLearning(seq, db, votes) {
    // Giả lập mạng Neural: Tìm quy luật lặp lại trong 20 phiên gần nhất
    if (seq.length < 20) return;
    const pattern = seq.slice(0, 5).join('');
    let match = 0, nextT = 0, nextX = 0;
    for (let i = 5; i < seq.length - 5; i++) {
        if (seq.slice(i, i+5).join('') === pattern) {
            match++;
            if (seq[i-1] === 'T') nextT++; else nextX++;
        }
    }
    if (match >= 2) {
        const pred = nextT >= nextX ? 'T' : 'X';
        pushVote(votes, pred, 15, `DeepLearning (${match})`, 'deep_learning', db);
    }
}
function fibonacci(seq, db, votes) {
    const fib = [1, 2, 3, 5, 8];
    let cur = seq[0], len = 1, match = 0;
    for (let i = 1; i < seq.length; i++) {
        if (seq[i] === cur) len++;
        else { if (fib.includes(len)) match++; cur = seq[i]; len = 1; }
    }
    if (match >= 2) pushVote(votes, flip(seq[0]), 9, 'Fibonacci', 'fibonacci', db);
}

// ============================================================
// 5. BỘ TỔNG HỢP ENSEMBLE (DEEP VOTING)
// ============================================================
function runVipEnsemble(seq, db, env) {
    let votes = [];
    const disabled = new Set(env.disabled || []);

    // Kích hoạt toàn bộ cầu
    const activeAlgos = [
        cauBet, cauDao11, cauRong, cauTuNhien, cauChuKy, cau121, cau22, cau33,
        cauNhayCoc, cauBeCau, cau3van1, markovChain, smartBet, deepLearning, fibonacci
    ];

    for (const algo of activeAlgos) {
        try { algo(seq, db, votes); } catch(e) {}
    }

    // Lọc bỏ các cầu bị vô hiệu hóa bởi môi trường
    votes = votes.filter(v => !disabled.has(v.rawCode));

    if (votes.length === 0) {
        // Cứu cánh: Nếu môi trường disable hết, tự động bẻ cầu phiên trước
        const last = seq[0];
        return { code: flip(last), label: 'Cứu Cánh (Bẻ Cầu)', tiLe: '51.5%', details: [], phase: 'READY' };
    }

    const vT = votes.filter(v => v.code === 'T');
    const vX = votes.filter(v => v.code === 'X');
    const sT = vT.reduce((a, b) => a + b.vote, 0);
    const sX = vX.reduce((a, b) => a + b.vote, 0);
    const cT = vT.length, cX = vX.length;

    let winner, confidence, patternName;

    // Nếu không có cầu nào vote cho 1 bên (Áp đảo hoàn toàn)
    if (cT === 0 && cX > 0) { winner = 'X'; confidence = 0.65; patternName = vX[0].name; }
    else if (cX === 0 && cT > 0) { winner = 'T'; confidence = 0.65; patternName = vT[0].name; }
    else {
        // Tính điểm trung bình có trọng số
        const avgT = sT / cT;
        const avgX = sX / cX;
        
        if (Math.abs(avgT - avgX) < 0.02) {
            winner = flip(seq[0]); confidence = 0.515; patternName = 'Hòa (Bẻ Cầu)';
        } else {
            winner = avgT > avgX ? 'T' : 'X';
            const diff = Math.abs(avgT - avgX) / Math.max(avgT, avgX);
            if (diff < 0.05) {
                winner = flip(seq[0]); confidence = 0.52; patternName = 'Nhiễu (Bẻ Cầu)';
            } else {
                confidence = clamp(0.5 + diff * 0.6, 0.5, 0.88);
                patternName = (winner === 'T' ? vT : vX).sort((a,b) => b.vote - a.vote)[0].name;
            }
        }
    }

    // Điều chỉnh tỉ lệ theo môi trường (EFS) - KHÔNG CHẶN DỰ ĐOÁN
    if (env.stats.L < 30) confidence = clamp(confidence * 0.9, 0.51, 0.6);
    else if (env.efs > 80) confidence = clamp(confidence + 0.05, 0.51, 0.90);
    else if (env.efs < 50) confidence = clamp(confidence - 0.03, 0.51, 0.60);

    return {
        code: winner,
        label: patternName,
        tiLe: (confidence * 100).toFixed(1) + '%',
        confidence,
        details: votes.sort((a,b)=>b.vote-a.vote).slice(0, 5), // Lấy top 5 lý do
        phase: 'READY'
    };
}

// ============================================================
// 6. FETCH & XỬ LÝ CHÍNH
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
        if (!res.data?.data || !Array.isArray(res.data.data) || res.data.data.length === 0) return null;
        return res.data.data[0];
    } catch (e) { return null; }
}

async function processGame(game) {
    const db = readDB(game);
    let seq = [], latest = null;

    if (game === 'b52') {
        const latestB52 = await fetchB52();
        if (!latestB52) return;
        latest = latestB52;
        const sid = safeInt(latest.sid);

        // Lưu phiên mới
        if (!db.rawHistory.find(x => x.sid === sid)) {
            db.rawHistory.push({ sid, d1: safeInt(latest.d1), d2: safeInt(latest.d2), d3: safeInt(latest.d3), result: getB52Result(latest) });
            if (db.rawHistory.length > 500) db.rawHistory.shift();
            saveDB(game, db);
        }

        seq = db.rawHistory.map(x => x.result).reverse();
        const prev = db.history[db.history.length - 1];

        // Chấm điểm phiên trước
        if (prev && prev.trangThai === 'ĐANG CHỜ' && prev.phien < sid) {
            prev.trangThai = prev.DU_DOAN_CODE === getB52Result(latest) ? 'ĐÚNG' : 'SAI';
            saveDB(game, db);
        }

        if (seq.length >= CONFIG.MIN_SESSIONS) {
            const env = profileEnvironment(seq);
            db.envProfile = env;
            const pred = runVipEnsemble(seq, db, env);
            
            if (!prev || prev.phien < sid) {
                db.history.push({
                    phien: sid, xucXac: getB52Dice(latest), tong: getB52Sum(latest),
                    ketQua: getB52Result(latest), ketQuaLabel: label(getB52Result(latest)),
                    phienDuDoan: sid + 1, DU_DOAN_CODE: pred.code, DU_DOAN: label(pred.code),
                    TI_LE: pred.tiLe, patternName: pred.label, details: pred.details,
                    envType: env.type, trangThai: 'ĐANG CHỜ'
                });
                if (db.history.length > 500) db.history.shift();
                saveDB(game, db);
            }
        }
        return;
    }

    // MD5 & TAIXIU
    const list = await fetchApi(game === 'md5' ? API_MD5 : API_TX);
    if (!list.length) return;
    latest = list[list.length - 1];
    seq = list.map(getResult).filter(Boolean).reverse();
    
    const session = safeInt(latest.SessionId);
    if (db.lastSession === session) return;
    db.lastSession = session;

    if (seq.length >= CONFIG.MIN_SESSIONS) {
        const env = profileEnvironment(seq);
        db.envProfile = env;
        const pred = runVipEnsemble(seq, db, env);

        const prev = db.history[db.history.length - 1];
        if (prev && prev.trangThai === 'ĐANG CHỜ' && prev.phien < session) {
            prev.trangThai = prev.DU_DOAN_CODE === getResult(latest) ? 'ĐÚNG' : 'SAI';
        }

        db.history.push({
            phien: session, xucXac: getDice(latest), tong: getSum(latest),
            ketQua: getResult(latest), ketQuaLabel: label(getResult(latest)),
            phienDuDoan: session + 1, DU_DOAN_CODE: pred.code, DU_DOAN: label(pred.code),
            TI_LE: pred.tiLe, patternName: pred.label, details: pred.details,
            envType: env.type, trangThai: 'ĐANG CHỜ'
        });
        if (db.history.length > 500) db.history.shift();
        saveDB(game, db);
    }
}

// Chạy vòng lặp
setInterval(() => { processGame('md5'); processGame('taixiu'); processGame('b52'); }, TICK_MS);

// ============================================================
// 7. API ROUTER
// ============================================================
function buildResponse(game, db) {
    const latest = db.history[db.history.length - 1] || {};
    const env = db.envProfile || { type: 'ĐANG TẢI', confidence: 0, efs: 0, purity: 0, entropy: 1, dominant: null, stats: { L: 0 } };
    
    // Nếu không có dự đoán trong lịch sử, báo đang chờ
    const pred = latest.DU_DOAN_CODE ? {
        code: latest.DU_DOAN_CODE,
        label: latest.patternName,
        tiLe: latest.TI_LE,
        details: latest.details || []
    } : null;

    const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const win = settled.filter(h => h.trangThai === 'ĐÚNG').length;
    const lose = settled.filter(h => h.trangThai === 'SAI').length;

    return {
        status: "success",
        data: {
            phienHienTai: latest.phien || "0",
            phienDuDoan: latest.phienDuDoan || "0",
            duDoan: pred ? label(pred.code) : "ĐANG CHỜ...",
            tiLe: pred ? pred.tiLe : "—",
            liDo: pred ? `⭐ ${pred.label} → ${label(pred.code)} (${pred.tiLe})` : `⏳ Cần thêm ${CONFIG.MIN_SESSIONS - (db.rawHistory.length || 0)} phiên...`,
            xucXac: latest.xucXac || [],
            tongDiem: latest.tong || 0,
            moiTruong: {
                loai: env.type,
                doTinCay: (env.confidence || 0).toFixed(2),
                efs: (env.efs || 0) + "%",
                doTinhKhiet: ((env.purity || 0) * 100).toFixed(1) + "%",
                doNhieu: ((env.entropy || 1) * 100).toFixed(1) + "%",
                nghieng: env.dominant ? label(env.dominant) : "CÂN BẰNG"
            },
            chiTietModel: {
                pattern: pred ? pred.label : '—',
                topAlgos: pred ? pred.details.map(d => `${d.name} (${label(d.code)})`).join(' | ') : '—'
            },
            thongKe: {
                win, lose,
                winrate: settled.length ? ((win / settled.length) * 100).toFixed(1) + '%' : '—',
                bankroll: (1000 + win * 10 - lose * 10) + '$'
            }
        }
    };
}

app.get('/b52', (req, res) => {
    const db = readDB('b52');
    res.json(buildResponse('b52', db));
});

app.get('/taixiu', (req, res) => {
    const db = readDB('taixiu');
    res.json(buildResponse('taixiu', db));
});

app.get('/md5', (req, res) => {
    const db = readDB('md5');
    res.json(buildResponse('md5', db));
});

app.get('/', (req, res) => res.redirect('/b52'));

app.listen(PORT, () => console.log(`🚀 V53 ULTIMATE VIP running on port ${PORT}`));
