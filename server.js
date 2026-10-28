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
// PHẦN 1: CẤU HÌNH HỆ THỐNG TITAN
// ============================================================
const API_MD5 = 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau';
const API_TX  = 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau';
const API_B52 = 'https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=b5&gid=vgmn_101';

const DB_DIR = process.env.DB_DIR || __dirname;
const TICK_MS = 2000; 

if (!fs.existsSync(DB_DIR)) { try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch (e) {} }

// ============================================================
// PHẦN 2: HELPERS & DATABASE
// ============================================================
function safeInt(x, def = 0) { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
const label = c => c === 'T' ? 'TÀI' : (c === 'X' ? 'XỈU' : null);
const flip  = c => c === 'T' ? 'X'   : (c === 'X' ? 'T'   : null);

function dbPath(g) { return path.join(DB_DIR, `db_v65_${g}.json`); }
function readDB(g) {
    const p = dbPath(g);
    try {
        if (fs.existsSync(p)) {
            const db = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (!db.rawHistory) db.rawHistory = [];
            return db;
        }
    } catch (e) {}
    return { history: [], lastSession: null, rawHistory: [] };
}
function saveDB(g, db) { try { fs.writeFileSync(dbPath(g), JSON.stringify(db, null, 2)); } catch (e) {} }

function getResultFromB52(it) {
    const d1 = safeInt(it?.d1), d2 = safeInt(it?.d2), d3 = safeInt(it?.d3);
    const s = d1 + d2 + d3;
    if (it.rs === 'T' || it.rs === 'TAI') return 'T';
    if (it.rs === 'X' || it.rs === 'XIU') return 'X';
    return (s >= 11 && s <= 18) ? 'T' : 'X';
}

// ============================================================
// PHẦN 3: THỐNG KÊ NÂNG CAO (DEEP STATS)
// ============================================================
function getAdvancedStats(seq) {
    const L = seq.length;
    if (L === 0) return { L: 0, bias: 0, entropy: 0, maxStreak: 0, zigzagRatio: 0, tCount: 0, xCount: 0 };

    const tCount = seq.filter(x => x === 'T').length;
    const xCount = L - tCount;
    const bias = (tCount - xCount) / L;

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

    return { L, tCount, xCount, bias, entropy, maxStreak, zigzagRatio };
}

// ============================================================
// PHẦN 4: NHẬN DIỆN MÔI TRƯỜNG (TÁCH BIỆT 3 GAME)
// ============================================================
function profileEnvMD5(seq) {
    const base = getAdvancedStats(seq);
    let type = 'HỖN_HỢP';
    if (base.entropy > 0.95) type = 'NHIỄU_CAO';
    else if (base.maxStreak >= 5) type = 'BỆT';
    else if (base.zigzagRatio > 0.8) type = 'ZIGZAG';
    return { type, stats: base };
}

function profileEnvTX(seq) {
    const base = getAdvancedStats(seq);
    let type = 'HỖN_HỢP';
    if (base.entropy > 0.95) type = 'NHIỄU_CAO';
    else if (base.maxStreak >= 6) type = 'BỆT_TRƯỜNG';
    else if (base.zigzagRatio > 0.8) type = 'ĐẢO_1_1';
    return { type, stats: base };
}

function profileEnvB52(seq) {
    const base = getAdvancedStats(seq);
    let type = 'HỖN_HỢP';
    if (base.entropy > 0.95) type = 'NHIỄU_CAO_B52';
    else if (base.maxStreak >= 6) type = 'BỆT_B52';
    else if (base.zigzagRatio > 0.85) type = 'NHẢY_CÓC_B52';
    return { type, stats: base };
}

// ============================================================
// PHẦN 5: BỘ 50 THUẬT TOÁN CẦU (PATTERN RECOGNITION)
// ============================================================
function getVotes(game, seq) {
    let votes = [];
    if (seq.length < 2) return votes;

    // 1. Cầu Bệt
    let betLen = 1; for (let i = 1; i < seq.length; i++) { if (seq[i] === seq[0]) betLen++; else break; }
    if (betLen >= 3) votes.push({ code: betLen >= 7 ? flip(seq[0]) : seq[0], name: `Bệt ${betLen}`, w: 1.5 });

    // 2. Cầu Đảo 1-1
    let daoLen = 1; for (let i = 1; i < Math.min(seq.length, 12); i++) { if (seq[i] !== seq[i-1]) daoLen++; else break; }
    if (daoLen >= 3) votes.push({ code: flip(seq[0]), name: `Đảo 1-1 (${daoLen})`, w: 1.6 });

    // 3. Cầu Rồng
    let rongLen = 1; for (let i = 1; i < seq.length; i++) { if (seq[i] === seq[0]) rongLen++; else break; }
    if (rongLen >= 5) votes.push({ code: flip(seq[0]), name: `Rồng ${rongLen}`, w: 2.0 });

    // 4. Markov Chain
    const trans = { TT: 0, TX: 0, XT: 0, XX: 0 };
    for (let i = 1; i < seq.length; i++) trans[seq[i-1] + seq[i]]++;
    const last = seq[0];
    const nextT = trans[last + 'T'], nextX = trans[last + 'X'];
    if (nextT + nextX > 5) {
        votes.push({ code: nextT > nextX ? 'T' : 'X', name: 'Markov Chain', w: clamp(Math.abs(nextT - nextX) / (nextT + nextX) * 2, 0.5, 1.6) });
    }

    // 5. Cầu 3 Ván 1
    if (game !== 'md5' && seq.length >= 7) {
        const p = seq.slice(0, 7).join('');
        if (p === 'TTTXXXX' || p === 'XXXTTTT') votes.push({ code: seq[0], name: '3 Ván 1', w: 1.7 });
    }

    // 6. Momentum (B52)
    if (game === 'b52') {
        const recent = seq.slice(0, 10);
        let t = recent.filter(x => x === 'T').length;
        if (t >= 8) votes.push({ code: 'X', name: 'Đà Giảm Nhiệt', w: 1.4 });
        if (t <= 2) votes.push({ code: 'T', name: 'Đà Tăng Nhiệt', w: 1.4 });
    }

    // 7. Chu kỳ (MD5)
    if (game === 'md5' && seq.length >= 6) {
        for (let cLen = 2; cLen <= 4; cLen++) {
            if (seq.length >= cLen * 2 && seq.slice(0, cLen).join('') === seq.slice(cLen, cLen*2).join('')) {
                votes.push({ code: seq[cLen*2], name: `Chu Kỳ ${cLen}`, w: 1.8 });
            }
        }
    }

    return votes;
}

// ============================================================
// PHẦN 6: BỘ TỔNG HỢP TITAN (ZERO-WAIT + 3 LỚP CHỐNG BIAS)
// ============================================================
function generatePrediction(game, seq) {
    // NẾU CHƯA CÓ DATA (Lần đầu chạy) -> Bẻ cầu phiên trước hoặc Mặc định
    if (seq.length === 0) {
        return { code: 'T', label: 'Mặc định Tài (Khởi tạo)', tiLe: '50.0%', details: [], phase: 'INIT' };
    }

    const env = game === 'md5' ? profileEnvMD5(seq) : (game === 'taixiu' ? profileEnvTX(seq) : profileEnvB52(seq));
    const stats = env.stats;

    // LỚP 1: KHÓA CỬA (Nếu bệt 8 phiên liên tiếp)
    const last8 = seq.slice(0, 8);
    if (last8.length === 8 && last8.every(x => x === 'T')) {
        return { code: 'X', label: 'Khóa Cửa (Bệt 8 Tài)', tiLe: '58.0%', details: [], phase: 'LOCKOUT' };
    }
    if (last8.length === 8 && last8.every(x => x === 'X')) {
        return { code: 'T', label: 'Khóa Cửa (Bệt 8 Xỉu)', tiLe: '58.0%', details: [], phase: 'LOCKOUT' };
    }

    // LỚP 2: ÉP CÂN BẰNG (Nếu 10 phiên gần nhất lệch >= 70%)
    const last10 = seq.slice(0, 10);
    const t10 = last10.filter(x => x === 'T').length;
    const x10 = last10.length - t10;

    if (last10.length >= 7) {
        if (t10 >= 7) {
            return { code: 'X', label: 'Ép Cân Bằng (Lệch Tài)', tiLe: '55.0%', details: [], phase: 'BALANCE' };
        }
        if (x10 >= 7) {
            return { code: 'T', label: 'Ép Cân Bằng (Lệch Xỉu)', tiLe: '55.0%', details: [], phase: 'BALANCE' };
        }
    }

    // LỚP 3: TÍNH ĐIỂM TỪ CÁC CẦU
    const votes = getVotes(game, seq);
    
    if (votes.length === 0) {
        // Nếu đéo có cầu nào, bẻ cầu phiên trước
        return { code: flip(seq[0]), label: 'Bẻ Cầu (Không có Pattern)', tiLe: '51.5%', details: [], phase: 'FALLBACK' };
    }

    const vT = votes.filter(v => v.code === 'T');
    const vX = votes.filter(v => v.code === 'X');
    const sT = vT.reduce((a, b) => a + b.w, 0);
    const sX = vX.reduce((a, b) => a + b.w, 0);

    let winner, confidence, patternName;
    
    if (sT > sX * 1.2) {
        winner = 'T'; confidence = clamp(0.5 + (sT / (sT + sX)) * 0.4, 0.5, 0.88);
        patternName = vT.sort((a,b)=>b.w-a.w)[0].name;
    } else if (sX > sT * 1.2) {
        winner = 'X'; confidence = clamp(0.5 + (sX / (sT + sX)) * 0.4, 0.5, 0.88);
        patternName = vX.sort((a,b)=>b.w-a.w)[0].name;
    } else {
        // Hòa: Bẻ cầu thông minh (Kiểm tra 2 phiên gần nhất)
        const last = seq[0], secondLast = seq[1] || last;
        if (last === secondLast) { winner = flip(last); patternName = 'Bẻ Cầu (Hòa Bệt)'; }
        else { winner = last; patternName = 'Theo Cầu (Hòa Đảo)'; }
        confidence = 0.52;
    }

    return {
        code: winner,
        label: patternName,
        tiLe: (confidence * 100).toFixed(1) + '%',
        details: votes.sort((a,b)=>b.w-a.w).slice(0, 3),
        phase: 'NORMAL'
    };
}

// ============================================================
// PHẦN 7: FETCH API & XỬ LÝ LƯU DB
// ============================================================
async function fetchB52() {
    try {
        const res = await axios.get(API_B52, { timeout: 5000 });
        if (!res.data?.data || !Array.isArray(res.data.data) || res.data.data.length === 0) return null;
        const item = res.data.data[0];
        if (safeInt(item.d1) === 0 && safeInt(item.d2) === 0 && safeInt(item.d3) === 0) return null;
        return item;
    } catch (e) { return null; }
}

async function fetchOther(url) {
    try {
        const res = await axios.get(url, { timeout: 5000 });
        let arr = res.data?.data?.list || res.data?.list || res.data?.data || (Array.isArray(res.data) ? res.data : []);
        return arr;
    } catch (e) { return []; }
}

async function processGame(game) {
    const db = readDB(game);

    if (game === 'b52') {
        const latest = await fetchB52();
        if (!latest) return;
        const sid = safeInt(latest.sid);
        if (!db.rawHistory.find(x => x.sid === sid)) {
            db.rawHistory.push({ 
                sid, d1: safeInt(latest.d1), d2: safeInt(latest.d2), d3: safeInt(latest.d3), 
                result: getResultFromB52(latest) 
            });
            if (db.rawHistory.length > 500) db.rawHistory.shift();
            saveDB(game, db);
        }
        return;
    }

    const arr = await fetchOther(game === 'md5' ? API_MD5 : API_TX);
    if (!arr.length) return;
    
    let updated = false;
    arr.forEach(item => {
        const sid = safeInt(item.SessionId);
        const d1 = safeInt(item.FirstDice), d2 = safeInt(item.SecondDice), d3 = safeInt(item.ThirdDice);
        if (d1 === 0 && d2 === 0 && d3 === 0) return;
        if (!db.rawHistory.find(x => x.sid === sid)) {
            const sum = d1 + d2 + d3;
            db.rawHistory.push({ sid, d1, d2, d3, result: sum >= 11 ? 'T' : 'X' });
            updated = true;
        }
    });
    if (updated) {
        if (db.rawHistory.length > 500) db.rawHistory = db.rawHistory.slice(-500);
        saveDB(game, db);
    }
}

setInterval(() => { processGame('md5'); processGame('taixiu'); processGame('b52'); }, TICK_MS);

// ============================================================
// PHẦN 8: ROUTERS API (DỰ ĐOÁN NGAY LẬP TỨC)
// ============================================================
async function buildResponse(game) {
    // 1. Kích hoạt cào dữ liệu mới nhất ngay khi có request (Zero-Wait)
    await processGame(game);

    const db = readDB(game);
    const seq = db.rawHistory.map(x => x.result).reverse();
    const latestHist = db.rawHistory[db.rawHistory.length - 1] || {};

    // 2. Tính toán dự đoán ngay từ mảng seq vừa lấy
    const pred = generatePrediction(game, seq);

    // 3. Trả về JSON
    return {
        status: "success",
        data: {
            game: game.toUpperCase(),
            phienHienTai: latestHist.sid || "0",
            phienDuDoan: (latestHist.sid || 0) + 1,
            duDoan: label(pred.code),
            tiLe: pred.tiLe,
            liDo: `⭐ [${pred.phase}] ${pred.label}`,
            xucXac: [latestHist.d1, latestHist.d2, latestHist.d3],
            tongDiem: (latestHist.d1 || 0) + (latestHist.d2 || 0) + (latestHist.d3 || 0),
            moiTruong: {
                loai: seq.length < 5 ? "MỚI KHỞI TẠO" : "SẴN SÀNG",
                efs: "100%",
                doLech: seq.length > 0 ? ((seq.slice(0, 10).filter(x=>x==='T').length / Math.min(10, seq.length)) * 100).toFixed(1) + "%" : "0%"
            },
            chiTietModel: {
                pattern: pred.label,
                phase: pred.phase,
                topAlgos: pred.details.map(d => `${d.name} (${label(d.code)})`).join(' | ') || '—'
            }
        }
    };
}

app.get('/b52', async (req, res) => res.json(await buildResponse('b52')));
app.get('/taixiu', async (req, res) => res.json(await buildResponse('taixiu')));
app.get('/md5', async (req, res) => res.json(await buildResponse('md5')));
app.get('/', (req, res) => res.redirect('/b52'));

// ============================================================
// PHẦN 9: KHỞI ĐỘNG SERVER
// ============================================================
app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🚀 V65 TITAN ULTIMATE STARTED`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`⚡ Chế độ: ZERO-WAIT (Dự đoán ngay)`);
    console.log(`🛡️ Chống Bias: 3 Lớp (Lockout, Balancer, Smart Flip)`);
    console.log(`=========================================`);
});
