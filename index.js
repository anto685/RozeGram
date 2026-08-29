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
    res.end('RozeGram Casino Engine v4.0 Ultimate - ONLINE 🎰');
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
const ADMIN_ID = 6947353037; // Твой Telegram ID 👑

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
const systemSchema = new mongoose.Schema({ 
    lastResetDate: { type: String, default: '' },
    jackpot: { type: Number, default: 500000 }
});

const User = mongoose.model('User', userSchema);
const History = mongoose.model('History', historySchema);
const System = mongoose.model('System', systemSchema);

// ==========================================
// 4. ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ
// ==========================================
let currentBets = [];
let lastRoundBets = {};
let userBetCooldowns = {};
let userGoCooldowns = {}; // Кулдаун на команду "ГО"
let isSpinning = false;

const bot = new TelegramBot(token, { polling: true });

bot.on('polling_error', (err) => {
    if (!err.message.includes('409 Conflict') && !err.message.includes('401')) {
        console.error(`[POLLING ERROR] ${err.code}: ${err.message}`);
    }
});

const redNumbers = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Генератор красивого ТЕГА пользователя
function getUserTag(user) {
    if (user.username) {
        return `@${user.username}`;
    }
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

const TOURNAMENT_PRIZES = [1000000, 500000, 300000, 200000, 100000, 75000, 50000, 30000, 20000, 10000];

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
        console.error('[GET USER ERROR]', e.message);
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

async function getSystem() {
    try {
        let sys = await System.findOne();
        if (!sys) sys = await System.create({ lastResetDate: '', jackpot: 500000 });
        return sys;
    } catch (e) {
        return { lastResetDate: '', jackpot: 500000, save: async () => {} };
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

        // --- КНОПКА ОТМЕНЫ СТАВКИ ---
        if (action.startsWith('cancel_bet_')) {
            if (isSpinning) {
                return await bot.answerCallbackQuery(query.id, { text: '❌ Рулетка уже крутится!', show_alert: true });
            }

            const betIndex = parseInt(action.split('_')[2]);
            const bet = currentBets[betIndex];

            if (!bet || bet.userId !== userId) {
                return await bot.answerCallbackQuery(query.id, { text: '❌ Это не твоя ставка или она уже снята!', show_alert: true });
            }

            // Возврат баланса
            await User.findOneAndUpdate(
                { userId },
                { $inc: { balance: bet.amount, tournamentProfit: bet.amount } }
            );

            currentBets.splice(betIndex, 1);

            await bot.answerCallbackQuery(query.id, { text: '✅ Ставка отменена!' });
            try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
            return await bot.sendMessage(chatId, `🚫 ${userTag}, твоя ставка в <b>${bet.amount.toLocaleString('ru-RU')} Roze</b> на [${bet.target.toUpperCase()}] отменена!`, { parse_mode: 'HTML' });
        }

        // --- ПРОВЕРКА ПОДПИСКИ И БОНУС ---
        if (action === 'check_sub_and_bonus') {
            const isSubbed = await checkSubscription(userId);
            if (!isSubbed) {
                return await bot.answerCallbackQuery(query.id, { text: '❌ Ты еще не подписался на канал!', show_alert: true });
            }

            const user = await getUser(userId, firstName, username);
            const now = Date.now();
            const cooldown = 12 * 60 * 60 * 1000;
            const lastBonus = user.lastBonus || 0;

            if (now - lastBonus < cooldown) {
                const timeLeft = cooldown - (now - lastBonus);
                const h = Math.floor(timeLeft / (1000 * 60 * 60));
                const m = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
                try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
                await bot.answerCallbackQuery(query.id, { text: 'Подписка подтверждена!' });
                return await bot.sendMessage(chatId, `⏳ ${userTag}, бонус уже забран! Приходи через <b>${h}ч ${m}м</b>`, { parse_mode: 'HTML', ...mainKeyboard });
            }

            user.balance += 10000;
            user.lastBonus = now;
            await user.save();

            try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
            await bot.answerCallbackQuery(query.id, { text: '🎉 +10 000 Roze 💰 зачислено!' });
            return await bot.sendMessage(chatId, `🎉 ${userTag}, <b>подписка подтверждена! Зачислено +10 000 Roze 💰!</b>\nТвой баланс: <b>${user.balance.toLocaleString('ru-RU')} Roze 💰</b>`, { parse_mode: 'HTML', ...mainKeyboard });
        }

        // --- ПОВТОР / УДВОЕНИЕ ---
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
                currentBets.push({ userId, firstName, username, amount: newAmount, target: oldBet.target });
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
                return await bot.sendMessage(
                    chatId, 
                    `🎰 <b>Добро пожаловать в RozeGram Casino!</b>\n\nПривет, ${userTag}!\nБаланс: <b>${user.balance.toLocaleString('ru-RU')} Roze 💰</b>\n\nИспользуй меню ниже 👇`, 
                    { parse_mode: 'HTML', ...mainKeyboard }
                );
            }
            return;
        }

        // ==========================================
        // 💰 КОМАНДА БАЛАНСА ("б", "бал", "баланс")
        // ==========================================
        if (text === 'б' || text === 'бал' || text === 'баланс' || text === '💰 б' || text === '💰 баланс') {
            return await bot.sendMessage(chatId, `💰 ${userTag}, твой баланс: <b>${user.balance.toLocaleString('ru-RU')} Roze 💰</b>`, { parse_mode: 'HTML', ...(isPrivate ? mainKeyboard : {}) });
        }

        // ==========================================
        // 🎮 МЕНЮ ИГР ("игры", "куб")
        // ==========================================
        if (text === 'игры' || text === 'куб' || text === '🎮 игры' || text === 'меню') {
            const gamesMenuText = 
`🎰 <b>Игровое Меню RozeGram Casino</b>

🎯 <b>Доступные режимчики:</b>

🎲 <b>Кубик (1-6):</b>
• <code>100 куб 6</code> — Выиграй x6!
• <code>200 куб чет</code> / <code>200 куб нечет</code> — (x2)

⚽️ <b>Футбол:</b>
• <code>100 фут</code> — (Гол = x2, Штанга/Перелет = 0)

🏀 <b>Баскетбол:</b>
• <code>100 баскет</code> — (Трёхочковый = x3, Отскок/Застрял/Почти = 0)

🔴⚫️ <b>Рулетка:</b>
• <code>100 к</code> / <code>100 ч</code> (x2)
• <code>100 0</code> — ZERO (x50 🟢)
• <code>100 12</code> — Число (x36)`;

            return await bot.sendMessage(chatId, gamesMenuText, { parse_mode: 'HTML', ...(isPrivate ? mainKeyboard : {}) });
        }

        // ==========================================
        // 🛑 ОТМЕНА СТАВОК ТЕКСТОМ
        // ==========================================
        if (text === 'отмена' || text === 'отменить' || text === 'стоп') {
            if (isSpinning) return await bot.sendMessage(chatId, `❌ Рулетка уже крутится!`);

            const userBets = currentBets.filter(b => b.userId === userId);
            if (userBets.length === 0) {
                return await bot.sendMessage(chatId, `⚠️ ${userTag}, у тебя нет активных ставок для отмены!`, { parse_mode: 'HTML' });
            }

            const totalRefund = userBets.reduce((sum, b) => sum + b.amount, 0);

            await User.findOneAndUpdate(
                { userId },
                { $inc: { balance: totalRefund, tournamentProfit: totalRefund } }
            );

            currentBets = currentBets.filter(b => b.userId !== userId);

            return await bot.sendMessage(
                chatId, 
                `✅ ${userTag}, твои ставки отменены! Возвращено: <b>+${totalRefund.toLocaleString('ru-RU')} Roze 💰</b>`, 
                { parse_mode: 'HTML' }
            );
        }

        // ==========================================
        // 👑 АДМИНКА
        // ==========================================
        const giveSelfMatch = text.match(/^(?:себе|админ)\s+(\d+)$/);
        if (giveSelfMatch && userId === ADMIN_ID) {
            const amount = parseInt(giveSelfMatch[1]);
            await User.findOneAndUpdate({ userId }, { $inc: { balance: amount } });
            return await bot.sendMessage(chatId, `👑 <b>Админ-выдача!</b> Начислено <b>+${amount.toLocaleString('ru-RU')} Roze 💰</b>!`, { parse_mode: 'HTML' });
        }

        // ==========================================
        // 💸 ПЕРЕДАЧА СРЕДСТВ
        // ==========================================
        const payMatch = text.match(/^(?:\/pay|передать|перевод|отдать)\s+(\d+)$/);
        if (payMatch) {
            if (isPrivate) return await bot.sendMessage(chatId, `⚠️ Переводить Roze можно только в чате!`);
            if (!msg.reply_to_message || !msg.reply_to_message.from) {
                return await bot.sendMessage(chatId, `⚠️ ${userTag}, ответь командой на сообщение того, кому хочешь передать Roze!`, { parse_mode: 'HTML' });
            }

            const targetUserId = msg.reply_to_message.from.id;
            const targetFirstName = msg.reply_to_message.from.first_name || 'Игрок';
            const targetUsername = msg.reply_to_message.from.username || '';
            const targetTag = getUserTag({ userId: targetUserId, firstName: targetFirstName, username: targetUsername });

            if (targetUserId === userId) return await bot.sendMessage(chatId, `❌ ${userTag}, нельзя переводить самому себе! 😂`, { parse_mode: 'HTML' });
            if (msg.reply_to_message.from.is_bot) return await bot.sendMessage(chatId, `❌ ${userTag}, ботам деньги не нужны! 🤖`, { parse_mode: 'HTML' });

            const amount = parseInt(payMatch[1]);
            if (amount <= 0) return await bot.sendMessage(chatId, `❌ Сумма должна быть больше 0!`);

            const sender = await User.findOneAndUpdate(
                { userId, balance: { $gte: amount } },
                { $inc: { balance: -amount } },
                { new: true }
            );

            if (!sender) return await bot.sendMessage(chatId, `❌ Нехватка средств! Твой баланс: <b>${user.balance.toLocaleString('ru-RU')} Roze 💰</b>`, { parse_mode: 'HTML' });

            await User.findOneAndUpdate({ userId: targetUserId }, { $inc: { balance: amount } }, { upsert: true });

            return await bot.sendMessage(chatId, `💸 <b>Успешный перевод!</b>\n\n👤 ${userTag} перевел <b>${amount.toLocaleString('ru-RU')} Roze 💰</b> для ${targetTag}!`, { parse_mode: 'HTML' });
        }

        // ==========================================
        // ⚽️ ФУТБОЛ
        // ==========================================
        const footMatch = text.match(/^(\d+)\s+(фут|футбол)$/);
        if (footMatch) {
            if (isPrivate) return await bot.sendMessage(chatId, `⚠️ Играть нужно в чате!`);
            const betAmount = parseInt(footMatch[1]);

            const updatedUser = await User.findOneAndUpdate(
                { userId, balance: { $gte: betAmount } },
                { $inc: { balance: -betAmount } },
                { new: true }
            );

            if (!updatedUser) return await bot.sendMessage(chatId, `❌ Нехватка средств! Баланс: <b>${user.balance.toLocaleString('ru-RU')} Roze 💰</b>`, { parse_mode: 'HTML' });

            const outcomes = [
                { name: '⚽️ ГООООЛ!', win: true, mult: 2 },
                { name: '🥅 ШТАНГА!', win: false, mult: 0 },
                { name: '🚀 ПЕРЕЛЕТ!', win: false, mult: 0 }
            ];

            const result = outcomes[crypto.randomInt(0, outcomes.length)];
            let report = `⚽️ ${userTag} бьёт по воротам...\nРезультат: <b>${result.name}</b>\n`;

            if (result.win) {
                const winAmount = betAmount * result.mult;
                await User.findOneAndUpdate({ userId }, { $inc: { balance: winAmount, tournamentProfit: winAmount } });
                report += `🎉 Красава! Выигрыш: <b>+${winAmount.toLocaleString('ru-RU')} Roze 💰</b>`;
            } else {
                report += `❌ Не повезло! Потеряно ${betAmount.toLocaleString('ru-RU')} Roze.`;
            }

            return await bot.sendMessage(chatId, report, { parse_mode: 'HTML' });
        }

        // ==========================================
        // 🏀 БАСКЕТБОЛ
        // ==========================================
        const basketMatch = text.match(/^(\d+)\s+(баскет|баскетбол)$/);
        if (basketMatch) {
            if (isPrivate) return await bot.sendMessage(chatId, `⚠️ Играть нужно в чате!`);
            const betAmount = parseInt(basketMatch[1]);

            const updatedUser = awaitUser.findOneAndUpdate(
                { userId, balance: { $gte: betAmount } },
                { $inc: { balance: -betAmount } },
                { new: true }
            );

            if (!updatedUser) return await bot.sendMessage(chatId, `❌ Нехватка средств! Баланс: <b>${user.balance.toLocaleString('ru-RU')} Roze 💰</b>`, { parse_mode: 'HTML' });

            const outcomes = [
                { name: '🏀 ТРЁХОЧКОВЫЙ!', win: true, mult: 3 },
                { name: '↪️ ОТСКОК ОТ КОЛЬЦА!', win: false, mult: 0 },
                { name: '❌ ЗАСТРЯЛ В СЕТКЕ!', win: false, mult: 0 },
                { name: '🎯 ПОЧТИ ПОПАЛ!', win: false, mult: 0 }
            ];

            const result = outcomes[crypto.randomInt(0, outcomes.length)];
            let report = `🏀 ${userTag} делает бросок в кольцо...\nРезультат: <b>${result.name}</b>\n`;

            if (result.win) {
                const winAmount = betAmount * result.mult;
                await User.findOneAndUpdate({ userId }, { $inc: { balance: winAmount, tournamentProfit: winAmount } });
                report += `🔥 Точно в цель! Выигрыш: <b>+${winAmount.toLocaleString('ru-RU')} Roze 💰</b>`;
            } else {
                report += `❌ Мимо! Потеряно ${betAmount.toLocaleString('ru-RU')} Roze.`;
            }

            return await bot.sendMessage(chatId, report, { parse_mode: 'HTML' });
        }

        // ==========================================
        // 🎲 КУБИК
        // ==========================================
        const diceMatch = text.match(/^(\d+)\s+куб\s+(1|2|3|4|5|6|чет|нечет)$/);
        if (diceMatch) {
            if (isPrivate) return await bot.sendMessage(chatId, `⚠️ Играть нужно в чате!`);
            const betAmount = parseInt(diceMatch[1]);
            const target = diceMatch[2];

            const updatedUser = await User.findOneAndUpdate(
                { userId, balance: { $gte: betAmount } },
                { $inc: { balance: -betAmount } },
                { new: true }
            );

            if (!updatedUser) return await bot.sendMessage(chatId, `❌ Нехватка средств! Баланс: <b>${user.balance.toLocaleString('ru-RU')} Roze 💰</b>`, { parse_mode: 'HTML' });

            const roll = crypto.randomInt(1, 7);
            let win = false;
            let multiplier = 0;

            if (target === 'чет' && roll % 2 === 0) { win = true; multiplier = 2; }
            else if (target === 'нечет' && roll % 2 !== 0) { win = true; multiplier = 2; }
            else if (parseInt(target) === roll) { win = true; multiplier = 6; }

            let report = `🎲 ${userTag} бросил кубик! Выпало: <b>[ ${roll} ]</b>\n`;

            if (win) {
                const winAmount = betAmount * multiplier;
                await User.findOneAndUpdate({ userId }, { $inc: { balance: winAmount, tournamentProfit: winAmount } });
                report += `✅ Победа! Выигрыш: <b>+${winAmount.toLocaleString('ru-RU')} Roze 💰</b>`;
            } else {
                report += `❌ Проигрыш! Потеряно ${betAmount.toLocaleString('ru-RU')} Roze.`;
            }

            return await bot.sendMessage(chatId, report, { parse_mode: 'HTML' });
        }

        // ==========================================
        // 🎰 СТАВКИ НА РУЛЕТКУ
        // ==========================================
        const rouletteMatch = text.match(/^(\d+)\s+(к|ч|красное|черное|red|black|чет|нечет|четное|нечетное|even|odd|\d{1,2})$/);
        if (rouletteMatch && !isSpinning) {
            if (isPrivate) return await bot.sendMessage(chatId, `⚠️ Играть нужно в чате!`);

            const betAmount = parseInt(rouletteMatch[1]);
            const target = rouletteMatch[2];

            if (target.match(/^\d+$/) && (parseInt(target) < 0 || parseInt(target) > 36)) {
                return await bot.sendMessage(chatId, `❌ Число должно быть от 0 до 36!`);
            }

            const updatedUser = await User.findOneAndUpdate(
                { userId, balance: { $gte: betAmount } },
                { $inc: { balance: -betAmount, tournamentProfit: -betAmount } },{ new: true }
            );

            if (!updatedUser) return await bot.sendMessage(chatId, `❌ Нехватка средств! Баланс: <b>${user.balance.toLocaleString('ru-RU')} Roze 💰</b>`, { parse_mode: 'HTML' });

            currentBets.push({ userId, firstName, username, amount: betAmount, target });

            const cancelKeyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '❌ Отменить ставку', callback_data: `cancel_bet_${currentBets.length - 1}` }]
                    ]
                }
            };

            return await bot.sendMessage(chatId, `✅ ${userTag} поставил <b>${betAmount.toLocaleString('ru-RU')} Roze</b> на [<b>${target.toUpperCase()}</b>]`, { parse_mode: 'HTML', ...cancelKeyboard });
        }

        // ==========================================
        // 🚀 КРУТИТЬ РУЛЕТКУ ("ГО") С ТАЙМЕРОМ КУЛДАУНА
        // ==========================================
        if (text === 'го' || text === 'go' || text === 'старт' || text === 'крутить') {
            if (isPrivate || isSpinning) return;
            if (currentBets.length === 0) return await bot.sendMessage(chatId, `⚠️ ${userTag}, сначала сделайте ставку!`, { parse_mode: 'HTML' });

            const now = Date.now();
            const lastGo = userGoCooldowns[userId] || 0;
            const cooldownTime = 10000; // 10 секунд кулдаун

            if (now - lastGo < cooldownTime) {
                const secondsLeft = Math.ceil((cooldownTime - (now - lastGo)) / 1000);
                return await bot.sendMessage(chatId, `⏳ ${userTag}, подожди еще <b>${secondsLeft} сек.</b> перед го!`, { parse_mode: 'HTML' });
            }

            userGoCooldowns[userId] = now;
            isSpinning = true;

            await bot.sendMessage(chatId, `🎲 ${userTag} запустил рулетку! Крутим...`, { parse_mode: 'HTML' });

            try { await bot.sendDice(chatId, { emoji: '🎰' }); } catch (e) {}
            await sleep(3800);

            try {
                const num = crypto.randomInt(0, 37);
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
                let report = `🎰 <b>Результат Рулетки:</b> [ <b>${num} ${colorEmoji}</b> ]\n\n`;

                for (const bet of currentBets) {
                    if (!lastRoundBets[bet.userId]) lastRoundBets[bet.userId] = [];
                    lastRoundBets[bet.userId].push(bet);

                    const betUserTag = getUserTag({ userId: bet.userId, firstName: bet.firstName, username: bet.username });
                    let win = false;
                    let multiplier = 0;
                    const t = bet.target.toLowerCase();

                    if ((t === 'к' || t === 'красное' || t === 'red') && isRed) { win = true; multiplier = 2; }
                    else if ((t === 'ч' || t === 'черное' || t === 'black') && isBlack) { win = true; multiplier = 2; }
                    else if ((t === 'чет' || t === 'четное' || t === 'even') && isEven) { win = true; multiplier = 2; }
                    else if ((t === 'нечет' || t === 'нечетное' || t === 'odd') && isOdd) { win = true; multiplier = 2; }
                    else if (!isNaN(t) && parseInt(t) === num) { 
                        win = true; 
                        multiplier = (num === 0) ? 50 : 36;
                    }

                    if (win) {
                        const winAmount = Math.floor(bet.amount * multiplier);
                        await User.findOneAndUpdate(
                            { userId: bet.userId },{ $inc: { balance: winAmount, tournamentProfit: winAmount } }
                        );
                        report += `✅ ${betUserTag} выбил <b>+${winAmount.toLocaleString('ru-RU')} Roze</b> на [${bet.target.toUpperCase()}]\n`;
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