const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const http = require('http');

// ==========================================
// 1. СЕРВЕР И АНТИ-СПЛИТ (ЧТОБЫ РЕНДЕР НЕ СПАЛ)
// ==========================================
const PORT = process.env.PORT || 10000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('RozeGram Casino Engine v2.0 Unstable - ONLINE 🎰');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Engine running on port ${PORT}`);
});

// Авто-пинг каждые 4 минуты, чтобы Render не засыпал
setInterval(() => {
    if (RENDER_URL.startsWith('http')) {
        http.get(RENDER_URL, (res) => {}).on('error', (err) => {});
    }
}, 4 * 60 * 1000);

// ==========================================
// 2. КОНФИГУРАЦИЯ И БАЗА ДАННЫХ
// ==========================================
const token = process.env.BOT_TOKEN || '8919281816:AAGLh6HcaeOLnr_ZmGosZL9FqfUpgyqkTmI';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://garbonretoy_db_user:SuperPass12345@cluster0.lk3ngtu.mongodb.net/RozegramDB?retryWrites=true&w=majority';

const CHANNEL_USERNAME = '@anloMorze2k26';
const CHANNEL_LINK = 'https://t.me/anloMorze2k26';
const BOT_START_TIME = Math.floor(Date.now() / 1000);

// Железобетонное подключение к MongoDB
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
        setTimeout(connectDB, 5000); // Авто-повтор при сбое
    }
};
connectDB();

// ==========================================
// 3. СХЕМЫ ДАННЫХ (MONGOOSE MODELS)
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
// 4. ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ И БОТ
// ==========================================
let currentBets = [];
let lastRoundBets = {};
let userBetCooldowns = {};
let isSpinning = false;

const bot = new TelegramBot(token, { polling: true });

bot.on('polling_error', (err) => {
    if (!err.message.includes('409 Conflict')) {
        console.error(`[POLLING ERROR] ${err.code}: ${err.message}`);
    }
});

// Хелперы
const redNumbers = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const mainKeyboard = {reply_markup: {
        keyboard: [
            [{ text: '💰 Баланс' }, { text: '🎁 Бонус' }],
            [{ text: '🏆 Турнир' }, { text: '📖 Правила игры' }]
        ],
        resize_keyboard: true
    }
};

const TOURNAMENT_PRIZES = [1000000, 500000, 300000, 200000, 100000, 75000, 50000, 30000, 20000, 10000];

// Атомарное получение/создание юзера
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

// Сброс турнира в 00:00
async function checkTournamentReset() {
    try {
        const now = new Date();
        const currentDateStr = now.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
        const currentHour = now.toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });

        let sys = await System.findOne();
        if (!sys) sys = await System.create({ lastResetDate: currentDateStr });

        if (sys.lastResetDate !== currentDateStr && currentHour === '00:00') {
            const topUsers = await User.find({ tournamentProfit: { $gt: 0 } }).sort({ tournamentProfit: -1 }).limit(10);
            for (let i = 0; i < topUsers.length; i++) {
                if (TOURNAMENT_PRIZES[i]) {
                    topUsers[i].balance += TOURNAMENT_PRIZES[i];
                    await topUsers[i].save();
                }
            }
            await User.updateMany({}, { tournamentProfit: 0 });
            sys.lastResetDate = currentDateStr;
            await sys.save();
        }
    } catch (e) {
        console.error('[TOURNAMENT RESET ERROR]', e.message);
    }
}
setInterval(checkTournamentReset, 60000);

// ==========================================
// 5. ОБРАБОТКА CALLBACK QUERY (КНОПКИ)
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
            const lastBonus = user.lastBonus || 0;

            if (now - lastBonus < cooldown) {
                const timeLeft = cooldown - (now - lastBonus);
                const h = Math.floor(timeLeft / (1000 * 60 * 60));
                const m = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
                try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
                await bot.answerCallbackQuery(query.id, { text: 'Подписка подтверждена!' });
                return await bot.sendMessage(chatId, `⏳ Бонус уже забран! Приходи через **${h}ч ${m}м**`, { parse_mode: 'Markdown', ...mainKeyboard });
            }

            user.balance += 10000;
            user.lastBonus = now;
            await user.save();

            try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
            await bot.answerCallbackQuery(query.id, { text: '🎉 +10 000 Roze 💰 зачислено!' });
            return await bot.sendMessage(chatId, `🎉 **Подписка подтверждена! Зачислено +10 000 Roze 💰!**\nТвой баланс: **${user.balance.toLocaleString('ru-RU')} Roze 💰**`, { parse_mode: 'Markdown', ...mainKeyboard });
        }

        if (action === 'repeat_bet' || action === 'double_bet') {
            if (isSpinning) return await bot.answerCallbackQuery(query.id, { text: 'Игра идет!', show_alert: true });

            const user = await getUser(userId, firstName);
            const userLastBets = lastRoundBets[userId];

            if (!userLastBets || userLastBets.length === 0) {
                return await bot.answerCallbackQuery(query.id, { text: 'Нет ставок с прошлого раунда!', show_alert: true });
            }

            let multiplier = (action === 'repeat_bet') ? 1 : 2;
            let totalCost = userLastBets.reduce((sum, b) => sum + (b.amount * multiplier), 0);

            if (user.balance < totalCost) {
                return await bot.answerCallbackQuery(query.id, { text: `Нужно ${totalCost.toLocaleString('ru-RU')} Roze, баланс: ${user.balance.toLocaleString('ru-RU')} Roze`, show_alert: true });
            }

            user.balance -= totalCost;
            user.tournamentProfit -= totalCost;
            await user.save();

            let addedText = [];
            for (const oldBet of userLastBets) {
                const newAmount = oldBet.amount * multiplier;
                currentBets.push({ userId, firstName, amount: newAmount, target: oldBet.target });
                addedText.push(`${newAmount.toLocaleString('ru-RU')} Roze на ${oldBet.target}`);
            }

            await bot.answerCallbackQuery(query.id, { text: 'Ставка принята' });
            await bot.sendMessage(chatId, `🎰 **${firstName}** ${action === 'repeat_bet' ? 'повторил' : 'удвоил'} (${totalCost.toLocaleString('ru-RU')} Roze): ${addedText.join(', ')}`);
        }
    } catch (e) {
        console.error('[CALLBACK ERROR]', e.message);
    }
});

// ==========================================
// 6. ОБРАБОТКА СООБЩЕНИЙ (ОСНОВНОЙ БЛОК)
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
                    `🎰 **Добро пожаловать в RozeGram Casino!**\n\nПривет, **${firstName}**!\nБаланс: **${user.balance.toLocaleString('ru-RU')} Roze 💰**\n\nИспользуй меню ниже для проверки баланса и бонусов 👇`, 
                    { parse_mode: 'Markdown', ...mainKeyboard }
                );
            }
            return;
        }

        if (text === '🏆 турнир' || text === 'турнир' || text === 'топ') {
            const topUsers = await User.find().sort({ tournamentProfit: -1 }).limit(10);
            let leaderboardText = `🏆 **Суточный Турнир RozeGram**\n🔴⚫️ **ROZE ROULETTE** 🔴⚫️\n\n` +
            `Турнир длится 1 день (обнуление в 00:00).\n` +
            `Участие автоматическое! Засчитывается **чистая прибыль**.\n\n` +
            `🎁 **Призы ТОП-10:**\n` +
            `🥇 1,000,000 Roze 💰\n🥈 500,000 Roze 💰\n🥉 300,000 Roze 💰\n\n` +
            `📊 **Текущий ТОП Лидеров:**\n`;

            if (topUsers.length === 0 || topUsers[0].tournamentProfit <= 0) {
                leaderboardText += `_Пока нет активных участников с плюсовым профитом._`;
            } else {
                topUsers.forEach((u, idx) => {
                    if (u.tournamentProfit > 0) {
                        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
                        leaderboardText += `${medal} **${u.firstName}** ➔ +${u.tournamentProfit.toLocaleString('ru-RU')} Roze 💰\n`;
                    }
                });
            }

            return await bot.sendMessage(chatId, leaderboardText, { parse_mode: 'Markdown', ...(isPrivate ? mainKeyboard : {}) });
        }

        if (text === 'бонус' || text === 'бонусы' || text === '🎁 бонус') {
            if (!isPrivate) return await bot.sendMessage(chatId, `🎁 **${firstName}**, забрать бонус можно только в ЛС бота!`, { parse_mode: 'Markdown' });
            
            const isSubbed = await checkSubscription(userId);
            if (!isSubbed) {
                const subMenu = {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '📢 Подписаться на Канал', url: CHANNEL_LINK }],
                            [{ text: '✅ Проверить подписку и забрать 10k Roze 💰', callback_data: 'check_sub_and_bonus' }]
                        ]
                    }
                };
                return await bot.sendMessage(chatId, `❌ **Для получения бонуса необходимо быть подписанным на наш канал!**`, { parse_mode: 'Markdown', ...subMenu });
            }

            const now = Date.now();
            const cooldown = 12 * 60 * 60 * 1000;
            const lastBonus = user.lastBonus || 0;

            if (now - lastBonus < cooldown) {
                const timeLeft = cooldown - (now - lastBonus);
                const h = Math.floor(timeLeft / (1000 * 60 * 60));
                const m = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
                return await bot.sendMessage(chatId, `⏳ Бонус доступен через **${h}ч ${m}м**`, { parse_mode: 'Markdown', ...mainKeyboard });
            }

            user.balance += 10000;
            user.lastBonus = now;
            await user.save();
            return await bot.sendMessage(chatId, `🎉 Зачислено **+10 000 Roze 💰**! Баланс: **${user.balance.toLocaleString('ru-RU')} Roze 💰**`, { parse_mode: 'Markdown', ...mainKeyboard });
        }

        if (text === 'баланс' || text === 'бал' || text === '💰 баланс') {
            if (isPrivate) {
                return await bot.sendMessage(chatId, `💰 Баланс: **${user.balance.toLocaleString('ru-RU')} Roze 💰**`, { parse_mode: 'Markdown', ...mainKeyboard });
            } else {
                return await bot.sendMessage(chatId, `💰 **${firstName}**, твой баланс: **${user.balance.toLocaleString('ru-RU')} Roze 💰**`, { parse_mode: 'Markdown' });
            }
        }

        if (text === 'история' || text === 'лог') {
            const histDoc = await getHistory();
            if (!histDoc.results || histDoc.results.length === 0) return await bot.sendMessage(chatId, '📜 История пуста');
            const historyText = histDoc.results.map((item, index) => `${index + 1}. ${item}`).join('\n');
            return await bot.sendMessage(chatId, `📜 **История:**\n\n${historyText}`, { parse_mode: 'Markdown' });
        }

        if (text === '📖 правила игры' || text === 'правила') {
            const rulesText = 
`🎰 **Правила RozeGram Casino**

Примеры ставок (Рулетка):
• \`100 к\` / \`100 ч\` — RED / BLACK (x2)
• \`500 чет\` / \`500 нечет\` — EVEN / ODD (x2)
• \`300 12\` — Число (x36)

🎲 Быстрый кубик (1-6):
• \`100 куб 6\` — Ставка на число (x6)
• \`200 куб чет\` / \`200 куб нечет\` (x2)

Старт рулетки: го`;
            return await bot.sendMessage(chatId, rulesText, { parse_mode: 'Markdown', ...(isPrivate ? mainKeyboard : {}) });
        }

        // ==========================================
        // 7. ИГРА В КУБИК (ФИКС БАЛАНСА И СЕЙВА)
        // ==========================================
        const diceMatch = text.match(/^(\d+)\s+куб\s+(1|2|3|4|5|6|чет|нечет)$/);
        if (diceMatch) {
            if (isPrivate) return await bot.sendMessage(chatId, `⚠️ **Играть нужно в чате!**`);

            const now = Date.now();
            if (now - (userBetCooldowns[userId] || 0) < 3000) {
                return await bot.sendMessage(chatId, `⚠️ **${firstName}**, не спам! Подожди 3 сек.`, { parse_mode: 'Markdown' });
            }
            userBetCooldowns[userId] = now;

            const betAmount = parseInt(diceMatch[1]);
            const target = diceMatch[2];

            if (user.balance < betAmount) {
                return await bot.sendMessage(chatId, `❌ Нехватка средств! Баланс: **${user.balance.toLocaleString('ru-RU')} Roze 💰**`, { parse_mode: 'Markdown' });
            }

            // Жестко списываем баланс
            user.balance -= betAmount;
            user.tournamentProfit -= betAmount;
            await user.save();

            const diceMsg = await bot.sendDice(chatId, { emoji: '🎲' });
            const diceValue = diceMsg.dice.value;

            await sleep(3000);

            // Переполучаем свежего юзера из БД, чтобы не было рассинхрона!
            const freshUser = await getUser(userId, firstName);

            let isWin = false;
            let winMultiplier = 0;

            if (!isNaN(target) && parseInt(target) === diceValue) {
                isWin = true; winMultiplier = 6;
            } else if (target === 'чет' && diceValue % 2 === 0) {
                isWin = true; winMultiplier = 2;
            } else if (target === 'нечет' && diceValue % 2 !== 0) {
                isWin = true; winMultiplier = 2;
            }

            if (isWin) {
                const winSum = betAmount * winMultiplier;
                freshUser.balance += winSum;
                freshUser.tournamentProfit += winSum;
                await freshUser.save(); // ЖЕЛЕЗНЫЙ СЕЙВ
                return await bot.sendMessage(chatId, `🎲 **Выпало: ${diceValue}**\n🎉 **${firstName}**, победа! +${winSum.toLocaleString('ru-RU')} Roze 💰 (Баланс: **${freshUser.balance.toLocaleString('ru-RU')} Roze 💰**)`, { parse_mode: 'Markdown' });
            } else {
                return await bot.sendMessage(chatId, `🎲 **Выпало: ${diceValue}**\n❌ **${firstName}**, мимо! -${betAmount.toLocaleString('ru-RU')} Roze 💰 (Баланс: **${freshUser.balance.toLocaleString('ru-RU')} Roze 💰**)`, { parse_mode: 'Markdown' });
            }
        }

        // ==========================================
        // 8. ПАРСЕР СТАВОК РУЛЕТКИ
        // ==========================================
        const parts = text.split(/\s+/);
        let numbersSum = 0;
        let targets = [];
        let hasBetTrigger = false;

        for (const p of parts) {
            if (!isNaN(p) && !p.includes('-')) {
                numbersSum += parseInt(p);
            } else if (p.match(/^(\d+)-(\d+)$/)) {
                targets.push(p); hasBetTrigger = true;
            } else if (['к', 'красное', 'red', 'ч', 'черное', 'black', 'чет', 'четное', 'even', 'нечет', 'нечетное', 'odd'].includes(p)) {
                targets.push(p); hasBetTrigger = true;
            } else if (!isNaN(p) && parseInt(p) >= 0 && parseInt(p) <= 36) {
                targets.push(p); hasBetTrigger = true;
            }
        }

        if (hasBetTrigger && numbersSum > 0 && targets.length > 0) {
            if (isPrivate) return await bot.sendMessage(chatId, `⚠️ **Ставки делаются в чате!**`);
            if (isSpinning) return await bot.sendMessage(chatId, '⏳ Рулетка крутится!');

            const now = Date.now();
            if (now - (userBetCooldowns[userId] || 0) < 3000) {
                return await bot.sendMessage(chatId, `⚠️ **${firstName}**, не спам! Подожди 3 сек.`, { parse_mode: 'Markdown' });
            }
            userBetCooldowns[userId] = now;

            const betPerTarget = numbersSum; 
            const totalRequired = betPerTarget * targets.length;

            if (user.balance < totalRequired) {
                return await bot.sendMessage(chatId, `❌ Нехватка средств! Нужно: **${totalRequired.toLocaleString('ru-RU')} Roze 💰**, баланс: **${user.balance.toLocaleString('ru-RU')} Roze 💰**`, { parse_mode: 'Markdown' });
            }

            for (const t of targets) {
                if (t.includes('-')) {
                    const [s, e] = t.split('-').map(Number);
                    if (s < 0 || e > 36 || s >= e) {
                        return await bot.sendMessage(chatId, `❌ Ошибка в диапазоне "${t}"`, { parse_mode: 'Markdown' });
                    }
                }
            }

            user.balance -= totalRequired;
            user.tournamentProfit -= totalRequired;
            await user.save();

            let placedText = [];
            for (const t of targets) {
                currentBets.push({ userId, firstName, amount: betPerTarget, target: t });
                placedText.push(`${betPerTarget.toLocaleString('ru-RU')} Roze на ${t}`);
            }

            return await bot.sendMessage(chatId, `✅ **${firstName}**: ${placedText.join(', ')}`, { parse_mode: 'Markdown' });
        }

        // ==========================================
        // 9. ЗАПУСК РУЛЕТКИ
        // ==========================================
        if (text === 'го' || text === 'go' || text === 'старт' || text === 'крутить') {
            if (isPrivate || isSpinning) return;
            if (currentBets.length === 0) return await bot.sendMessage(chatId, '⚠️ Сначала сделайте ставку');

            isSpinning = true;
            await bot.sendMessage(chatId, '🎲 Крутим...');

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
                let report = `Рулетка: ${num}${colorEmoji}\n`;

                for (const bet of currentBets) {
                    if (!lastRoundBets[bet.userId]) lastRoundBets[bet.userId] = [];
                    lastRoundBets[bet.userId].push(bet);

                    let displayTarget = bet.target.toUpperCase();
                    if (['К', 'КРАСНОЕ'].includes(displayTarget)) displayTarget = 'RED';
                    if (['Ч', 'ЧЕРНОЕ'].includes(displayTarget)) displayTarget = 'BLACK';
                    if (['ЧЕТ', 'ЧЕТНОЕ', 'EVEN'].includes(displayTarget)) displayTarget = 'EVEN';
                    if (['НЕЧЕТ', 'НЕЧЕТНОЕ', 'ODD'].includes(displayTarget)) displayTarget = 'ODD';

                    report += `${bet.firstName} ${bet.amount.toLocaleString('ru-RU')} Roze на ${displayTarget}\n`;
                }

                report += `\n`;

                for (const bet of currentBets) {
                    let win = false;
                    let multiplier = 0;
                    const t = bet.target.toLowerCase();

                    if ((t === 'к' || t === 'красное' || t === 'red') && isRed) { win = true; multiplier = 2; }
                    else if ((t === 'ч' || t === 'черное' || t === 'black') && isBlack) { win = true; multiplier = 2; }
                    else if ((t === 'чет' || t === 'четное' || t === 'even') && isEven) { win = true; multiplier = 2; }
                    else if ((t === 'нечет' || t === 'нечетное' || t === 'odd') && isOdd) { win = true; multiplier = 2; }
                    else if (!isNaN(t) && parseInt(t) === num) { win = true; multiplier = 36; }
                    else if (t.includes('-')) {
                        const [s, e] = t.split('-').map(Number);
                        if (num >= s && num <= e) {
                            win = true;
                            multiplier = 36 / ((e - s) + 1);
                        }
                    }

                    const betUser = await getUser(bet.userId, bet.firstName);

                    if (win) {
                        const winAmount = Math.floor(bet.amount * multiplier);
                        betUser.balance += winAmount;
                        betUser.tournamentProfit += winAmount;
                        await betUser.save();

                        let displayTarget = bet.target.toUpperCase();
                        if (['К', 'КРАСНОЕ'].includes(displayTarget)) displayTarget = 'RED';
                        if (['Ч', 'ЧЕРНОЕ'].includes(displayTarget)) displayTarget = 'BLACK';
                        if (['ЧЕТ', 'ЧЕТНОЕ', 'EVEN'].includes(displayTarget)) displayTarget = 'EVEN';
                        if (['НЕЧЕТ', 'НЕЧЕТНОЕ', 'ODD'].includes(displayTarget)) displayTarget = 'ODD';

                        report += `${bet.firstName} ставка ${bet.amount.toLocaleString('ru-RU')} Roze выиграл ${winAmount.toLocaleString('ru-RU')} на ${displayTarget}\n`;
                    } else {
                        await betUser.save();
                    }
                }

                currentBets = [];
                isSpinning = false;

                const actionButtons = {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: 'Повторить', callback_data: 'repeat_bet' },
                                { text: 'Удвоить', callback_data: 'double_bet' }
                            ]
                        ]
                    }
                };

                await bot.sendMessage(chatId, report.trim(), actionButtons);

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