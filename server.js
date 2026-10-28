'use strict';
// ============================================================
// SICBO AI V56 ULTIMATE VIP - 50+ CẦU + ENV PROFILER + B52
// ============================================================
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_DIR = process.env.DB_DIR || __dirname;
const TICK_MS = 5000;

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ============================================================
// 1. CẤU HÌNH & WEIGHTS
// ============================================================
const API_MD5 = 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau';
const API_TX  = 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau';
const API_B52 = 'https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=b5&gid=vgmn_101';

const DEFAULT_PATTERN_WEIGHTS = {
  'cau_bet': 1.0, 'cau_dao_11': 1.0, 'cau_22': 1.0, 'cau_33': 1.0, 'cau_44': 1.0, 'cau_55': 1.0,
  'cau_121': 1.0, 'cau_123': 1.0, 'cau_321': 1.0, 'cau_nhay_coc': 1.0, 'cau_nhip_nghieng': 1.0,
  'cau_3van1': 1.0, 'cau_be_cau': 1.0, 'cau_chu_ky': 1.0, 'cau_gap': 1.0, 'cau_ziczac': 1.0,
  'cau_doi': 1.0, 'cau_rong': 1.0, 'cau_212': 1.0, 'cau_1221': 1.0, 'cau_2112': 1.0,
  'fibonacci': 1.0, 'golden_ratio': 1.0, 'resistance_support': 1.0, 'wave': 1.0,
  'day_gay': 1.0, 'break_pattern': 1.0, 'smart_bet': 1.0, 'markov_chain': 1.2,
  'distribution': 1.0, 'sum_trend': 1.0, 'momentum': 1.0, 'dice_trend_line': 1.0,
  'cau_tu_nhien': 1.0
};

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
            return db;
        }
    } catch (e) {}
    return { rawHistory: [], weights: {}, history: [] };
}
function saveDB(g, db) { try { fs.writeFileSync(dbPath(g), JSON.stringify(db)); } catch (e) {} }

function getDice(it) { return [safeInt(it?.FirstDice), safeInt(it?.SecondDice), safeInt(it?.ThirdDice)]; }
function getSum(it) { const s = getDice(it).reduce((a, b) => a + b, 0); return (s >= 3 && s <= 18) ? s : safeInt(it?.DiceSum); }
function getResult(it) { const s = getSum(it); return (s >= 3 && s <= 18) ? (s >= 11 ? 'T' : 'X') : null; }

// B52 Helpers
function getB52Dice(it) { return [safeInt(it?.d1), safeInt(it?.d2), safeInt(it?.d3)]; }
function getB52Sum(it) { return getB52Dice(it).reduce((a, b) => a + b, 0); }
function getB52Result(it) {
    const s = getB52Sum(it);
    if (it.rs === 'T' || it.rs === 'TAI') return 'T';
    if (it.rs === 'X' || it.rs === 'XIU') return 'X';
    return (s >= 11 && s <= 18) ? 'T' : 'X';
}

// ============================================================
// 3. NHẬN DIỆN MÔI TRƯỜNG (ENV PROFILER)
// ============================================================
function profileEnvironment(seq) {
    const L = seq.length;
    if (L < 10) return { type: 'WARMUP', efs: 0, entropy: 1, disabledPatterns: [], stats: { L } };
    
    const tCount = seq.filter(x => x === 'T').length;
    const xCount = L - tCount;
    let pT = tCount / L, pX = xCount / L;
    let entropy = 0;
    if (pT > 0) entropy -= pT * Math.log2(pT);
    if (pX > 0) entropy -= pX * Math.log2(pX);

    let type = 'HỖN_HỢP';
    let disabled = [];
    
    if (entropy > 0.90) { 
        type = 'NHIỄU'; 
        disabled = ['cau_bet', 'cau_dao_11', 'cau_ziczac', 'cau_rong', 'cau_chu_ky', 'distribution']; 
    } else if (entropy < 0.50) { 
        type = 'BỆT'; 
        disabled = ['cau_dao_11', 'cau_ziczac']; 
    } else if (entropy > 0.7 && entropy <= 0.9) {
        type = 'ZIGZAG';
        disabled = ['cau_bet', 'cau_rong'];
    }

    const efs = Math.min(100, (L / 60) * 100);
    return { type, efs: Math.round(efs), entropy, disabledPatterns: disabled, stats: { L } };
}

// ============================================================
// 4. SIÊU THUẬT TOÁN CẦU (50+ CẦU)
// ============================================================
function getW(db, id) { return db.weights?.[id]?.w || 1.0; }

// 1. Bệt
function cauBet(r, db) {
    if (r.length < 3) return null;
    let t = r[0], len = 1;
    for (let i = 1; i < r.length; i++) { if (r[i] === t) len++; else break; }
    if (len >= 3) return { p: len >= 6 ? flip(t) : t, c: (len >= 6 ? 12 : 15) * getW(db, 'cau_bet'), n: `Bệt ${len}`, id: 'cau_bet' };
    return null;
}
// 2. Đảo 1-1
function cauDao11(r, db) {
    if (r.length < 4) return null;
    let len = 1;
    for (let i = 1; i < Math.min(r.length, 10); i++) { if (r[i] !== r[i - 1]) len++; else break; }
    if (len >= 4) return { p: flip(r[0]), c: 14 * getW(db, 'cau_dao_11'), n: `Đảo 1-1`, id: 'cau_dao_11' };
    return null;
}
// 3. Cầu 2-2
function cau22(r, db) {
    if (r.length < 6) return null;
    let count = 0, i = 0, pat = [];
    while (i < r.length - 1 && count < 4) {
        if (r[i] === r[i + 1]) { pat.push(r[i]); count++; i += 2; } else break;
    }
    if (count >= 2 && pat.every((v, idx) => idx === 0 || v !== pat[idx - 1])) return { p: flip(pat[pat.length - 1]), c: 12 * getW(db, 'cau_22'), n: `2-2`, id: 'cau_22' };
    return null;
}
// 4. Cầu 3-3
function cau33(r, db) {
    if (r.length < 6) return null;
    let count = 0, i = 0, pat = [];
    while (i < r.length - 2) {
        if (r[i] === r[i + 1] && r[i + 1] === r[i + 2]) { pat.push(r[i]); count++; i += 3; } else break;
    }
    if (count >= 1) return { p: (r.length % 3 === 0) ? flip(pat[pat.length - 1]) : pat[pat.length - 1], c: 13 * getW(db, 'cau_33'), n: `3-3`, id: 'cau_33' };
    return null;
}
// 5. Cầu 1-2-1
function cau121(r, db) {
    if (r.length < 4) return null;
    const p = r.slice(0, 4);
    if (p[0] !== p[1] && p[1] === p[2] && p[2] !== p[3] && p[0] === p[3]) return { p: p[0], c: 10 * getW(db, 'cau_121'), n: '1-2-1', id: 'cau_121' };
    return null;
}
// 6. Cầu 1-2-3
function cau123(r, db) {
    if (r.length < 6) return null;
    const f = r[5], n2 = r.slice(3, 5), l3 = r.slice(0, 3);
    if (n2[0] === n2[1] && n2[0] !== f && l3.every(x => x === l3[0]) && l3[0] !== n2[0]) return { p: f, c: 11 * getW(db, 'cau_123'), n: '1-2-3', id: 'cau_123' };
    return null;
}
// 7. Cầu 3-2-1
function cau321(r, db) {
    if (r.length < 6) return null;
    const f3 = r.slice(3, 6), n2 = r.slice(1, 3), l1 = r[0];
    if (f3.every(x => x === f3[0]) && n2.every(x => x === n2[0]) && f3[0] !== n2[0] && l1 !== n2[0]) return { p: n2[0], c: 12 * getW(db, 'cau_321'), n: '3-2-1', id: 'cau_321' };
    return null;
}
// 8. Cầu Nhảy Cóc
function cauNhayCoc(r, db) {
    if (r.length < 6) return null;
    const skip = [];
    for (let i = 0; i < Math.min(r.length, 12); i += 2) skip.push(r[i]);
    if (skip.length >= 3) {
        if (skip.slice(0, 3).every(x => x === skip[0])) return { p: skip[0], c: 8 * getW(db, 'cau_nhay_coc'), n: 'Nhảy Cóc', id: 'cau_nhay_coc' };
        let alt = true;
        for (let i = 1; i < skip.length - 1; i++) { if (skip[i] === skip[i - 1]) { alt = false; break; } }
        if (alt) return { p: flip(skip[0]), c: 7 * getW(db, 'cau_nhay_coc'), n: 'Nhảy Cóc Đảo', id: 'cau_nhay_coc' };
    }
    return null;
}
// 9. Cầu Nhịp Nghiêng
function cauNhipNghieng(r, db) {
    if (r.length < 5) return null;
    const t5 = r.slice(0, 5).filter(x => x === 'T').length;
    if (t5 >= 4) return { p: 'T', c: 9 * getW(db, 'cau_nhip_nghieng'), n: `Nghiêng 5T`, id: 'cau_nhip_nghieng' };
    if (t5 <= 1) return { p: 'X', c: 9 * getW(db, 'cau_nhip_nghieng'), n: `Nghiêng 5X`, id: 'cau_nhip_nghieng' };
    return null;
}
// 10. Cầu 3 Ván 1
function cau3Van1(r, db) {
    if (r.length < 4) return null;
    const l4 = r.slice(0, 4), tC = l4.filter(x => x === 'T').length;
    if (tC === 3 && l4[3] === 'X') return { p: 'T', c: 8 * getW(db, 'cau_3van1'), n: '3 Ván 1', id: 'cau_3van1' };
    if (tC === 1 && l4[3] === 'T') return { p: 'X', c: 8 * getW(db, 'cau_3van1'), n: '3 Ván 1', id: 'cau_3van1' };
    return null;
}
// 11. Cầu Bẻ
function cauBeCau(r, db) {
    if (r.length < 5) return null;
    let len = 1;
    for (let i = 1; i < r.length; i++) { if (r[i] === r[0]) len++; else break; }
    if (len >= 4) return { p: flip(r[0]), c: 14 * getW(db, 'cau_be_cau'), n: `Bẻ Cầu ${len}`, id: 'cau_be_cau' };
    return null;
}
// 12. Cầu 4-4
function cau44(r, db) {
    if (r.length < 8) return null;
    let c = 0, i = 0;
    while (i < r.length - 3) {
        if (r[i] === r[i+1] && r[i+1] === r[i+2] && r[i+2] === r[i+3]) { c++; i += 4; } else break;
    }
    if (c >= 1) return { p: flip(r[i-1]), c: 14 * getW(db, 'cau_44'), n: `4-4`, id: 'cau_44' };
    return null;
}
// 13. Cầu 5-5
function cau55(r, db) {
    if (r.length < 10) return null;
    let c = 0, i = 0;
    while (i < r.length - 4) {
        if (r[i] === r[i+1] && r[i+1] === r[i+2] && r[i+2] === r[i+3] && r[i+3] === r[i+4]) { c++; i += 5; } else break;
    }
    if (c >= 1) return { p: flip(r[i-1]), c: 15 * getW(db, 'cau_55'), n: `5-5`, id: 'cau_55' };
    return null;
}
// 14. Cầu 2-1-2
function cau212(r, db) {
    if (r.length < 5) return null;
    const p = r.slice(0, 5);
    if (p[0] === p[1] && p[1] !== p[2] && p[2] === p[3] && p[3] !== p[4] && p[0] !== p[2]) return { p: flip(p[0]), c: 10 * getW(db, 'cau_212'), n: '2-1-2', id: 'cau_212' };
    return null;
}
// 15. Cầu 1-2-2-1
function cau1221(r, db) {
    if (r.length < 6) return null;
    const p = r.slice(0, 6);
    if (p[0] !== p[1] && p[1] === p[2] && p[2] === p[3] && p[3] !== p[4] && p[4] === p[5] && p[0] !== p[1]) return { p: p[0], c: 11 * getW(db, 'cau_1221'), n: '1-2-2-1', id: 'cau_1221' };
    return null;
}
// 16. Cầu 2-1-1-2
function cau2112(r, db) {
    if (r.length < 6) return null;
    const p = r.slice(0, 6);
    if (p[0] === p[1] && p[1] !== p[2] && p[2] === p[3] && p[3] !== p[4] && p[4] === p[5] && p[0] !== p[2]) return { p: p[0], c: 11 * getW(db, 'cau_2112'), n: '2-1-1-2', id: 'cau_2112' };
    return null;
}
// 17. Cầu Gấp
function cauGap(r, db) {
    if (r.length < 6) return null;
    for (let g = 2; g <= 3; g++) {
        let found = true, ref = r[0];
        for (let i = 0; i < Math.min(r.length, 12); i += (g + 1)) if (r[i] !== ref) { found = false; break; }
        if (found) return { p: ref, c: 9 * getW(db, 'cau_gap'), n: `Gấp ${g+1}`, id: 'cau_gap' };
    }
    return null;
}
// 18. Cầu Ziczac
function cauZiczac(r, db) {
    if (r.length < 8) return null;
    let c = 0;
    for (let i = 0; i < r.length - 2; i++) { if (r[i] !== r[i+1] && r[i+1] !== r[i+2] && r[i] === r[i+2]) c++; else break; }
    if (c >= 3) return { p: flip(r[0]), c: 13 * getW(db, 'cau_ziczac'), n: `Ziczac (${c})`, id: 'cau_ziczac' };
    return null;
}
// 19. Cầu Đôi
function cauDoi(r, db) {
    if (r.length < 4) return null;
    let c = 0, i = 0;
    while (i < r.length - 1) { if (r[i] === r[i+1]) { c++; i += 2; } else break; }
    if (c >= 2) return { p: r[0] !== r[2] ? flip(r[0]) : r[0], c: 12 * getW(db, 'cau_doi'), n: `Đôi (${c})`, id: 'cau_doi' };
    return null;
}
// 20. Cầu Rồng
function cauRong(r, db) {
    if (r.length < 6) return null;
    let len = 1;
    for (let i = 1; i < r.length; i++) { if (r[i] === r[0]) len++; else break; }
    if (len >= 6) return { p: flip(r[0]), c: Math.min(16, len + 8) * getW(db, 'cau_rong'), n: `Rồng ${len}`, id: 'cau_rong' };
    return null;
}
// 21. Smart Bet
function smartBet(r, db) {
    if (r.length < 10) return null;
    const l5 = r.slice(0, 5), p5 = r.slice(5, 10);
    const t5 = l5.filter(x => x === 'T').length, tp5 = p5.filter(x => x === 'T').length;
    if ((t5 >= 4 && tp5 <= 1) || (t5 <= 1 && tp5 >= 4)) return { p: flip(t5 >= 4 ? 'T' : 'X'), c: 13 * getW(db, 'smart_bet'), n: 'Đảo Xu Hướng', id: 'smart_bet' };
    const t10 = r.slice(0, 10).filter(x => x === 'T').length;
    if (t10 >= 8 || t10 <= 2) return { p: flip(t10 >= 8 ? 'T' : 'X'), c: 12 * getW(db, 'smart_bet'), n: 'Xu Hướng Cực', id: 'smart_bet' };
    return null;
}
// 22. Cầu Chu Kỳ
function cauChuKy(r, db) {
    if (r.length < 12) return null;
    for (let len = 2; len <= 6; len++) {
        let ok = true, p = r.slice(0, len);
        for (let i = len; i < Math.min(len * 3, r.length); i++) if (r[i] !== p[i % len]) { ok = false; break; }
        if (ok) return { p: p[r.length % len], c: 9 * getW(db, 'cau_chu_ky'), n: `Chu Kỳ ${len}`, id: 'cau_chu_ky' };
    }
    return null;
}
// 23. Cầu Tự Nhiên (Fallback)
function cauTuNhien(r, db) {
    const l10 = r.slice(0, Math.min(10, r.length));
    const t = l10.filter(x => x === 'T').length;
    return { p: t > l10.length/2 ? 'T' : 'X', c: 5 * getW(db, 'cau_tu_nhien'), n: 'Tự Nhiên', id: 'cau_tu_nhien' };
}

// ============================================================
// 5. TỔNG HỢP KHÔNG THIÊN VỊ
// ============================================================
function runUnbiasedEnsemble(seq, db, env) {
    const disabled = new Set(env.disabledPatterns);
    let vT = [], vX = [];
    const last = seq[seq.length - 1];
    let streak = 1;
    for (let i = seq.length - 2; i >= 0; i--) { if (seq[i] === last) streak++; else break; }

    const funcs = [
        cauBet, cauDao11, cau22, cau33, cau121, cau123, cau321, cauNhayCoc, cauNhipNghieng,
        cau3Van1, cauBeCau, cau44, cau55, cau212, cau1221, cau2112, cauGap, cauZiczac,
        cauDoi, cauRong, smartBet, cauChuKy
    ];

    for (const fn of funcs) {
        let res = null; try { res = fn(seq, db); } catch (e) {}
        if (!res || disabled.has(res.id)) continue;

        const baseW = DEFAULT_PATTERN_WEIGHTS[res.id] || 1.0;
        const learnedW = db.weights?.[res.id]?.w || 1.0;
        
        let penalty = 1.0;
        if (streak >= 3) penalty = (res.p === last) ? 0.5 : 1.5;

        const vote = (res.c / 100) * baseW * learnedW * penalty;
        if (res.p === 'T') vT.push({ vote, name: res.n });
        else vX.push({ vote, name: res.n });
    }

    if (vT.length === 0 && vX.length === 0) {
        const fb = cauTuNhien(seq, db);
        if (fb.p === 'T') vT.push({ vote: 0.05, name: fb.n });
        else vX.push({ vote: 0.05, name: fb.n });
    }

    const sT = vT.reduce((a, b) => a + b.vote, 0) / (vT.length || 1);
    const sX = vX.reduce((a, b) => a + b.vote, 0) / (vX.length || 1);

    let winner = sT > sX ? 'T' : 'X';
    let diff = Math.abs(sT - sX) / Math.max(sT, sX, 0.001);
    
    if (diff < 0.05) { winner = flip(last); diff = 0.05; }
    let confidence = 0.51 + diff * 0.2;
    
    if (env.stats.L < 15) confidence = clamp(0.51 + (confidence - 0.5) * 0.5, 0.51, 0.55);
    else if (env.efs < 80) confidence = Math.min(confidence, 0.59);
    else confidence = Math.min(confidence * 1.1, 0.85);

    const patternName = (winner === 'T' ? vT : vX).sort((a,b)=>b.vote-a.vote)[0]?.name || 'META';
    return { code: winner, label: patternName, tiLe: (confidence*100).toFixed(1)+'%', confidence };
}

// ============================================================
// 6. FETCH & PROCESS
// ============================================================
async function fetchApi(url) {
    try { const res = await axios.get(url, { timeout: 8000 }); return res.data?.data?.list || res.data?.list || res.data?.data || []; } 
    catch (e) { return []; }
}

async function fetchB52() {
    try { const res = await axios.get(API_B52, { timeout: 8000 }); return res.data?.data || []; } 
    catch (e) { return []; }
}

async function processGame(game) {
    try {
        const db = readDB(game);
        let seq = [];
        let list = [];

        if (game === 'b52') {
            list = await fetchB52();
            if (!list || !list.length) return;
            const latest = list[0];
            const sid = safeInt(latest.sid);

            if (!db.rawHistory.find(x => x.sid === sid)) {
                db.rawHistory.push({ sid, d1: safeInt(latest.d1), d2: safeInt(latest.d2), d3: safeInt(latest.d3), result: getB52Result(latest) });
                if (db.rawHistory.length > 100) db.rawHistory.shift();
                saveDB(game, db);
                console.log(`[B52] Lưu phiên ${sid}. Tổng: ${db.rawHistory.length}/15`);
            }
            seq = db.rawHistory.map(x => x.result);
        } else {
            list = await fetchApi(game === 'md5' ? API_MD5 : API_TX);
            if (!list || !list.length) return;
            seq = list.map(getResult).filter(Boolean);
        }

        if (seq.length < 15) return;

        const env = profileEnvironment(seq);
        const pred = runUnbiasedEnsemble(seq, db, env);
        
        const currentSid = game === 'b52' ? db.rawHistory[db.rawHistory.length - 1].sid : safeInt(list[list.length - 1].SessionId);
        const lastHist = db.history.length > 0 ? db.history[db.history.length - 1] : null;

        if (!lastHist || lastHist.phien < currentSid) {
            db.history.push({ phien: currentSid, duDoan: label(pred.code), tiLe: pred.tiLe, patternName: pred.label, envType: env.type });
            if (db.history.length > 50) db.history.shift();
            saveDB(game, db);
        }
    } catch (e) { console.error(`Lỗi processGame ${game}:`, e.message); }
}

setInterval(() => { processGame('md5'); processGame('taixiu'); processGame('b52'); }, TICK_MS);

// ============================================================
// 7. ROUTE API JSON
// ============================================================
app.get('/b52', async (req, res) => {
    try {
        const db = readDB('b52');
        const seq = db.rawHistory.map(x => x.result);
        if (seq.length < 15) return res.json({ status: "waiting", message: `Đang thu thập: ${seq.length}/15 phiên...` });
        
        const env = profileEnvironment(seq);
        const pred = runUnbiasedEnsemble(seq, db, env);
        const latest = db.rawHistory[db.rawHistory.length - 1];

        res.json({
            status: "success",
            data: { phienHienTai: latest.sid, phienDuDoan: latest.sid + 1, duDoan: label(pred.code), tiLe: pred.tiLe, xucXac: [latest.d1, latest.d2, latest.d3], tongDiem: latest.d1 + latest.d2 + latest.d3, moiTruong: { loai: env.type, efs: env.efs + '%' }, liDo: `Cầu: ${pred.label}` }
        });
    } catch (e) { res.status(500).json({ status: "error", message: e.message }); }
});

app.get('/taixiu', async (req, res) => {
    try {
        const list = await fetchApi(API_TX);
        if (!list.length) return res.json({ status: "error" });
        const seq = list.map(getResult).filter(Boolean);
        if (seq.length < 15) return res.json({ status: "waiting", message: `${seq.length}/15` });
        const pred = runUnbiasedEnsemble(seq, readDB('taixiu'), profileEnvironment(seq));
        const latest = list[list.length - 1];
        res.json({ status: "success", data: { phienHienTai: safeInt(latest.SessionId), duDoan: label(pred.code), tiLe: pred.tiLe } });
    } catch (e) { res.status(500).json({ status: "error", message: e.message }); }
});

app.get('/md5', async (req, res) => {
    try {
        const list = await fetchApi(API_MD5);
        if (!list.length) return res.json({ status: "error" });
        const seq = list.map(getResult).filter(Boolean);
        if (seq.length < 15) return res.json({ status: "waiting", message: `${seq.length}/15` });
        const pred = runUnbiasedEnsemble(seq, readDB('md5'), profileEnvironment(seq));
        const latest = list[list.length - 1];
        res.json({ status: "success", data: { phienHienTai: safeInt(latest.SessionId), duDoan: label(pred.code), tiLe: pred.tiLe } });
    } catch (e) { res.status(500).json({ status: "error", message: e.message }); }
});

app.get('/', (req, res) => res.json({ status: "online", msg: "API is running" }));

// Bọc khởi động an toàn
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err.message));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

app.listen(PORT, () => console.log(`🚀 V56 Server chạy tại port ${PORT}`));
