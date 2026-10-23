'use strict';

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.json());

const CONFIG = {
    PORT: process.env.PORT || 3000,
    HOST: '0.0.0.0', 
    API: {
        MD5: 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau',
        TAIXIU: 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau'
    },
    DB_DIR: process.env.RENDER ? '/tmp' : __dirname,
    TICK_MS: 8000, 
    MAX_HISTORY: 1000
};

if (!fs.existsSync(CONFIG.DB_DIR)) {
    try { fs.mkdirSync(CONFIG.DB_DIR, { recursive: true }); } catch (e) {}
}

process.on('uncaughtException', (err) => console.error('[FATAL] Uncaught:', err.message));
process.on('unhandledRejection', (reason) => console.error('[FATAL] Rejection:', reason));

// ========================================================================
// HELPERS
// ========================================================================
class Helper {
    static safeInt(val, def = 0) {
        const parsed = parseInt(val, 10);
        return Number.isFinite(parsed) ? parsed : def;
    }
    static clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }
    static getLabel(code) { return code === 'T' ? 'Tài' : (code === 'X' ? 'Xỉu' : null); }
    static flip(code) { return code === 'T' ? 'X' : (code === 'X' ? 'T' : null); }
    
    static getDice(item) {
        return [this.safeInt(item?.FirstDice), this.safeInt(item?.SecondDice), this.safeInt(item?.ThirdDice)];
    }
    static getSum(item) {
        const s = this.getDice(item).reduce((a, b) => a + b, 0);
        return (s >= 3 && s <= 18) ? s : this.safeInt(item?.DiceSum);
    }
    static getResult(item) {
        const s = this.getSum(item);
        return (s >= 3 && s <= 18) ? (s >= 11 ? 'T' : 'X') : null;
    }
}

// ========================================================================
// DATABASE
// ========================================================================
class DB {
    static getFilePath(game) { return path.join(CONFIG.DB_DIR, `db_v21_${game}.json`); }
    
    static load(game) {
        const file = this.getFilePath(game);
        try {
            if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {}
        return { history: [], lastSession: null, algoStats: {}, streakStats: { T: {}, X: {} } };
    }
    
    static save(game, db) {
        const file = this.getFilePath(game);
        try {
            if (db.history.length > CONFIG.MAX_HISTORY) db.history = db.history.slice(-CONFIG.MAX_HISTORY);
            fs.writeFileSync(file, JSON.stringify(db, null, 2), 'utf8');
        } catch (e) {}
    }
    
    static updateStreak(seq, db) {
        if (!db.streakStats) db.streakStats = { T: {}, X: {} };
        if (seq.length === 0) return;
        let curSide = seq[0], curLen = 1;
        for (let i = 1; i < seq.length; i++) {
            if (seq[i] === curSide) curLen++;
            else {
                if (!db.streakStats[curSide][curLen]) db.streakStats[curSide][curLen] = { cont: 0, stop: 0 };
                db.streakStats[curSide][curLen].stop++;
                for (let l = 1; l < curLen; l++) {
                    if (!db.streakStats[curSide][l]) db.streakStats[curSide][l] = { cont: 0, stop: 0 };
                    db.streakStats[curSide][l].cont++;
                }
                curSide = seq[i]; curLen = 1;
            }
        }
    }
}

// ========================================================================
// ALGORITHMS (GIỮ NGUYÊN CÁC THUẬT TOÁN TỐT NHẤT)
// ========================================================================
class Algos {
    static cycle(seq) {
        if (seq.length < 10) return null;
        const cycles = [2, 3, 4, 5, 6, 8, 10];
        let best = { p: 0, ratio: 0, code: null };
        for (const p of cycles) {
            if (seq.length < p * 2) continue;
            let match = 0, len = Math.min(p * 2, seq.length - 1);
            for (let i = seq.length - len; i < seq.length; i++) if (seq[i] === seq[i - p]) match++;
            const ratio = match / len;
            if (ratio > best.ratio) best = { p, ratio, code: seq[seq.length - p] };
        }
        if (best.ratio >= 0.85) return { code: best.code, name: `CYCLE-${best.p}`, conf: best.ratio, id: `cycle_${best.p}` };
        return null;
    }
    static ngram(seq) {
        if (seq.length < 15) return null;
        const len = 4, tail = seq.slice(-len).join('');
        let t = 0, x = 0, occ = 0;
        for (let i = 0; i <= seq.length - len - 1; i++) {
            if (seq.slice(i, i + len).join('') === tail) { occ++; if (seq[i + len] === 'T') t++; else x++; }
        }
        if (occ >= 2) {
            const conf = Math.max(t, x) / occ;
            if (conf >= 0.65) return { code: t > x ? 'T' : 'X', name: `NGRAM`, conf, id: 'ngram_4' };
        }
        return null;
    }
    static streak(seq) {
        if (seq.length < 5) return null;
        const last = seq[seq.length - 1];
        let len = 1;
        for (let i = seq.length - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
        if (len === 4) return { code: Helper.flip(last), name: `BREAK-4`, conf: 0.75, id: 'streak_break_4' };
        if (len === 5) return { code: Helper.flip(last), name: `BREAK-5`, conf: 0.85, id: 'streak_break_5' };
        if (len >= 6) return { code: last, name: `BỆT-TIẾP`, conf: 0.65, id: 'streak_continue_6' };
        return null;
    }
    static bounce(seq) {
        if (seq.length < 6) return null;
        let isBounce = true;
        for (let i = seq.length - 6; i < seq.length - 1; i++) if (seq[i] === seq[i + 1]) { isBounce = false; break; }
        if (isBounce) return { code: Helper.flip(seq[seq.length - 1]), name: `BOUNCE`, conf: 0.72, id: 'bounce' };
        return null;
    }
    static markov(seq) {
        if (seq.length < 15) return null;
        const key = seq.slice(-3).join('');
        let t = 0, x = 0;
        for (let i = 3; i < seq.length; i++) {
            if (seq.slice(i - 3, i).join('') === key) { if (seq[i] === 'T') t++; else x++; }
        }
        const total = t + x;
        if (total >= 3) {
            const conf = Math.max(t, x) / total;
            if (conf >= 0.7) return { code: t > x ? 'T' : 'X', name: `MARKOV-3`, conf, id: 'markov_3' };
        }
        return null;
    }
    static dist(seq) {
        if (seq.length < 20) return null;
        const recent = seq.slice(-20), tCount = recent.filter(x => x === 'T').length, ratio = tCount / 20;
        if (ratio <= 0.3) return { code: 'T', name: `DIST-T`, conf: 0.65, id: 'dist_t' };
        if (ratio >= 0.7) return { code: 'X', name: `DIST-X`, conf: 0.65, id: 'dist_x' };
        return null;
    }
}

// ========================================================================
// META ENGINE
// ========================================================================
class MetaEngine {
    static run(seq, db) {
        const candidates = [
            Algos.cycle(seq), Algos.ngram(seq), Algos.streak(seq),
            Algos.bounce(seq), Algos.markov(seq), Algos.dist(seq)
        ].filter(Boolean);

        const votes = { T: 0, X: 0 }, details = [];
        for (const algo of candidates) {
            const stats = db.algoStats?.[algo.id] || { wins: 0, total: 0 };
            let weight = 1.0;
            if (stats.total >= 5) {
                const winRate = stats.wins / stats.total;
                weight = winRate > 0.6 ? 1.5 : (winRate < 0.4 ? 0.5 : 1.0);
            }
            const voteValue = algo.conf * weight;
            votes[algo.code] += voteValue;
            details.push({ algo: algo.id, family: 'elite', code: algo.code, name: algo.name, conf: +algo.conf.toFixed(3), vote: +voteValue.toFixed(3) });
        }

        const totalVotes = votes.T + votes.X;
        let winner, confidence, gap, pT, pX, loserShare, decisionPath, biasForced;

        if (totalVotes === 0) {
            const recent = seq.slice(-10), tCount = recent.filter(x => x === 'T').length;
            winner = tCount <= 5 ? 'T' : 'X';
            confidence = 0.51; pT = winner === 'T' ? 0.51 : 0.49; pX = winner === 'X' ? 0.51 : 0.49;
            gap = 0.02; loserShare = 0.49; decisionPath = 'NORMAL'; biasForced = false;
            details.push({ algo: 'default', family: 'sys', code: winner, name: 'MẶC-ĐỊNH', conf: 0.51, vote: 1 });
        } else {
            pT = votes.T / totalVotes; pX = votes.X / totalVotes;
            gap = Math.abs(pT - pX); winner = pT > pX ? 'T' : 'X';
            confidence = Math.max(pT, pX); loserShare = Math.min(pT, pX);
            decisionPath = 'NORMAL'; biasForced = false;
            if (gap > 0.8 && confidence > 0.8) {
                biasForced = true; decisionPath = 'TRAP_AVOIDED';
                winner = Helper.flip(winner); confidence = 0.60;
            }
        }

        confidence = Helper.clamp(confidence, 0.50, 0.85);
        const isWeak = confidence < 0.60, isVeryWeak = confidence <= 0.55;
        const topAlgo = details.filter(d => d.code === winner).sort((a, b) => b.vote - a.vote)[0];
        const reasonLabel = topAlgo ? `META·${topAlgo.name}` : 'META';

        return {
            code: winner, label: reasonLabel, tiLe: (confidence * 100).toFixed(1) + '%',
            weak: isWeak, veryWeak: isVeryWeak, decisionPath, biasForced,
            balance: {
                votesT: +votes.T.toFixed(3), votesX: +votes.X.toFixed(3), gap: +gap.toFixed(3),
                pT: +pT.toFixed(3), pX: +pX.toFixed(3), loserShare: +loserShare.toFixed(3)
            }, details
        };
    }
}

// ========================================================================
// WORKER (FIX LỖI 502 VÀ BYPASS API)
// ========================================================================
class Worker {
    static async fetchData(url) {
        for (let i = 0; i < 3; i++) {
            try {
                const res = await axios.get(url, { 
                    timeout: 15000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'application/json, text/plain, */*',
                        'Referer': 'https://taixiu.maksh3979madfw.com/',
                        'Origin': 'https://taixiu.maksh3979madfw.com'
                    }
                });
                let arr = res.data?.data?.list || res.data?.list || res.data?.data || (Array.isArray(res.data) ? res.data : []);
                if (!Array.isArray(arr) || arr.length === 0) throw new Error("Mảng rỗng");
                
                if (arr.length >= 2 && Number(arr[0].SessionId) > Number(arr[arr.length - 1].SessionId)) arr.reverse();
                return arr;
            } catch (e) {
                console.warn(`[API] Thử lại lần ${i+1}: ${e.message}`);
                if (i === 2) return []; 
                await new Promise(r => setTimeout(r, 1000));
            }
        }
        return [];
    }

    static async processGame(game) {
        try {
            const url = game === 'md5' ? CONFIG.API.MD5 : CONFIG.API.TAIXIU;
            const list = await this.fetchData(url);
            
            // Nếu API gốc lỗi (mảng rỗng), bỏ qua không làm gì cả, giữ nguyên DB cũ
            if (!list || list.length < 10) return; 

            const latest = list[list.length - 1];
            const session = Helper.safeInt(latest.SessionId);
            const db = DB.load(game);

            if (db.lastSession === session) return;
            const seq = list.map(Helper.getResult).filter(Boolean);
            DB.updateStreak(seq, db);

            const prev = db.history[db.history.length - 1];
            if (prev && Helper.safeInt(prev.phienDuDoan) === session) {
                const actual = Helper.getResult(latest);
                prev.ketQua = actual; prev.ketQuaLabel = Helper.getLabel(actual);
                prev.trangThai = prev.DU_DOAN_CODE === actual ? 'ĐÚNG' : 'SAI';
                if (!db.algoStats) db.algoStats = {};
                for (const d of prev.algoDetails) {
                    if (!db.algoStats[d.algo]) db.algoStats[d.algo] = { wins: 0, total: 0 };
                    db.algoStats[d.algo].total++;
                    if (d.code === actual) db.algoStats[d.algo].wins++;
                }
            }

            const pred = MetaEngine.run(seq, db);
            db.history.push({
                phien: session, xucXac: Helper.getDice(latest), tong: Helper.getSum(latest),
                ketQua: Helper.getResult(latest), ketQuaLabel: Helper.getLabel(Helper.getResult(latest)),
                phienDuDoan: session + 1, DU_DOAN_CODE: pred.code, DU_DOAN: Helper.getLabel(pred.code),
                TI_LE: pred.tiLe, patternName: pred.label, algoDetails: pred.details,
                weak: pred.weak, veryWeak: pred.veryWeak, trangThai: 'ĐANG CHỜ'
            });

            db.lastSession = session;
            DB.save(game, db);
        } catch (err) {
            console.error(`[WORKER] Lỗi ${game}:`, err.message);
        }
    }

    static start() {
        this.processGame('md5'); this.processGame('taixiu');
        setInterval(() => { this.processGame('md5'); this.processGame('taixiu'); }, CONFIG.TICK_MS);
    }
}

Worker.start();

// ========================================================================
// ROUTES API VÀ GIAO DIỆN
// ========================================================================
app.get('/', (req, res) => res.redirect('/history/md5'));

app.get('/:game(md5|taixiu)', async (req, res) => {
    try {
        const game = req.params.game;
        const url = game === 'md5' ? CONFIG.API.MD5 : CONFIG.API.TAIXIU;
        let list = await Worker.fetchData(url);
        
        let isCached = false;
        let db = DB.load(game);

        // NẾU API GỐC LỖI -> LẤY DỮ LIỆU TỪ CACHE (LỊCH SỬ ĐÃ LƯU) ĐỂ TRẢ VỀ
        if (!list || list.length < 10) {
            isCached = true;
            if (db.history.length === 0) {
                return res.status(503).json({ success: false, error: 'API Gốc đang chặn IP, chưa có dữ liệu Cache. Vui lòng đợi 1-2 phút!' });
            }
            // Giả lập lại list từ DB
            const lastHist = db.history[db.history.length - 1];
            list = [{ 
                SessionId: lastHist.phien, FirstDice: lastHist.xucXac[0], 
                SecondDice: lastHist.xucXac[1], ThirdDice: lastHist.xucXac[2] 
            }];
        }

        const latest = list[list.length - 1];
        const session = Helper.safeInt(latest.SessionId);
        const seq = list.map(Helper.getResult).filter(Boolean);
        
        // Nếu mảng quá ngắn do cache, tự động sinh thêm data từ lịch sử cũ
        if (seq.length < 15 && db.history.length > 15) {
            for (let i = db.history.length - 15; i < db.history.length; i++) {
                if (db.history[i].ketQua) seq.push(db.history[i].ketQua);
            }
        }

        const pred = MetaEngine.run(seq, db);

        res.json({
            success: true, game, phien: session,
            xucXac: Helper.getDice(latest), tong: Helper.getSum(latest),
            ketQua: Helper.getResult(latest), ketQuaLabel: Helper.getLabel(Helper.getResult(latest)),
            phienDuDoan: session + 1, duDoan: Helper.getLabel(pred.code),
            duDoanCode: pred.code, tiLe: pred.tiLe, reason: pred.label,
            weak: pred.weak, veryWeak: pred.veryWeak,
            decisionPath: isCached ? 'CACHED_DUE_TO_API_BLOCK' : pred.decisionPath, 
            biasForced: pred.biasForced, balance: pred.balance, algoVotes: pred.details
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Lỗi Server: ' + err.message });
    }
});

app.get('/history/:game(md5|taixiu)', (req, res) => {
    try {
        const game = req.params.game;
        const db = DB.load(game);
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
    } catch (err) {
        res.status(500).send('Lỗi UI: ' + err.message);
    }
});

app.listen(CONFIG.PORT, CONFIG.HOST, () => {
    console.log(`🚀 V21 ONLINE - PORT ${CONFIG.PORT} - CHỐNG CHẶN API`);
});
