'use strict';

// ========================================================================
// [MODULE 1] IMPORT CÁC THƯ VIỆN LÕI
// ========================================================================
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ========================================================================
// [MODULE 2] KHỞI TẠO SERVER & MIDDLEWARE
// ========================================================================
const app = express();

// Cấu hình CORS cho phép mọi nguồn gọi API (Để làm tool)
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ========================================================================
// [MODULE 3] CẤU HÌNH HỆ THỐNG TOÀN CỤC
// ========================================================================
const SYSTEM_CONFIG = {
    // Render cấp PORT tự động, Local chạy 3000
    PORT: process.env.PORT || 3000,
    // BẮT BUỘC phải là 0.0.0.0 để Render nhận diện (Fix lỗi 502)
    HOST: '0.0.0.0',
    // Link API Gốc của nhà cái
    API_URLS: {
        MD5: 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau',
        TAIXIU: 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau'
    },
    // Thư mục lưu trữ (Trên Render thì lưu vào /tmp để tránh lỗi Permission)
    DB_DIR: process.env.RENDER ? '/tmp' : path.join(__dirname, 'database'),
    // Chu kỳ quét API (10 giây/lần để tránh bị nhà cái ban IP)
    TICK_MS: 10000,
    // Số lượng lịch sử lưu trữ tối đa
    MAX_HISTORY: 2000,
    VERSION: 'V22.0.0-TITAN-FIX-ALL'
};

// Tạo thư mục nếu chưa có
if (!fs.existsSync(SYSTEM_CONFIG.DB_DIR)) {
    try {
        fs.mkdirSync(SYSTEM_CONFIG.DB_DIR, { recursive: true });
    } catch (e) {
        console.error('[SYS] Lỗi tạo thư mục:', e.message);
    }
}

// ========================================================================
// [MODULE 4] BẢO VỆ SERVER (GLOBAL ERROR HANDLING)
// Ngăn chặn mọi rủi ro sập app (Crash) do lỗi code hoặc rớt mạng
// ========================================================================
process.on('uncaughtException', (err) => {
    console.error('[CRITICAL] Bắt được lỗi Uncaught Exception:', err.message);
    // Không gọi process.exit() để server tiếp tục sống
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[CRITICAL] Bắt được lỗi Unhandled Rejection:', reason);
    // Không gọi process.exit()
});

// ========================================================================
// [MODULE 5] CÁC HÀM TIỆN ÍCH TOÁN HỌC & XỬ LÝ SỐ LIỆU
// ========================================================================
class MathHelpers {
    static safeInt(val, defaultValue = 0) {
        const num = parseInt(val, 10);
        return Number.isFinite(num) ? num : defaultValue;
    }

    static safeFloat(val, defaultValue = 0.0) {
        const num = parseFloat(val);
        return Number.isFinite(num) ? num : defaultValue;
    }

    static clamp(val, min, max) {
        return Math.max(min, Math.min(max, val));
    }

    static round(val, decimals = 3) {
        return Number(Math.round(val + 'e' + decimals) + 'e-' + decimals);
    }

    // Tính Entropy (Độ hỗn loạn của chuỗi)
    static calculateEntropy(sequence) {
        if (!sequence || sequence.length === 0) return 0;
        const frequencies = {};
        for (const item of sequence) {
            frequencies[item] = (frequencies[item] || 0) + 1;
        }
        let entropy = 0;
        const total = sequence.length;
        for (const key in frequencies) {
            const p = frequencies[key] / total;
            if (p > 0) entropy -= p * Math.log2(p);
        }
        return entropy;
    }

    // Tính độ lệch chuẩn
    static calculateStdDev(array) {
        if (array.length === 0) return 0;
        const mean = array.reduce((a, b) => a + b, 0) / array.length;
        const variance = array.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / array.length;
        return Math.sqrt(variance);
    }
}

class GameHelpers {
    static getDice(item) {
        return [
            MathHelpers.safeInt(item?.FirstDice),
            MathHelpers.safeInt(item?.SecondDice),
            MathHelpers.safeInt(item?.ThirdDice)
        ];
    }

    static getSum(item) {
        const dices = this.getDice(item);
        const sum = dices.reduce((a, b) => a + b, 0);
        return (sum >= 3 && sum <= 18) ? sum : MathHelpers.safeInt(item?.DiceSum);
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

    static flip(code) {
        if (code === 'T') return 'X';
        if (code === 'X') return 'T';
        return null;
    }
}

// ========================================================================
// [MODULE 6] QUẢN LÝ CƠ SỞ DỮ LIỆU (DATABASE MANAGER)
// ========================================================================
class DatabaseManager {
    static getPath(game) {
        return path.join(SYSTEM_CONFIG.DB_DIR, `db_titan_${game}.json`);
    }

    static load(game) {
        const filePath = this.getPath(game);
        try {
            if (fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath, 'utf8');
                const parsed = JSON.parse(data);
                // Đảm bảo cấu trúc DB luôn đầy đủ
                return {
                    history: parsed.history || [],
                    lastSession: parsed.lastSession || null,
                    algoStats: parsed.algoStats || {},
                    streakStats: parsed.streakStats || { T: {}, X: {} }
                };
            }
        } catch (e) {
            console.error(`[DB] Lỗi đọc file ${game}:`, e.message);
        }
        return {
            history: [],
            lastSession: null,
            algoStats: {},
            streakStats: { T: {}, X: {} }
        };
    }

    static save(game, db) {
        const filePath = this.getPath(game);
        try {
            // Cắt tỉa lịch sử nếu quá dài để tránh tràn RAM
            if (db.history.length > SYSTEM_CONFIG.MAX_HISTORY) {
                db.history = db.history.slice(-SYSTEM_CONFIG.MAX_HISTORY);
            }
            fs.writeFileSync(filePath, JSON.stringify(db, null, 2), 'utf8');
        } catch (e) {
            console.error(`[DB] Lỗi ghi file ${game}:`, e.message);
        }
    }

    // Cập nhật thống kê chuỗi (Streak)
    static updateStreak(sequence, db) {
        if (sequence.length === 0) return;
        if (!db.streakStats) db.streakStats = { T: {}, X: {} };

        let currentSide = sequence[0];
        let currentLength = 1;

        for (let i = 1; i < sequence.length; i++) {
            if (sequence[i] === currentSide) {
                currentLength++;
            } else {
                // Ghi nhận kết thúc chuỗi
                if (!db.streakStats[currentSide][currentLength]) {
                    db.streakStats[currentSide][currentLength] = { cont: 0, stop: 0 };
                }
                db.streakStats[currentSide][currentLength].stop++;

                // Ghi nhận chuỗi con
                for (let l = 1; l < currentLength; l++) {
                    if (!db.streakStats[currentSide][l]) {
                        db.streakStats[currentSide][l] = { cont: 0, stop: 0 };
                    }
                    db.streakStats[currentSide][l].cont++;
                }

                currentSide = sequence[i];
                currentLength = 1;
            }
        }
    }
}

// ========================================================================
// [MODULE 7] HỆ THỐNG THUẬT TOÁN ĐỈNH CAO (TITAN ALGORITHMS)
// 10 nhóm thuật toán cốt lõi được tinh chỉnh
// ========================================================================
class TitanAlgorithms {
    
    // 1. BẮT CHU KỲ (CYCLE PATTERN) - Tìm quy luật lặp lại
    static cycle(seq) {
        if (seq.length < 12) return null;
        const cycles = [2, 3, 4, 5, 6, 8, 10, 12];
        let bestMatch = { period: 0, ratio: 0, code: null };

        for (const p of cycles) {
            if (seq.length < p * 2) continue;
            let matches = 0;
            const checkLength = Math.min(p * 3, seq.length - 1);
            for (let i = seq.length - checkLength; i < seq.length; i++) {
                if (seq[i] === seq[i - p]) matches++;
            }
            const ratio = matches / checkLength;
            if (ratio > bestMatch.ratio) {
                bestMatch = { period: p, ratio: ratio, code: seq[seq.length - p] };
            }
        }

        if (bestMatch.ratio >= 0.82) {
            return { 
                code: bestMatch.code, 
                name: `CYCLE-${bestMatch.period}`, 
                conf: bestMatch.ratio, 
                id: `cycle_${bestMatch.period}` 
            };
        }
        return null;
    }

    // 2. N-GRAM (TÌM CHUỖI TƯƠNG ĐỒNG TRONG QUÁ KHỨ)
    static ngram(seq) {
        const len = 4;
        if (seq.length < len + 15) return null;
        
        const tail = seq.slice(-len).join('');
        let tCount = 0, xCount = 0, occurrences = 0;

        for (let i = 0; i <= seq.length - len - 1; i++) {
            if (seq.slice(i, i + len).join('') === tail) {
                occurrences++;
                if (seq[i + len] === 'T') tCount++;
                else xCount++;
            }
        }

        if (occurrences >= 2) {
            const conf = Math.max(tCount, xCount) / occurrences;
            if (conf >= 0.65) {
                return { 
                    code: tCount > xCount ? 'T' : 'X', 
                    name: `NGRAM-4`, 
                    conf: conf, 
                    id: 'ngram_4' 
                };
            }
        }
        return null;
    }

    // 3. BẺ CẦU BỆT (STREAK BREAKER) - Chống bệt dài
    static streakBreaker(seq) {
        if (seq.length < 5) return null;
        const last = seq[seq.length - 1];
        let len = 1;
        for (let i = seq.length - 2; i >= 0; i--) {
            if (seq[i] === last) len++;
            else break;
        }

        // Bệt 4 bẻ, bệt 5 bẻ mạnh, bệt 6+ đánh tiếp (bệt dài vô tận)
        if (len === 4) return { code: GameHelpers.flip(last), name: `BREAK-4`, conf: 0.75, id: 'streak_break_4' };
        if (len === 5) return { code: GameHelpers.flip(last), name: `BREAK-5`, conf: 0.85, id: 'streak_break_5' };
        if (len >= 6) return { code: last, name: `BỆT-TIẾP`, conf: 0.68, id: 'streak_continue_6' };
        return null;
    }

    // 4. CẦU ĐẢO 1-1 (BOUNCE)
    static bounce(seq) {
        if (seq.length < 7) return null;
        let isBouncing = true;
        for (let i = seq.length - 7; i < seq.length - 1; i++) {
            if (seq[i] === seq[i + 1]) { 
                isBouncing = false; 
                break; 
            }
        }
        if (isBouncing) {
            return { code: GameHelpers.flip(seq[seq.length - 1]), name: `BOUNCE`, conf: 0.74, id: 'bounce' };
        }
        return null;
    }

    // 5. MARKOV CHAIN (XÁC SUẤT CHUYỂN ĐỔI TRẠNG THÁI)
    static markov(seq) {
        const k = 3;
        if (seq.length < 20) return null;
        
        const key = seq.slice(-k).join('');
        let t = 0, x = 0;
        
        for (let i = k; i < seq.length; i++) {
            if (seq.slice(i - k, i).join('') === key) {
                if (seq[i] === 'T') t++;
                else x++;
            }
        }
        
        const total = t + x;
        if (total >= 3) {
            const conf = Math.max(t, x) / total;
            if (conf >= 0.72) {
                return { code: t > x ? 'T' : 'X', name: `MARKOV-3`, conf: conf, id: 'markov_3' };
            }
        }
        return null;
    }

    // 6. ĐỘ LỆCH PHÂN PHỐI (DISTRIBUTION BIAS) - Bù trừ xác suất
    static distribution(seq) {
        if (seq.length < 25) return null;
        const recent = seq.slice(-20);
        const tCount = recent.filter(x => x === 'T').length;
        const ratio = tCount / 20;

        // Nếu Tài ra quá ít (<30%), sắp tới sẽ bù Tài
        if (ratio <= 0.30) return { code: 'T', name: `DIST-T`, conf: 0.66, id: 'dist_t' };
        // Nếu Xỉu ra quá ít (<30%), sắp tới sẽ bù Xỉu
        if (ratio >= 0.70) return { code: 'X', name: `DIST-X`, conf: 0.66, id: 'dist_x' };
        return null;
    }

    // 7. PHÂN TÍCH ENTROPY (ĐỘ HỖN LOẠN)
    static entropy(seq) {
        if (seq.length < 15) return null;
        const recent = seq.slice(-15);
        const ent = MathHelpers.calculateEntropy(recent);
        const last = recent[recent.length - 1];
        
        // Entropy thấp = Cầu đang bệt -> Đánh tiếp
        if (ent < 0.85) return { code: last, name: `ENTROPY-LOW`, conf: 0.64, id: 'ent_low' };
        // Entropy cao = Cầu đang đảo -> Đánh đảo
        if (ent > 0.95) return { code: GameHelpers.flip(last), name: `ENTROPY-HIGH`, conf: 0.62, id: 'ent_high' };
        return null;
    }

    // 8. MÔ HÌNH BAYES CƠ BẢN (Xác suất có điều kiện)
    static bayes(seq) {
        if (seq.length < 20) return null;
        const target = seq[seq.length - 1];
        let countTarget = 0, countNextT = 0;
        
        for (let i = 0; i < seq.length - 1; i++) {
            if (seq[i] === target) {
                countTarget++;
                if (seq[i + 1] === 'T') countNextT++;
            }
        }
        
        if (countTarget >= 5) {
            const pT = countNextT / countTarget;
            if (pT >= 0.68) return { code: 'T', name: `BAYES-T`, conf: pT, id: 'bayes_t' };
            if (pT <= 0.32) return { code: 'X', name: `BAYES-X`, conf: 1 - pT, id: 'bayes_x' };
        }
        return null;
    }

    // 9. CẦU NHẢY CÓC (GAP PATTERN)
    static gapPattern(seq) {
        if (seq.length < 10) return null;
        const last = seq[seq.length - 1];
        const secondLast = seq[seq.length - 2];
        const thirdLast = seq[seq.length - 3];
        
        // Mô hình A-B-A -> Đánh B
        if (last === thirdLast && last !== secondLast) {
            return { code: secondLast, name: `GAP-ABA`, conf: 0.63, id: 'gap_aba' };
        }
        // Mô hình A-A-B-A -> Đánh B
        if (last === seq[seq.length - 4] && last !== seq[seq.length - 3] && last !== secondLast) {
            return { code: seq[seq.length - 3], name: `GAP-AABA`, conf: 0.61, id: 'gap_aaba' };
        }
        return null;
    }

    // 10. BẮT BẪY NHÀ CÁI (ANTI-TRAP)
    static antiTrap(seq) {
        if (seq.length < 5) return null;
        // Nếu 3 phiên gần nhất toàn Tài, nhà cái dễ gài bẫy Xỉu
        const last3 = seq.slice(-3).join('');
        if (last3 === 'TTT') return { code: 'X', name: `TRAP-3T`, conf: 0.60, id: 'trap_3t' };
        if (last3 === 'XXX') return { code: 'T', name: `TRAP-3X`, conf: 0.60, id: 'trap_3x' };
        return null;
    }
}

// ========================================================================
// [MODULE 8] BỘ NÃO TỔNG HỢP META-ENGINE (ĐÁNH GIÁ & CHỌN KẾT QUẢ)
// ========================================================================
class MetaEngine {
    static analyze(seq, db) {
        // Thu thập tất cả tín hiệu từ 10 thuật toán
        const candidates = [
            TitanAlgorithms.cycle(seq),
            TitanAlgorithms.ngram(seq),
            TitanAlgorithms.streakBreaker(seq),
            TitanAlgorithms.bounce(seq),
            TitanAlgorithms.markov(seq),
            TitanAlgorithms.distribution(seq),
            TitanAlgorithms.entropy(seq),
            TitanAlgorithms.bayes(seq),
            TitanAlgorithms.gapPattern(seq),
            TitanAlgorithms.antiTrap(seq)
        ].filter(Boolean); // Loại bỏ các thuật toán không có tín hiệu (null)

        const votes = { T: 0.0, X: 0.0 };
        const details = [];

        // Đánh giá trọng số (Weight) dựa trên lịch sử thắng thua của từng thuật toán
        for (const algo of candidates) {
            const stats = db.algoStats?.[algo.id] || { wins: 0, total: 0 };
            let weight = 1.0;
            
            if (stats.total >= 5) {
                const winRate = stats.wins / stats.total;
                // Nếu winrate > 60% thì tin tưởng (Weight 1.5), < 40% thì giảm độ tin (Weight 0.5)
                weight = winRate > 0.60 ? 1.5 : (winRate < 0.40 ? 0.5 : 1.0);
            }

            const votePower = algo.conf * weight;
            votes[algo.code] += votePower;
            
            details.push({
                algo: algo.id,
                family: 'titan',
                code: algo.code,
                name: algo.name,
                conf: MathHelpers.round(algo.conf, 3),
                vote: MathHelpers.round(votePower, 3)
            });
        }

        const totalVotes = votes.T + votes.X;
        let winner, confidence, gap, pT, pX, loserShare, decisionPath, biasForced;

        // TRƯỜNG HỢP KHÔNG CÓ TÍN HIỆU NÀO (Cầu nhiễu) -> Đánh theo xu hướng nhẹ
        if (totalVotes === 0) {
            const recent = seq.slice(-10);
            const tCount = recent.filter(x => x === 'T').length;
            winner = tCount <= recent.length / 2 ? 'T' : 'X';
            confidence = 0.51;
            pT = winner === 'T' ? 0.51 : 0.49;
            pX = winner === 'X' ? 0.51 : 0.49;
            gap = 0.02;
            loserShare = 0.49;
            decisionPath = 'NORMAL';
            biasForced = false;
            
            details.push({
                algo: 'default_fallback',
                family: 'sys',
                code: winner,
                name: 'MẶC-ĐỊNH',
                conf: 0.51,
                vote: 1.0
            });
        } else {
            pT = votes.T / totalVotes;
            pX = votes.X / totalVotes;
            gap = Math.abs(pT - pX);
            winner = pT > pX ? 'T' : 'X';
            confidence = Math.max(pT, pX);
            loserShare = Math.min(pT, pX);
            decisionPath = 'NORMAL';
            biasForced = false;

            // BẮT BẪY: Nếu chênh lệch quá cao (>80%), nhà cái đang gài bẫy -> Bẻ ngược lại
            if (gap > 0.80 && confidence > 0.80) {
                biasForced = true;
                decisionPath = 'TRAP_AVOIDED';
                winner = GameHelpers.flip(winner);
                confidence = 0.60;
            }
        }

        // Khống chế tỉ lệ tối đa 85% để tránh ảo tưởng sức mạnh
        confidence = MathHelpers.clamp(confidence, 0.50, 0.85);
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
                votesT: MathHelpers.round(votes.T, 3),
                votesX: MathHelpers.round(votes.X, 3),
                gap: MathHelpers.round(gap, 3),
                pT: MathHelpers.round(pT, 3),
                pX: MathHelpers.round(pX, 3),
                loserShare: MathHelpers.round(loserShare, 3)
            },
            details
        };
    }
}

// ========================================================================
// [MODULE 9] BỘ LẤY DỮ LIỆU & XỬ LÝ NGẦM (WORKER ENGINE)
// ========================================================================
class WorkerEngine {
    // Hàm gọi API với cơ chế Bypass (Giả lập Trình Duyệt)
    static async fetchApi(game) {
        const url = game === 'md5' ? SYSTEM_CONFIG.API_URLS.MD5 : SYSTEM_CONFIG.API_URLS.TAIXIU;
        
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const response = await axios.get(url, { 
                    timeout: 12000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'application/json, text/plain, */*',
                        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
                        'Referer': 'https://taixiu.maksh3979madfw.com/',
                        'Origin': 'https://taixiu.maksh3979madfw.com'
                    }
                });

                let data = response.data?.data?.list 
                    || response.data?.list 
                    || response.data?.data 
                    || (Array.isArray(response.data) ? response.data : []);

                if (!Array.isArray(data) || data.length === 0) {
                    throw new Error('Dữ liệu trả về không hợp lệ hoặc rỗng');
                }

                // Đảo ngược mảng nếu API trả về từ cũ đến mới
                if (data.length >= 2 && Number(data[0].SessionId) > Number(data[data.length - 1].SessionId)) {
                    data.reverse();
                }

                return data;
            } catch (error) {
                console.warn(`[API WARN] Lỗi gọi API ${game} (Lần ${attempt}): ${error.message}`);
                if (attempt === 3) return []; // Thử 3 lần thất bại thì bỏ cuộc
                await new Promise(resolve => setTimeout(resolve, 1000)); // Nghỉ 1s rồi thử lại
            }
        }
        return [];
    }

    // Xử lý logic chính của Game
    static async processGame(game) {
        try {
            const rawData = await this.fetchApi(game);
            
            // Nếu API lỗi hoặc không đủ dữ liệu (dưới 10 phiên) -> Dừng, không làm gì cả
            if (!rawData || rawData.length < 10) {
                return; 
            }

            const latestItem = rawData[rawData.length - 1];
            const currentSession = MathHelpers.safeInt(latestItem.SessionId);
            
            const db = DatabaseManager.load(game);
            
            // Nếu phiên này đã được xử lý rồi thì bỏ qua
            if (db.lastSession === currentSession) {
                return;
            }

            // Chuyển đổi mảng dữ liệu thành chuỗi kết quả (T / X)
            const sequence = rawData.map(item => GameHelpers.getResult(item)).filter(Boolean);
            
            // Cập nhật thống kê Bệt
            DatabaseManager.updateStreak(sequence, db);

            // KIỂM TRA KẾT QUẢ PHIÊN TRƯỚC ĐÓ (Để chấm điểm thuật toán)
            const prevPrediction = db.history[db.history.length - 1];
            if (prevPrediction && MathHelpers.safeInt(prevPrediction.phienDuDoan) === currentSession) {
                const actualResult = GameHelpers.getResult(latestItem);
                
                prevPrediction.ketQua = actualResult;
                prevPrediction.ketQuaLabel = GameHelpers.getLabel(actualResult);
                prevPrediction.trangThai = prevPrediction.DU_DOAN_CODE === actualResult ? 'ĐÚNG' : 'SAI';

                // Cập nhật điểm (Wins/Losses) cho từng thuật toán
                if (!db.algoStats) db.algoStats = {};
                for (const detail of prevPrediction.algoDetails) {
                    if (!db.algoStats[detail.algo]) {
                        db.algoStats[detail.algo] = { wins: 0, total: 0 };
                    }
                    db.algoStats[detail.algo].total++;
                    if (detail.code === actualResult) {
                        db.algoStats[detail.algo].wins++;
                    }
                }
            }

            // CHẠY DỰ ĐOÁN CHO PHIÊN TIẾP THEO
            const prediction = MetaEngine.analyze(sequence, db);

            // LƯU LỊCH SỬ
            db.history.push({
                phien: currentSession,
                xucXac: GameHelpers.getDice(latestItem),
                tong: GameHelpers.getSum(latestItem),
                ketQua: GameHelpers.getResult(latestItem),
                ketQuaLabel: GameHelpers.getLabel(GameHelpers.getResult(latestItem)),
                phienDuDoan: currentSession + 1,
                DU_DOAN_CODE: prediction.code,
                DU_DOAN: GameHelpers.getLabel(prediction.code),
                TI_LE: prediction.tiLe,
                patternName: prediction.label,
                algoDetails: prediction.details,
                weak: prediction.weak,
                veryWeak: prediction.veryWeak,
                trangThai: 'ĐANG CHỜ'
            });

            db.lastSession = currentSession;
            DatabaseManager.save(game, db);
            
            console.log(`[WORKER] Đã xử lý phiên ${currentSession} (${game}). Dự đoán phiên ${currentSession + 1}: ${prediction.code}`);

        } catch (err) {
            console.error(`[WORKER FATAL] Lỗi xử lý game ${game}:`, err.message);
        }
    }

    // Kích hoạt vòng lặp chạy ngầm
    static start() {
        console.log(`[SYSTEM] Khởi động Worker quét API mỗi ${SYSTEM_CONFIG.TICK_MS / 1000}s...`);
        
        // Chạy ngay lần đầu khi khởi động
        this.processGame('md5');
        this.processGame('taixiu');

        // Vòng lặp vô hạn
        setInterval(() => {
            this.processGame('md5');
            this.processGame('taixiu');
        }, SYSTEM_CONFIG.TICK_MS);
    }
}

// KÍCH HOẠT WORKER CHẠY NGẦM
WorkerEngine.start();

// ========================================================================
// [MODULE 10] ROUTES API (DÀNH CHO TOOL)
// ========================================================================
app.get('/', (req, res) => res.redirect('/history/md5'));

// Endpoint: /md5 hoặc /taixiu
app.get('/:game(md5|taixiu)', async (req, res) => {
    try {
        const game = req.params.game;
        
        // Gọi trực tiếp API để lấy dữ liệu real-time
        let rawData = await WorkerEngine.fetchApi(game);
        let db = DatabaseManager.load(game);
        let isFallbackCache = false;

        // NẾU API GỐC SẬP HOẶC CHẶN IP -> LẤY DỮ LIỆU TỪ CACHE
        if (!rawData || rawData.length < 10) {
            isFallbackCache = true;
            
            if (db.history.length === 0) {
                return res.status(503).json({ 
                    success: false, 
                    error: 'API Gốc đang sập hoặc chặn IP, chưa có dữ liệu Cache. Đợi 1-2 phút để hệ thống tự lấy lại.' 
                });
            }

            // Tái tạo lại mảng rawData ảo từ DB để trả về kết quả không bị gián đoạn
            const recentHist = db.history.slice(-50);
            rawData = recentHist.map(h => ({
                SessionId: h.phien,
                FirstDice: h.xucXac[0] || 1,
                SecondDice: h.xucXac[1] || 1,
                ThirdDice: h.xucXac[2] || 1
            }));
        }

        const latestItem = rawData[rawData.length - 1];
        const currentSession = MathHelpers.safeInt(latestItem.SessionId);
        const sequence = rawData.map(item => GameHelpers.getResult(item)).filter(Boolean);

        // Phân tích lại với dữ liệu mới nhất
        const prediction = MetaEngine.analyze(sequence, db);

        // TRẢ VỀ JSON CHUẨN XÁC NHƯ ẢNH
        res.json({
            success: true,
            game: game,
            phien: currentSession,
            xucXac: GameHelpers.getDice(latestItem),
            tong: GameHelpers.getSum(latestItem),
            ketQua: GameHelpers.getResult(latestItem),
            ketQuaLabel: GameHelpers.getLabel(GameHelpers.getResult(latestItem)),
            phienDuDoan: currentSession + 1,
            duDoan: GameHelpers.getLabel(prediction.code),
            duDoanCode: prediction.code,
            tiLe: prediction.tiLe,
            reason: prediction.label,
            weak: prediction.weak,
            veryWeak: prediction.veryWeak,
            decisionPath: isFallbackCache ? 'API_BLOCKED_USING_CACHE' : prediction.decisionPath,
            biasForced: prediction.biasForced,
            balance: prediction.balance,
            algoVotes: prediction.details
        });

    } catch (error) {
        console.error('[API ROUTE ERROR]:', error);
        res.status(500).json({ success: false, error: 'Lỗi Server: ' + error.message });
    }
});

// ========================================================================
// [MODULE 11] ROUTES GIAO DIỆN (DASHBOARD LỊCH SỬ)
// ========================================================================
app.get('/history/:game(md5|taixiu)', (req, res) => {
    try {
        const game = req.params.game;
        const db = DatabaseManager.load(game);
        const rows = db.history.slice(-50).reverse(); // Lấy 50 phiên gần nhất

        // Tính toán độ chính xác
        const settled = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
        const correct = settled.filter(h => h.trangThai === 'ĐÚNG').length;
        const accuracy = settled.length > 0 ? (correct / settled.length * 100).toFixed(1) : '0.0';

        const strong = settled.filter(h => !h.weak);
        const strongAcc = strong.length > 0 ? (strong.filter(h => h.trangThai === 'ĐÚNG').length / strong.length * 100).toFixed(1) : '-';
        
        const weak = settled.filter(h => h.weak);
        const weakAcc = weak.length > 0 ? (weak.filter(h => h.trangThai === 'ĐÚNG').length / weak.length * 100).toFixed(1) : '-';

        const html = `
        <!DOCTYPE html>
        <html lang="vi">
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
            <title>DASHBOARD LỊCH SỬ - ${game.toUpperCase()}</title>
            <style>
                :root {
                    --bg: #0a0a0a;
                    --card: #171717;
                    --text: #f5f5f5;
                    --green: #22c55e;
                    --red: #ef4444;
                    --yellow: #eab308;
                }
                * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, sans-serif; }
                body { background-color: var(--bg); color: var(--text); padding: 15px; }
                
                .header { text-align: center; margin-bottom: 25px; background: var(--card); padding: 20px; border-radius: 12px; border: 1px solid #333; }
                .header h1 { font-size: 20px; text-transform: uppercase; margin-bottom: 15px; letter-spacing: 1px; }
                
                .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
                .stat-box { background: #222; padding: 15px; border-radius: 8px; border: 1px solid #333; }
                .stat-label { font-size: 12px; color: #888; text-transform: uppercase; }
                .stat-value { font-size: 22px; font-weight: 900; margin-top: 5px; }
                
                .table-wrap { background: var(--card); border-radius: 12px; overflow-x: auto; border: 1px solid #333; }
                table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: center; }
                th { background: #222; padding: 15px 5px; color: #888; font-size: 11px; text-transform: uppercase; }
                td { padding: 12px 5px; border-bottom: 1px solid #222; }
                
                .tai { color: var(--green); font-weight: bold; }
                .xiu { color: var(--red); font-weight: bold; }
                .dung { color: var(--green); font-weight: bold; }
                .sai { color: var(--red); font-weight: bold; }
                .cho { color: var(--yellow); font-weight: bold; }
                
                .dice-box { display: flex; justify-content: center; gap: 3px; }
                .dice { width: 20px; height: 20px; background: #fff; color: #000; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 12px; }
                
                .sum-badge { background: #333; padding: 4px 8px; border-radius: 6px; color: #fbbf24; font-weight: bold; }
                .pattern-badge { background: #222; padding: 4px 8px; border-radius: 6px; font-size: 11px; border: 1px solid #333; }
            </style>
            <script>setTimeout(() => { window.location.reload(); }, 5000);</script>
        </head>
        <body>
            <div class="header">
                <h1>BẢNG ĐIỀU KHIỂN AI - ${game.toUpperCase()}</h1>
                <div class="stats-grid">
                    <div class="stat-box">
                        <div class="stat-label">Tỉ Lệ Thắng Tổng</div>
                        <div class="stat-value" style="color: ${parseFloat(accuracy) >= 55 ? 'var(--green)' : 'var(--red)'}">${accuracy}%</div>
                    </div>
                    <div class="stat-box">
                        <div class="stat-label">Tổng Số Phiên</div>
                        <div class="stat-value">${settled.length}</div>
                    </div>
                    <div class="stat-box">
                        <div class="stat-label">🔥 Cầu Mạnh</div>
                        <div class="stat-value" style="color: var(--green)">${strongAcc}%</div>
                    </div>
                    <div class="stat-box">
                        <div class="stat-label">⚠️ Cầu Yếu</div>
                        <div class="stat-value" style="color: var(--yellow)">${weakAcc}%</div>
                    </div>
                </div>
            </div>

            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>Phiên</th>
                            <th>XX</th>
                            <th>Tổng</th>
                            <th>KQ</th>
                            <th>Dự Đoán</th>
                            <th>Cầu</th>
                            <th>Trạng Thái</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map(it => `
                            <tr>
                                <td style="font-family: monospace; color: #888;">${it.phien}</td>
                                <td>
                                    <div class="dice-box">
                                        ${(it.xucXac || []).map(d => `<div class="dice">${d}</div>`).join('')}
                                    </div>
                                </td>
                                <td><span class="sum-badge">${it.tong}</span></td>
                                <td class="${it.ketQua}">${it.ketQuaLabel}</td>
                                <td class="${it.DU_DOAN_CODE}">${it.DU_DOAN} (${it.TI_LE})</td>
                                <td><span class="pattern-badge">${it.patternName}</span></td>
                                <td class="${it.trangThai === 'ĐÚNG' ? 'dung' : (it.trangThai === 'SAI' ? 'sai' : 'cho')}">
                                    ${it.trangThai}
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </body>
        </html>
        `;
        res.send(html);

    } catch (error) {
        res.status(500).send('Lỗi giao diện: ' + error.message);
    }
});

// ========================================================================
// [MODULE 12] KHỞI ĐỘNG SERVER (LẮNG NGHE CỔNG - FIX LỖI RENDER)
// ========================================================================
app.listen(SYSTEM_CONFIG.PORT, SYSTEM_CONFIG.HOST, () => {
    console.log('===========================================================');
    console.log(`🚀 HỆ THỐNG ${SYSTEM_CONFIG.VERSION} ĐÃ ONLINE`);
    console.log(`📡 Server đang chạy tại: http://${SYSTEM_CONFIG.HOST}:${SYSTEM_CONFIG.PORT}`);
    console.log(`📁 Thư mục lưu trữ: ${SYSTEM_CONFIG.DB_DIR}`);
    console.log('-----------------------------------------------------------');
    console.log(`🔗 LINK JSON DÀNH CHO TOOL:`);
    console.log(`   - MD5:     http://localhost:${SYSTEM_CONFIG.PORT}/md5`);
    console.log(`   - Tài Xỉu: http://localhost:${SYSTEM_CONFIG.PORT}/taixiu`);
    console.log(`🔗 LINK GIAO DIỆN XEM LỊCH SỬ:`);
    console.log(`   - MD5:     http://localhost:${SYSTEM_CONFIG.PORT}/history/md5`);
    console.log(`   - Tài Xỉu: http://localhost:${SYSTEM_CONFIG.PORT}/history/taixiu`);
    console.log('===========================================================');
});
