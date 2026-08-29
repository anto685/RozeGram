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
    res.end('RozeGram Casino Engine v3.0 Ultra Fat - ONLINE 🎰');
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
const token = process.env.BOT_TOKEN || '8919281816:AAHpFyVQvzRwwfpX-6PDHGpg3walL0eLHB0';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://garbonretoy_db_user:SuperPass12345@cluster0.lk3ngtu.mongodb.net/RozegramDB?retryWrites=true&w=majority';

const CHANNEL_USERNAME = '@anloMorze2k26';
const CHANNEL_LINK = 'https://t.me/anloMorze2k26';
const BOT_START_TIME = Math.floor(Date.now() / 1000);
const ADMIN_ID = 8082980072; // Твой Telegram ID 👑

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
const systemSchema = new mongoose.Schema({ 
    lastResetDate: { type: String, default: '' },
    jackpot: { type: Number, default: 500000 }
});

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

const redNumbers = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '💰 Баланс' }, { text: '🎁 Бонус' }],
            [{ text: '🏆 Турнир' }, { text: '📖 Правила игры' }]
        ],
        resize_keyboard: true
    }
};

const TOURNAMENT_PRIZES = [1000000, 500000, 300000, 200000, 100000, 75000, 50000, 30000, 20000, 10000];

// Вспомогательные асинхронные функции
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

// Авто-сброс суточного турнира
async function checkTournamentReset() {
    try {
        const now = new Date();
        const currentDateStr = now.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
        const currentHour = now.toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });

        let sys = await getSystem();

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
// 5. ОБРАБОТКА CALLBACK QUERY
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
                return await bot.sendMessage(chatId, `⏳ Бонус уже забран! Приходи через <b>${h}ч ${m}м</b>`, { parse_mode: 'HTML', ...mainKeyboard });
            }

            user.balance += 10000;
            user.lastBonus = now;
            await user.save();

            try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
            await bot.answerCallbackQuery(query.id, { text: '🎉 +10 000 Roze 💰 зачислено!' });
            return await bot.sendMessage(chatId, `🎉 <b>Подписка подтверждена! Зачислено +10 000 Roze 💰!</b>\nТвой баланс: <b>${user.balance.toLocaleString('ru-RU')} Roze 💰</b>`, { parse_mode: 'HTML', ...mainKeyboard });
        }

        if (action === 'repeat_bet' || action === 'double_bet') {
            if (isSpinning) return await bot.answerCallbackQuery(query.id, { text: 'Игра идет!', show_alert: true });

            const userLastBets = lastRoundBets[userId];
            if (!userLastBets || userLastBets.length === 0) {
                return await bot.answerCallbackQuery(query.id, { text: 'Нет ставок с прошлого раунда!', show_alert: true });
            }

            let multiplier = (action === 'repeat_bet') ? 1 : 2;
            let totalCost = userLastBets.reduce((sum, b) => sum + (b.amount * multiplier), 0);

            // Атомарное списание средств напрямую из MongoDB
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
                currentBets.push({ userId, firstName, amount: newAmount, target: oldBet.target });
                addedText.push(`${newAmount.toLocaleString('ru-RU')} Roze на ${oldBet.target}`);
            }

            await bot.answerCallbackQuery(query.id, { text: 'Ставка принята' });
            await bot.sendMessage(chatId, `🎰 <b>${firstName}</b> ${action === 'repeat_bet' ? 'повторил' : 'удвоил'} (${totalCost.toLocaleString('ru-RU')} Roze): ${addedText.join(', ')}`, { parse_mode: 'HTML' });
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
                    `🎰 <b>Добро пожаловать в RozeGram Casino Ultra!</b>\n\nПривет, <b>${firstName}</b>!\nБаланс: <b>${user.balance.toLocaleString('ru-RU')} Roze 💰</b>\n\nИспользуй меню ниже для игры 👇`, 
                    { parse_mode: 'HTML', ...mainKeyboard }
                );
            }
            return;
        }

        // ==========================================
        // 👑 АДМИНКА: ВЫДАЧА БАБЛА (ТОЛЬКО ДЛЯ СОЗДАТЕЛЯ)
        // ==========================================
        const giveSelfMatch = text.match(/^(?:себе|админ)\s+(\d+)$/);
        if (giveSelfMatch && userId === ADMIN_ID) {
            const amount = parseInt(giveSelfMatch[1]);
            await User.findOneAndUpdate({ userId }, { $inc: { balance: amount } });
            return await bot.sendMessage(chatId, `👑 <b>Админ-выдача!</b> Начислено <b>+${amount.toLocaleString('ru-RU')} Roze 💰</b> на твой баланс!`, { parse_mode: 'HTML' });
        }

        const giveOtherMatch = text.match(/^(?:выдать|начислить)\s+(\d+)$/);
        if (giveOtherMatch && userId === ADMIN_ID) {
            if (!msg.reply_to_message || !msg.reply_to_message.from) {
                return await bot.sendMessage(chatId, `⚠️ <b>Админ</b>, ответь на сообщение того, кому хочешь выдать Roze!`, { parse_mode: 'HTML' });
            }

            const targetUserId = msg.reply_to_message.from.id;
            const targetFirstName = msg.reply_to_message.from.first_name || 'Игрок';
            const amount = parseInt(giveOtherMatch[1]);

            await User.findOneAndUpdate({ userId: targetUserId }, { $inc: { balance: amount } }, { upsert: true });
            return await bot.sendMessage(chatId, `👑 <b>Админ-выдача!</b> Игроку <b>${targetFirstName}</b> зачислено <b>+${amount.toLocaleString('ru-RU')} Roze 💰</b>!`, { parse_mode: 'HTML' });
        }

        // ==========================================
        // 💸 ПЕРЕДАЧА ROZE МЕЖДУ ИГРОКАМИ (ПЕРЕВОД)
        // ==========================================
        const payMatch = text.match(/^(?:\/pay|передать|перевод|отдать)\s+(\d+)$/);
        if (payMatch) {
            if (isPrivate) return await bot.sendMessage(chatId, `⚠️ Переводить Roze можно только в чате!`);

            if (!msg.reply_to_message || !msg.reply_to_message.from) {
                return await bot.sendMessage(chatId, `⚠️ <b>${firstName}</b>, ответь командой на сообщение того, кому хочешь передать Roze!`, { parse_mode: 'HTML' });
            }

            const targetUserId = msg.reply_to_message.from.id;
            const targetFirstName = msg.reply_to_message.from.first_name || 'Игрок';

            if (targetUserId === userId) {
                return await bot.sendMessage(chatId, `❌ <b>${firstName}</b>, нельзя переводить Roze самому себе! 😂`, { parse_mode: 'HTML' });
            }

            if (msg.reply_to_message.from.is_bot) {
                return await bot.sendMessage(chatId, `❌ <b>${firstName}</b>, ботам деньги не нужны! 🤖`, { parse_mode: 'HTML' });
            }

            const amount = parseInt(payMatch[1]);
            if (amount <= 0) return await bot.sendMessage(chatId, `❌ Сумма должна быть больше 0!`);

            // Атомарный перевод
            const sender = await User.findOneAndUpdate(
                { userId, balance: { $gte: amount } },
                { $inc: { balance: -amount } },
                { new: true }
            );

            if (!sender) {
                return await bot.sendMessage(chatId, `❌ Нехватка средств! Твой баланс: <b>${user.balance.toLocaleString('ru-RU')} Roze 💰</b>`, { parse_mode: 'HTML' });
            }

            await User.findOneAndUpdate({ userId: targetUserId }, { $inc: { balance: amount } }, { upsert: true });

            return await bot.sendMessage(
                chatId, 
                `💸 <b>Успешный перевод!</b>\n\n👤 <b>${firstName}</b> перевел <b>${amount.toLocaleString('ru-RU')} Roze 💰</b> для <b>${targetFirstName}</b>!\n\n💰 Твой остаток: <b>${sender.balance.toLocaleString('ru-RU')} Roze 💰</b>`, 
                { parse_mode: 'HTML' }
            );
        }

        // ==========================================
        // 🏆 ТУРНИР И ЛИДЕРБОРД
        // ==========================================
        if (text === '🏆 турнир' || text === 'турнир' || text === 'топ') {
            const topUsers = await User.find().sort({ tournamentProfit: -1 }).limit(10);
            const sys = await getSystem();

            let leaderboardText = `🏆 <b>Суточный Турнир RozeGram</b>\n🔴⚫️ <b>ROZE ROULETTE</b> 🔴⚫️\n\n` +
            `💥 <b>Текущий ДЖЕКПОТ БАНК:</b> ${sys.jackpot.toLocaleString('ru-RU')} Roze 💰\n\n` +
            `Турнир длится 1 день (обнуление в 00:00).\n` +
            `Участие автоматическое! Засчитывается <b>чистая прибыль</b>.\n\n` +
            `🎁 <b>Призы ТОП-3:</b>\n` +
            `🥇 1,000,000 Roze 💰\n🥈 500,000 Roze 💰\n🥉 300,000 Roze 💰\n\n` +
            `📊 <b>Текущий ТОП Лидеров:</b>\n`;

            if (topUsers.length === 0 || topUsers[0].tournamentProfit <= 0) {
                leaderboardText += `<i>Пока нет активных участников с плюсовым профитом.</i>`;
            } else {
                topUsers.forEach((u, idx) => {
                    if (u.tournamentProfit > 0) {
                        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
                        leaderboardText += `${medal} <b>${u.firstName}</b> ➔ +${u.tournamentProfit.toLocaleString('ru-RU')} Roze 💰\n`;
                    }
                });
            }

            return await bot.sendMessage(chatId, leaderboardText, { parse_mode: 'HTML', ...(isPrivate ? mainKeyboard : {}) });
        }

        // ==========================================
        // 🎁 БОНУСЫ, БАЛАНС И ПРАВИЛА
        // ==========================================
        if (text === 'бонус' || text === 'бонусы' || text === '🎁 бонус') {
            if (!isPrivate) return await bot.sendMessage(chatId, `🎁 <b>${firstName}</b>, забрать бонус можно только в ЛС бота!`, { parse_mode: 'HTML' });
            
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
                return await bot.sendMessage(chatId, `❌ <b>Для получения бонуса необходимо быть подписанным на наш канал!</b>`, { parse_mode: 'HTML', ...subMenu });
            }

            const now = Date.now();
            const cooldown = 12 * 60 * 60 * 1000;
            const lastBonus = user.lastBonus || 0;

            if (now - lastBonus < cooldown) {
                const timeLeft = cooldown - (now - lastBonus);
                const h = Math.floor(timeLeft / (1000 * 60 * 60));
                const m = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
                return await bot.sendMessage(chatId, `⏳ Бонус доступен через <b>${h}ч ${m}м</b>`, { parse_mode: 'HTML', ...mainKeyboard });
            }

            user.balance += 10000;
            user.lastBonus = now;
            await user.save();
            return await bot.sendMessage(chatId, `🎉 Зачислено <b>+10 000 Roze 💰</b>! Баланс: <b>${user.balance.toLocaleString('ru-RU')} Roze 💰</b>`, { parse_mode: 'HTML', ...mainKeyboard });
        }

        if (text === 'баланс' || text === 'бал' || text === '💰 баланс') {
            return await bot.sendMessage(chatId, `💰 <b>${firstName}</b>, твой баланс: <b>${user.balance.toLocaleString('ru-RU')} Roze 💰</b>`, { parse_mode: 'HTML', ...(isPrivate ? mainKeyboard : {}) });
        }

        if (text === 'история' || text === 'лог') {
            const histDoc = await getHistory();
            if (!histDoc.results || histDoc.results.length === 0) return await bot.sendMessage(chatId, '📜 История пуста');
            const historyText = histDoc.results.map((item, index) => `${index + 1}. ${item}`).join('\n');
            return await bot.sendMessage(chatId, `📜 <b>История последних спинов:</b>\n\n${historyText}`, { parse_mode: 'HTML' });
        }

        if (text === '📖 правила игры' || text === 'правила') {
            const rulesText = 
`🎰 <b>Правила RozeGram Ultra Casino</b>

Примеры ставок (Рулетка):
• <code>100 к</code> / <code>100 ч</code> — RED / BLACK (x2)
• <code>500 чет</code> / <code>500 нечет</code> — EVEN / ODD (x2)
• <code>300 0</code> — ZERO (БОНУС x50!) 🟢
• <code>300 12</code> — Число (x36)

🎲 Быстрый кубик (1-6) + ДЖЕКПОТ:
• <code>100 куб 6</code> — Ставка на число (x6)• <code>200 куб чет</code> / <code>200 куб нечет</code> (x2)

💸 Перевод баланса:
• <code>передать 500</code> (ответом на сообщение)

Старт рулетки: <b>го</b>`;
            return await bot.sendMessage(chatId, rulesText, { parse_mode: 'HTML', ...(isPrivate ? mainKeyboard : {}) });
        }

        // ==========================================
        // 7. ИГРА В КУБИК (КРИПТО-РАНДОМ + ДЖЕКПОТ)
        // ==========================================
        const diceMatch = text.match(/^(\d+)\s+куб\s+(1|2|3|4|5|6|чет|нечет)$/);
        if (diceMatch) {
            if (isPrivate) return await bot.sendMessage(chatId, `⚠️ <b>Играть нужно в чате!</b>`, { parse_mode: 'HTML' });

            const now = Date.now();
            if (now - (userBetCooldowns[userId] || 0) < 2500) {
                return await bot.sendMessage(chatId, `⚠️ <b>${firstName}</b>, не спам! Подожди 2.5 сек.`, { parse_mode: 'HTML' });
            }
            userBetCooldowns[userId] = now;

            const betAmount = parseInt(diceMatch[1]);
            const target = diceMatch[2];

            // Атомарное списание ставки
            const updatedUser = await User.findOneAndUpdate(
                { userId, balance: { $gte: betAmount } },
                { $inc: { balance: -betAmount } },
                { new: true }
            );

            if (!updatedUser) {
                return await bot.sendMessage(chatId, `❌ Нехватка средств! Баланс: <b>${user.balance.toLocaleString('ru-RU')} Roze 💰</b>`, { parse_mode: 'HTML' });
            }

            // Наполнение джекпота на 5% от ставки
            const sys = await getSystem();
            const jackpotAdd = Math.floor(betAmount * 0.05);
            sys.jackpot += jackpotAdd;

            // Честный криптографический рандом (1-6)
            const roll = crypto.randomInt(1, 7);
            let win = false;
            let multiplier = 0;

            if (target === 'чет' && roll % 2 === 0) { win = true; multiplier = 2; }
            else if (target === 'нечет' && roll % 2 !== 0) { win = true; multiplier = 2; }
            else if (parseInt(target) === roll) { win = true; multiplier = 6; }

            let report = `🎲 <b>${firstName}</b> бросил кубик! Выпало: <b>[ ${roll} ]</b>\n`;

            if (win) {
                let winAmount = betAmount * multiplier;
                
                // 5% шанс сорвать Джекпот, если выпала 6
                if (roll === 6 && crypto.randomInt(1, 101) <= 5) {
                    const jackpotWin = sys.jackpot;
                    winAmount += jackpotWin;
                    sys.jackpot = 100000; // Сброс банка
                    report += `💥 <b>СОРВАН ДЖЕКПОТ! +${jackpotWin.toLocaleString('ru-RU')} Roze 💰!!</b>\n`;
                }

                await User.findOneAndUpdate(
                    { userId }, 
                    { $inc: { balance: winAmount, tournamentProfit: winAmount } }
                );

                report += `✅ Победа! Выигрыш: <b>+${winAmount.toLocaleString('ru-RU')} Roze 💰</b>`;
            } else {
                report += `❌ Проигрыш! Вы потеряли ${betAmount.toLocaleString('ru-RU')} Roze.`;
            }

            await sys.save();
            return await bot.sendMessage(chatId, report, { parse_mode: 'HTML' });
        }

        // ==========================================
        // 8. ПРИЕМ СТАВОК В РУЛЕТКУ
        // ==========================================
        const rouletteMatch = text.match(/^(\d+)\s+(к|ч|красное|черное|red|black|чет|нечет|четное|нечетное|even|odd|\d{1,2})$/);
        if (rouletteMatch && !isSpinning) {
            if (isPrivate) return await bot.sendMessage(chatId, `⚠️ <b>Играть нужно в чате!</b>`, { parse_mode: 'HTML' });

            const betAmount = parseInt(rouletteMatch[1]);
            const target = rouletteMatch[2];

            if (target.match(/^\d+$/) && (parseInt(target) < 0 || parseInt(target) > 36)) {
                return await bot.sendMessage(chatId, `❌ Число должно быть от 0 до 36!`);
            }

            const updatedUser = await User.findOneAndUpdate({ userId, balance: { $gte: betAmount } },
                { $inc: { balance: -betAmount, tournamentProfit: -betAmount } },
                { new: true }
            );

            if (!updatedUser) {
                return await bot.sendMessage(chatId, `❌ Нехватка средств! Баланс: <b>${user.balance.toLocaleString('ru-RU')} Roze 💰</b>`, { parse_mode: 'HTML' });
            }

            currentBets.push({ userId, firstName, amount: betAmount, target });
            return await bot.sendMessage(chatId, `✅ <b>${firstName}</b> поставил <b>${betAmount.toLocaleString('ru-RU')} Roze</b> на [<b>${target.toUpperCase()}</b>]`, { parse_mode: 'HTML' });
        }

        // ==========================================
        // 9. ЗАПУСК РУЛЕТКИ (С КРИПТО-РАНДОМОМ)
        // ==========================================
        if (text === 'го' || text === 'go' || text === 'старт' || text === 'крутить') {
            if (isPrivate || isSpinning) return;
            if (currentBets.length === 0) return await bot.sendMessage(chatId, '⚠️ Сначала сделайте ставку!');

            isSpinning = true;
            await bot.sendMessage(chatId, '🎲 <b>Рулетка крутится... Удачи!</b>', { parse_mode: 'HTML' });

            try { await bot.sendDice(chatId, { emoji: '🎰' }); } catch (e) {}
            await sleep(3800);

            try {
                // Честный криптографический запуск рулетки (0-36)
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

                    let win = false;
                    let multiplier = 0;
                    const t = bet.target.toLowerCase();

                    if ((t === 'к' || t === 'красное' || t === 'red') && isRed) { win = true; multiplier = 2; }
                    else if ((t === 'ч' || t === 'черное' || t === 'black') && isBlack) { win = true; multiplier = 2; }
                    else if ((t === 'чет' || t === 'четное' || t === 'even') && isEven) { win = true; multiplier = 2; }
                    else if ((t === 'нечет' || t === 'нечетное' || t === 'odd') && isOdd) { win = true; multiplier = 2; }
                    else if (!isNaN(t) && parseInt(t) === num) { 
                        win = true; 
                        multiplier = (num === 0) ? 50 : 36; // Жирный бонус х50 на ЗЕРО!
                    }

                    if (win) {
                        const winAmount = Math.floor(bet.amount * multiplier);
                        await User.findOneAndUpdate(
                            { userId: bet.userId },
                            { $inc: { balance: winAmount, tournamentProfit: winAmount } }
                        );
                        report += `✅ <b>${bet.firstName}</b> выбил <b>+${winAmount.toLocaleString('ru-RU')} Roze</b> на [${bet.target.toUpperCase()}]\n`;
                    } else {
                        report += `❌ <b>${bet.firstName}</b> проиграл ${bet.amount.toLocaleString('ru-RU')} Roze [${bet.target.toUpperCase()}]\n`;
                    }
                }

                currentBets = [];
                isSpinning = false;

                const actionButtons = {
                    reply_markup: {
                        inline_keyboard: [[
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