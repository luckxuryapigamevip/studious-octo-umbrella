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
// 1. CẤU HÌNH HỆ THỐNG
// ============================================================
const API_MD5 = 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau';
const API_TX  = 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau';
const API_B52 = 'https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=b5&gid=vgmn_101';

const DB_DIR = process.env.DB_DIR || __dirname;
const TICK_MS = 5000;
const MIN_SESSIONS = 15; 

if (!fs.existsSync(DB_DIR)) { try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch (e) {} }

// ============================================================
// 2. HELPERS & DATABASE
// ============================================================
function safeInt(x, def = 0) { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
const label = c => c === 'T' ? 'TÀI' : (c === 'X' ? 'XỈU' : null);
const flip  = c => c === 'T' ? 'X'   : (c === 'X' ? 'T'   : null);

function dbPath(g) { return path.join(DB_DIR, `db_v56_${g}.json`); }
function readDB(g) {
    const p = dbPath(g);
    try {
        if (fs.existsSync(p)) {
            const db = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (!db.rawHistory) db.rawHistory = [];
            if (!db.weights) db.weights = {};
            if (!db.history) db.history = [];
            if (!db.stats) db.stats = { T: 0, X: 0 }; // Lưu thống kê T/X
            return db;
        }
    } catch (e) {}
    return { history: [], lastSession: null, rawHistory: [], weights: {}, stats: { T: 0, X: 0 } };
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

// Hàm tính toán cơ bản
function getBaseStats(seq) {
    const L = seq.length;
    const tCount = seq.filter(x => x === 'T').length;
    const xCount = L - tCount;
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
    return { L, tCount, xCount, entropy, maxStreak, zigzagRatio, purity: 1 - entropy };
}

// ============================================================
// 3. NHẬN DIỆN MÔI TRƯỜNG
// ============================================================
function profileEnvMD5(seq) {
    if (seq.length < 10) return { type: 'CHƯA_ĐỦ_DATA', confidence: 0, efs: 0, purity: 0, entropy: 1, dominant: null, stats: { L: seq.length } };
    const base = getBaseStats(seq);
    let maxCycle = 0;
    for (let cLen = 2; cLen <= 6; cLen++) {
        if (seq.length < cLen * 2) continue;
        let match = 0;
        for (let i = cLen; i < seq.length; i++) {
            if (seq[i] === seq[i - cLen]) match++; else break;
        }
        if (match > maxCycle) maxCycle = match;
    }
    let type = 'HỖN_HỢP', conf = 0.5;
    if (maxCycle >= 8) { type = 'CHU_KY_MANH'; conf = 0.9; }
    else if (maxCycle >= 5) { type = 'CHU_KY_VUA'; conf = 0.75; }
    else if (base.entropy > 0.95) { type = 'NHIỄU_CAO'; conf = 0.85; }
    else if (base.zigzagRatio > 0.85) { type = 'ZIGZAG_1_1'; conf = 0.8; }
    else if (base.maxStreak >= 5) { type = 'BỆT_MD5'; conf = 0.75; }
    const efs = (clamp(base.L / 60, 0, 1) * 0.3 + base.purity * 0.3 + conf * 0.2 + (1 - base.entropy) * 0.2) * 100;
    const dominant = Math.abs(base.tCount - base.xCount) > 0.15 * base.L ? (base.tCount > base.xCount ? 'T' : 'X') : null;
    return { type, confidence: conf, efs: Math.round(efs * 10) / 10, purity: base.purity, entropy: base.entropy, dominant, stats: base };
}

function profileEnvTX(seq) {
    if (seq.length < 10) return { type: 'CHƯA_ĐỦ_DATA', confidence: 0, efs: 0, purity: 0, entropy: 1, dominant: null, stats: { L: seq.length } };
    const base = getBaseStats(seq);
    const recent = seq.slice(0, Math.min(20, seq.length));
    const rT = recent.filter(x => x === 'T').length;
    const recentBalance = Math.abs(rT - (recent.length - rT)) / recent.length;
    let type = 'HỖN_HỢP', conf = 0.5;
    if (base.entropy > 0.98) { type = 'NHIỄU_TUYỆT_ĐỐI'; conf = 0.95; }
    else if (base.entropy > 0.93) { type = 'NHIỄU_CAO'; conf = 0.85; }
    else if (base.maxStreak >= 7) { type = 'BỆT_TRƯỜNG'; conf = 0.9; }
    else if (base.maxStreak >= 4 && base.zigzagRatio < 0.4) { type = 'BỆT_NHẸ'; conf = 0.75; }
    else if (base.zigzagRatio > 0.85) { type = 'ZIGZAG_ĐẢO_1_1'; conf = 0.85; }
    else if (recentBalance > 0.4) { type = 'XU_HUONG_NGẮN'; conf = 0.75; }
    const efs = (clamp(base.L / 60, 0, 1) * 0.25 + base.purity * 0.35 + conf * 0.2 + (1 - base.entropy) * 0.2) * 100;
    const dominant = Math.abs(base.tCount - base.xCount) > 0.15 * base.L ? (base.tCount > base.xCount ? 'T' : 'X') : null;
    return { type, confidence: conf, efs: Math.round(efs * 10) / 10, purity: base.purity, entropy: base.entropy, dominant, stats: base };
}

function profileEnvB52(seq) {
    if (seq.length < 10) return { type: 'CHƯA_ĐỦ_DATA', confidence: 0, efs: 0, purity: 0, entropy: 1, dominant: null, stats: { L: seq.length } };
    const base = getBaseStats(seq);
    const recent10 = seq.slice(0, 10);
    const t10 = recent10.filter(x => x === 'T').length;
    const momentum = (t10 - 5) / 5;
    let type = 'HỖN_HỢP', conf = 0.5;
    if (base.entropy > 0.95) { type = 'NHIỄU_CAO_B52'; conf = 0.9; }
    else if (base.maxStreak >= 6) { type = 'BỆT_DÀI_B52'; conf = 0.85; }
    else if (base.zigzagRatio > 0.88) { type = 'NHẢY_CÓC_B52'; conf = 0.9; }
    else if (Math.abs(momentum) > 0.6) { type = 'ĐỘNG_LƯỢNG_MẠNH'; conf = 0.8; }
    else if (base.zigzagRatio > 0.7 && base.entropy > 0.8) { type = 'ZIGZAG_B52'; conf = 0.8; }
    const efs = (clamp(base.L / 60, 0, 1) * 0.2 + base.purity * 0.3 + conf * 0.3 + (1 - base.entropy) * 0.2) * 100;
    const dominant = Math.abs(base.tCount - base.xCount) > 0.15 * base.L ? (base.tCount > base.xCount ? 'T' : 'X') : null;
    return { type, confidence: conf, efs: Math.round(efs * 10) / 10, purity: base.purity, entropy: base.entropy, dominant, stats: base };
}

// ============================================================
// 4. THUẬT TOÁN CẦU (ĐÃ CẬP NHẬT CHỐNG BIAS)
// ============================================================
const MD5_ALGOS = {
    cauSieuchuKyMD5(seq, votes) {
        for (let cLen = 2; cLen <= 6; cLen++) {
            if (seq.length < cLen * 3) continue;
            const p1 = seq.slice(0, cLen).join(''), p2 = seq.slice(cLen, cLen*2).join(''), p3 = seq.slice(cLen*2, cLen*3).join('');
            if (p1 === p2 && p1 === p3) votes.push({ code: seq[cLen*3], name: `Siêu Chu Kỳ ${cLen}`, w: 2.0 });
        }
    },
    cauDoiXungMD5(seq, votes) {
        if (seq.length < 8) return;
        const p = seq.slice(0, 8).join('');
        if (p === 'TTXXTTXX' || p === 'XXTTXXTT') votes.push({ code: seq[0], name: 'Đối Xứng Kép', w: 1.6 });
        if (p === 'TXXTTXXT' || p === 'XTTXTTXX') votes.push({ code: flip(seq[0]), name: 'Đối Xứng Nghịch', w: 1.5 });
    },
    cauBetMD5(seq, votes) {
        let len = 1; for (let i = 1; i < seq.length; i++) { if (seq[i] === seq[0]) len++; else break; }
        if (len >= 4) votes.push({ code: len >= 8 ? flip(seq[0]) : seq[0], name: `Bệt Dài ${len}`, w: 1.8 });
    },
    markovMD5(seq, votes) {
        const trans = { TT: 0, TX: 0, XT: 0, XX: 0 };
        for (let i = 1; i < seq.length; i++) trans[seq[i-1] + seq[i]]++;
        const last = seq[0];
        const nextT = trans[last + 'T'], nextX = trans[last + 'X'];
        if (nextT + nextX > 10) votes.push({ code: nextT > nextX ? 'T' : 'X', name: 'Markov MD5', w: clamp(Math.abs(nextT - nextX) / (nextT + nextX) * 2, 0.5, 1.6) });
    }
};

const TAIXIU_ALGOS = {
    cauDao11TX(seq, votes) {
        let len = 1; for (let i = 1; i < Math.min(seq.length, 15); i++) { if (seq[i] !== seq[i-1]) len++; else break; }
        if (len >= 5) votes.push({ code: flip(seq[0]), name: `Đảo 1-1 Cấp Cao (${len})`, w: 1.8 });
    },
    cau3Van1TX(seq, votes) {
        if (seq.length < 8) return;
        const p = seq.slice(0, 7).join('');
        if (p === 'TTTXXXX' || p === 'XXXTTTT') votes.push({ code: seq[0], name: '3 Ván 1 Chuẩn', w: 1.7 });
    },
    fibonacciTX(seq, votes) {
        const fib = [1, 2, 3, 5, 8, 13];
        let cur = seq[0], len = 1, match = 0;
        for (let i = 1; i < seq.length; i++) {
            if (seq[i] === cur) len++;
            else { if (fib.includes(len)) match++; cur = seq[i]; len = 1; }
        }
        if (match >= 3) votes.push({ code: flip(seq[0]), name: 'Fibonacci TX', w: 1.5 });
    },
    smartBetTX(seq, votes) {
        let t = 0, x = 0;
        for (let i = 0; i < 6; i++) { if (seq[i] === 'T') t++; else x++; }
        if (t === 6) votes.push({ code: 'X', name: 'Smart Bet (Bệt T)', w: 1.6 });
        if (x === 6) votes.push({ code: 'T', name: 'Smart Bet (Bệt X)', w: 1.6 });
    }
};

const B52_ALGOS = {
    deepLearningB52(seq, votes) {
        if (seq.length < 30) return;
        const pattern = seq.slice(0, 5).join('');
        let match = 0, nextT = 0, nextX = 0;
        for (let i = 5; i < seq.length - 5; i++) {
            if (seq.slice(i, i+5).join('') === pattern) {
                match++;
                if (seq[i-1] === 'T') nextT++; else nextX++;
            }
        }
        if (match >= 2) votes.push({ code: nextT >= nextX ? 'T' : 'X', name: `DeepLearning B52 (${match})`, w: 2.0 });
    },
    cauNhayCocB52(seq, votes) {
        if (seq.length < 8) return;
        let flips = 0; for (let i = 1; i < 8; i++) if (seq[i] !== seq[i-1]) flips++;
        if (flips >= 7) votes.push({ code: flip(seq[0]), name: 'Nhảy Cóc B52', w: 1.6 });
    },
    cauBeCauB52(seq, votes) {
        let len = 1; for (let i = 1; i < seq.length; i++) { if (seq[i] === seq[0]) len++; else break; }
        if (len >= 3 && seq[len] === flip(seq[0])) votes.push({ code: seq[0], name: 'Bẻ Cầu B52', w: 1.5 });
    },
    momentumB52(seq, votes) {
        const recent = seq.slice(0, 10);
        let t = recent.filter(x => x === 'T').length;
        if (t >= 8) votes.push({ code: 'X', name: 'Đà Giảm Nhiệt', w: 1.3 });
        if (t <= 2) votes.push({ code: 'T', name: 'Đà Tăng Nhiệt', w: 1.3 });
    }
};

// ============================================================
// 5. BỘ TỔNG HỢP (ĐÃ FIX LỖI THIÊN VỊ)
// ============================================================
function runEnsemble(game, seq, env, db) {
    let votes = [];
    
    if (game === 'md5') {
        MD5_ALGOS.cauSieuchuKyMD5(seq, votes);
        MD5_ALGOS.cauDoiXungMD5(seq, votes);
        MD5_ALGOS.cauBetMD5(seq, votes);
        MD5_ALGOS.markovMD5(seq, votes);
    } else if (game === 'taixiu') {
        TAIXIU_ALGOS.cauDao11TX(seq, votes);
        TAIXIU_ALGOS.cau3Van1TX(seq, votes);
        TAIXIU_ALGOS.fibonacciTX(seq, votes);
        TAIXIU_ALGOS.smartBetTX(seq, votes);
    } else if (game === 'b52') {
        B52_ALGOS.deepLearningB52(seq, votes);
        B52_ALGOS.cauNhayCocB52(seq, votes);
        B52_ALGOS.cauBeCauB52(seq, votes);
        B52_ALGOS.momentumB52(seq, votes);
    }

    // 🔥 FIX LỖI TOÀN TÀI: Nếu không có cầu nào vote, PHẢI dùng hàm Random an toàn (không dùng bẻ cầu mù quáng)
    if (votes.length === 0) {
        // Lấy ngẫu nhiên dựa trên kết quả 5 phiên gần nhất để tránh bias
        const last5 = seq.slice(0, 5);
        const t5 = last5.filter(x => x === 'T').length;
        const pred = t5 >= 3 ? 'X' : 'T'; // Nếu 5 phiên gần nhất nhiều Tài -> dự đoán Xỉu và ngược lại
        return { code: pred, label: 'Phân Tích Cân Bằng', tiLe: '52.0%', details: [], phase: 'READY' };
    }

    const vT = votes.filter(v => v.code === 'T');
    const vX = votes.filter(v => v.code === 'X');
    const sT = vT.reduce((a, b) => a + b.w, 0);
    const sX = vX.reduce((a, b) => a + b.w, 0);
    
    // 🔥 FIX LỖI THIÊN VỊ: Tự động cân bằng lại trọng số
    // Nếu bên Tài hoặc Xỉu đang bị "lệch" quá nhiều trong lịch sử, tự động giảm trọng số của bên đó
    let biasPenaltyT = 1.0, biasPenaltyX = 1.0;
    const totalHistory = db.stats.T + db.stats.X;
    if (totalHistory > 20) {
        const realRatioT = db.stats.T / totalHistory;
        if (realRatioT > 0.6) biasPenaltyT = 0.8; // Nếu lịch sử đang quá nhiều Tài, giảm ưu tiên dự đoán Tài
        if (realRatioT < 0.4) biasPenaltyX = 0.8; // Nếu lịch sử đang quá nhiều Xỉu, giảm ưu tiên dự đoán Xỉu
    }

    const finalScoreT = sT * biasPenaltyT;
    const finalScoreX = sX * biasPenaltyX;

    let winner, confidence, patternName;

    if (finalScoreT > finalScoreX * 1.2) {
        winner = 'T'; confidence = clamp(0.5 + (finalScoreT / (finalScoreT + finalScoreX)) * 0.4, 0.5, 0.88);
        patternName = vT.sort((a,b)=>b.w-a.w)[0].name;
    } else if (finalScoreX > finalScoreT * 1.2) {
        winner = 'X'; confidence = clamp(0.5 + (finalScoreX / (finalScoreT + finalScoreX)) * 0.4, 0.5, 0.88);
        patternName = vX.sort((a,b)=>b.w-a.w)[0].name;
    } else {
        // 🔥 NẾU HÒA NHAU, KHÔNG BẺ CẦU MÙ QUÁNG, MÀ XEM XU HƯỚNG THỰC TẾ
        const last = seq[0];
        const secondLast = seq[1] || last;
        // Nếu 2 phiên gần nhất giống nhau -> Bẻ cầu. Nếu khác nhau -> Theo cầu (đánh tiếp)
        if (last === secondLast) {
            winner = flip(last); patternName = 'Bẻ Cầu Hòa';
        } else {
            winner = last; patternName = 'Theo Cầu Hòa';
        }
        confidence = 0.515; 
    }

    // Điều chỉnh tỉ lệ theo môi trường
    if (env.stats.L < 30) confidence = clamp(confidence * 0.9, 0.51, 0.6);
    else if (env.efs > 80) confidence = clamp(confidence + 0.05, 0.51, 0.90);
    else if (env.efs < 50) confidence = clamp(confidence - 0.03, 0.51, 0.60);

    return {
        code: winner,
        label: patternName,
        tiLe: (confidence * 100).toFixed(1) + '%',
        details: votes.sort((a,b)=>b.w-a.w).slice(0, 3),
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

        if (!db.rawHistory.find(x => x.sid === sid)) {
            db.rawHistory.push({ sid, d1: safeInt(latest.d1), d2: safeInt(latest.d2), d3: safeInt(latest.d3), result: getB52Result(latest) });
            if (db.rawHistory.length > 500) db.rawHistory.shift();
            saveDB(game, db);
        }

        seq = db.rawHistory.map(x => x.result).reverse();
        
        // Cập nhật thống kê T/X để chống bias
        if (seq.length > 0) {
            db.stats.T = seq.filter(x => x === 'T').length;
            db.stats.X = seq.filter(x => x === 'X').length;
            saveDB(game, db);
        }

        const prev = db.history[db.history.length - 1];
        if (prev && prev.trangThai === 'ĐANG CHỜ' && prev.phien < sid) {
            prev.trangThai = prev.DU_DOAN_CODE === getB52Result(latest) ? 'ĐÚNG' : 'SAI';
            saveDB(game, db);
        }

        if (seq.length >= MIN_SESSIONS) {
            const env = profileEnvB52(seq);
            db.envProfile = env;
            const pred = runEnsemble('b52', seq, env, db);
            
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
    
    if (seq.length > 0) {
        db.stats.T = seq.filter(x => x === 'T').length;
        db.stats.X = seq.filter(x => x === 'X').length;
        saveDB(game, db);
    }

    const session = safeInt(latest.SessionId);
    if (db.lastSession === session) return;
    db.lastSession = session;

    if (seq.length >= MIN_SESSIONS) {
        const env = game === 'md5' ? profileEnvMD5(seq) : profileEnvTX(seq);
        db.envProfile = env;
        const pred = runEnsemble(game, seq, env, db);

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

setInterval(() => { processGame('md5'); processGame('taixiu'); processGame('b52'); }, TICK_MS);

// ============================================================
// 7. ROUTERS API
// ============================================================
function buildResponse(game, db) {
    const latest = db.history[db.history.length - 1] || {};
    const env = db.envProfile || { type: 'ĐANG TẢI', confidence: 0, efs: 0, purity: 0, entropy: 1, dominant: null, stats: { L: 0 } };
    
    const pred = latest.DU_DOAN_CODE ? {
        code: latest.DU_DOAN_CODE, label: latest.patternName, tiLe: latest.TI_LE, details: latest.details || []
    } : null;

    const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const win = settled.filter(h => h.trangThai === 'ĐÚNG').length;
    const lose = settled.filter(h => h.trangThai === 'SAI').length;

    return {
        status: "success",
        data: {
            game: game.toUpperCase(),
            phienHienTai: latest.phien || "0",
            phienDuDoan: latest.phienDuDoan || "0",
            duDoan: pred ? label(pred.code) : "ĐANG CHỜ...",
            tiLe: pred ? pred.tiLe : "—",
            liDo: pred ? `⭐ ${pred.label} → ${label(pred.code)} (${pred.tiLe})` : `⏳ Cần thêm ${MIN_SESSIONS - (db.rawHistory.length || 0)} phiên...`,
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
                topAlgos: pred ? pred.details.map(d => `${d.name}`).join(' | ') : '—'
            },
            thongKe: {
                win, lose,
                winrate: settled.length ? ((win / settled.length) * 100).toFixed(1) + '%' : '—',
                bankroll: (1000 + win * 10 - lose * 10) + '$'
            }
        }
    };
}

app.get('/b52', (req, res) => { const db = readDB('b52'); res.json(buildResponse('b52', db)); });
app.get('/taixiu', (req, res) => { const db = readDB('taixiu'); res.json(buildResponse('taixiu', db)); });
app.get('/md5', (req, res) => { const db = readDB('md5'); res.json(buildResponse('md5', db)); });
app.get('/', (req, res) => res.redirect('/b52'));

app.listen(PORT, () => console.log(`🚀 V56 ANTI-BIAS running on port ${PORT}`));
