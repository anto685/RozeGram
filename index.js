const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const http = require('http');

// ==========================================
// 1. СЕРВЕР И АНТИ-СПЛИТ
// ==========================================
const PORT = process.env.PORT || 10000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('RozeGram Casino Engine v7.0 Compact - ONLINE 🎰');
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
const token = process.env.BOT_TOKEN || '8919281816:AAFBc2Y0HAJnWPiBJO-ThUwI7fCWIDAY8gI';
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
    balance: { type: Number, default: 1000 },
    lastBonus: { type: Number, default: 0 },
    tournamentProfit: { type: Number, default: 0 }
});

const historySchema = new mongoose.Schema({ results: { type: [String], default: [] } });
const systemSchema = new mongoose.Schema({ lastResetDate: { type: String, default: '' } });

const User = mongoose.model('User', userSchema);
const History = mongoose.model('History', historySchema);
const System = mongoose.model('System', systemSchema);

// ==========================================
// 4. ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ И ХЕЛПЕРЫ
// ==========================================
let currentBets = [];
let lastRoundBets = {};
let isSpinning = false;
let spinSafetyTimer = null;
let activeMinesGames = {}; 

const MAX_BETS_PER_ROUND = 250; // ТВОЙ ЛИМИТ В 250 СТАВОК!

const bot = new TelegramBot(token, { polling: true });

bot.on('polling_error', (err) => {
    if (!err.message.includes('409 Conflict')) {
        console.error(`[POLLING ERROR] ${err.code}: ${err.message}`);
    }
});

const redNumbers = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function mentionUser(userId, name) {
    const safeName = (name || 'Игрок').replace(/[*_`\[\]()]/g, '');
    return `[${safeName}](tg://user?id=${userId})`;
}

const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '💰 Баланс' }, { text: '🎁 Бонус' }],
            [{ text: '🏆 Турнир' }, { text: '📖 Правила игры' }]
        ],
        resize_keyboard: true
    }
};

async function getUser(userId, firstName = 'Игрок') {
    try {
        let user = await User.findOne({ userId });
        if (!user) {
            user = await User.create({ userId, firstName, balance: 1000, lastBonus: 0, tournamentProfit: 0 });
        } else if (firstName !== 'Игрок' && user.firstName !== firstName) {
            user.firstName = firstName;
            await user.save();
        }
        return user;
    } catch (e) {
        console.error('[GET USER ERROR]', e.message);
        return { userId, firstName, balance: 1000, lastBonus: 0, tournamentProfit: 0, save: async () => {} };
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

async function checkSubscription(userId) {
    try {
        const member = await bot.getChatMember(CHANNEL_USERNAME, userId);
        return ['creator', 'administrator', 'member'].includes(member.status);
    } catch (e) {
        return false;
    }
}

// 🛡 АВТОВОЗВРАТ ПРИ ЗАВИСАНИИ
async function emergencyRefund(chatId, reason = 'Ошибка сервера') {
    if (currentBets.length === 0) {
        isSpinning = false;
        return;
    }
    for (const bet of currentBets) {
        try {
            const betUser = await getUser(bet.userId, bet.firstName);
            betUser.balance += bet.amount;
            betUser.tournamentProfit += bet.amount;
            await betUser.save();
        } catch (e) {}
    }
    currentBets = [];
    isSpinning = false;
    if (spinSafetyTimer) clearTimeout(spinSafetyTimer);
    try {
        await bot.sendMessage(chatId, `🚨 **[Защита]** Сбой (${reason}). Все ставки возвращены!`, { parse_mode: 'Markdown' });
    } catch (e) {}
}

// ==========================================
// 5. МИНЫ (5х5)
// ==========================================
function generateMinesKeyboard(game) {
    let inline_keyboard = [];
    for (let r = 0; r < 5; r++) {
        let row = [];
        for (let c = 0; c < 5; c++) {
            const idx = r * 5 + c;
            let btnText = '❓';
            if (game.revealed[idx] || game.gameOver) {
                btnText = game.board[idx] === 'MINE' ? '💥' : '💎';
            }
            row.push({ text: btnText, callback_data: `mine_click_${idx}` });
        }
        inline_keyboard.push(row);
    }
    if (!game.gameOver) {
        const currentWin = Math.floor(game.bet * game.multiplier);
        inline_keyboard.push([{ text: `💰 Забрать (${currentWin.toLocaleString('ru-RU')} Roze)`, callback_data: 'mine_take' }]);
    }
    return { reply_markup: { inline_keyboard } };
}

// ==========================================
// 6. ОБРАБОТКА CALLBACK QUERY
// ==========================================
bot.on('callback_query', async (query) => {
    try {
        if (query.message && query.message.date < BOT_START_TIME) return;

        const userId = query.from.id;
        const firstName = query.from.first_name || 'Игрок';
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;
        const action = query.data;

        if (action === 'check_sub_and_bonus') {
            const isSubbed = await checkSubscription(userId);
            if (!isSubbed) {
                return await bot.answerCallbackQuery(query.id, { text: '❌ Ты еще не подписался на канал!', show_alert: true });
            }

            const user = await getUser(userId, firstName);
            const now = Date.now();
            const cooldown = 12 * 60 * 60 * 1000;
            if (now - (user.lastBonus || 0) < cooldown) {
                return await bot.answerCallbackQuery(query.id, { text: '⏳ Бонус можно брать раз в 12 часов!', show_alert: true });
            }

            user.balance += 500;
            user.lastBonus = now;
            await user.save();
            return await bot.answerCallbackQuery(query.id, { text: '🎁 Вы получили +500 Roze!', show_alert: true });
        }

        // Обработка кликов в Минах
        const gameKey = `${chatId}_${userId}`;
        const game = activeMinesGames[gameKey];if (action.startsWith('mine_click_') && game && !game.gameOver) {
            const idx = parseInt(action.replace('mine_click_', ''));
            if (game.revealed[idx]) return await bot.answerCallbackQuery(query.id, { text: 'Уже открыто!' });

            game.revealed[idx] = true;

            if (game.board[idx] === 'MINE') {
                game.gameOver = true;
                delete activeMinesGames[gameKey];
                await bot.answerCallbackQuery(query.id, { text: '💥 БУМ! Подорвался!', show_alert: true });
                return await bot.editMessageText(
                    `💥 **Мины | Взрыв!**\n\n${mentionUser(userId, firstName)} наступил на мину и потерял **${game.bet.toLocaleString('ru-RU')} Roze**!`, 
                    { chatId, message_id: messageId, ...generateMinesKeyboard(game), parse_mode: 'Markdown' }
                );
            } else {
                game.gemsFound++;
                game.multiplier += 0.35;
                await bot.answerCallbackQuery(query.id, { text: '💎 Алмаз!' });

                if (game.gemsFound === 22) { 
                    const winAmount = Math.floor(game.bet * game.multiplier);
                    const user = await getUser(userId, firstName);
                    user.balance += winAmount;
                    user.tournamentProfit += winAmount;
                    await user.save();
                    game.gameOver = true;
                    delete activeMinesGames[gameKey];
                    return await bot.editMessageText(
                        `🏆 **Мины | ПОБЕДА!**\n\n${mentionUser(userId, firstName)} очистил все кристаллы и поднял **${winAmount.toLocaleString('ru-RU')} Roze!**`, 
                        { chatId, message_id: messageId, ...generateMinesKeyboard(game), parse_mode: 'Markdown' }
                    );
                }

                return await bot.editMessageText(
                    `💣 **Мины (5x5)**\nИгрок: ${mentionUser(userId, firstName)}\nСтавка: **${game.bet.toLocaleString('ru-RU')} Roze** | Множитель: **x${game.multiplier.toFixed(2)}**`, 
                    { chatId, message_id: messageId, ...generateMinesKeyboard(game), parse_mode: 'Markdown' }
                );
            }
        }

        if (action === 'mine_take' && game && !game.gameOver) {
            const winAmount = Math.floor(game.bet * game.multiplier);
            const user = await getUser(userId, firstName);
            user.balance += winAmount;
            user.tournamentProfit += winAmount;
            await user.save();
            game.gameOver = true;
            delete activeMinesGames[gameKey];

            await bot.answerCallbackQuery(query.id, { text: `💰 Вы забрали ${winAmount.toLocaleString('ru-RU')} Roze!` });
            return await bot.editMessageText(
                `💰 **Мины | Забрал выигрыш!**\n\n${mentionUser(userId, firstName)} зафиксировал выигрыш **+${winAmount.toLocaleString('ru-RU')} Roze**!`, 
                { chatId, message_id: messageId, ...generateMinesKeyboard(game), parse_mode: 'Markdown' }
            );
        }
    } catch (e) {
        console.error('[CALLBACK ERROR]', e.message);
    }
});

// ==========================================
// 7. ОБРАБОТКА СООБЩЕНИЙ
// ==========================================
bot.on('message', async (msg) => {
    try {
        if (msg.date < BOT_START_TIME) return;

        const chatId = msg.chat.id;
        const userId = msg.from ? msg.from.id : null;
        const firstName = msg.from ? msg.from.first_name : 'Игрок';
        const isPrivate = msg.chat.type === 'private';
        if (!userId) return;

        const text = msg.text ? msg.text.trim().toLowerCase() : '';
        if (!text) return;

        const user = await getUser(userId, firstName);

        if (text === '/start') {
            if (isPrivate) {
                return await bot.sendMessage(
                    chatId, 
                    `🎰 **Добро пожаловать в RozeGram Casino!**\n\nПривет, ${mentionUser(userId, firstName)}!\nБаланс: **${user.balance.toLocaleString('ru-RU')} Roze 💰**`,{ parse_mode: 'Markdown', ...mainKeyboard }
                );
            }
            return;
        }

        // --- АДМИНКА ---
        const giveSelfMatch = text.match(/^(?:себе|админ)\s+(\d+)$/);
        if (giveSelfMatch && userId === ADMIN_ID) {
            const amount = parseInt(giveSelfMatch[1]);
            user.balance += amount;
            await user.save();
            return await bot.sendMessage(chatId, `👑 **Админ-выдача!** Начислено **+${amount.toLocaleString('ru-RU')} Roze 💰**`, { parse_mode: 'Markdown' });
        }

        // --- БАЛАНС ---
        if (text === 'б' || text === 'баланс' || text === 'бал' || text === '💰 баланс') {
            return await bot.sendMessage(chatId, `💰 ${mentionUser(userId, firstName)}, твой баланс: **${user.balance.toLocaleString('ru-RU')} Roze 💰**`, { parse_mode: 'Markdown' });
        }

        // --- ОТМЕНА СТАВОК ---
        if (text === 'отмена' || text === 'отменить') {
            if (isSpinning) {
                return await bot.sendMessage(chatId, `❌ ${mentionUser(userId, firstName)}, рулетка уже крутится!`, { parse_mode: 'Markdown' });
            }

            const userBets = currentBets.filter(b => b.userId === userId);
            if (userBets.length === 0) {
                return await bot.sendMessage(chatId, `⚠️ ${mentionUser(userId, firstName)}, у тебя нет активных ставок!`, { parse_mode: 'Markdown' });
            }

            const totalRefund = userBets.reduce((sum, b) => sum + b.amount, 0);
            user.balance += totalRefund;
            user.tournamentProfit += totalRefund;
            await user.save();

            currentBets = currentBets.filter(b => b.userId !== userId);
            return await bot.sendMessage(chatId, `✅ ${mentionUser(userId, firstName)} отменил все свои ставки! Возвращено: **${totalRefund.toLocaleString('ru-RU')} Roze 💰**`, { parse_mode: 'Markdown' });
        }

        // --- ПЕРЕДАЧА ROZE ---
        const payMatch = text.match(/^(?:\/pay|передать|перевод|отдать)\s+(\d+)$/);
        if (payMatch) {
            if (isPrivate) return await bot.sendMessage(chatId, '⚠️ Переводить можно только в чате!');

            if (!msg.reply_to_message || !msg.reply_to_message.from) {
                return await bot.sendMessage(chatId, `⚠️ ${mentionUser(userId, firstName)}, ответь на сообщение получателя!`, { parse_mode: 'Markdown' });
            }

            const targetUserId = msg.reply_to_message.from.id;
            const targetFirstName = msg.reply_to_message.from.first_name || 'Игрок';
            if (targetUserId === userId) return await bot.sendMessage(chatId, '❌ Нельзя переводить самому себе!', { parse_mode: 'Markdown' });

            const amount = parseInt(payMatch[1]);
            if (amount <= 0 || user.balance < amount) return await bot.sendMessage(chatId, `❌ Ошибка перевода или нехватка средств!`, { parse_mode: 'Markdown' });

            const recipient = await getUser(targetUserId, targetFirstName);
            user.balance -= amount;
            recipient.balance += amount;
            await user.save();
            await recipient.save();

            return await bot.sendMessage(chatId, `💸 **Успешный перевод!**\n\n${mentionUser(userId, firstName)} ➔ ${mentionUser(targetUserId, targetFirstName)}: **${amount.toLocaleString('ru-RU')} Roze 💰**`, { parse_mode: 'Markdown' });
        }

        // --- МИНЫ ---
        const minesMatch = text.match(/^мины\s+(\d+)$/);
        if (minesMatch) {
            if (isPrivate) return await bot.sendMessage(chatId, '⚠️ Играть нужно в чате!');
            const betAmount = parseInt(minesMatch[1]);

            if (user.balance < betAmount || betAmount <= 0) {
                return await bot.sendMessage(chatId, '❌ Нехватка средств!', { parse_mode: 'Markdown' });
            }

            const gameKey = `${chatId}_${userId}`;
            if (activeMinesGames[gameKey]) {
                return await bot.sendMessage(chatId, '⚠️ Закончи текущую игру в мины!', { parse_mode: 'Markdown' });
            }

            user.balance -= betAmount;
            user.tournamentProfit -= betAmount;
            await user.save();

            let board = Array(25).fill('GEM');
            let minesPlaced = 0;
            while (minesPlaced < 3) {
                let idx = Math.floor(Math.random() * 25);
                if (board[idx] !== 'MINE') {
                    board[idx] = 'MINE';
                    minesPlaced++;
                }
            }

            const game = {
                bet: betAmount,
                board: board,
                revealed: Array(25).fill(false),
                gemsFound: 0,
                multiplier: 1.0,
                gameOver: false
            };

            activeMinesGames[gameKey] = game;

            return await bot.sendMessage(
                chatId, 
                `💣 **Мины (5x5)**\nИгрок: ${mentionUser(userId, firstName)}\nСтавка: **${betAmount.toLocaleString('ru-RU')} Roze**\nНажми на ячейку чтобы открыть:`, 
                { parse_mode: 'Markdown', ...generateMinesKeyboard(game) }
            );
        }

        // --- КУБИК ---
        const diceMatch = text.match(/^(\d+)\s+куб\s+(1|2|3|4|5|6|чет|нечет)$/);
        if (diceMatch) {
            if (isPrivate) return await bot.sendMessage(chatId, '⚠️ Играть нужно в чате!');
            const betAmount = parseInt(diceMatch[1]);
            const target = diceMatch[2];

            if (user.balance < betAmount || betAmount <= 0) return await bot.sendMessage(chatId, '❌ Нехватка средств!', { parse_mode: 'Markdown' });

            user.balance -= betAmount;
            user.tournamentProfit -= betAmount;
            await user.save();

            const diceMsg = await bot.sendDice(chatId, { emoji: '🎲' });
            const roll = diceMsg.dice.value;

            await sleep(3000);

            let win = false;
            let multiplier = 0;

            if (target === 'чет' && roll % 2 === 0) { win = true; multiplier = 2; }
            else if (target === 'нечет' && roll % 2 !== 0) { win = true; multiplier = 2; }
            else if (parseInt(target) === roll) { win = true; multiplier = 6; }

            let report = `🎲 ${mentionUser(userId, firstName)} бросил кубик! Результат: **[ ${roll} ]**\n`;
            if (win) {
                const winAmount = betAmount * multiplier;
                user.balance += winAmount;
                user.tournamentProfit += winAmount;
                report += `✅ Победа! Выигрыш: **+${winAmount.toLocaleString('ru-RU')} Roze 💰**`;
            } else {
                report += `❌ Проигрыш! Потеряно **${betAmount.toLocaleString('ru-RU')} Roze**`;
            }
            await user.save();
            return await bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
        }

        // ==========================================
        // 8. ПАРСИНГ СТАВОК (КОМПАКТНЫЙ ПРИЕМ)
        // ==========================================
        const tokens = text.split(/\s+/);
        const firstNum = parseInt(tokens[0]);

        if (!isSpinning && !isNaN(firstNum) && firstNum > 0 && tokens.length >= 2 && !['мины', 'куб', 'передать', 'перевод', 'себе', 'админ', 'выдать'].includes(tokens[0])) {
            
            const betAmount = firstNum;
            const targetTokens = tokens.slice(1);
            
            if (currentBets.length + targetTokens.length > MAX_BETS_PER_ROUND) {
                return await bot.sendMessage(chatId, `❌ Лимит стола: максимум **${MAX_BETS_PER_ROUND}** ставок за раунд!`, { parse_mode: 'Markdown' });
            }

            let parsedBets = [];
            let detectedType = null;
            let parseError = false;

            for (const target of targetTokens) {
                let currentType = null;

                const rangeMatch = target.match(/^(\d{1,2})-(\d{1,2})$/);
                if (target === '0' || (!isNaN(target) && parseInt(target) >= 0 && parseInt(target) <= 36)) {
                    currentType = 'NUMBERS';
                } else if (rangeMatch) {
                    const min = parseInt(rangeMatch[1]);
                    const max = parseInt(rangeMatch[2]);if (min >= max || min < 0 || max > 36) { parseError = true; break; }
                    currentType = 'NUMBERS';
                } else if (['к', 'ч', 'красное', 'черное', 'red', 'black'].includes(target)) {
                    currentType = 'COLORS';
                } else if (['чет', 'нечет', 'четное', 'нечетное', 'even', 'odd'].includes(target)) {
                    currentType = 'EVENODD';
                } else {
                    parseError = true;
                    break;
                }

                if (detectedType === null) {
                    detectedType = currentType;
                } else if (detectedType !== currentType) {
                    return await bot.sendMessage(chatId, `❌ **${mentionUser(userId, firstName)}**, НЕЛЬЗЯ мешать категории!\n\nСтавь строго:\n1️⃣ Только **Числа и Диапазоны** (\`10000 0 1 2 3 4 5 12-18\`)\n2️⃣ Только Цвета (\`100 к ч\`)\n3️⃣ Только Чет/Нечет (\`100 чет нечет\`)`, { parse_mode: 'Markdown' });
                }

                parsedBets.push({ amount: betAmount, target: target, type: currentType });
            }

            if (!parseError && parsedBets.length > 0) {
                if (isPrivate) return await bot.sendMessage(chatId, '⚠️ Играть нужно в чате!');

                const totalSum = parsedBets.reduce((s, b) => s + b.amount, 0);
                if (user.balance < totalSum) {
                    return await bot.sendMessage(chatId, `❌ Нехватка средств! Нужно: **${totalSum.toLocaleString('ru-RU')} Roze** (баланс: ${user.balance.toLocaleString('ru-RU')} Roze)`, { parse_mode: 'Markdown' });
                }

                user.balance -= totalSum;
                user.tournamentProfit -= totalSum;
                await user.save();

                let targetsList = [];
                for (const b of parsedBets) {
                    currentBets.push({ userId, firstName, amount: b.amount, target: b.target, type: b.type });
                    targetsList.push(b.target.toUpperCase());
                }

                return await bot.sendMessage(chatId, `✅ ${mentionUser(userId, firstName)} поставил по **${betAmount.toLocaleString('ru-RU')} Roze** на ${parsedBets.length} целей: [ ${targetsList.join(', ')} ]`, { parse_mode: 'Markdown' });
            }
        }

        // ==========================================
        // 9. ЗАПУСК РУЛЕТКИ (ЛИСТОЧЕК ВИНОВ И ДИАПАЗОНОВ)
        // ==========================================
        if (text === 'го' || text === 'go' || text === 'крутить' || text === 'старт') {
            if (isPrivate || isSpinning) return;
            if (currentBets.length === 0) return await bot.sendMessage(chatId, '⚠️ Сначала сделайте ставку!');

            isSpinning = true;

            spinSafetyTimer = setTimeout(() => {
                if (isSpinning) emergencyRefund(chatId, 'Превышено время ожидания 5 минут');
            }, 5 * 60 * 1000);

            await bot.sendMessage(chatId, '🎰 Крутим рулетку...', { parse_mode: 'Markdown' });

            try { await bot.sendDice(chatId, { emoji: '🎰' }); } catch (e) {}
            await sleep(3800);

            try {
                const num = Math.floor(Math.random() * 37);
                let colorEmoji = num === 0 ? '🟢' : (redNumbers.includes(num) ? '🔴' : '⚫️');

                const histDoc = await getHistory();
                histDoc.results.unshift(`${num}${colorEmoji}`);
                if (histDoc.results.length > 10) histDoc.results = histDoc.results.slice(0, 10);
                await histDoc.save();

                let isRed = redNumbers.includes(num);
                let isBlack = num !== 0 && !isRed;
                let isEven = num !== 0 && num % 2 === 0;
                let isOdd = num !== 0 && num % 2 !== 0;

                lastRoundBets = {}; 
                let userSummary = {};

                for (const bet of currentBets) {
                    if (!lastRoundBets[bet.userId]) lastRoundBets[bet.userId] = [];
                    lastRoundBets[bet.userId].push(bet);

                    if (!userSummary[bet.userId]) {userSummary[bet.userId] = {
                            firstName: bet.firstName,
                            totalCost: 0,
                            totalWin: 0,
                            betsCount: 0
                        };
                    }

                    userSummary[bet.userId].totalCost += bet.amount;
                    userSummary[bet.userId].betsCount++;

                    let win = false;
                    let multiplier = 0;
                    const t = bet.target.toLowerCase();

                    if ((t === 'к' || t === 'красное' || t === 'red') && isRed) { win = true; multiplier = 2; }
                    else if ((t === 'ч' || t === 'черное' || t === 'black') && isBlack) { win = true; multiplier = 2; }
                    else if ((t === 'чет' || t === 'четное' || t === 'even') && isEven) { win = true; multiplier = 2; }
                    else if ((t === 'нечет' || t === 'нечетное' || t === 'odd') && isOdd) { win = true; multiplier = 2; }
                    else if (!isNaN(t) && parseInt(t) === num) { win = true; multiplier = 36; }
                    else if (t.includes('-')) {
                        const [min, max] = t.split('-').map(Number);
                        if (num >= min && num <= max) {
                            win = true;
                            const count = (max - min) + 1;
                            multiplier = Math.floor(36 / count);
                        }
                    }

                    if (win) {
                        const winAmount = Math.floor(bet.amount * multiplier);
                        userSummary[bet.userId].totalWin += winAmount;
                    }
                }

                // Определение зашедшего диапазона
                let winningRange = 'Зеро 🟢';
                if (num >= 1 && num <= 12) winningRange = '1 - 12 🎯';
                else if (num >= 13 && num <= 24) winningRange = '13 - 24 🎯';
                else if (num >= 25 && num <= 36) winningRange = '25 - 36 🎯';

                // Сбор листочка и начисление балансов
                let playersSheet = '';
                for (const uId in userSummary) {
                    const data = userSummary[uId];
                    const betUser = await getUser(uId, data.firstName);
                    const netProfit = data.totalWin - data.totalCost;

                    if (data.totalWin > 0) {
                        betUser.balance += data.totalWin;
                        betUser.tournamentProfit += data.totalWin;
                        await betUser.save();
                        playersSheet += `├ 🎉 ${mentionUser(uId, data.firstName)}: **ВИН +${data.totalWin.toLocaleString('ru-RU')} Roze** (Профит: +${netProfit.toLocaleString('ru-RU')})\n`;
                    } else {
                        await betUser.save();
                        playersSheet += `├ 📉 ${mentionUser(uId, data.firstName)}: Минус **${data.totalCost.toLocaleString('ru-RU')} Roze**\n`;
                    }
                }

                if (!playersSheet) playersSheet = '├ Ставок не было\n';

                // ФОРМИРУЕМ ЛИСТОЧЕК ИТОГОВ
                const report = 
`📜 **--- [ ЛИСТОЧЕК РАУНДА ] ---**

🎰 Выпало: **[ ${num} ${colorEmoji} ]**

📊 **ДИАПАЗОН И СВОЙСТВА ВИНА:**
├ 🎯 Выигравший диапазон: **${winningRange}**
├ 🎨 Цвет: **${colorEmoji} ${isRed ? 'Красное' : (isBlack ? 'Черное' : 'Зеро')}**
└ ⚖️ Четность: **${num === 0 ? 'Зеро' : (isEven ? 'Четное' : 'Нечетное')}**

💰 **ИТОГИ ИГРОКОВ:**
${playersSheet}
📜 **История:** ${histDoc.results.join(' | ')}`;

                currentBets = [];
                isSpinning = false;
                if (spinSafetyTimer) clearTimeout(spinSafetyTimer);

                const actionButtons = {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '🔄 Повторить', callback_data: 'repeat_bet' },
                                { text: '✖️2 Удвоить', callback_data: 'double_bet' }
                            ]]
                    }
                };

                await bot.sendMessage(chatId, report.trim(), { parse_mode: 'Markdown', ...actionButtons });

            } catch (err) {
                console.error('[SPIN ERROR]', err.message);
                await emergencyRefund(chatId, err.message);
            }
        }

        // ==========================================
        // 10. ИНФОРМАЦИОННЫЕ КОМАНДЫ
        // ==========================================
        if (text === '🏆 турнир' || text === 'турнир' || text === 'топ') {
            const topUsers = await User.find().sort({ tournamentProfit: -1 }).limit(10);
            let leaderboardText = `🏆 **Суточный Турнир RozeGram**\n\n📊 **ТОП Лидеров:**\n`;
            topUsers.forEach((u, idx) => {
                if (u.tournamentProfit > 0) {
                    const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
                    leaderboardText += `${medal} ${mentionUser(u.userId, u.firstName)} ➔ +${u.tournamentProfit.toLocaleString('ru-RU')} Roze\n`;
                }
            });
            return await bot.sendMessage(chatId, leaderboardText, { parse_mode: 'Markdown' });
        }

        if (text === 'история') {
            const histDoc = await getHistory();
            const historyText = histDoc.results.map((item, index) => `${index + 1}. ${item}`).join('\n') || 'Пусто';
            return await bot.sendMessage(chatId, `📜 **История:**\n\n${historyText}`, { parse_mode: 'Markdown' });
        }

        if (text === '📖 правила игры' || text === 'правила') {
            return await bot.sendMessage(chatId, `🎰 **Правила Casino**\n\n• Ставка: \`100 к\`, \`2000 0 1 2 3 4 5 12-18\`\n• Лимит ставок за раунд: **250 шт.**\n• Баланс: кнопка или буква \`б\`\n• Отмена: \`отмена\`\n• Мины: \`мины 500\`\n• Кубик: \`100 куб 6\`\n• Старт: \`го\``, { parse_mode: 'Markdown' });
        }

    } catch (globalErr) {
        console.error('[GLOBAL ERROR]', globalErr.message);
    }
});