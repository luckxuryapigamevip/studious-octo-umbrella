'use strict';

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();

// ========================================================================
// [1] CONFIG & MIDDLEWARE
// ========================================================================
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
});

const PORT = process.env.PORT || 3000;
const API_MD5 = 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau';
const API_TX = 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau';
const DB_DIR = process.env.DB_DIR || __dirname;
const TICK_MS = 5000;

if (!fs.existsSync(DB_DIR)) {
    try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch (e) {}
}

// ========================================================================
// [2] HELPERS & DATABASE
// ========================================================================
function safeInt(x, def = 0) {
    const n = parseInt(x, 10);
    return Number.isFinite(n) ? n : def;
}
const getLabel = c => c === 'T' ? 'Tài' : (c === 'X' ? 'Xỉu' : null);
const flip = c => c === 'T' ? 'X' : (c === 'X' ? 'T' : null);

function readDB(game) {
    const p = path.join(DB_DIR, `db_v19_${game}.json`);
    try {
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {}
    return { history: [], lastSession: null, algoStats: {} };
}
function saveDB(game, db) {
    const p = path.join(DB_DIR, `db_v19_${game}.json`);
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

// ========================================================================
// [3] KHO THUẬT TOÁN TINH TÚY (CHỈ GIỮ LẠI NHỮNG CÁI TỐT NHẤT)
// ========================================================================
class EliteAlgorithms {
    // 1. TÌM CHU KỲ LẶP LẠI (CYCLE PATTERN)
    // Nhà cái thường lặp lại chu kỳ 2-4-6-8-10 phiên. Cái này cực kỳ chuẩn.
    static cycle(seq) {
        const n = seq.length;
        if (n < 10) return null;
        const cycles = [2, 3, 4, 5, 6, 8, 10];
        let bestMatch = { p: 0, ratio: 0, code: null };
        
        for (const p of cycles) {
            if (n < p * 2) continue;
            let match = 0;
            const checkLength = Math.min(p * 2, n - 1);
            for (let i = n - checkLength; i < n; i++) {
                if (seq[i] === seq[i - p]) match++;
            }
            const ratio = match / checkLength;
            if (ratio > bestMatch.ratio) {
                bestMatch = { p, ratio, code: seq[n - p] };
            }
        }
        
        if (bestMatch.ratio >= 0.85) {
            return { code: bestMatch.code, name: `CYCLE-${bestMatch.p}`, conf: bestMatch.ratio, id: `cycle_${bestMatch.p}` };
        }
        return null;
    }

    // 2. N-GRAM (TÌM CHUỖI TƯƠNG ĐỒNG)
    static ngram(seq) {
        const n = seq.length;
        const len = 4; // Tìm 4 phiên gần nhất giống với quá khứ
        if (n < len + 10) return null;
        
        const tail = seq.slice(-len).join('');
        let t = 0, x = 0, occ = 0;
        
        for (let i = 0; i <= n - len - 1; i++) {
            if (seq.slice(i, i + len).join('') === tail) {
                occ++;
                if (seq[i + len] === 'T') t++;
                else x++;
            }
        }
        
        if (occ >= 2) {
            const conf = Math.max(t, x) / occ;
            if (conf >= 0.65) {
                return { code: t > x ? 'T' : 'X', name: `NGRAM`, conf: conf, id: 'ngram_4' };
            }
        }
        return null;
    }

    // 3. BẺ CẦU BỆT (STREAK BREAKER)
    // Nếu bệt 4-5 phiên, tỷ lệ gãy cực cao.
    static streakBreaker(seq) {
        const n = seq.length;
        if (n < 5) return null;
        const last = seq[n - 1];
        let len = 1;
        for (let i = n - 2; i >= 0; i--) {
            if (seq[i] === last) len++;
            else break;
        }
        
        // Bệt 4 thì 75% gãy, bệt 5 thì 85% gãy
        if (len === 4) return { code: flip(last), name: `BREAK-4`, conf: 0.75, id: 'streak_break_4' };
        if (len === 5) return { code: flip(last), name: `BREAK-5`, conf: 0.85, id: 'streak_break_5' };
        if (len >= 6) return { code: last, name: `BỆT-TIẾP`, conf: 0.65, id: 'streak_continue_6' }; // Bệt quá dài thì đánh tiếp
        return null;
    }

    // 4. CẦU ĐẢO 1-1 (BOUNDING)
    static bounce(seq) {
        const n = seq.length;
        if (n < 6) return null;
        // Kiểm tra 6 phiên gần nhất có đảo liên tục không
        let isBounce = true;
        for (let i = n - 6; i < n - 1; i++) {
            if (seq[i] === seq[i + 1]) {
                isBounce = false;
                break;
            }
        }
        if (isBounce) {
            return { code: flip(seq[n - 1]), name: `BOUNCE`, conf: 0.72, id: 'bounce' };
        }
        return null;
    }

    // 5. MARKOV CHAIN (TRẠNG THÁI 3 PHIÊN)
    static markov3(seq) {
        const n = seq.length;
        if (n < 15) return null;
        const key = seq.slice(-3).join('');
        let t = 0, x = 0;
        for (let i = 3; i < n; i++) {
            if (seq.slice(i - 3, i).join('') === key) {
                if (seq[i] === 'T') t++;
                else x++;
            }
        }
        const total = t + x;
        if (total >= 3) {
            const conf = Math.max(t, x) / total;
            if (conf >= 0.7) {
                return { code: t > x ? 'T' : 'X', name: `MARKOV-3`, conf: conf, id: 'markov_3' };
            }
        }
        return null;
    }

    // 6. ĐỘ LỆCH PHA (DISTRIBUTION BIAS)
    // Trong 20 phiên, nếu Tài ra quá ít (dưới 30%), khả năng cao sắp bù Tài
    static distribution(seq) {
        const n = seq.length;
        if (n < 20) return null;
        const recent = seq.slice(-20);
        const tCount = recent.filter(x => x === 'T').length;
        const tRatio = tCount / 20;
        
        if (tRatio <= 0.3) return { code: 'T', name: `DIST-BIAS-T`, conf: 0.65, id: 'dist_t' };
        if (tRatio >= 0.7) return { code: 'X', name: `DIST-BIAS-X`, conf: 0.65, id: 'dist_x' };
        return null;
    }
}

// ========================================================================
// [4] META ENGINE (BỘ NÃO QUYẾT ĐỊNH CHỐNG BẪY)
// ========================================================================
function runMetaEngine(seq, db, session) {
    const candidates = [
        EliteAlgorithms.cycle(seq),
        EliteAlgorithms.ngram(seq),
        EliteAlgorithms.streakBreaker(seq),
        EliteAlgorithms.bounce(seq),
        EliteAlgorithms.markov3(seq),
        EliteAlgorithms.distribution(seq)
    ].filter(Boolean);

    const votes = { T: 0, X: 0 };
    const details = [];

    // 1. Quét và lọc những thuật toán có tỷ lệ thắng tốt
    for (const algo of candidates) {
        const stats = db.algoStats?.[algo.id] || { wins: 0, total: 0 };
        let weight = 1.0;
        
        // Thuật toán nào sai nhiều thì giảm trọng số, đúng nhiều thì tăng
        if (stats.total >= 5) {
            const winRate = stats.wins / stats.total;
            weight = winRate > 0.6 ? 1.5 : (winRate < 0.4 ? 0.5 : 1.0);
        }

        const voteValue = algo.conf * weight;
        votes[algo.code] += voteValue;
        details.push({
            algo: algo.id,
            family: 'elite',
            code: algo.code,
            name: algo.name,
            conf: +algo.conf.toFixed(3),
            vote: +voteValue.toFixed(3)
        });
    }

    const totalVotes = votes.T + votes.X;
    let winner, confidence, gap, pT, pX, loserShare, decisionPath, biasForced;

    // 2. Nếu không có tín hiệu (Cầu nhiễu) -> Đánh theo xu hướng nhẹ
    if (totalVotes === 0) {
        const recent = seq.slice(-10);
        const tCount = recent.filter(x => x === 'T').length;
        winner = tCount <= 5 ? 'T' : 'X';
        confidence = 0.51;
        pT = winner === 'T' ? 0.51 : 0.49;
        pX = winner === 'X' ? 0.51 : 0.49;
        gap = 0.02;
        loserShare = 0.49;
        decisionPath = 'NORMAL';
        biasForced = false;
        details.push({ algo: 'default', family: 'sys', code: winner, name: 'MẶC-ĐỊNH', conf: 0.51, vote: 1 });
    } else {
        pT = votes.T / totalVotes;
        pX = votes.X / totalVotes;
        gap = Math.abs(pT - pX);
        winner = pT > pX ? 'T' : 'X';
        confidence = Math.max(pT, pX);
        loserShare = Math.min(pT, pX);
        decisionPath = 'NORMAL';
        biasForced = false;

        // 3. CHỐNG BẪY: Nếu gap > 0.8 (quá chênh lệch), nhà cái đang gài bẫy. Bẻ lại!
        if (gap > 0.8 && confidence > 0.8) {
            biasForced = true;
            decisionPath = 'TRAP_AVOIDED';
            winner = flip(winner); // Đảo ngược
            confidence = 0.60; // Hạ tỷ lệ xuống
        }
    }

    // Giới hạn tỷ lệ ảo (Max 85%)
    confidence = Math.min(Math.max(confidence, 0.50), 0.85);
    const isWeak = confidence < 0.60;
    const isVeryWeak = confidence <= 0.55;

    const topAlgo = details.filter(d => d.code === winner).sort((a, b) => b.vote - a.vote)[0];
    const reasonLabel = topAlgo ? `META·${topAlgo.name}` : 'META';

    return {
        code: winner,
        label: reasonLabel,
        tiLe: (confidence * 100).toFixed(1) + '%',
        weak: isWeak,
        veryWeak: isVeryWeak,
        decisionPath,
        biasForced,
        balance: {
            votesT: +votes.T.toFixed(3),
            votesX: +votes.X.toFixed(3),
            gap: +gap.toFixed(3),
            pT: +pT.toFixed(3),
            pX: +pX.toFixed(3),
            loserShare: +loserShare.toFixed(3)
        },
        details
    };
}

// ========================================================================
// [5] XỬ LÝ FETCH API & LƯU LỊCH SỬ
// ========================================================================
async function fetchApi(url) {
    for (let i = 0; i < 3; i++) {
        try {
            const res = await axios.get(url, { timeout: 8000 });
            let arr = res.data?.data?.list || res.data?.list || res.data?.data || [];
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
    if (!list || list.length < 15) return;

    const latest = list[list.length - 1], session = safeInt(latest.SessionId);
    const db = readDB(game);
    if (db.lastSession === session) return;

    const seq = list.map(getResult).filter(Boolean);
    
    // Cập nhật tỷ lệ thắng/thua cho từng thuật toán
    const prev = db.history[db.history.length - 1];
    if (prev && safeInt(prev.phienDuDoan) === session) {
        const actual = getResult(latest);
        prev.ketQua = actual;
        prev.ketQuaLabel = getLabel(actual);
        prev.trangThai = prev.DU_DOAN_CODE === actual ? 'ĐÚNG' : 'SAI';
        
        // Lưu stats cho thuật toán
        if (!db.algoStats) db.algoStats = {};
        for (const d of prev.algoDetails) {
            if (!db.algoStats[d.algo]) db.algoStats[d.algo] = { wins: 0, total: 0 };
            db.algoStats[d.algo].total++;
            if (d.code === actual) db.algoStats[d.algo].wins++;
        }
    }

    const pred = runMetaEngine(seq, db, session + 1);

    db.history.push({
        phien: session,
        xucXac: getDice(latest),
        tong: getSum(latest),
        ketQua: getResult(latest),
        ketQuaLabel: getLabel(getResult(latest)),
        phienDuDoan: session + 1,
        DU_DOAN_CODE: pred.code,
        DU_DOAN: getLabel(pred.code),
        TI_LE: pred.tiLe,
        patternName: pred.label,
        algoDetails: pred.details,
        weak: pred.weak,
        veryWeak: pred.veryWeak,
        trangThai: 'ĐANG CHỜ'
    });

    db.lastSession = session;
    saveDB(game, db);
}

setInterval(() => { processGame('md5'); processGame('taixiu'); }, TICK_MS);

// ========================================================================
// [6] ROUTES API
// ========================================================================
app.get('/', (req, res) => res.redirect('/history/md5'));

app.get('/:game(md5|taixiu)', async (req, res) => {
    const game = req.params.game;
    const list = await fetchApi(game === 'md5' ? API_MD5 : API_TX);
    if (!list) return res.status(500).json({ error: 'API Error' });

    const latest = list[list.length - 1], session = safeInt(latest.SessionId);
    const seq = list.map(getResult).filter(Boolean);
    const db = readDB(game);
    const pred = runMetaEngine(seq, db, session + 1);

    res.json({
        success: true, game, phien: session,
        xucXac: getDice(latest), tong: getSum(latest),
        ketQua: getResult(latest), ketQuaLabel: getLabel(getResult(latest)),
        phienDuDoan: session + 1, duDoan: getLabel(pred.code),
        duDoanCode: pred.code, tiLe: pred.tiLe, reason: pred.label,
        weak: pred.weak, veryWeak: pred.veryWeak,
        decisionPath: pred.decisionPath, biasForced: pred.biasForced,
        balance: pred.balance, algoVotes: pred.details
    });
});

// ========================================================================
// [7] UI HISTORY (GIAO DIỆN THEO DÕI)
// ========================================================================
app.get('/history/:game(md5|taixiu)', (req, res) => {
    const game = req.params.game;
    const db = readDB(game);
    const rows = db.history.slice(-50).reverse();

    const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const correct = settled.filter(h => h.trangThai === 'ĐÚNG').length;
    const acc = settled.length ? (correct / settled.length * 100).toFixed(1) : '0.0';

    const html = `<!DOCTYPE html>
    <html lang="vi">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
    <title>AI HISTORY - ${game.toUpperCase()}</title>
    <style>
      body { font-family: -apple-system, sans-serif; background: #000; color: #fff; padding: 15px; margin: 0; }
      .header { text-align: center; margin-bottom: 20px; }
      .acc { font-size: 28px; font-weight: bold; color: ${parseFloat(acc) >= 55 ? '#22c55e' : '#ef4444'}; }
      .table-wrap { background: #111; border-radius: 10px; overflow-x: auto; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th { background: #222; padding: 12px 5px; text-align: left; color: #888; }
      td { padding: 12px 5px; border-bottom: 1px solid #222; text-align: left; }
      .T { color: #22c55e; font-weight: bold; }
      .X { color: #ef4444; font-weight: bold; }
      .dung { color: #22c55e; } .sai { color: #ef4444; } .cho { color: #eab308; }
      .badge { background: #333; padding: 2px 6px; border-radius: 4px; font-size: 11px; }
    </style>
    <script>setTimeout(()=>location.reload(), 5000);</script>
    </head>
    <body>
      <div class="header">
        <h2>ĐỘ CHÍNH XÁC: <span class="acc">${acc}%</span></h2>
        <p>Tổng: ${settled.length} phiên</p>
      </div>
      <div class="table-wrap">
        <table>
          <tr><th>Phiên</th><th>XX</th><th>KQ</th><th>Dự Đoán</th><th>Cầu</th><th>TT</th></tr>
          ${rows.map(it => `
            <tr>
              <td>${it.phien}</td>
              <td>${(it.xucXac||[]).join('-')}</td>
              <td class="${it.ketQua}">${it.ketQuaLabel}</td>
              <td class="${it.DU_DOAN_CODE}">${it.DU_DOAN} (${it.TI_LE})</td>
              <td><span class="badge">${it.patternName}</span></td>
              <td class="${it.trangThai === 'ĐÚNG' ? 'dung' : (it.trangThai === 'SAI' ? 'sai' : 'cho')}">${it.trangThai}</td>
            </tr>
          `).join('')}
        </table>
      </div>
    </body>
    </html>`;
    res.send(html);
});

app.listen(PORT, () => console.log(`🚀 AI V19 REAL ALPHA chạy port ${PORT}`));
