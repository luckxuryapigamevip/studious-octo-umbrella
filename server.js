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

// ========================================================================
// [MODULE 1] CẤU HÌNH HỆ THỐNG
// ========================================================================
const CONFIG = {
    PORT: process.env.PORT || 3000,
    HOST: '0.0.0.0',
    API: {
        MD5: 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau',
        TAIXIU: 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau'
    },
    DB_DIR: process.env.RENDER ? '/tmp' : path.join(__dirname, 'data_v25'),
    TICK_MS: 10000,
    MAX_HISTORY: 2000,
    VERSION: 'V25.0.0-SPECIAL-PATTERN'
};

if (!fs.existsSync(CONFIG.DB_DIR)) {
    try { fs.mkdirSync(CONFIG.DB_DIR, { recursive: true }); } catch (e) {}
}

// Bảo vệ server khỏi crash
process.on('uncaughtException', (err) => console.error('[FATAL] Uncaught:', err.message));
process.on('unhandledRejection', (reason) => console.error('[FATAL] Rejection:', reason));

// ========================================================================
// [MODULE 2] TIỆN ÍCH CORE (XỬ LÝ DỮ LIỆU)
// ========================================================================
class Core {
    static safeInt(val, def = 0) {
        const parsed = parseInt(val, 10);
        return Number.isFinite(parsed) ? parsed : def;
    }
    static clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }
    static round(val, decimals = 3) { return Number(Math.round(val + 'e' + decimals) + 'e-' + decimals); }
    
    static getLabel(code) { return code === 'T' ? 'Tài' : (code === 'X' ? 'Xỉu' : null); }
    static flip(code) { return code === 'T' ? 'X' : (code === 'X' ? 'T' : null); }
    
    static getDice(item) { return [this.safeInt(item?.FirstDice), this.safeInt(item?.SecondDice), this.safeInt(item?.ThirdDice)]; }
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
// [MODULE 3] DATABASE MANAGER
// ========================================================================
class DB {
    static getFilePath(game) { return path.join(CONFIG.DB_DIR, `db_v25_${game}.json`); }
    
    static load(game) {
        const file = this.getFilePath(game);
        try {
            if (fs.existsSync(file)) {
                const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
                return {
                    history: parsed.history || [],
                    lastSession: parsed.lastSession || null,
                    algoStats: parsed.algoStats || {}
                };
            }
        } catch (e) {}
        return { history: [], lastSession: null, algoStats: {} };
    }
    
    static save(game, db) {
        const file = this.getFilePath(game);
        try {
            if (db.history.length > CONFIG.MAX_HISTORY) db.history = db.history.slice(-CONFIG.MAX_HISTORY);
            fs.writeFileSync(file, JSON.stringify(db, null, 2), 'utf8');
        } catch (e) {}
    }
}

// ========================================================================
// [MODULE 4] TRÁI TIM HỆ THỐNG: BỘ NHẬN DIỆN CẦU ĐẶC BIỆT
// ========================================================================
class SpecialPatterns {
    // 1. CẦU 1-1 (ĐẢO LIÊN TỤC) - Nhịp T-X-T-X
    static p11(seq) {
        if (seq.length < 8) return null;
        let match = 0;
        for (let i = seq.length - 7; i < seq.length; i++) {
            if (seq[i] !== seq[i - 1]) match++;
        }
        if (match === 7) return { code: Core.flip(seq[seq.length - 1]), name: `CẦU 1-1`, conf: 0.75, id: 'pat_11' };
        return null;
    }

    // 2. CẦU 2-2 (KHỐI 2) - Nhịp T-T-X-X-T-T
    static p22(seq) {
        if (seq.length < 8) return null;
        const last6 = seq.slice(-6);
        if (last6[0] === last6[1] && last6[2] === last6[3] && last6[4] === last6[5] && last6[0] !== last6[2]) {
            // Đang chạy T-T-X-X-T-T -> Phiên tiếp theo phải là X
            return { code: Core.flip(last6[5]), name: `CẦU 2-2`, conf: 0.70, id: 'pat_22' };
        }
        return null;
    }

    // 3. CẦU 3-3 (KHỐI 3) - Nhịp T-T-T-X-X-X
    static p33(seq) {
        if (seq.length < 12) return null;
        const last6 = seq.slice(-6);
        if (last6[0] === last6[1] && last6[1] === last6[2] && last6[3] === last6[4] && last6[4] === last6[5] && last6[0] !== last6[3]) {
            return { code: Core.flip(last6[5]), name: `CẦU 3-3`, conf: 0.72, id: 'pat_33' };
        }
        return null;
    }

    // 4. CẦU NHẢY CÓC (CÁCH QUÃNG) - T-A-T-B-T-C
    static gap(seq) {
        if (seq.length < 6) return null;
        // Mẫu A-B-A-B-A
        const last5 = seq.slice(-5);
        if (last5[0] === last5[2] && last5[2] === last5[4] && last5[1] === last5[3] && last5[0] !== last5[1]) {
            return { code: last5[1], name: `NHẢY CÓC`, conf: 0.68, id: 'pat_gap' };
        }
        return null;
    }

    // 5. CẦU BẬC THANG (1-2-3) - T-X-X-T-T-T
    static stair(seq) {
        if (seq.length < 6) return null;
        const last6 = seq.slice(-6).join('');
        if (last6 === 'TXXTTT' || last6 === 'XTTXXX') {
            return { code: Core.flip(seq[seq.length - 1]), name: `CẦU BẬC THANG`, conf: 0.65, id: 'pat_stair' };
        }
        return null;
    }

    // 6. CẦU NGHIÊNG (THIÊN LỆCH) - 20 phiên Tài > 60%
    static trend(seq) {
        if (seq.length < 20) return null;
        const recent20 = seq.slice(-20);
        const tCount = recent20.filter(x => x === 'T').length;
        if (tCount >= 14) return { code: 'T', name: `CẦU NGHIÊNG TÀI`, conf: 0.62, id: 'pat_trend_t' };
        if (tCount <= 6) return { code: 'X', name: `CẦU NGHIÊNG XỈU`, conf: 0.62, id: 'pat_trend_x' };
        return null;
    }

    // 7. BẺ BỆT (STREAK BREAKER)
    static streak(seq) {
        if (seq.length < 5) return null;
        const last = seq[seq.length - 1];
        let len = 1;
        for (let i = seq.length - 2; i >= 0; i--) {
            if (seq[i] === last) len++;
            else break;
        }
        if (len === 4) return { code: Core.flip(last), name: `BẺ BỆT 4`, conf: 0.78, id: 'pat_break4' };
        if (len === 5) return { code: Core.flip(last), name: `BẺ BỆT 5`, conf: 0.85, id: 'pat_break5' };
        if (len >= 7) return { code: last, name: `BỆT DÀI`, conf: 0.65, id: 'pat_streak7' };
        return null;
    }

    // 8. N-GRAM 6 PHIÊN (TÌM CHUỖI TƯƠNG ĐỒNG QUÁ KHỨ)
    static ngram(seq) {
        const len = 6;
        if (seq.length < 20) return null;
        
        const tail = seq.slice(-len).join('');
        let tCount = 0, xCount = 0, occurrences = 0;
        let matchSession = null;

        for (let i = 0; i <= seq.length - len - 1; i++) {
            if (seq.slice(i, i + len).join('') === tail) {
                occurrences++;
                matchSession = i + len; // Lưu vị trí
                if (seq[i + len] === 'T') tCount++;
                else xCount++;
            }
        }

        if (occurrences >= 2) {
            const conf = Math.max(tCount, xCount) / occurrences;
            if (conf >= 0.70) {
                return { 
                    code: tCount > xCount ? 'T' : 'X', 
                    name: `N-GRAM 6`, 
                    conf: conf, 
                    id: 'pat_ngram6'
                };
            }
        }
        return null;
    }

    // 9. BẪY NHÀ CÁI (TRAP)
    static trap(seq) {
        if (seq.length < 4) return null;
        const last3 = seq.slice(-3).join('');
        if (last3 === 'TTT') return { code: 'X', name: `BẪY 3T`, conf: 0.60, id: 'pat_trap3t' };
        if (last3 === 'XXX') return { code: 'T', name: `BẪY 3X`, conf: 0.60, id: 'pat_trap3x' };
        return null;
    }
}

// ========================================================================
// [MODULE 5] META ENGINE (TỔNG HỢP VÀ KHÓA THUẬT TOÁN YẾU)
// ========================================================================
class MetaEngine {
    static analyze(seq, db) {
        const candidates = [
            SpecialPatterns.p11(seq),
            SpecialPatterns.p22(seq),
            SpecialPatterns.p33(seq),
            SpecialPatterns.gap(seq),
            SpecialPatterns.stair(seq),
            SpecialPatterns.trend(seq),
            SpecialPatterns.streak(seq),
            SpecialPatterns.ngram(seq),
            SpecialPatterns.trap(seq)
        ].filter(Boolean);

        const votes = { T: 0, X: 0 };
        const details = [];

        for (const algo of candidates) {
            const stats = db.algoStats?.[algo.id] || { weight: 1.0, loseStreak: 0 };
            
            // Khóa mõm nếu sai 2 lần liên tiếp
            let weight = stats.weight || 1.0;
            if (stats.loseStreak >= 2) weight = 0.0;

            // Cầu N-Gram và Bẻ bệt được ưu tiên hơn
            if (['pat_ngram6', 'pat_break4', 'pat_break5'].includes(algo.id)) weight *= 1.3;

            const power = algo.conf * weight;
            votes[algo.code] += power;
            
            details.push({
                algo: algo.id,
                family: 'pattern',
                code: algo.code,
                name: algo.name,
                conf: Core.round(algo.conf, 3),
                vote: Core.round(power, 3)
            });
        }

        const totalVotes = votes.T + votes.X;
        let winner, confidence, gap, pT, pX;

        if (totalVotes < 0.1) {
            const recent = seq.slice(-10);
            const tCount = recent.filter(x => x === 'T').length;
            winner = tCount <= 5 ? 'T' : 'X';
            confidence = 0.51;
            pT = winner === 'T' ? 0.51 : 0.49;
            pX = winner === 'X' ? 0.51 : 0.49;
            gap = 0.02;
            details.push({ algo: 'default', family: 'sys', code: winner, name: 'KHÔNG CÓ CẦU', conf: 0.51, vote: 1 });
        } else {
            pT = votes.T / totalVotes;
            pX = votes.X / totalVotes;
            gap = Math.abs(pT - pX);
            winner = pT > pX ? 'T' : 'X';
            confidence = Math.max(pT, pX);
        }

        confidence = Core.clamp(confidence, 0.50, 0.85);
        const isWeak = confidence < 0.60;

        const topAlgo = details.filter(d => d.code === winner).sort((a, b) => b.vote - a.vote)[0];
        const reasonLabel = topAlgo ? `META·${topAlgo.name}` : 'META·TỔNG HỢP';

        return {
            code: winner,
            label: reasonLabel,
            tiLe: (confidence * 100).toFixed(1) + '%',
            weak: isWeak,
            details
        };
    }
}

// ========================================================================
// [MODULE 6] WORKER ENGINE & API FETCHER
// ========================================================================
class Worker {
    static async fetchData(game) {
        const url = game === 'md5' ? CONFIG.API.MD5 : CONFIG.API.TAIXIU;
        for (let i = 0; i < 3; i++) {
            try {
                const res = await axios.get(url, { 
                    timeout: 12000,
                    headers: { 
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': 'https://taixiu.maksh3979madfw.com/'
                    }
                });
                let arr = res.data?.data?.list || res.data?.list || res.data?.data || (Array.isArray(res.data) ? res.data : []);
                if (!Array.isArray(arr) || arr.length === 0) throw new Error("Empty");
                if (arr.length >= 2 && Number(arr[0].SessionId) > Number(arr[arr.length - 1].SessionId)) arr.reverse();
                return arr;
            } catch (e) {
                if (i === 2) return [];
                await new Promise(r => setTimeout(r, 1000));
            }
        }
        return [];
    }

    static async process(game) {
        try {
            const list = await this.fetchData(game);
            if (!list || list.length < 10) return;

            const latest = list[list.length - 1];
            const session = Core.safeInt(latest.SessionId);
            const db = DB.load(game);

            if (db.lastSession === session) return;
            const seq = list.map(Core.getResult).filter(Boolean);

            // Chấm điểm thuật toán phiên trước
            const prev = db.history[db.history.length - 1];
            if (prev && Core.safeInt(prev.phienDuDoan) === session) {
                const actual = Core.getResult(latest);
                prev.ketQua = actual; prev.ketQuaLabel = Core.getLabel(actual);
                prev.trangThai = prev.DU_DOAN_CODE === actual ? 'ĐÚNG' : 'SAI';
                
                if (!db.algoStats) db.algoStats = {};
                for (const d of prev.algoDetails) {
                    if (!db.algoStats[d.algo]) db.algoStats[d.algo] = { weight: 1.0, loseStreak: 0 };
                    const stat = db.algoStats[d.algo];
                    if (d.code === actual) {
                        stat.weight = Core.clamp(stat.weight + 0.1, 0.5, 2.5);
                        stat.loseStreak = 0;
                    } else {
                        stat.weight = Core.clamp(stat.weight - 0.2, 0.0, 2.5);
                        stat.loseStreak += 1;
                    }
                }
            }

            // Dự đoán phiên tiếp theo
            const pred = MetaEngine.analyze(seq, db);

            db.history.push({
                phien: session, xucXac: Core.getDice(latest), tong: Core.getSum(latest),
                ketQua: Core.getResult(latest), ketQuaLabel: Core.getLabel(Core.getResult(latest)),
                phienDuDoan: session + 1, DU_DOAN_CODE: pred.code, DU_DOAN: Core.getLabel(pred.code),
                TI_LE: pred.tiLe, patternName: pred.label, algoDetails: pred.details,
                weak: pred.weak, trangThai: 'ĐANG CHỜ'
            });

            db.lastSession = session;
            DB.save(game, db);
        } catch (err) {
            console.error(`[WORKER] Lỗi ${game}:`, err.message);
        }
    }

    static start() {
        this.process('md5'); this.process('taixiu');
        setInterval(() => { this.process('md5'); this.process('taixiu'); }, CONFIG.TICK_MS);
    }
}

Worker.start();

// ========================================================================
// [MODULE 7] ROUTES API
// ========================================================================
app.get('/', (req, res) => res.redirect('/history/md5'));

app.get('/:game(md5|taixiu)', async (req, res) => {
    try {
        const game = req.params.game;
        let list = await Worker.fetchData(game);
        let db = DB.load(game);

        // Nếu API chặn IP, lấy Cache
        if (!list || list.length < 10) {
            if (db.history.length === 0) return res.status(503).json({ error: 'API Blocked & No Cache' });
            list = db.history.slice(-50).map(h => ({ 
                SessionId: h.phien, FirstDice: h.xucXac[0]||1, SecondDice: h.xucXac[1]||1, ThirdDice: h.xucXac[2]||1 
            }));
        }

        const latest = list[list.length - 1];
        const session = Core.safeInt(latest.SessionId);
        const seq = list.map(Core.getResult).filter(Boolean);
        const pred = MetaEngine.analyze(seq, db);

        res.json({
            success: true, game, phien: session,
            xucXac: Core.getDice(latest), tong: Core.getSum(latest),
            ketQua: Core.getResult(latest), ketQuaLabel: Core.getLabel(Core.getResult(latest)),
            phienDuDoan: session + 1, duDoan: Core.getLabel(pred.code),
            duDoanCode: pred.code, tiLe: pred.tiLe, reason: pred.label,
            weak: pred.weak, algoVotes: pred.details
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ========================================================================
// [MODULE 8] GIAO DIỆN WEB
// ========================================================================
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
        <title>SPECIAL PATTERN - ${game.toUpperCase()}</title>
        <style>
            :root { --bg: #09090b; --card: #18181b; --text: #f4f4f5; --green: #10b981; --red: #ef4444; --yellow: #f59e0b; }
            * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, sans-serif; }
            body { background: var(--bg); color: var(--text); padding: 15px; }
            .header { background: var(--card); padding: 20px; border-radius: 12px; text-align: center; margin-bottom: 20px; border: 1px solid #27272a; }
            h1 { font-size: 20px; text-transform: uppercase; margin-bottom: 15px; color: #a78bfa; }
            .acc { font-size: 28px; font-weight: 900; color: ${parseFloat(acc) >= 55 ? 'var(--green)' : 'var(--red)'}; }
            .table-wrap { background: var(--card); border-radius: 12px; overflow-x: auto; border: 1px solid #27272a; }
            table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: center; }
            th { background: #27272a; padding: 15px 5px; color: #a1a1aa; font-size: 11px; text-transform: uppercase; }
            td { padding: 12px 5px; border-bottom: 1px solid #27272a; }
            .tai { color: var(--green); font-weight: bold; }
            .xiu { color: var(--red); font-weight: bold; }
            .dung { color: var(--green); font-weight: bold; }
            .sai { color: var(--red); font-weight: bold; }
            .cho { color: var(--yellow); font-weight: bold; }
            .dice-box { display: flex; justify-content: center; gap: 3px; }
            .dice { width: 20px; height: 20px; background: #fff; color: #000; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 12px; }
            .sum { background: #27272a; padding: 4px 8px; border-radius: 6px; color: var(--yellow); font-weight: bold; }
            .pattern { background: #27272a; padding: 4px 8px; border-radius: 6px; font-size: 11px; border: 1px solid #3f3f46; color: #cbd5e1; }
        </style>
        <script>setTimeout(() => { window.location.reload(); }, 5000);</script>
        </head>
        <body>
            <div class="header">
                <h1>HỆ THỐNG CẦU ĐẶC BIỆT - ${game.toUpperCase()}</h1>
                <div class="acc">${acc}%</div>
            </div>
            <div class="table-wrap">
                <table>
                    <thead><tr><th>Phiên</th><th>XX</th><th>Tổng</th><th>KQ</th><th>Dự Đoán</th><th>Cầu</th><th>Trạng Thái</th></tr></thead>
                    <tbody>
                        ${rows.map(it => `
                            <tr>
                                <td style="color: #71717a;">${it.phien}</td>
                                <td><div class="dice-box">${(it.xucXac||[]).map(d => `<div class="dice">${d}</div>`).join('')}</div></td>
                                <td><span class="sum">${it.tong}</span></td>
                                <td class="${it.ketQua}">${it.ketQuaLabel}</td>
                                <td class="${it.DU_DOAN_CODE}">${it.DU_DOAN} (${it.TI_LE})</td>
                                <td><span class="pattern">${it.patternName}</span></td>
                                <td class="${it.trangThai === 'ĐÚNG' ? 'dung' : (it.trangThai === 'SAI' ? 'sai' : 'cho')}">${it.trangThai}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </body>
        </html>`;
        res.send(html);
    } catch (err) { res.status(500).send(err.message); }
});

app.listen(CONFIG.PORT, CONFIG.HOST, () => {
    console.log(`🚀 ${CONFIG.VERSION} ONLINE - PORT ${CONFIG.PORT}`);
});
