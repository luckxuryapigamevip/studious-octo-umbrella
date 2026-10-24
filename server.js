// ========================================================================
// [MODULE 1] IMPORT THƯ VIỆN LÕI
// ========================================================================
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();

// ========================================================================
// [MODULE 2] MIDDLEWARE & BẢO MẬT
// ========================================================================
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.json({ limit: '50mb' }));

// ========================================================================
// [MODULE 3] CẤU HÌNH HỆ THỐNG
// ========================================================================
const CONFIG = {
    PORT: process.env.PORT || 3000,
    HOST: '0.0.0.0',
    // Mảng chứa các domain có thể dùng để tự động fallback
    API_DOMAINS: [
        'https://ixiu.maksh3979madfw.com',
        'https://taixiu.maksh3979madfw.com',
        'https://taixiumd5.maksh3979madfw.com'
    ],
    DB_DIR: process.env.DB_DIR || (fs.existsSync('/data') ? '/data' : (process.env.RENDER ? '/tmp' : path.join(__dirname, 'db_v31'))),
    TICK_MS: 10000, // 10 giây quét 1 lần
    VERSION: 'V31.2.0-TXTX-RENDER-PRO'
};

// Khởi tạo thư mục DB
if (!fs.existsSync(CONFIG.DB_DIR)) {
    try { fs.mkdirSync(CONFIG.DB_DIR, { recursive: true }); } catch (e) {}
}

// Bắt lỗi toàn cục (Không để server crash)
process.on('uncaughtException', (err) => console.error('[FATAL EXCEPTION]', err.message));
process.on('unhandledRejection', (reason) => console.error('[FATAL REJECTION]', reason));

// ========================================================================
// [MODULE 4] CORE HELPERS & MATH UTILS
// ========================================================================
class MathUtils {
    static safeInt(val, def = 0) {
        const parsed = parseInt(val, 10);
        return Number.isFinite(parsed) ? parsed : def;
    }
    static clamp(val, min, max) {
        return Math.max(min, Math.min(max, val));
    }
    static round(val, decimals = 3) {
        return Number(Math.round(val + 'e' + decimals) + 'e-' + decimals);
    }
    static logWeight(val, base = 2) {
        return Math.log(Math.max(0.1, val)) / Math.log(base);
    }
}

class Core {
    static getLabel(code) { return code === 'T' ? 'Tài' : (code === 'X' ? 'Xỉu' : null); }
    static flip(code) { return code === 'T' ? 'X' : (code === 'X' ? 'T' : null); }
    
    static getDice(item) {
        return [
            MathUtils.safeInt(item?.FirstDice),
            MathUtils.safeInt(item?.SecondDice),
            MathUtils.safeInt(item?.ThirdDice)
        ];
    }
    static getSum(item) {
        const s = this.getDice(item).reduce((a, b) => a + b, 0);
        return (s >= 3 && s <= 18) ? s : MathUtils.safeInt(item?.DiceSum);
    }
    static getResult(item) {
        const s = this.getSum(item);
        return (s >= 3 && s <= 18) ? (s >= 11 ? 'T' : 'X') : null;
    }

    static levenshteinDistance(str1, str2) {
        if (str1 === str2) return 0;
        if (str1.length === 0) return str2.length;
        if (str2.length === 0) return str1.length;
        const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));
        for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
        for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;
        for (let j = 1; j <= str2.length; j++) {
            for (let i = 1; i <= str1.length; i++) {
                const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
                matrix[j][i] = Math.min(
                    matrix[j][i - 1] + 1,
                    matrix[j - 1][i] + 1,
                    matrix[j - 1][i - 1] + indicator
                );
            }
        }
        return matrix[str2.length][str1.length];
    }
}

// ========================================================================
// [MODULE 5] DATABASE MANAGER
// ========================================================================
class DB {
    static getFilePath(game) { return path.join(CONFIG.DB_DIR, `db_v31_${game}.json`); }
    
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
        const tmp = file + '.tmp';
        try {
            fs.writeFileSync(tmp, JSON.stringify(db), 'utf8');
            fs.renameSync(tmp, file);
        } catch (e) { console.error('[DB SAVE ERROR]', e.message); }
    }
}

// ========================================================================
// [MODULE 6] BỘ LỌC NHIỄU (NOISE FILTER)
// ========================================================================
class NoiseFilter {
    static isPureTXTX(seq, lookback = 10) {
        if (seq.length < lookback) return false;
        const recent = seq.slice(-lookback);
        let alternatingCount = 0;
        for (let i = 1; i < recent.length; i++) {
            if (recent[i] !== recent[i - 1]) alternatingCount++;
        }
        // Cho phép sai số nhịp (>=70% là đảo liên tục)
        return (alternatingCount / (lookback - 1)) >= 0.70;
    }
}

// ========================================================================
// [MODULE 7] ĐỘNG CƠ TXTX
// ========================================================================
class TXTXEngine {
    static markovTXTX(seq) {
        if (seq.length < 10) return null;
        const last = seq[seq.length - 1];
        let countFlip = 0;
        for (let i = seq.length - 10; i < seq.length; i++) {
            if (seq[i] !== seq[i - 1]) countFlip++;
        }
        if (countFlip >= 7) {
            return { code: Core.flip(last), name: 'TXTX-MARKOV', conf: 0.82, id: 'tx_markov' };
        }
        return null;
    }

    static recursiveTXTX(seq, windowSize = 6) {
        if (seq.length < windowSize + 5) return null;
        const target = seq.slice(-windowSize).join('');
        let tCount = 0, xCount = 0, occurrences = 0;

        for (let i = 0; i <= seq.length - windowSize - 1; i++) {
            const sub = seq.slice(i, i + windowSize).join('');
            if (Core.levenshteinDistance(sub, target) <= 1) { 
                occurrences++;
                if (seq[i + windowSize] === 'T') tCount++;
                else xCount++;
            }
        }

        if (occurrences >= 1) {
            const conf = Math.max(tCount, xCount) / occurrences;
            if (conf >= 0.60) {
                return { code: tCount > xCount ? 'T' : 'X', name: `TXTX-EXACT`, conf: conf, id: 'tx_exact' };
            }
        }
        return null;
    }

    static deviationAnalysis(seq) {
        if (seq.length < 8) return null;
        const last4 = seq.slice(-4).join('');
        if (last4 === 'TXXT' || last4 === 'XTTX') {
            return { code: Core.flip(seq[seq.length - 1]), name: 'TXTX-SỬA LỖI', conf: 0.75, id: 'tx_fix' };
        }
        return null;
    }
}

// ========================================================================
// [MODULE 8] META ENGINE (TỔNG HỢP)
// ========================================================================
class MetaEngine {
    static analyze(seq, db) {
        if (!NoiseFilter.isPureTXTX(seq, 10)) {
            return { code: null, label: 'NHIỄU - BỎ QUA', tiLe: '0.0%', weak: true, details: [] };
        }

        const candidates = [
            TXTXEngine.markovTXTX(seq),
            TXTXEngine.recursiveTXTX(seq),
            TXTXEngine.deviationAnalysis(seq)
        ].filter(Boolean);

        if (candidates.length === 0) {
            return {
                code: Core.flip(seq[seq.length - 1]),
                label: 'TXTX-CƠ BẢN',
                tiLe: '60.0%',
                weak: false,
                details: [{ algo: 'tx_basic', family: 'txtx', code: Core.flip(seq[seq.length - 1]), name: 'TXTX-MẶC ĐỊNH', conf: 0.60, vote: 0.60 }]
            };
        }

        const votes = { T: 0, X: 0 };
        const details = [];

        for (const algo of candidates) {
            const stats = db.algoStats?.[algo.id] || { weight: 1.0, loseStreak: 0, winStreak: 0 };
            let weight = stats.weight || 1.0;
            if (stats.winStreak >= 2) weight *= 1.5;
            if (stats.loseStreak >= 2) weight = Math.max(0.1, weight * 0.5);
            
            const finalWeight = MathUtils.clamp(MathUtils.logWeight(weight + 1), 0.1, 2.5);
            const power = algo.conf * finalWeight;

            votes[algo.code] += power;
            details.push({ algo: algo.id, family: 'txtx', code: algo.code, name: algo.name, conf: MathUtils.round(algo.conf, 3), vote: MathUtils.round(power, 3) });
        }

        const totalVotes = votes.T + votes.X;
        let winner, confidence;

        if (totalVotes < 0.1) {
            winner = Core.flip(seq[seq.length - 1]);
            confidence = 0.60;
            details.push({ algo: 'tx_fb', family: 'txtx', code: winner, name: 'TXTX-FALLBACK', conf: 0.60, vote: 1 });
        } else {
            const pT = votes.T / totalVotes;
            const pX = votes.X / totalVotes;
            winner = pT > pX ? 'T' : 'X';
            confidence = Math.max(pT, pX);
        }

        confidence = MathUtils.clamp(confidence, 0.50, 0.95);
        const topAlgo = details.filter(d => d.code === winner).sort((a, b) => b.vote - a.vote)[0];

        return {
            code: winner,
            label: topAlgo ? `META·${topAlgo.name}` : 'META·TXTX',
            tiLe: (confidence * 100).toFixed(1) + '%',
            weak: confidence < 0.65,
            details
        };
    }
}

// ========================================================================
// [MODULE 9] FETCHER THÔNG MINH (TỰ ĐỘNG ĐỔI DOMAIN)
// ========================================================================
let activeDomainIndex = 0; // Lưu domain đang hoạt động

class Fetcher {
    static async getData(game) {
        // Thử tối đa 3 domain nếu domain hiện tại lỗi
        for (let attempt = 0; attempt < CONFIG.API_DOMAINS.length; attempt++) {
            // Xoay vòng domain
            const currentDomain = CONFIG.API_DOMAINS[activeDomainIndex];
            const pathApi = game === 'md5' ? '/api/md5luckydice/GetSoiCau' : '/api/luckydice/GetSoiCau';
            const targetUrl = `${currentDomain}${pathApi}`;

            try {
                const res = await axios.get(targetUrl, { 
                    timeout: 12000,
                    headers: { 
                        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
                        'Accept': 'application/json, text/plain, */*'
                    }
                });

                let arr = [];
                let data = res.data;
                if (Array.isArray(data)) arr = data;
                else if (data && data.data && Array.isArray(data.data)) arr = data.data;
                else if (data && data.data && data.data.list) arr = data.data.list;

                if (Array.isArray(arr) && arr.length > 5) {
                    if (Number(arr[0].SessionId) > Number(arr[arr.length - 1].SessionId)) arr.reverse(); 
                    console.log(`[FETCH OK] ${game.toUpperCase()} | Domain: ${currentDomain} | Phiên mới nhất: ${arr[arr.length-1].SessionId}`);
                    return arr;
                }
            } catch (e) {
                console.error(`[FETCH FAIL] ${game.toUpperCase()} | Domain: ${currentDomain} | Lỗi: ${e.message}`);
                // Đổi domain tiếp theo
                activeDomainIndex = (activeDomainIndex + 1) % CONFIG.API_DOMAINS.length;
                await new Promise(r => setTimeout(r, 1000));
            }
        }
        return []; // Trả về rỗng nếu chết hết cả 3 domain
    }
}

// ========================================================================
// [MODULE 10] WORKER (XỬ LÝ NGẦM)
// ========================================================================
class Worker {
    static async process(game) {
        try {
            const list = await Fetcher.getData(game);
            if (!list || list.length < 10) return;

            const latest = list[list.length - 1];
            const session = MathUtils.safeInt(latest.SessionId);
            const db = DB.load(game);

            if (db.lastSession !== null && session <= db.lastSession) return;

            const seq = list.map(Core.getResult).filter(Boolean);
            const prev = db.history[db.history.length - 1];
            
            // Cập nhật kết quả phiên trước
            if (prev && MathUtils.safeInt(prev.phienDuDoan) <= session) {
                const targetItem = list.find(x => MathUtils.safeInt(x.SessionId) === prev.phienDuDoan);
                if (targetItem) {
                    const actual = Core.getResult(targetItem);
                    prev.ketQua = actual; prev.ketQuaLabel = Core.getLabel(actual);
                    prev.trangThai = prev.DU_DOAN_CODE === actual ? 'ĐÚNG' : 'SAI';
                    
                    if (!db.algoStats) db.algoStats = {};
                    for (const d of prev.algoDetails) {
                        if (!db.algoStats[d.algo]) db.algoStats[d.algo] = { weight: 1.0, loseStreak: 0, winStreak: 0 };
                        const stat = db.algoStats[d.algo];
                        if (d.code === actual) {
                            stat.weight = MathUtils.clamp(stat.weight + 0.1, 0.5, 3.0);
                            stat.loseStreak = 0;
                            stat.winStreak = (stat.winStreak || 0) + 1;
                        } else {
                            stat.weight = MathUtils.clamp(stat.weight - 0.2, 0.1, 3.0);
                            stat.loseStreak += 1;
                            stat.winStreak = 0;
                        }
                    }
                }
            }

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
            console.error('[WORKER ERROR]', err.message);
        }
    }

    static start() {
        let isProcessing = false;
        const run = async () => {
            if (isProcessing) return;
            isProcessing = true;
            try {
                await this.process('md5'); 
                await this.process('taixiu'); 
            } finally {
                isProcessing = false;
            }
        };
        run(); 
        setInterval(run, CONFIG.TICK_MS);
    }
}

Worker.start();

// ========================================================================
// [MODULE 11] GIAO DIỆN & API ROUTES
// ========================================================================
app.get('/', (req, res) => res.redirect('/history/md5'));

app.get('/history/:game(md5|taixiu)', async (req, res) => {
    try {
        const game = req.params.game;
        const db = DB.load(game);
        
        const page = MathUtils.safeInt(req.query.page, 1);
        const limit = 100;
        const startIndex = Math.max(0, db.history.length - (page * limit));
        const endIndex = db.history.length - ((page - 1) * limit);
        const rows = db.history.slice(startIndex, endIndex).reverse();

        const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
        const correct = settled.filter(h => h.trangThai === 'ĐÚNG').length;
        const acc = settled.length ? (correct / settled.length * 100).toFixed(1) : '0.0';

        // Nếu DB rỗng (do API chết trên Render), hiển thị cảnh báo
        const warningHtml = db.history.length === 0 ? `
            <div style="background: rgba(239, 68, 68, 0.1); border: 1px solid #ef4444; color: #ef4444; padding: 15px; border-radius: 8px; text-align: center; margin-bottom: 20px;">
                <b>⚠️ CHƯA CÓ DỮ LIỆU</b><br>
                <span style="font-size: 12px;">Hệ thống đang chờ API phản hồi. Nếu quá 1 phút vẫn trống, có thể IP của Render đã bị nhà cái chặn. Hãy xem Logs trên Render để kiểm tra.</span>
            </div>
        ` : '';

        const html = `<!DOCTYPE html>
        <html lang="vi">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
        <title>TXTX AI - ${game.toUpperCase()}</title>
        <style>
            :root { --bg: #09090b; --card: #18181b; --text: #f4f4f5; --green: #10b981; --red: #ef4444; --yellow: #f59e0b; --border: #27272a; }
            * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, sans-serif; }
            body { background: var(--bg); color: var(--text); padding: 15px; }
            .header { background: var(--card); padding: 20px; border-radius: 12px; text-align: center; margin-bottom: 20px; border: 1px solid var(--border); }
            h1 { font-size: 20px; text-transform: uppercase; margin-bottom: 15px; color: #a78bfa; }
            .acc { font-size: 28px; font-weight: 900; color: ${parseFloat(acc) >= 55 ? 'var(--green)' : 'var(--red)'}; }
            .table-wrap { background: var(--card); border-radius: 12px; overflow-x: auto; border: 1px solid var(--border); margin-bottom: 20px; }
            table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: center; }
            th { background: #27272a; padding: 15px 5px; color: #a1a1aa; font-size: 11px; text-transform: uppercase; }
            td { padding: 12px 5px; border-bottom: 1px solid var(--border); }
            .tai { color: var(--green); font-weight: bold; }
            .xiu { color: var(--red); font-weight: bold; }
            .dung { color: var(--green); font-weight: bold; }
            .sai { color: var(--red); font-weight: bold; }
            .cho { color: var(--yellow); font-weight: bold; }
            .dice-box { display: flex; justify-content: center; gap: 3px; }
            .dice { width: 20px; height: 20px; background: #fff; color: #000; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 12px; }
            .sum { background: #27272a; padding: 4px 8px; border-radius: 6px; color: var(--yellow); font-weight: bold; }
            .pattern { background: #27272a; padding: 4px 8px; border-radius: 6px; font-size: 11px; border: 1px solid #3f3f46; color: #cbd5e1; }
            .pagination { display: flex; justify-content: center; gap: 10px; margin-top: 20px; }
            .pagination a { color: #a78bfa; text-decoration: none; padding: 8px 16px; background: var(--card); border-radius: 8px; border: 1px solid var(--border); }
        </style>
        <script>setTimeout(() => { window.location.reload(); }, 5000);</script>
        </head>
        <body>
            <div class="header">
                <h1>HỆ THỐNG TXTX - ${game.toUpperCase()}</h1>
                <div class="acc">${acc}%</div>
                <div style="font-size:12px; color:#888; margin-top:5px;">Tổng ${settled.length} phiên đã học</div>
            </div>
            ${warningHtml}
            <div class="table-wrap">
                <table>
                    <thead><tr><th>Phiên</th><th>XX</th><th>Tổng</th><th>KQ</th><th>Dự Đoán</th><th>Cầu</th><th>Trạng Thái</th></tr></thead>
                    <tbody>
                        ${rows.map(it => `
                            <tr>
                                <td style="color: #71717a;">${it.phien}</td>
                                <td><div class="dice-box">${(it.xucXac||[]).map(d => `<div class="dice">${d}</div>`).join('')}</div></td>
                                <td><span class="sum">${it.tong}</span></td>
                                <td class="${it.ketQua === 'T' ? 'tai' : 'xiu'}">${it.ketQuaLabel || 'N/A'}</td>
                                <td class="${it.DU_DOAN_CODE === 'T' ? 'tai' : 'xiu'}">${it.DU_DOAN || 'N/A'} (${it.TI_LE})</td>
                                <td><span class="pattern">${it.patternName}</span></td>
                                <td class="${it.trangThai === 'ĐÚNG' ? 'dung' : (it.trangThai === 'SAI' ? 'sai' : 'cho')}">${it.trangThai}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
            <div class="pagination">
                ${page > 1 ? `<a href="?page=${page - 1}">Trang trước</a>` : ''}
                <span style="padding: 8px 16px;">Trang ${page}</span>
                ${rows.length === limit ? `<a href="?page=${page + 1}">Trang tiếp</a>` : ''}
            </div>
        </body>
        </html>`;
        res.send(html);
    } catch (err) { res.status(500).send('Lỗi UI: ' + err.message); }
});

app.get('/:game(md5|taixiu)', async (req, res) => {
    try {
        const game = req.params.game;
        let list = await Fetcher.getData(game);
        let db = DB.load(game);

        // Nếu không lấy được từ API, dùng tạm DB cũ để không bị sập API Endpoint
        if (!list || list.length < 10) {
            if (db.history.length === 0) return res.status(503).json({ error: 'No Data API blocked' });
            list = db.history.slice(-50).map(h => ({ 
                SessionId: h.phien, 
                FirstDice: h.xucXac[0]||1, 
                SecondDice: h.xucXac[1]||1, 
                ThirdDice: h.xucXac[2]||1 
            }));
        }

        const latest = list[list.length - 1];
        const session = MathUtils.safeInt(latest.SessionId);
        const seq = list.map(Core.getResult).filter(Boolean);
        const pred = MetaEngine.analyze(seq, db);

        if (!pred.code) {
            return res.json({ success: true, message: "Nhiễu cầu, bỏ qua phiên này", duDoan: "BỎ QUA" });
        }

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
// [MODULE 12] KHỞI CHẠY
// ========================================================================
app.listen(CONFIG.PORT, CONFIG.HOST, () => {
    console.log(`=======================================================`);
    console.log(`🚀 ${CONFIG.VERSION} ONLINE - PORT ${CONFIG.PORT}`);
    console.log(`🌐 DB DIR: ${CONFIG.DB_DIR}`);
    console.log(`🎯 FOCUS: TXTX PATTERN ONLY`);
    console.log(`=======================================================`);
});
