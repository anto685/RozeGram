const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const http = require('http');
const crypto = require('crypto');

// ==========================================
// 1. СЕРВЕР И АНТИ-СПЛИТ (RENDER KEEP-ALIVE)
// ==========================================
const PORT = process.env.PORT || 10000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('RozeGram Casino Engine v5.0 Master - ONLINE 🎰');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Engine running on port ${PORT}`);
});

setInterval(() => {
    if (RENDER_URL.startsWith('http')) {
        http.get(RENDER_URL, () => {}).on('error', () => {});
    }
}, 4 * 60 * 1000);

// ==========================================
// 2. КОНФИГУРАЦИЯ И БАЗА ДАННЫХ
// ==========================================
const token = process.env.BOT_TOKEN || '8919281816:AAFJl-QUVwa9iUJ5c3UjD-0n4c0tghcmAEw';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://garbonretoy_db_user:SuperPass12345@cluster0.lk3ngtu.mongodb.net/RozegramDB?retryWrites=true&w=majority';

const CHANNEL_USERNAME = '@anloMorze2k26';
const CHANNEL_LINK = 'https://t.me/anloMorze2k26';
const BOT_START_TIME = Math.floor(Date.now() / 1000);
const ADMIN_ID = 6947353037;

mongoose.set('strictQuery', false);
const connectDB = async () => {
    try {
        await mongoose.connect(MONGO_URI, {
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });
        console.log('[CLOUD DB] Успешное подключение к MongoDB Atlas!');
    } catch (err) {
        console.error('[CLOUD DB ERROR] Ошибка подключения:', err.message);
        setTimeout(connectDB, 5000);
    }
};
connectDB();

// ==========================================
// 3. СХЕМЫ ДАННЫХ
// ==========================================
const userSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    firstName: { type: String, default: 'Игрок' },
    username: { type: String, default: '' },
    balance: { type: Number, default: 1000 },
    lastBonus: { type: Number, default: 0 },
    tournamentProfit: { type: Number, default: 0 }
});

const historySchema = new mongoose.Schema({ results: { type: [String], default: [] } });
const User = mongoose.model('User', userSchema);
const History = mongoose.model('History', historySchema);

// ==========================================
// 4. ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ И ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================
let currentBets = [];
let lastRoundBets = {};
let userGoCooldowns = {};
let isSpinning = false;

const bot = new TelegramBot(token, { polling: true });

bot.on('polling_error', (err) => {
    if (!err.message.includes('409 Conflict') && !err.message.includes('401')) {
        console.error(`[POLLING ERROR] ${err.code}: ${err.message}`);
    }
});

const redNumbers = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getUserTag(user) {
    if (user.username) return `@${user.username}`;
    return `<a href="tg://user?id=${user.userId}">${user.firstName || 'Игрок'}</a>`;
}

const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '💰 б' }, { text: '🎁 Бонус' }],
            [{ text: '🎮 Игры' }, { text: '🏆 Турнир' }],
            [{ text: '📖 Правила игры' }]
        ],
        resize_keyboard: true
    }
};

async function getUser(userId, firstName = 'Игрок', username = '') {
    try {
        let user = await User.findOne({ userId });
        if (!user) {
            user = await User.create({ userId, firstName, username, balance: 1000, lastBonus: 0, tournamentProfit: 0 });
        } else {
            let updated = false;
            if (firstName && user.firstName !== firstName) { user.firstName = firstName; updated = true; }
            if (username !== undefined && user.username !== username) { user.username = username; updated = true; }
            if (updated) await user.save();
        }
        return user;
    } catch (e) {
        return { userId, firstName, username, balance: 1000, lastBonus: 0, tournamentProfit: 0, save: async () => {} };
    }
}

async function getHistory() {
    try {
        let doc = await History.findOne();
        if (!doc) doc = await History.create({ results: [] });
        return doc;
    } catch (e) {
        return { results: [], save: async () => {} };
    }
}

// ------------------------------------------
// 🧠 ВСПОМОГАТЕЛЬНЫЙ МОДУЛЬ: ДИАПАЗОНЫ РУЛЕТКИ
// ------------------------------------------
function parseRanges(targetStr) {
    // Парсит диапазоны вида "2-8,12-18"
    const parts = targetStr.split(',');
    const coveredNumbers = new Set();

    for (let part of parts) {
        part = part.trim();
        const rangeMatch = part.match(/^(\d{1,2})-(\d{1,2})$/);
        if (!rangeMatch) return null; // Неверный формат

        const start = parseInt(rangeMatch[1]);
        const end = parseInt(rangeMatch[2]);

        // Валидация: от 0 до 36 и start <= end
        if (start < 0 || end > 36 || start > end) return null;

        for (let i = start; i <= end; i++) {
            coveredNumbers.add(i);
        }
    }

    if (coveredNumbers.size === 0) return null;

    const count = coveredNumbers.size;
    const multiplier = parseFloat((36 / count).toFixed(2));

    return {
        numbers: Array.from(coveredNumbers),
        count,
        multiplier
    };
}

// ==========================================
// 5. ОБРАБОТКА CALLBACK QUERY
// ==========================================
bot.on('callback_query', async (query) => {
    try {
        if (query.message && query.message.date < BOT_START_TIME) return;

        const userId = query.from.id;
        const firstName = query.from.first_name || 'Игрок';
        const username = query.from.username || '';
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;
        const action = query.data;

        const userTag = getUserTag({ userId, firstName, username });

        // Отмена конкретной ставки по кнопке
        if (action.startsWith('cancel_bet_')) {
            if (isSpinning) {
                return await bot.answerCallbackQuery(query.id, { text: '❌ Рулетка уже крутится!', show_alert: true });
            }

            const betIndex = parseInt(action.split('_')[2]);
            const bet = currentBets[betIndex];

            if (!bet || bet.userId !== userId) {
                return await bot.answerCallbackQuery(query.id, { text: '❌ Это не твоя ставка или она уже снята!', show_alert: true });
            }

            await User.findOneAndUpdate(
                { userId },
                { $inc: { balance: bet.amount, tournamentProfit: bet.amount } }
            );

            currentBets.splice(betIndex, 1);

            await bot.answerCallbackQuery(query.id, { text: '✅ Ставка отменена!' });
            try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
            return await bot.sendMessage(chatId, `🚫 ${userTag}, твоя ставка <b>${bet.amount.toLocaleString('ru-RU')} Roze</b> на [${bet.target.toUpperCase()}] отменена!`, { parse_mode: 'HTML' });
        }

        // Повтор / Удвоение
        if (action === 'repeat_bet' || action === 'double_bet') {
            if (isSpinning) return await bot.answerCallbackQuery(query.id, { text: 'Игра идет!', show_alert: true });

            const userLastBets = lastRoundBets[userId];
            if (!userLastBets || userLastBets.length === 0) {
                return await bot.answerCallbackQuery(query.id, { text: 'Нет ставок с прошлого раунда!', show_alert: true });
            }

            let multiplier = (action === 'repeat_bet') ? 1 : 2;
            let totalCost = userLastBets.reduce((sum, b) => sum + (b.amount * multiplier), 0);

            const updatedUser = await User.findOneAndUpdate(
                { userId, balance: { $gte: totalCost } },
                { $inc: { balance: -totalCost, tournamentProfit: -totalCost } },
                { new: true }
            );

            if (!updatedUser) {
                return await bot.answerCallbackQuery(query.id, { text: `Нужно ${totalCost.toLocaleString('ru-RU')} Roze, не хватает баланса!`, show_alert: true });
            }

            let addedText = [];
            for (const oldBet of userLastBets) {
                const newAmount = oldBet.amount * multiplier;
                currentBets.push({ userId, firstName, username, amount: newAmount, target: oldBet.target, parsedRange: oldBet.parsedRange });
                addedText.push(`${newAmount.toLocaleString('ru-RU')} Roze на ${oldBet.target}`);
            }

            await bot.answerCallbackQuery(query.id, { text: 'Ставка принята' });
            await bot.sendMessage(chatId, `🎰 ${userTag} ${action === 'repeat_bet' ? 'повторил' : 'удвоил'} (${totalCost.toLocaleString('ru-RU')} Roze): ${addedText.join(', ')}`, { parse_mode: 'HTML' });
        }
    } catch (e) {
        console.error('[CALLBACK ERROR]', e.message);
    }
});

// ==========================================
// 6. ОБРАБОТКА СООБЩЕНИЙ
// ==========================================
bot.on('message', async (msg) => {
    try {
        if (msg.date < BOT_START_TIME) return;

        const chatId = msg.chat.id;
        const userId = msg.from ? msg.from.id : null;
        const firstName = msg.from ? msg.from.first_name : 'Игрок';
        const username = msg.from ? msg.from.username : '';
        const isPrivate = msg.chat.type === 'private';
        if (!userId) return;

        const text = msg.text ? msg.text.trim().toLowerCase() : '';
        if (!text) return;

        const user = await getUser(userId, firstName, username);
        const userTag = getUserTag(user);

        if (text === '/start') {
            if (isPrivate) {
                return await bot.sendMessage(chatId, `🎰 <b>Добро пожаловать в RozeGram Casino!</b>\n\nПривет, ${userTag}!\nБаланс: <b>${user.balance.toLocaleString('ru-RU')} Roze 💰</b>`, { parse_mode: 'HTML', ...mainKeyboard });
            }
            return;
        }

        if (text === 'б' || text === 'бал' || text === 'баланс' || text === '💰 б' || text === '💰 баланс') {
            return await bot.sendMessage(chatId, `💰 ${userTag}, твой баланс: <b>${user.balance.toLocaleString('ru-RU')} Roze 💰</b>`, { parse_mode: 'HTML', ...(isPrivate ? mainKeyboard : {}) });
        }

        if (text === 'игры' || text === 'куб' || text === '🎮 игры' || text === 'меню') {
            const gamesText = 
`🎰 <b>Игровые режимы RozeGram:</b>

🔴⚫️ <b>Рулетка:</b>
• <code>100 к</code> / <code>100 ч</code> — Red/Black (x2)
• <code>100 чет</code> / <code>100 нечет</code> — Even/Odd (x2)
• <code>100 12</code> — Число (x36)
• <code>100 2-8</code> — Диапазон (х5.14)
• <code>100 2-8,12-18</code> — Мульти-диапазон

⚽️ <b>Футбол:</b>
• <code>100 фут</code> — Матч забитых мячей!

🏀 <b>Баскетбол:</b>
• <code>100 баскет</code> — Броски по кольцу!`;
            return await bot.sendMessage(chatId, gamesText, { parse_mode: 'HTML', ...(isPrivate ? mainKeyboard : {}) });
        }

        // ==========================================
        // ⚽️ ФУТБОЛ С ЭМОДЗИ (⚽️)
        // ==========================================
        const footMatch = text.match(/^(\d+)\s+(фут|футбол)$/);
        if (footMatch) {
            if (isPrivate) return await bot.sendMessage(chatId, `⚠️ Играть нужно в чате!`);
            const betAmount = parseInt(footMatch[1]);

            if (betAmount <= 0) return await bot.sendMessage(chatId, `❌ Ставка должна быть больше 0!`);

            const updatedUser = await User.findOneAndUpdate(
                { userId, balance: { $gte: betAmount } },
                { $inc: { balance: -betAmount } },
                { new: true }
            );

            if (!updatedUser) return await bot.sendMessage(chatId, `❌ Нехватка средств! Баланс: <b>${user.balance.toLocaleString('ru-RU')} Roze 💰</b>`, { parse_mode: 'HTML' });

            // Генерируем количество голов от 0 до 4
            const goals = crypto.randomInt(0, 5);
            const goalsEmoji = goals > 0 ? '⚽️'.repeat(goals) : '❌ (0 голов)';

            let winAmount = 0;
            let resultText = '';

            if (goals >= 2) { // 2 и более голов — Победа
                winAmount = Math.floor(betAmount * (goals * 0.8)); // Динамический коэффициент
                await User.findOneAndUpdate({ userId }, { $inc: { balance: winAmount, tournamentProfit: winAmount } });
                resultText = `🎉 <b>ПОБЕДА!</b> Забито: ${goalsEmoji}\nВыигрыш: <b>+${winAmount.toLocaleString('ru-RU')} Roze 💰</b>`;
            } else {
                resultText = `Проигрыш... Забито: ${goalsEmoji}\nПотеряно: ${betAmount.toLocaleString('ru-RU')} Roze`;
            }

            return await bot.sendMessage(chatId, `⚽️ ${userTag} проводит футбольный матч!\n\n${resultText}`, { parse_mode: 'HTML' });
        }

        // ==========================================
        // 🏀 БАСКЕТБОЛ С ЭМОДЗИ (🏀)
        // ==========================================
        const basketMatch = text.match(/^(\d+)\s+(баскет|баскетбол)$/);
        if (basketMatch) {
            if (isPrivate) return await bot.sendMessage(chatId, `⚠️ Играть нужно в чате!`);
            const betAmount = parseInt(basketMatch[1]);

            if (betAmount <= 0) return await bot.sendMessage(chatId, `❌ Ставка должна быть больше 0!`);

            const updatedUser = await User.findOneAndUpdate(
                { userId, balance: { $gte: betAmount } },
                { $inc: { balance: -betAmount } },
                { new: true }
            );

            if (!updatedUser) return await bot.sendMessage(chatId, `❌ Нехватка средств! Баланс: <b>${user.balance.toLocaleString('ru-RU')} Roze 💰</b>`, { parse_mode: 'HTML' });

            // Генерируем забитые очки от 0 до 3
            const points = crypto.randomInt(0, 4);
            const pointsEmoji = points > 0 ? '🏀'.repeat(points) : '❌ (Мимо!)';

            let winAmount = 0;
            let resultText = '';

            if (points > 0) {
                const multipliers = [0, 1.5, 2.5, 4.0];
                winAmount = Math.floor(betAmount * multipliers[points]);
                await User.findOneAndUpdate({ userId }, { $inc: { balance: winAmount, tournamentProfit: winAmount } });
                resultText = `🔥 <b>ПОПАДАНИЕ!</b> Забито очков: ${pointsEmoji}\nВыигрыш: <b>+${winAmount.toLocaleString('ru-RU')} Roze 💰</b>`;
            } else {
                resultText = `❌ Мимо! Забито: ${pointsEmoji}\nПотеряно: ${betAmount.toLocaleString('ru-RU')} Roze`;
            }

            return await bot.sendMessage(chatId, `🏀 ${userTag} делает броски по кольцу!\n\n${resultText}`, { parse_mode: 'HTML' });
        }

        // ==========================================// 🎰 СТАВКИ НА РУЛЕТКУ (ЦВЕТА, ЧИСЛА, ДИАПАЗОНЫ)
        // ==========================================
        const rouletteMatch = text.match(/^(\d+)\s+(.+)$/);
        if (rouletteMatch && !isSpinning && !text.startsWith('куб') && !text.startsWith('передать')) {
            const betAmount = parseInt(rouletteMatch[1]);
            const targetRaw = rouletteMatch[2].trim();

            if (betAmount <= 0) return await bot.sendMessage(chatId, `❌ Ставка должна быть больше 0!`);

            let isRangeBet = false;
            let parsedRange = null;

            // 1. Проверяем, не диапазон ли это (например "2-8" или "2-8,12-18")
            if (targetRaw.includes('-')) {
                parsedRange = parseRanges(targetRaw);
                if (!parsedRange) {
                    return await bot.sendMessage(chatId, `❌ Некорректный диапазон! Пример верного ввода: <code>2-8</code> или <code>2-8,12-18</code> (числа от 0 до 36).`, { parse_mode: 'HTML' });
                }
                isRangeBet = true;
            }

            // 2. Валидация простых типов ставок
            const validSimple = ['к', 'ч', 'красное', 'черное', 'red', 'black', 'чет', 'нечет', 'четное', 'нечетное', 'even', 'odd'];
            const isNumber = !isNaN(targetRaw) && parseInt(targetRaw) >= 0 && parseInt(targetRaw) <= 36;

            if (!isRangeBet && !validSimple.includes(targetRaw) && !isNumber) {
                return; // Не относится к рулетке
            }

            if (isPrivate) return await bot.sendMessage(chatId, `⚠️ Играть нужно в чате!`);

            // Списываем средства
            const updatedUser = await User.findOneAndUpdate(
                { userId, balance: { $gte: betAmount } },
                { $inc: { balance: -betAmount, tournamentProfit: -betAmount } },
                { new: true }
            );

            if (!updatedUser) return await bot.sendMessage(chatId, `❌ Нехватка средств! Баланс: <b>${user.balance.toLocaleString('ru-RU')} Roze 💰</b>`, { parse_mode: 'HTML' });

            currentBets.push({
                userId,
                firstName,
                username,
                amount: betAmount,
                target: targetRaw,
                parsedRange: isRangeBet ? parsedRange : null
            });

            const cancelKeyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '❌ Отменить ставку', callback_data: `cancel_bet_${currentBets.length - 1}` }]
                    ]
                }
            };

            let betInfoText = `[<b>${targetRaw.toUpperCase()}</b>]`;
            if (isRangeBet) {
                betInfoText += ` (Покрыто чисел: ${parsedRange.count} | Коэфф: x${parsedRange.multiplier})`;
            }

            return await bot.sendMessage(chatId, `✅ ${userTag} поставил <b>${betAmount.toLocaleString('ru-RU')} Roze</b> на ${betInfoText}`, { parse_mode: 'HTML', ...cancelKeyboard });
        }

        // ==========================================
        // 🚀 КРУТИТЬ РУЛЕТКУ ("ГО")
        // ==========================================
        if (text === 'го' || text === 'go' || text === 'старт' || text === 'крутить') {
            if (isPrivate || isSpinning) return;
            if (currentBets.length === 0) return await bot.sendMessage(chatId, `⚠️ ${userTag}, сначала сделайте ставку!`, { parse_mode: 'HTML' });

            const now = Date.now();
            const lastGo = userGoCooldowns[userId] || 0;
            if (now - lastGo < 10000) {
                const secLeft = Math.ceil((10000 - (now - lastGo)) / 1000);
                return await bot.sendMessage(chatId, `⏳ ${userTag}, подожди еще <b>${secLeft} сек.</b> перед го!`, { parse_mode: 'HTML' });
            }

            userGoCooldowns[userId] = now;
            isSpinning = true;

            await bot.sendMessage(chatId, `🎲 ${userTag} запустил рулетку! Крутим...`, { parse_mode: 'HTML' });
            try { await bot.sendDice(chatId, { emoji: '🎰' }); } catch (e) {}
            await sleep(3800);

            try {const num = crypto.randomInt(0, 37);
                let colorEmoji = num === 0 ? '🟢' : (redNumbers.includes(num) ? '🔴' : '⚫️');

                const histDoc = await getHistory();
                histDoc.results.unshift(`${num}${colorEmoji}`);
                if (histDoc.results.length > 10) histDoc.results = histDoc.results.slice(0, 10);
                await histDoc.save();

                let isRed = redNumbers.includes(num);
                let isBlack = num !== 0 && !isRed;
                let isEven = num % 2 === 0; // 0 считается чётным
                let isOdd = num !== 0 && num % 2 !== 0;

                lastRoundBets = {}; 
                let report = `🎰 <b>Результат Рулетки:</b> [ <b>${num} ${colorEmoji}</b> ]\n\n`;

                for (const bet of currentBets) {
                    if (!lastRoundBets[bet.userId]) lastRoundBets[bet.userId] = [];
                    lastRoundBets[bet.userId].push(bet);

                    const betUserTag = getUserTag({ userId: bet.userId, firstName: bet.firstName, username: bet.username });
                    let win = false;
                    let multiplier = 0;
                    const t = bet.target.toLowerCase();

                    // 1. Проверка Диапазонов
                    if (bet.parsedRange) {
                        if (bet.parsedRange.numbers.includes(num)) {
                            win = true;
                            multiplier = bet.parsedRange.multiplier;
                        }
                    } 
                    // 2. Проверка стандартных типов
                    else if ((t === 'к' || t === 'красное' || t === 'red') && isRed) { win = true; multiplier = 2; }
                    else if ((t === 'ч' || t === 'черное' || t === 'black') && isBlack) { win = true; multiplier = 2; }
                    else if ((t === 'чет' || t === 'четное' || t === 'even') && isEven && num !== 0) { win = true; multiplier = 2; }
                    else if ((t === 'нечет' || t === 'нечетное' || t === 'odd') && isOdd) { win = true; multiplier = 2; }
                    else if (!isNaN(t) && parseInt(t) === num) { win = true; multiplier = 36; }

                    if (win) {
                        const winAmount = Math.floor(bet.amount * multiplier);
                        await User.findOneAndUpdate(
                            { userId: bet.userId },
                            { $inc: { balance: winAmount, tournamentProfit: winAmount } }
                        );
                        report += `✅ ${betUserTag} выбил <b>+${winAmount.toLocaleString('ru-RU')} Roze</b> на [${bet.target.toUpperCase()}] (x${multiplier})\n`;
                    } else {
                        report += `❌ ${betUserTag} проиграл ${bet.amount.toLocaleString('ru-RU')} Roze [${bet.target.toUpperCase()}]\n`;
                    }
                }

                currentBets = [];
                isSpinning = false;

                const actionButtons = {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '🔄 Повторить', callback_data: 'repeat_bet' },
                                { text: '⚡️ Удвоить', callback_data: 'double_bet' }
                            ]
                        ]
                    }
                };

                await bot.sendMessage(chatId, report.trim(), { parse_mode: 'HTML', ...actionButtons });

            } catch (err) {
                isSpinning = false;
                currentBets = [];
            }
        }
    } catch (globalErr) {
        isSpinning = false;
        currentBets = [];
    }
});