'use strict';

// ========================================================================
// [MODULE 1] THƯ VIỆN LÕI
// ========================================================================
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ========================================================================
// [MODULE 2] MIDDLEWARE & KHỞI TẠO SERVER
// ========================================================================
const app = express();

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.json({ limit: '50mb' }));

// ========================================================================
// [MODULE 3] CẤU HÌNH HỆ THỐNG TOÀN CỤC
// ========================================================================
const CONFIG = {
    PORT: process.env.PORT || 3000,
    HOST: '0.0.0.0',
    API: {
        MD5: 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau',
        TAIXIU: 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau'
    },
    DB_DIR: process.env.RENDER ? '/tmp' : path.join(__dirname, 'data_v28'),
    TICK_MS: 8000, 
    MAX_HISTORY: 2500,
    VERSION: 'V28.0.0-GOD-LEVEL'
};

if (!fs.existsSync(CONFIG.DB_DIR)) {
    try { fs.mkdirSync(CONFIG.DB_DIR, { recursive: true }); } catch (e) {}
}

process.on('uncaughtException', (err) => console.error('[FATAL EXCEPTION]', err.message));
process.on('unhandledRejection', (reason) => console.error('[FATAL REJECTION]', reason));

// ========================================================================
// [MODULE 4] BỘ XỬ LÝ TIỆN ÍCH (HELPERS)
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
// [MODULE 5] QUẢN LÝ DATABASE (LƯU TRỮ LỊCH SỬ & TRỌNG SỐ)
// ========================================================================
class DB {
    static getFilePath(game) { return path.join(CONFIG.DB_DIR, `db_god_${game}.json`); }
    
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
// [MODULE 6] KHO THUẬT TOÁN PHÂN TÍCH CẦU VIP (V28 ALGORITHMS)
// ========================================================================
class VipAlgorithms {
    // 1. CẦU BỆT (STREAK) - Đánh tiếp hoặc bẻ
    static streak(seq) {
        if (seq.length < 5) return null;
        const last = seq[seq.length - 1];
        let len = 1;
        for (let i = seq.length - 2; i >= 0; i--) {
            if (seq[i] === last) len++;
            else break;
        }
        if (len === 4) return { code: Core.flip(last), name: `BẺ BỆT 4`, conf: 0.78, id: 'vip_streak4' };
        if (len === 5) return { code: Core.flip(last), name: `BẺ BỆT 5`, conf: 0.85, id: 'vip_streak5' };
        if (len >= 7) return { code: last, name: `BỆT DÀI`, conf: 0.70, id: 'vip_streak7' };
        return null;
    }

    // 2. CẦU ĐẢO 1-1 (BOUNCE)
    static bounce(seq) {
        if (seq.length < 8) return null;
        let isBounce = true;
        for (let i = seq.length - 7; i < seq.length; i++) {
            if (seq[i] === seq[i - 1]) { isBounce = false; break; }
        }
        if (isBounce) return { code: Core.flip(seq[seq.length - 1]), name: `CẦU 1-1`, conf: 0.76, id: 'vip_bounce11' };
        return null;
    }

    // 3. CẦU 2-2 (BLOCK 2)
    static block2(seq) {
        if (seq.length < 8) return null;
        const l6 = seq.slice(-6);
        if (l6[0] === l6[1] && l6[2] === l6[3] && l6[4] === l6[5] && l6[0] !== l6[2]) {
            return { code: Core.flip(l6[5]), name: `CẦU 2-2`, conf: 0.72, id: 'vip_block2' };
        }
        return null;
    }

    // 4. CẦU 3-3 (BLOCK 3)
    static block3(seq) {
        if (seq.length < 12) return null;
        const l6 = seq.slice(-6);
        if (l6[0] === l6[1] && l6[1] === l6[2] && l6[3] === l6[4] && l6[4] === l6[5] && l6[0] !== l6[3]) {
            return { code: Core.flip(l6[5]), name: `CẦU 3-3`, conf: 0.75, id: 'vip_block3' };
        }
        return null;
    }

    // 5. CẦU NHẢY CÓC (GAP)
    static gap(seq) {
        if (seq.length < 6) return null;
        const l5 = seq.slice(-5);
        if (l5[0] === l5[2] && l5[2] === l5[4] && l5[1] === l5[3] && l5[0] !== l5[1]) {
            return { code: l5[1], name: `NHẢY CÓC`, conf: 0.70, id: 'vip_gap' };
        }
        return null;
    }

    // 6. CẦU KẸP (SANDWICH) T-X-X-T
    static sandwich(seq) {
        if (seq.length < 4) return null;
        const l4 = seq.slice(-4).join('');
        if (l4 === 'TXXT') return { code: 'T', name: `CẦU KẸP T`, conf: 0.73, id: 'vip_sand_t' };
        if (l4 === 'XTTX') return { code: 'X', name: `CẦU KẸP X`, conf: 0.73, id: 'vip_sand_x' };
        return null;
    }

    // 7. CẦU KIM TỰ THÁP (PYRAMID) 1-3-1
    static pyramid(seq) {
        if (seq.length < 5) return null;
        const l5 = seq.slice(-5).join('');
        if (l5 === 'TXXXT') return { code: 'X', name: `KIM TỰ THÁP`, conf: 0.78, id: 'vip_pyramid_t' };
        if (l5 === 'XTTTX') return { code: 'T', name: `KIM TỰ THÁP`, conf: 0.78, id: 'vip_pyramid_x' };
        return null;
    }

    // 8. BÁN CẦU (HEMISPHERE) - So sánh 10 phiên gần và 10 phiên trước
    static hemisphere(seq) {
        if (seq.length < 20) return null;
        const recent10 = seq.slice(-10);
        const past10 = seq.slice(-20, -10);
        const rT = recent10.filter(x => x === 'T').length;
        const pT = past10.filter(x => x === 'T').length;
        
        if (pT >= 7 && rT <= 3) return { code: 'T', name: `BÁN CẦU TÀI`, conf: 0.68, id: 'vip_hemi_t' };
        if (pT <= 3 && rT >= 7) return { code: 'X', name: `BÁN CẦU XỈU`, conf: 0.68, id: 'vip_hemi_x' };
        return null;
    }

    // 9. CẦU NGHIÊNG (TREND) - Xu hướng 20 phiên
    static trend(seq) {
        if (seq.length < 20) return null;
        const recent20 = seq.slice(-20);
        const tCount = recent20.filter(x => x === 'T').length;
        if (tCount >= 14) return { code: 'T', name: `NGHIÊNG TÀI`, conf: 0.65, id: 'vip_trend_t' };
        if (tCount <= 6) return { code: 'X', name: `NGHIÊNG XỈU`, conf: 0.65, id: 'vip_trend_x' };
        return null;
    }

    // 10. CẦU BẬC THANG (1-2-3)
    static stair(seq) {
        if (seq.length < 6) return null;
        const l6 = seq.slice(-6).join('');
        if (l6 === 'TXXTTT') return { code: 'X', name: `BẬC THANG`, conf: 0.68, id: 'vip_stair1' };
        if (l6 === 'XTTXXX') return { code: 'T', name: `BẬC THANG`, conf: 0.68, id: 'vip_stair2' };
        return null;
    }

    // 11. CẦU ZICZAC 2-1 (T-T-X-T-T-X)
    static zigzag21(seq) {
        if (seq.length < 6) return null;
        const l6 = seq.slice(-6).join('');
        if (l6 === 'TTXTTX') return { code: 'X', name: `ZICZAC 2-1`, conf: 0.71, id: 'vip_zig21_t' };
        if (l6 === 'XXTXXT') return { code: 'T', name: `ZICZAC 2-1`, conf: 0.71, id: 'vip_zig21_x' };
        return null;
    }

    // 12. CẦU LẬT KÈO (TRAP) - 3 lần ra Tài liên tiếp -> Đánh Xỉu
    static trap(seq) {
        if (seq.length < 4) return null;
        const last3 = seq.slice(-3).join('');
        if (last3 === 'TTT') return { code: 'X', name: `BẪY 3T`, conf: 0.62, id: 'vip_trap_t' };
        if (last3 === 'XXX') return { code: 'T', name: `BẪY 3X`, conf: 0.62, id: 'vip_trap_x' };
        return null;
    }

    // 13. N-GRAM 5 PHIÊN (TÌM CHUỖI TƯƠNG ĐỒNG)
    static ngram5(seq) {
        const len = 5;
        if (seq.length < 20) return null;
        const tail = seq.slice(-len).join('');
        let t = 0, x = 0, occ = 0;
        for (let i = 0; i <= seq.length - len - 1; i++) {
            if (seq.slice(i, i + len).join('') === tail) {
                occ++;
                if (seq[i + len] === 'T') t++;
                else x++;
            }
        }
        if (occ >= 2) {
            const conf = Math.max(t, x) / occ;
            if (conf >= 0.72) return { code: t > x ? 'T' : 'X', name: `N-GRAM 5`, conf, id: 'vip_ngram5' };
        }
        return null;
    }

    // 14. N-GRAM 6 PHIÊN (TÌM CHUỖI TƯƠNG ĐỒNG)
    static ngram6(seq) {
        const len = 6;
        if (seq.length < 25) return null;
        const tail = seq.slice(-len).join('');
        let t = 0, x = 0, occ = 0;
        for (let i = 0; i <= seq.length - len - 1; i++) {
            if (seq.slice(i, i + len).join('') === tail) {
                occ++;
                if (seq[i + len] === 'T') t++;
                else x++;
            }
        }
        if (occ >= 2) {
            const conf = Math.max(t, x) / occ;
            if (conf >= 0.72) return { code: t > x ? 'T' : 'X', name: `N-GRAM 6`, conf, id: 'vip_ngram6' };
        }
        return null;
    }

    // 15. N-GRAM 7 PHIÊN
    static ngram7(seq) {
        const len = 7;
        if (seq.length < 30) return null;
        const tail = seq.slice(-len).join('');
        let t = 0, x = 0, occ = 0;
        for (let i = 0; i <= seq.length - len - 1; i++) {
            if (seq.slice(i, i + len).join('') === tail) {
                occ++;
                if (seq[i + len] === 'T') t++;
                else x++;
            }
        }
        if (occ >= 2) {
            const conf = Math.max(t, x) / occ;
            if (conf >= 0.72) return { code: t > x ? 'T' : 'X', name: `N-GRAM 7`, conf, id: 'vip_ngram7' };
        }
        return null;
    }

    // 16. CHU KỲ 3 PHIÊN
    static cycle3(seq) {
        if (seq.length < 9) return null;
        const l3 = seq.slice(-3).join('');
        let t = 0, x = 0, occ = 0;
        for (let i = 0; i <= seq.length - 4; i++) {
            if (seq.slice(i, i + 3).join('') === l3) {
                occ++;
                if (seq[i + 3] === 'T') t++;
                else x++;
            }
        }
        if (occ >= 2) {
            const conf = Math.max(t, x) / occ;
            if (conf >= 0.78) return { code: t > x ? 'T' : 'X', name: `CHU KỲ 3`, conf, id: 'vip_cycle3' };
        }
        return null;
    }

    // 17. CHU KỲ 4 PHIÊN
    static cycle4(seq) {
        if (seq.length < 12) return null;
        const l4 = seq.slice(-4).join('');
        let t = 0, x = 0, occ = 0;
        for (let i = 0; i <= seq.length - 5; i++) {
            if (seq.slice(i, i + 4).join('') === l4) {
                occ++;
                if (seq[i + 4] === 'T') t++;
                else x++;
            }
        }
        if (occ >= 2) {
            const conf = Math.max(t, x) / occ;
            if (conf >= 0.78) return { code: t > x ? 'T' : 'X', name: `CHU KỲ 4`, conf, id: 'vip_cycle4' };
        }
        return null;
    }

    // 18. CẦU GẪY KHÚC (X-T-X-X-T)
    static breakCurve(seq) {
        if (seq.length < 5) return null;
        const l5 = seq.slice(-5).join('');
        if (l5 === 'XTXXT') return { code: 'X', name: `GẪY KHÚC`, conf: 0.70, id: 'vip_curve_x' };
        if (l5 === 'TXT TX') return { code: 'T', name: `GẪY KHÚC`, conf: 0.70, id: 'vip_curve_t' };
        return null;
    }

    // 19. CẦU SONG SONG (PARALLEL) - T-X-T | X-T-X
    static parallel(seq) {
        if (seq.length < 6) return null;
        const l6 = seq.slice(-6).join('');
        if (l6 === 'TXTXTX') return { code: 'T', name: `SONG SONG`, conf: 0.65, id: 'vip_parallel_t' };
        if (l6 === 'XTXTXT') return { code: 'X', name: `SONG SONG`, conf: 0.65, id: 'vip_parallel_x' };
        return null;
    }

    // 20. TỔNG ĐIỂM (SUM BIAS) - Tổng 10 phiên gần đây
    static sumBias(seq, sums) {
        if (!sums || sums.length < 10) return null;
        const last10 = sums.slice(-10);
        const total = last10.reduce((a, b) => a + b, 0);
        if (total >= 120) return { code: 'X', name: `TỔNG CAO`, conf: 0.68, id: 'vip_sum_high' };
        if (total <= 90) return { code: 'T', name: `TỔNG THẤP`, conf: 0.68, id: 'vip_sum_low' };
        return null;
    }
}

// ========================================================================
// [MODULE 7] META ENGINE - TỔNG HỢP VÀ HỌC CẦU (REINFORCEMENT)
// ========================================================================
class MetaEngine {
    static analyze(seq, sums, db) {
        const candidates = [
            VipAlgorithms.streak(seq),
            VipAlgorithms.bounce(seq),
            VipAlgorithms.block2(seq),
            VipAlgorithms.block3(seq),
            VipAlgorithms.gap(seq),
            VipAlgorithms.sandwich(seq),
            VipAlgorithms.pyramid(seq),
            VipAlgorithms.hemisphere(seq),
            VipAlgorithms.trend(seq),
            VipAlgorithms.stair(seq),
            VipAlgorithms.zigzag21(seq),
            VipAlgorithms.trap(seq),
            VipAlgorithms.ngram5(seq),
            VipAlgorithms.ngram6(seq),
            VipAlgorithms.ngram7(seq),
            VipAlgorithms.cycle3(seq),
            VipAlgorithms.cycle4(seq),
            VipAlgorithms.breakCurve(seq),
            VipAlgorithms.parallel(seq),
            VipAlgorithms.sumBias(seq, sums)
        ].filter(Boolean);

        const votes = { T: 0, X: 0 };
        const details = [];

        for (const algo of candidates) {
            const stats = db.algoStats?.[algo.id] || { weight: 1.0, loseStreak: 0, winStreak: 0 };
            
            let weight = stats.weight || 1.0;
            
            // HỌC CẦU (REINFORCEMENT LEARNING)
            if (stats.winStreak >= 2) weight *= 1.5; 
            if (stats.loseStreak >= 2) weight = 0.0; 

            const power = algo.conf * weight;
            votes[algo.code] += power;
            
            details.push({
                algo: algo.id,
                family: 'vip',
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
            details.push({ algo: 'default', family: 'sys', code: winner, name: 'MẶC ĐỊNH', conf: 0.51, vote: 1 });
        } else {
            pT = votes.T / totalVotes;
            pX = votes.X / totalVotes;
            gap = Math.abs(pT - pX);
            winner = pT > pX ? 'T' : 'X';
            confidence = Math.max(pT, pX);
        }

        confidence = Core.clamp(confidence, 0.50, 0.88);
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
// [MODULE 8] FETCH API & WORKER
// ========================================================================
class Fetcher {
    static async getData(game) {
        const targetUrl = game === 'md5' ? CONFIG.API.MD5 : CONFIG.API.TAIXIU;
        for (let i = 0; i < 3; i++) {
            try {
                const res = await axios.get(targetUrl, { 
                    timeout: 10000,
                    headers: { 
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': 'https://taixiu.maksh3979madfw.com/'
                    }
                });
                let arr = res.data?.data?.list || res.data?.list || res.data?.data || (Array.isArray(res.data) ? res.data : []);
                if (Array.isArray(arr) && arr.length > 5) {
                    if (Number(arr[0].SessionId) > Number(arr[arr.length - 1].SessionId)) arr.reverse();
                    return arr;
                }
            } catch (e) {
                await new Promise(r => setTimeout(r, 1000));
            }
        }
        return [];
    }
}

class Worker {
    static async process(game) {
        try {
            const list = await Fetcher.getData(game);
            if (!list || list.length < 10) return;

            const latest = list[list.length - 1];
            const session = Core.safeInt(latest.SessionId);
            const db = DB.load(game);

            if (db.lastSession === session) return;
            const seq = list.map(Core.getResult).filter(Boolean);
            const sums = list.map(Core.getSum).filter(s => s >= 3 && s <= 18);

            // Chấm điểm phiên trước
            const prev = db.history[db.history.length - 1];
            if (prev && Core.safeInt(prev.phienDuDoan) === session) {
                const actual = Core.getResult(latest);
                prev.ketQua = actual; 
                prev.ketQuaLabel = Core.getLabel(actual);
                prev.trangThai = prev.DU_DOAN_CODE === actual ? 'ĐÚNG' : 'SAI';
                
                if (!db.algoStats) db.algoStats = {};
                for (const d of prev.algoDetails) {
                    if (!db.algoStats[d.algo]) db.algoStats[d.algo] = { weight: 1.0, loseStreak: 0, winStreak: 0 };
                    const stat = db.algoStats[d.algo];
                    
                    if (d.code === actual) {
                        stat.weight = Core.clamp(stat.weight + 0.1, 0.5, 2.5);
                        stat.loseStreak = 0;
                        stat.winStreak = (stat.winStreak || 0) + 1;
                    } else {
                        stat.weight = Core.clamp(stat.weight - 0.2, 0.0, 2.5);
                        stat.loseStreak += 1;
                        stat.winStreak = 0;
                    }
                }
            }

            // Dự đoán phiên mới
            const pred = MetaEngine.analyze(seq, sums, db);

            db.history.push({
                phien: session, xucXac: Core.getDice(latest), tong: Core.getSum(latest),
                ketQua: Core.getResult(latest), ketQuaLabel: Core.getLabel(Core.getResult(latest)),
                phienDuDoan: session + 1, DU_DOAN_CODE: pred.code, DU_DOAN: Core.getLabel(pred.code),
                TI_LE: pred.tiLe, patternName: pred.label, algoDetails: pred.details,
                weak: pred.weak, trangThai: 'ĐANG CHỜ'
            });

            db.lastSession = session;
            DB.save(game, db);
        } catch (err) {}
    }

    static start() {
        this.process('md5'); this.process('taixiu');
        setInterval(() => { this.process('md5'); this.process('taixiu'); }, CONFIG.TICK_MS);
    }
}

Worker.start();

// ========================================================================
// [MODULE 9] ROUTES API CHO TOOL
// ========================================================================
app.get('/', (req, res) => res.redirect('/history/md5'));

app.get('/:game(md5|taixiu)', async (req, res) => {
    try {
        const game = req.params.game;
        let list = await Fetcher.getData(game);
        let db = DB.load(game);

        if (!list || list.length < 10) {
            if (db.history.length === 0) return res.status(503).json({ error: 'No Data' });
            list = db.history.slice(-50).map(h => ({ SessionId: h.phien, FirstDice: h.xucXac[0]||1, SecondDice: h.xucXac[1]||1, ThirdDice: h.xucXac[2]||1 }));
        }

        const latest = list[list.length - 1];
        const session = Core.safeInt(latest.SessionId);
        const seq = list.map(Core.getResult).filter(Boolean);
        const sums = list.map(Core.getSum).filter(s => s >= 3 && s <= 18);
        const pred = MetaEngine.analyze(seq, sums, db);

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
// [MODULE 10] GIAO DIỆN WEB
// ========================================================================
app.get('/history/:game(md5|taixiu)', async (req, res) => {
    try {
        const game = req.params.game;
        let list = await Fetcher.getData(game);
        let db = DB.load(game);

        if (list && list.length > 10) {
            const latest = list[list.length - 1];
            const session = Core.safeInt(latest.SessionId);
            if (db.lastSession !== session) {
                const seq = list.map(Core.getResult).filter(Boolean);
                const sums = list.map(Core.getSum).filter(s => s >= 3 && s <= 18);
                const pred = MetaEngine.analyze(seq, sums, db);
                db.history.push({
                    phien: session, xucXac: Core.getDice(latest), tong: Core.getSum(latest),
                    ketQua: Core.getResult(latest), ketQuaLabel: Core.getLabel(Core.getResult(latest)),
                    phienDuDoan: session + 1, DU_DOAN_CODE: pred.code, DU_DOAN: Core.getLabel(pred.code),
                    TI_LE: pred.tiLe, patternName: pred.label, algoDetails: pred.details,
                    weak: pred.weak, trangThai: 'ĐANG CHỜ'
                });
                db.lastSession = session;
                DB.save(game, db);
            }
        }

        const rows = db.history.slice(-50).reverse();
        const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
        const correct = settled.filter(h => h.trangThai === 'ĐÚNG').length;
        const acc = settled.length ? (correct / settled.length * 100).toFixed(1) : '0.0';

        const warningHtml = rows.length === 0 ? `
            <div style="background: #7f1d1d; color: #fca5a5; padding: 15px; border-radius: 10px; text-align: center; margin-bottom: 20px;">
                ⚠️ Không lấy được dữ liệu. IP Render đang bị chặn.
            </div>
        ` : '';

        const html = `<!DOCTYPE html>
        <html lang="vi">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
        <title>AI V28 - ${game.toUpperCase()}</title>
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
            ${warningHtml}
            <div class="header">
                <h1>HỆ THỐNG CẦU VIP V28 - ${game.toUpperCase()}</h1>
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
    } catch (err) { res.status(500).send('Lỗi UI: ' + err.message); }
});

app.listen(CONFIG.PORT, CONFIG.HOST, () => {
    console.log(`🚀 V28 GOD LEVEL ONLINE - PORT ${CONFIG.PORT}`);
    console.log(`Đã kích hoạt 20 thuật toán phân tích cầu VIP.`);
});
