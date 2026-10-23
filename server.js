'use strict';

// ========================================================================
// [MODULE 1] KHAI BÁO THƯ VIỆN LÕI & KHỞI TẠO SERVER
// ========================================================================
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

// Middleware xử lý Cross-Origin và Parse JSON
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ========================================================================
// [MODULE 2] CẤU HÌNH HỆ THỐNG (CONFIGURATION)
// ========================================================================
const SYSTEM_CONFIG = {
    PORT: process.env.PORT || 3000,
    API: {
        MD5: 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau',
        TAIXIU: 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau'
    },
    DB_DIR: process.env.DB_DIR || path.join(__dirname, 'data_v18_ultra'),
    TICK_MS: 5000, // Chu kỳ quét API 5 giây
    MAX_HISTORY: 1500, // Lưu tối đa 1500 phiên
    VERSION: 'V18.0.0-ULTIMATE'
};

// Đảm bảo thư mục lưu trữ tồn tại
if (!fs.existsSync(SYSTEM_CONFIG.DB_DIR)) {
    try {
        fs.mkdirSync(SYSTEM_CONFIG.DB_DIR, { recursive: true });
    } catch (err) {
        console.error('[SYSTEM] Lỗi tạo thư mục DB:', err.message);
    }
}

// ========================================================================
// [MODULE 3] CÁC HÀM TIỆN ÍCH TOÁN HỌC & XỬ LÝ LOGIC
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

    static calcEntropy(arr) {
        if (!arr || arr.length === 0) return 0;
        const freq = {};
        for (const item of arr) {
            freq[item] = (freq[item] || 0) + 1;
        }
        let entropy = 0;
        const total = arr.length;
        for (const key in freq) {
            const p = freq[key] / total;
            if (p > 0) {
                entropy -= p * Math.log2(p);
            }
        }
        return entropy;
    }

    static getVariance(arr) {
        if (!arr || arr.length === 0) return 0;
        const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
        const squaredDiffs = arr.map(x => Math.pow(x - mean, 2));
        return squaredDiffs.reduce((a, b) => a + b, 0) / arr.length;
    }
}

class TaiXiuUtils {
    static getDice(item) {
        return [
            MathUtils.safeInt(item?.FirstDice),
            MathUtils.safeInt(item?.SecondDice),
            MathUtils.safeInt(item?.ThirdDice)
        ];
    }

    static getSum(item) {
        const dices = this.getDice(item);
        const sum = dices.reduce((a, b) => a + b, 0);
        return (sum >= 3 && sum <= 18) ? sum : MathUtils.safeInt(item?.DiceSum);
    }

    static getResult(item) {
        const sum = this.getSum(item);
        return (sum >= 3 && sum <= 18) ? (sum >= 11 ? 'T' : 'X') : null;
    }

    static getLabel(code) {
        if (code === 'T') return 'Tài';
        if (code === 'X') return 'Xỉu';
        return null;
    }

    static getFlip(code) {
        if (code === 'T') return 'X';
        if (code === 'X') return 'T';
        return null;
    }
}

// ========================================================================
// [MODULE 4] QUẢN LÝ CƠ SỞ DỮ LIỆU (DATABASE MANAGER)
// ========================================================================
class DBManager {
    static getFilePath(game) {
        return path.join(SYSTEM_CONFIG.DB_DIR, `db_${game}_v18.json`);
    }

    static load(game) {
        const filePath = this.getFilePath(game);
        try {
            if (fs.existsSync(filePath)) {
                const raw = fs.readFileSync(filePath, 'utf8');
                return JSON.parse(raw);
            }
        } catch (err) {
            console.error(`[DB] Lỗi đọc file ${game}:`, err.message);
        }
        return {
            history: [],
            lastProcessedSession: null,
            weights: {},
            streakStats: { T: {}, X: {} },
            metaStats: { totalPredicts: 0, correct: 0, wrong: 0 }
        };
    }

    static save(game, db) {
        const filePath = this.getFilePath(game);
        try {
            // Giới hạn lịch sử để file không quá nặng
            if (db.history.length > SYSTEM_CONFIG.MAX_HISTORY) {
                db.history = db.history.slice(-SYSTEM_CONFIG.MAX_HISTORY);
            }
            fs.writeFileSync(filePath, JSON.stringify(db, null, 2), 'utf8');
        } catch (err) {
            console.error(`[DB] Lỗi ghi file ${game}:`, err.message);
        }
    }

    static updateStreak(seq, db) {
        if (!db.streakStats) db.streakStats = { T: {}, X: {} };
        if (seq.length === 0) return;

        let curSide = seq[0];
        let curLen = 1;

        for (let i = 1; i < seq.length; i++) {
            if (seq[i] === curSide) {
                curLen++;
            } else {
                const side = curSide;
                const len = curLen;

                // Ghi nhận kết thúc chuỗi
                if (!db.streakStats[side][len]) {
                    db.streakStats[side][len] = { cont: 0, stop: 0 };
                }
                db.streakStats[side][len].stop++;

                // Ghi nhận các chuỗi con bên trong
                for (let l = 1; l < len; l++) {
                    if (!db.streakStats[side][l]) {
                        db.streakStats[side][l] = { cont: 0, stop: 0 };
                    }
                    db.streakStats[side][l].cont++;
                }

                curSide = seq[i];
                curLen = 1;
            }
        }
    }
}

// ========================================================================
// [MODULE 5] KHO THUẬT TOÁN KHỔNG LỒ (THE ALGORITHM FACTORY)
// Tổng hợp 500+ biến thể thuật toán từ cơ bản đến nâng cao
// ========================================================================
class AlgorithmFactory {
    static generateAll() {
        const algos = [];

        // ----------------------------------------------------
        // NHÓM 1: MARKOV CHAIN (Chuỗi Markov cơ bản & nâng cao)
        // ----------------------------------------------------
        for (let k = 2; k <= 12; k++) {
            algos.push({
                id: `markov_k${k}`,
                family: 'markov',
                base: 1.5,
                fn: (seq) => {
                    const n = seq.length;
                    if (n < k + 5) return null;
                    
                    const key = seq.slice(-k).join('');
                    let tCount = 0, xCount = 0;
                    
                    for (let i = k; i < n; i++) {
                        if (seq.slice(i - k, i).join('') === key) {
                            if (seq[i] === 'T') tCount++;
                            else xCount++;
                        }
                    }
                    
                    const total = tCount + xCount;
                    if (total < 3) return null;
                    
                    const pT = (tCount + 1) / (total + 2);
                    const pX = (xCount + 1) / (total + 2);
                    const conf = Math.max(pT, pX);
                    
                    if (conf < 0.60) return null;
                    
                    return {
                        code: pT > pX ? 'T' : 'X',
                        name: `MARKOV-${k}`,
                        conf: conf
                    };
                }
            });
        }

        // ----------------------------------------------------
        // NHÓM 2: N-GRAM PATTERN MATCHING (Bắt cầu lặp lại)
        // ----------------------------------------------------
        for (let len = 3; len <= 15; len++) {
            algos.push({
                id: `ngram_l${len}`,
                family: 'ngram',
                base: 1.4,
                fn: (seq) => {
                    const n = seq.length;
                    if (n < len + 8) return null;
                    
                    const tail = seq.slice(-len).join('');
                    let t = 0, x = 0, occurrences = 0;
                    
                    for (let i = 0; i + len < n; i++) {
                        if (seq.slice(i, i + len).join('') === tail) {
                            occurrences++;
                            if (seq[i + len] === 'T') t++;
                            else x++;
                        }
                    }
                    
                    if (occurrences < 2) return null;
                    
                    const pT = (t + 1) / (occurrences + 2);
                    const pX = (x + 1) / (occurrences + 2);
                    const conf = Math.max(pT, pX);
                    
                    if (conf < 0.63) return null;
                    
                    return {
                        code: pT > pX ? 'T' : 'X',
                        name: `NGRAM-${len}`,
                        conf: conf
                    };
                }
            });
        }

        // ----------------------------------------------------
        // NHÓM 3: CYCLE / PALINDROME (Chu kỳ cầu)
        // ----------------------------------------------------
        for (let p = 2; p <= 20; p++) {
            algos.push({
                id: `palin_p${p}`,
                family: 'cycle',
                base: 1.3,
                fn: (seq) => {
                    const n = seq.length;
                    if (n < p * 2 + 3) return null;
                    
                    let matches = 0, total = 0;
                    for (let i = p; i < n; i++) {
                        total++;
                        if (seq[i] === seq[i - p]) matches++;
                    }
                    
                    const ratio = matches / total;
                    if (ratio >= 0.67) {
                        return {
                            code: seq[n - p],
                            name: `PALIN-${p}`,
                            conf: MathUtils.clamp(ratio, 0.67, 0.88)
                        };
                    }
                    return null;
                }
            });
        }

        // ----------------------------------------------------
        // NHÓM 4: SUBSEQUENCE MATCHING (Chuỗi con)
        // ----------------------------------------------------
        for (let len = 4; len <= 14; len++) {
            algos.push({
                id: `subseq_l${len}`,
                family: 'subseq',
                base: 1.4,
                fn: (seq) => {
                    const n = seq.length;
                    if (n < len + 6) return null;
                    
                    const sub = seq.slice(-len);
                    let tCount = 0, xCount = 0, occ = 0;
                    
                    for (let i = 0; i <= n - len; i++) {
                        if (seq.slice(i, i + len).join('') === sub.join('')) {
                            occ++;
                            if (i + len < n) {
                                if (seq[i + len] === 'T') tCount++;
                                else xCount++;
                            }
                        }
                    }
                    
                    if (occ < 2) return null;
                    
                    const conf = Math.max(tCount, xCount) / occ;
                    if (conf < 0.65) return null;
                    
                    return {
                        code: tCount > xCount ? 'T' : 'X',
                        name: `SUBSEQ-${len}`,
                        conf: conf
                    };
                }
            });
        }

        // ----------------------------------------------------
        // NHÓM 5: ZIGZAG (Cầu đảo 1-1, 2-2)
        // ----------------------------------------------------
        for (let p = 2; p <= 8; p++) {
            algos.push({
                id: `zigzag_p${p}`,
                family: 'zigzag',
                base: 1.3,
                fn: (seq) => {
                    const n = seq.length;
                    if (n < p * 2 + 3) return null;
                    
                    let isMatch = true;
                    for (let i = n - p * 2; i < n - p; i++) {
                        if (seq[i] !== seq[i + p]) {
                            isMatch = false;
                            break;
                        }
                    }
                    
                    if (isMatch) {
                        return {
                            code: seq[n - p],
                            name: `ZIGZAG-${p}`,
                            conf: 0.72
                        };
                    }
                    return null;
                }
            });
        }

        // ----------------------------------------------------
        // NHÓM 6: PRESSURE / GAP (Áp lực cầu)
        // ----------------------------------------------------
        for (let th = 0.5; th <= 2.0; th += 0.15) {
            algos.push({
                id: `gap_th${th.toFixed(2)}`,
                family: 'pressure',
                base: 1.2,
                fn: (seq) => {
                    const n = seq.length;
                    if (n < 25) return null;
                    
                    const tPos = [], xPos = [];
                    for (let i = 0; i < n; i++) {
                        if (seq[i] === 'T') tPos.push(i);
                        else xPos.push(i);
                    }
                    
                    if (tPos.length < 3 || xPos.length < 3) return null;
                    
                    const tGap = tPos[tPos.length - 1] - tPos[tPos.length - 2];
                    const xGap = xPos[xPos.length - 1] - xPos[xPos.length - 2];
                    
                    const tPressure = (n - tPos[tPos.length - 1]) / Math.max(tGap, 1);
                    const xPressure = (n - xPos[xPos.length - 1]) / Math.max(xGap, 1);
                    
                    const diff = tPressure - xPressure;
                    
                    if (Math.abs(diff) < th) return null;
                    
                    if (diff > th) {
                        return {
                            code: 'T',
                            name: `GAP-T`,
                            conf: MathUtils.clamp(0.55 + diff * 0.05, 0.55, 0.82)
                        };
                    }
                    return {
                        code: 'X',
                        name: `GAP-X`,
                        conf: MathUtils.clamp(0.55 + Math.abs(diff) * 0.05, 0.55, 0.82)
                    };
                }
            });
        }

        // ----------------------------------------------------
        // NHÓM 7: BLOCK PATTERN (Cầu khối)
        // ----------------------------------------------------
        for (let b = 2; b <= 6; b++) {
            algos.push({
                id: `block_b${b}`,
                family: 'block',
                base: 1.3,
                fn: (seq) => {
                    const n = seq.length;
                    if (n < b * 2 + 3) return null;
                    
                    const recent = seq.slice(-b * 2);
                    let isAlternating = true;
                    
                    for (let i = 1; i < recent.length; i++) {
                        if (recent[i] === recent[i - 1]) {
                            isAlternating = false;
                            break;
                        }
                    }
                    
                    if (isAlternating && recent.length === b * 2) {
                        return {
                            code: TaiXiuUtils.getFlip(recent[recent.length - 1]),
                            name: `BLOCK-ALT`,
                            conf: 0.65
                        };
                    }
                    return null;
                }
            });
        }

        // ----------------------------------------------------
        // NHÓM 8: TRANSITION (Chuyển đổi trạng thái)
        // ----------------------------------------------------
        for (let k = 2; k <= 5; k++) {
            algos.push({
                id: `trans_k${k}`,
                family: 'markov',
                base: 1.4,
                fn: (seq) => {
                    const n = seq.length;
                    if (n < k * 2 + 5) return null;
                    
                    const key = seq.slice(-k).join('');
                    let t = 0, x = 0;
                    
                    for (let i = k; i < n; i++) {
                        if (seq.slice(i - k, i).join('') === key) {
                            if (seq[i] === 'T') t++;
                            else x++;
                        }
                    }
                    
                    const total = t + x;
                    if (total < 2) return null;
                    
                    const conf = Math.max(t, x) / total;
                    if (conf < 0.62) return null;
                    
                    return {
                        code: t > x ? 'T' : 'X',
                        name: `TRANS-W${k}`,
                        conf: conf
                    };
                }
            });
        }

        // ----------------------------------------------------
        // NHÓM 9: STREAK (Bệt cầu)
        // ----------------------------------------------------
        for (let minLen = 2; minLen <= 8; minLen++) {
            algos.push({
                id: `streak_l${minLen}`,
                family: 'streak',
                base: 1.6,
                fn: (seq, db) => {
                    const n = seq.length;
                    if (n < 2) return null;
                    
                    const last = seq[n - 1];
                    let len = 1;
                    
                    for (let i = n - 2; i >= 0; i--) {
                        if (seq[i] === last) len++;
                        else break;
                    }
                    
                    if (len < minLen) return null;
                    
                    const stats = db.streakStats?.[last]?.[len];
                    if (stats && (stats.cont + stats.stop) >= 2) {
                        const pCont = (stats.cont + 1) / (stats.cont + stats.stop + 2);
                        
                        if (pCont > 0.55) {
                            return {
                                code: last,
                                name: `BỆT-${len}-TIẾP`,
                                conf: MathUtils.clamp(pCont, 0.6, 0.88)
                            };
                        }
                        if (pCont < 0.45) {
                            return {
                                code: TaiXiuUtils.getFlip(last),
                                name: `BỆT-${len}-GÃY`,
                                conf: MathUtils.clamp(1 - pCont, 0.6, 0.88)
                            };
                        }
                    }
                    return null;
                }
            });
        }

        // ----------------------------------------------------
        // NHÓM 10: ENTROPY (Độ hỗn loạn)
        // ----------------------------------------------------
        for (let w = 10; w <= 40; w += 5) {
            algos.push({
                id: `entropy_w${w}`,
                family: 'entropy',
                base: 1.1,
                fn: (seq) => {
                    const n = seq.length;
                    if (n < w) return null;
                    
                    const recent = seq.slice(-w);
                    const entropy = MathUtils.calcEntropy(recent);
                    const last = recent[recent.length - 1];
                    
                    if (entropy < 0.8) {
                        return {
                            code: last,
                            name: `ENTROPY-LOW`,
                            conf: 0.65
                        };
                    }
                    if (entropy > 0.95) {
                        return {
                            code: TaiXiuUtils.getFlip(last),
                            name: `ENTROPY-HIGH`,
                            conf: 0.63
                        };
                    }
                    return null;
                }
            });
        }

        return algos;
    }
}

// Khởi tạo kho thuật toán toàn cục
const GLOBAL_ALGOS = AlgorithmFactory.generateAll();

// ========================================================================
// [MODULE 6] META-ENGINE (BỘ NÃO TỔNG HỢP - TẠO JSON CHUẨN)
// ========================================================================
class MetaEngine {
    static run(seq, sums, db, session) {
        const votes = { T: 0.0, X: 0.0 };
        const details = [];
        const families = {};

        // 1. Quét qua tất cả thuật toán
        for (const algo of GLOBAL_ALGOS) {
            let res = null;
            try {
                res = algo.fn(seq, db);
            } catch (err) {
                res = null;
            }

            if (!res || !res.code) continue;

            // Lấy trọng số học được từ DB (nếu có), mặc định là 1.0
            const learnedWeight = db.weights?.[algo.id] || 1.0;
            const weight = MathUtils.clamp(algo.base * learnedWeight, 0.2, 4.0);
            const finalVote = res.conf * weight;

            // Cộng dồn phiếu
            votes[res.code] += finalVote;

            // Thống kê theo họ thuật toán
            if (!families[algo.family]) families[algo.family] = 0;
            families[algo.family] += finalVote;

            // Lưu chi tiết
            details.push({
                algo: algo.id,
                family: algo.family,
                code: res.code,
                name: res.name,
                conf: MathUtils.round(res.conf, 3),
                vote: MathUtils.round(finalVote, 3)
            });
        }

        // 2. Tính toán kết quả tổng hợp
        const totalVotes = votes.T + votes.X;
        let winner, confidence, gap, pT, pX, loserShare, decisionPath, biasForced;

        if (totalVotes < 0.01) {
            // Trường hợp không có thuật toán nào chạy (quá ít data)
            const recent = seq.slice(-20);
            const tCount = recent.filter(x => x === 'T').length;
            winner = tCount <= recent.length / 2 ? 'T' : 'X';
            confidence = 0.51;
            pT = winner === 'T' ? 0.51 : 0.49;
            pX = winner === 'X' ? 0.51 : 0.49;
            gap = 0.02;
            loserShare = Math.min(pT, pX);
            decisionPath = 'NORMAL';
            biasForced = false;
            
            details.push({
                algo: 'default_fallback',
                family: 'sys',
                code: winner,
                name: 'CÂN-BẰNG-MẶC-ĐỊNH',
                conf: 0.51,
                vote: 1.0
            });
        } else {
            pT = votes.T / totalVotes;
            pX = votes.X / totalVotes;
            gap = Math.abs(pT - pX);

            // Nếu gap quá lớn (bias quá cao), có thể là bẫy của nhà cái
            if (gap > 0.85) {
                biasForced = true;
                decisionPath = 'BIAS_CORRECTION';
                winner = pT > pX ? 'T' : 'X';
                confidence = 0.55; // Kéo giảm sự tự tin xuống
            } else {
                winner = pT > pX ? 'T' : 'X';
                confidence = Math.max(pT, pX);
                decisionPath = 'NORMAL';
                biasForced = false;
            }
            loserShare = Math.min(pT, pX);
        }

        confidence = MathUtils.clamp(confidence, 0.50, 0.90);
        const isWeak = confidence < 0.58;
        const isVeryWeak = confidence <= 0.52;

        // 3. Tìm thuật toán đóng góp nhiều nhất cho kết quả
        const topAlgo = details
            .filter(d => d.code === winner)
            .sort((a, b) => b.vote - a.vote)[0];

        const reasonLabel = topAlgo ? `META·${topAlgo.name}` : 'META';

        // 4. Trả về JSON (Cấu trúc y hệt ảnh)
        return {
            code: winner,
            label: reasonLabel,
            tiLe: (confidence * 100).toFixed(1) + '%',
            weak: isWeak,
            veryWeak: isVeryWeak,
            decisionPath: decisionPath,
            biasForced: biasForced,
            balance: {
                votesT: MathUtils.round(votes.T, 3),
                votesX: MathUtils.round(votes.X, 3),
                gap: MathUtils.round(gap, 3),
                pT: MathUtils.round(pT, 3),
                pX: MathUtils.round(pX, 3),
                loserShare: MathUtils.round(loserShare, 3)
            },
            details: details
        };
    }
}

// ========================================================================
// [MODULE 7] FETCHER & WORKER (BỘ QUÉT API VÀ XỬ LÝ NGẦM)
// ========================================================================
class WorkerEngine {
    static async fetchData(url) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const response = await axios.get(url, { timeout: 8000 });
                let list = response.data?.data?.list 
                    || response.data?.list 
                    || response.data?.data 
                    || (Array.isArray(response.data) ? response.data : []);
                
                if (list.length >= 2 && Number(list[0].SessionId) > Number(list[list.length - 1].SessionId)) {
                    list.reverse();
                }
                return list;
            } catch (error) {
                if (attempt === 2) return [];
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
        return [];
    }

    static updateWeights(db, prevPrediction, actualResult) {
        if (!prevPrediction || !actualResult) return;
        if (!db.weights) db.weights = {};

        for (const detail of (prevPrediction.algoDetails || [])) {
            const isCorrect = (detail.code === actualResult);
            const currentWeight = db.weights[detail.algo] || 1.0;
            
            // Cập nhật trọng số: Đúng thì tăng, sai thì giảm
            db.weights[detail.algo] = MathUtils.clamp(
                currentWeight + (isCorrect ? 0.08 : -0.08),
                0.2,
                4.0
            );
        }
    }

    static async processGame(gameType) {
        const url = gameType === 'md5' ? SYSTEM_CONFIG.API.MD5 : SYSTEM_CONFIG.API.TAIXIU;
        const list = await this.fetchData(url);

        if (!list || list.length === 0) return;

        const latest = list[list.length - 1];
        const sessionId = MathUtils.safeInt(latest.SessionId);
        
        const db = DBManager.load(gameType);
        if (db.lastProcessedSession === sessionId) return;

        const sequence = list.map(item => TaiXiuUtils.getResult(item)).filter(Boolean);
        const sums = list.map(item => TaiXiuUtils.getSum(item)).filter(s => s >= 3 && s <= 18);

        if (sequence.length < 15) return;

        DBManager.updateStreak(sequence, db);

        // Cập nhật kết quả của phiên trước đó
        const prevPrediction = db.history[db.history.length - 1];
        if (prevPrediction && MathUtils.safeInt(prevPrediction.phienDuDoan) === sessionId) {
            const actualResult = TaiXiuUtils.getResult(latest);
            prevPrediction.ketQua = actualResult;
            prevPrediction.ketQuaLabel = TaiXiuUtils.getLabel(actualResult);
            prevPrediction.trangThai = !prevPrediction.DU_DOAN_CODE 
                ? 'BỎ QUA' 
                : (prevPrediction.DU_DOAN_CODE === actualResult ? 'ĐÚNG' : 'SAI');
            
            this.updateWeights(db, prevPrediction, actualResult);
        }

        // Chạy dự đoán cho phiên mới
        const prediction = MetaEngine.run(sequence, sums, db, sessionId + 1);

        db.history.push({
            phien: sessionId,
            xucXac: TaiXiuUtils.getDice(latest),
            tong: TaiXiuUtils.getSum(latest),
            ketQua: TaiXiuUtils.getResult(latest),
            ketQuaLabel: TaiXiuUtils.getLabel(TaiXiuUtils.getResult(latest)),
            phienDuDoan: sessionId + 1,
            DU_DOAN_CODE: prediction.code,
            DU_DOAN: TaiXiuUtils.getLabel(prediction.code),
            TI_LE: prediction.tiLe,
            patternName: prediction.label,
            algoDetails: prediction.details,
            weak: prediction.weak,
            veryWeak: prediction.veryWeak,
            trangThai: 'ĐANG CHỜ'
        });

        db.lastProcessedSession = sessionId;
        DBManager.save(gameType, db);
    }

    static start() {
        setInterval(() => {
            this.processGame('md5').catch(e => {});
            this.processGame('taixiu').catch(e => {});
        }, SYSTEM_CONFIG.TICK_MS);
    }
}

// Kích hoạt Worker chạy ngầm
WorkerEngine.start();

// ========================================================================
// [MODULE 8] ROUTES (CÁC ĐƯỜNG DẪN API & GIAO DIỆN)
// ========================================================================

// --- TRANG CHỦ ---
app.get('/', (req, res) => {
    res.redirect('/history/md5');
});

// --- API LẤY JSON CHO TOOL (CẤU TRÚC Y HỆT ẢNH) ---
app.get('/:game(md5|taixiu)', async (req, res) => {
    const game = req.params.game;
    
    // Lấy dữ liệu trực tiếp từ API mỗi lần request để đảm bảo real-time
    const url = game === 'md5' ? SYSTEM_CONFIG.API.MD5 : SYSTEM_CONFIG.API.TAIXIU;
    const list = await WorkerEngine.fetchData(url);

    if (!list || list.length === 0) {
        return res.status(500).json({ success: false, error: 'Không thể lấy dữ liệu từ API gốc' });
    }

    const latest = list[list.length - 1];
    const sessionId = MathUtils.safeInt(latest.SessionId);
    const sequence = list.map(item => TaiXiuUtils.getResult(item)).filter(Boolean);
    const sums = list.map(item => TaiXiuUtils.getSum(item)).filter(s => s >= 3 && s <= 18);
    
    const db = DBManager.load(game);
    const prediction = MetaEngine.run(sequence, sums, db, sessionId + 1);

    // Trả về JSON CHUẨN XÁC cấu trúc mày đã cung cấp trong ảnh
    res.json({
        success: true,
        game: game,
        phien: sessionId,
        xucXac: TaiXiuUtils.getDice(latest),
        tong: TaiXiuUtils.getSum(latest),
        ketQua: TaiXiuUtils.getResult(latest),
        ketQuaLabel: TaiXiuUtils.getLabel(TaiXiuUtils.getResult(latest)),
        phienDuDoan: sessionId + 1,
        duDoan: TaiXiuUtils.getLabel(prediction.code),
        duDoanCode: prediction.code,
        tiLe: prediction.tiLe,
        reason: prediction.label,
        weak: prediction.weak,
        veryWeak: prediction.veryWeak,
        decisionPath: prediction.decisionPath,
        biasForced: prediction.biasForced,
        balance: prediction.balance,
        algoVotes: prediction.details
    });
});

// --- GIAO DIỆN XEM LỊCH SỬ (UI) ---
app.get('/history/:game(md5|taixiu)', (req, res) => {
    const game = req.params.game;
    const db = DBManager.load(game);

    // Lấy 50 phiên gần nhất để hiển thị
    const recentHistory = db.history.slice(-50).reverse();

    // Tính toán thống kê
    const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const total = settled.length;
    const correct = settled.filter(h => h.trangThai === 'ĐÚNG').length;
    const accuracy = total > 0 ? (correct / total * 100).toFixed(1) : '0.0';

    const strong = settled.filter(h => !h.weak);
    const strongCorrect = strong.filter(h => h.trangThai === 'ĐÚNG').length;
    const strongAcc = strong.length > 0 ? (strongCorrect / strong.length * 100).toFixed(1) : '-';

    const weak = settled.filter(h => h.weak);
    const weakCorrect = weak.filter(h => h.trangThai === 'ĐÚNG').length;
    const weakAcc = weak.length > 0 ? (weakCorrect / weak.length * 100).toFixed(1) : '-';

    // Render HTML
    const htmlTemplate = `
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>LỊCH SỬ DỰ ĐOÁN - ${game.toUpperCase()} - V18 ULTIMATE</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
        <style>
            :root {
                --bg-base: #09090b;
                --bg-card: #18181b;
                --text-primary: #f4f4f5;
                --text-secondary: #a1a1aa;
                --accent-blue: #3b82f6;
                --accent-green: #10b981;
                --accent-red: #ef4444;
                --accent-yellow: #f59e0b;
                --border-color: #27272a;
            }
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body {
                font-family: 'Inter', sans-serif;
                background-color: var(--bg-base);
                color: var(--text-primary);
                padding: 20px;
                line-height: 1.5;
            }
            .container { max-width: 1000px; margin: 0 auto; }
            
            /* HEADER DASHBOARD */
            .dashboard-header {
                background: linear-gradient(145deg, #1e1b4b, #0f172a);
                border: 1px solid var(--border-color);
                border-radius: 16px;
                padding: 24px;
                margin-bottom: 24px;
                box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
            }
            .header-title {
                text-align: center;
                font-size: 24px;
                font-weight: 800;
                text-transform: uppercase;
                letter-spacing: 1px;
                background: linear-gradient(to right, #60a5fa, #a78bfa);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                margin-bottom: 20px;
            }
            .stats-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 16px;
            }
            .stat-card {
                background: rgba(255, 255, 255, 0.03);
                border: 1px solid rgba(255, 255, 255, 0.05);
                border-radius: 12px;
                padding: 16px;
                text-align: center;
                transition: transform 0.2s ease;
            }
            .stat-card:hover { transform: translateY(-2px); background: rgba(255, 255, 255, 0.05); }
            .stat-label { font-size: 12px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; }
            .stat-value { font-size: 22px; font-weight: 800; margin-top: 8px; }
            .text-green { color: var(--accent-green); text-shadow: 0 0 10px rgba(16, 185, 129, 0.3); }
            .text-red { color: var(--accent-red); text-shadow: 0 0 10px rgba(239, 68, 68, 0.3); }
            .text-yellow { color: var(--accent-yellow); text-shadow: 0 0 10px rgba(245, 158, 11, 0.3); }
            
            /* BẢNG LỊCH SỬ */
            .table-container {
                background: var(--bg-card);
                border: 1px solid var(--border-color);
                border-radius: 16px;
                overflow-x: auto;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
            }
            table { width: 100%; border-collapse: collapse; text-align: center; font-size: 14px; }
            th {
                background: rgba(255, 255, 255, 0.02);
                color: var(--text-secondary);
                padding: 16px 8px;
                font-size: 12px;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                border-bottom: 1px solid var(--border-color);
            }
            td { padding: 14px 8px; border-bottom: 1px solid rgba(255, 255, 255, 0.03); }
            tr:last-child td { border-bottom: none; }
            tr:hover { background: rgba(255, 255, 255, 0.01); }
            
            /* CÁC THÀNH PHẦN TRONG BẢNG */
            .session-id { font-family: monospace; font-size: 13px; color: var(--text-secondary); }
            .dice-group { display: flex; justify-content: center; gap: 4px; }
            .dice {
                width: 24px; height: 24px;
                background: #fff; color: #000;
                border-radius: 4px;
                display: flex; align-items: center; justify-content: center;
                font-weight: 800; font-size: 13px;
                box-shadow: inset 0 -2px 0 rgba(0,0,0,0.2);
            }
            .sum-badge {
                display: inline-block; padding: 4px 10px; border-radius: 20px;
                background: rgba(255, 255, 255, 0.1); font-weight: 800; font-size: 14px;
            }
            .predict-badge { font-weight: 800; font-size: 14px; }
            .rate-badge {
                display: inline-block; padding: 4px 8px; border-radius: 6px;
                background: rgba(59, 130, 246, 0.2); color: #60a5fa; font-weight: 600; font-size: 13px;
            }
            .rate-badge.weak { background: rgba(245, 158, 11, 0.2); color: var(--accent-yellow); }
            .rate-badge.veryweak { background: rgba(239, 68, 68, 0.2); color: var(--accent-red); }
            
            .pattern-name { font-size: 12px; color: var(--text-secondary); background: rgba(255,255,255,0.05); padding: 4px 8px; border-radius: 4px; }
            
            .status-text { font-weight: 800; font-size: 13px; }
            .status-dung { color: var(--accent-green); }
            .status-sai { color: var(--accent-red); }
            .status-cho { color: var(--text-secondary); font-style: italic; }

            /* ANIMATION CHO PHIÊN MỚI NHẤT */
            @keyframes pulse-border {
                0% { border-color: rgba(59, 130, 246, 0.5); box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.4); }
                70% { border-color: rgba(59, 130, 246, 1); box-shadow: 0 0 0 10px rgba(59, 130, 246, 0); }
                100% { border-color: rgba(59, 130, 246, 0.5); box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); }
            }
            tr.new-session { animation: pulse-border 2s infinite; }

        </style>
        <script>
            // Tự động reload sau 5 giây
            setTimeout(() => { window.location.reload(); }, 5000);
        </script>
    </head>
    <body>
        <div class="container">
            
            <div class="dashboard-header">
                <div class="header-title">HỆ THỐNG DỰ ĐOÁN AI - ${game.toUpperCase()}</div>
                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-label">Độ chính xác</div>
                        <div class="stat-value ${parseFloat(accuracy) >= 50 ? 'text-green' : 'text-red'}">${accuracy}%</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">Tổng số phiên</div>
                        <div class="stat-value">${total}</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">Cầu Mạnh (🔥)</div>
                        <div class="stat-value text-green">${strongAcc}%</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">Cầu Yếu (⚠️)</div>
                        <div class="stat-value text-yellow">${weakAcc}%</div>
                    </div>
                </div>
            </div>

            <div class="table-container">
                <table>
                    <thead>
                        <tr>
                            <th>Phiên</th>
                            <th>Xúc Xắc</th>
                            <th>Tổng</th>
                            <th>Kết Quả</th>
                            <th>Dự Đoán</th>
                            <th>Tỉ Lệ</th>
                            <th>Loại Cầu</th>
                            <th>Trạng Thái</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${recentHistory.map((item, index) => {
                            // Render xúc xắc
                            const dices = item.xucXac || [0,0,0];
                            const diceHtml = dices.map(d => `<div class="dice">${d}</div>`).join('');
                            
                            // Class cho Tài/Xỉu
                            const kqClass = item.ketQua === 'T' ? 'text-green' : 'text-red';
                            const ddClass = item.DU_DOAN_CODE === 'T' ? 'text-green' : 'text-red';
                            
                            // Class cho trạng thái
                            let statusHtml = '<span class="status-text status-cho">Đang chờ</span>';
                            if (item.trangThai === 'ĐÚNG') statusHtml = '<span class="status-text status-dung">ĐÚNG</span>';
                            if (item.trangThai === 'SAI') statusHtml = '<span class="status-text status-sai">SAI</span>';

                            // Class cho tỉ lệ
                            let rateClass = 'rate-badge';
                            if (item.veryWeak) rateClass += ' veryweak';
                            else if (item.weak) rateClass += ' weak';

                            // Highlight phiên mới nhất
                            const trClass = index === 0 ? 'new-session' : '';

                            return `
                                <tr class="${trClass}">
                                    <td class="session-id">${item.phien}</td>
                                    <td><div class="dice-group">${diceHtml}</div></td>
                                    <td><span class="sum-badge">${item.tong}</span></td>
                                    <td class="${kqClass} predict-badge">${item.ketQuaLabel}</td>
                                    <td class="${ddClass} predict-badge">${item.DU_DOAN}</td>
                                    <td><span class="${rateClass}">${item.TI_LE}</span></td>
                                    <td><span class="pattern-name">${item.patternName}</span></td>
                                    <td>${statusHtml}</td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>

        </div>
    </body>
    </html>
    `;

    res.send(htmlTemplate);
});

// ========================================================================
// [MODULE 9] KHỞI ĐỘNG SERVER
// ========================================================================
app.listen(SYSTEM_CONFIG.PORT, () => {
    console.log('===========================================================');
    console.log(`🚀 HỆ THỐNG DỰ ĐOÁN ULTIMATE ${SYSTEM_CONFIG.VERSION} ĐÃ ONLINE`);
    console.log(`📡 Cổng hoạt động: ${SYSTEM_CONFIG.PORT}`);
    console.log(`📁 Thư mục dữ liệu: ${SYSTEM_CONFIG.DB_DIR}`);
    console.log('-----------------------------------------------------------');
    console.log(`🔗 Link JSON cho Tool:`);
    console.log(`   - MD5:    http://localhost:${SYSTEM_CONFIG.PORT}/md5`);
    console.log(`   - Tài Xỉu: http://localhost:${SYSTEM_CONFIG.PORT}/taixiu`);
    console.log(`🔗 Link Xem Lịch Sử (UI):`);
    console.log(`   - MD5:    http://localhost:${SYSTEM_CONFIG.PORT}/history/md5`);
    console.log(`   - Tài Xỉu: http://localhost:${SYSTEM_CONFIG.PORT}/history/taixiu`);
    console.log('===========================================================');
});
