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
    res.end('RozeGram Casino Engine v3.0 Ultimate - ONLINE 🎰');
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
const ADMIN_ID = 6947353037; // Твой обновленный ID 👑

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
// 4. ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ
// ==========================================
let currentBets = [];
let lastRoundBets = {};
let userBetCooldowns = {};
let isSpinning = false;
let spinSafetyTimer = null;
let activeMinesGames = {}; // Состояния игры в "Мины"

const bot = new TelegramBot(token, { polling: true });

bot.on('polling_error', (err) => {
    if (!err.message.includes('409 Conflict')) {
        console.error(`[POLLING ERROR] ${err.code}: ${err.message}`);
    }
});

const redNumbers = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Функция для красивого синего тега по имени
function mentionUser(userId, name) {
    const safeName = name.replace(/[*_`\[\]()]/g, '');
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

const TOURNAMENT_PRIZES = [1000000, 500000, 300000, 200000, 100000, 75000, 50000, 30000, 20000, 10000];

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

// 🛡 ЛЮТАЯ ЗАЩИТА: Автовозврат денег при лаге/зависании бота
async function emergencyRefund(chatId, reason = 'Ошибка сервера') {
    if (currentBets.length === 0) {
        isSpinning = false;
        return;
    }
    console.log(`[SAFETY SYSTEM] Запущен автовозврат ставок. Причина: ${reason}`);
    for (const bet of currentBets) {
        try {
            const betUser = await getUser(bet.userId, bet.firstName);
            betUser.balance += bet.amount;
            betUser.tournamentProfit += bet.amount;
            await betUser.save();
        } catch (e) {
            console.error('[REFUND ERROR]', e.message);
        }
    }
    currentBets = [];
    isSpinning = false;
    if (spinSafetyTimer) clearTimeout(spinSafetyTimer);
    try {
        await bot.sendMessage(chatId, `🚨 **[Система Защиты]** Произошел сбой или таймаут (${reason}). Все ставки успешно возвращены игрокам!`, { parse_mode: 'Markdown' });
    } catch (e) {}
}

// ==========================================
// 5. МИНЫ (ГЕНЕРАЦИЯ КНОПОК)
// ==========================================
function generateMinesKeyboard(game) {
    let inline_keyboard = [];
    for (let r = 0; r < 3; r++) {
        let row = [];
        for (let c = 0; c < 3; c++) {
            const idx = r * 3 + c;
            let btnText = '❓';
            if (game.revealed[idx]) {
                btnText = game.board[idx] === 'MINE' ? '💥' : '💎';
            }
            row.push({ text: btnText, callback_data: `mine_click_${idx}` });
        }
        row.push();
        inline_keyboard.push(row);
    }
    if (!game.gameOver) {
        inline_keyboard.push([{ text: `💰 Забрать (${Math.floor(game.bet * game.multiplier)} Roze)`, callback_data: 'mine_take' }]);
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

        // --- БОНУС ---
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

        // --- ПОВТОР / УДВОЕНИЕ ---
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
                return await bot.answerCallbackQuery(query.id, { text: `Нужно ${totalCost.toLocaleString('ru-RU')} Roze`, show_alert: true });
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
            await bot.sendMessage(chatId, `🎰 ${mentionUser(userId, firstName)} ${action === 'repeat_bet' ? 'повторил' : 'удвоил'} (${totalCost.toLocaleString('ru-RU')} Roze): ${addedText.join(', ')}`, { parse_mode: 'Markdown' });
        }

        // --- ИГРА В МИНЫ (КНОПКИ) ---
        if (action.startsWith('mine_click_') || action === 'mine_take') {
            const gameKey = `${chatId}_${userId}`;
            const game = activeMinesGames[gameKey];

            if (!game || game.gameOver) {
                return await bot.answerCallbackQuery(query.id, { text: 'Сессия игры не найдена или завершена!', show_alert: true });
            }

            if (action === 'mine_take') {
                const winAmount = Math.floor(game.bet * game.multiplier);
                const user = await getUser(userId, firstName);
                user.balance += winAmount;
                user.tournamentProfit += winAmount;
                await user.save();

                game.gameOver = true;
                delete activeMinesGames[gameKey];

                await bot.answerCallbackQuery(query.id, { text: `Забрал +${winAmount} Roze!` });
                return await bot.editMessageText(`💣 **Мины | Выигрыш!**\n\n${mentionUser(userId, firstName)} забрал **+${winAmount.toLocaleString('ru-RU')} Roze 💰** (Множитель: x${game.multiplier.toFixed(2)})`, { chatId, message_id: messageId, parse_mode: 'Markdown' });
            }

            const idx = parseInt(action.replace('mine_click_', ''));
            if (game.revealed[idx]) {
                return await bot.answerCallbackQuery(query.id, { text: 'Уже открыто!' });
            }

            game.revealed[idx] = true;if (game.board[idx] === 'MINE') {
                game.gameOver = true;
                delete activeMinesGames[gameKey];
                await bot.answerCallbackQuery(query.id, { text: '💥 БУМ! Подорвался!' });
                return await bot.editMessageText(`💥 **Мины | Взрыв!**\n\n${mentionUser(userId, firstName)} наступил на мину и потерял **${game.bet.toLocaleString('ru-RU')} Roze**!`, { chatId, message_id: messageId, ...generateMinesKeyboard(game), parse_mode: 'Markdown' });
            } else {
                game.gemsFound++;
                game.multiplier += 0.45;
                if (game.gemsFound === 7) { 
                    const winAmount = Math.floor(game.bet * game.multiplier);
                    const user = await getUser(userId, firstName);
                    user.balance += winAmount;
                    user.tournamentProfit += winAmount;
                    await user.save();
                    game.gameOver = true;
                    delete activeMinesGames[gameKey];
                    await bot.answerCallbackQuery(query.id, { text: '🏆 Очистил поле!' });
                    return await bot.editMessageText(`🏆 **Мины | Идеально!**\n\n${mentionUser(userId, firstName)} нашел все кристаллы и выиграл **${winAmount.toLocaleString('ru-RU')} Roze!**`, { chatId, message_id: messageId, parse_mode: 'Markdown' });
                }

                await bot.answerCallbackQuery(query.id, { text: '💎 Алмаз!' });
                await bot.editMessageText(`💣 **Мины** (Ставка: ${game.bet} Roze)\nИгрок: ${mentionUser(userId, firstName)}\nТекущий X: **x${game.multiplier.toFixed(2)}**`, { chatId, message_id: messageId, ...generateMinesKeyboard(game), parse_mode: 'Markdown' });
            }
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
                    `🎰 **Добро пожаловать в RozeGram Casino!**\n\nПривет, ${mentionUser(userId, firstName)}!\nБаланс: **${user.balance.toLocaleString('ru-RU')} Roze 💰**\n\nИспользуй меню ниже 👇`, 
                    { parse_mode: 'Markdown', ...mainKeyboard }
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

        const giveOtherMatch = text.match(/^(?:выдать|начислить)\s+(\d+)$/);
        if (giveOtherMatch && userId === ADMIN_ID) {
            if (!msg.reply_to_message || !msg.reply_to_message.from) {
                return await bot.sendMessage(chatId, `⚠️ **Админ**, ответь на сообщение!`, { parse_mode: 'Markdown' });
            }

            const targetUserId = msg.reply_to_message.from.id;
            const targetFirstName = msg.reply_to_message.from.first_name || 'Игрок';
            const amount = parseInt(giveOtherMatch[1]);

            const recipient = await getUser(targetUserId, targetFirstName);
            recipient.balance += amount;
            await recipient.save();

            return await bot.sendMessage(chatId, `👑 **Админ-выдача!** Игроку ${mentionUser(targetUserId, targetFirstName)} зачислено **+${amount.toLocaleString('ru-RU')} Roze 💰**!`, { parse_mode: 'Markdown' });
        }

        // --- БАЛАНС (БУКВА "б", "бал", "баланс") ---
        if (text === 'б' || text === 'баланс' || text === 'бал' || text === '💰 баланс') {
            if (isPrivate) {
                return await bot.sendMessage(chatId, `💰 Баланс: **${user.balance.toLocaleString('ru-RU')} Roze 💰**`, { parse_mode: 'Markdown', ...mainKeyboard });
            } else {
                return await bot.sendMessage(chatId, `💰 ${mentionUser(userId, firstName)}, твой баланс: **${user.balance.toLocaleString('ru-RU')} Roze 💰**`, { parse_mode: 'Markdown' });
            }
        }

        // --- ОТМЕНА СТАВКИ ---
        if (text === 'отмена' || text === 'отменить') {
            if (isSpinning) return await bot.sendMessage(chatId, `❌ **${mentionUser(userId, firstName)}**, рулетка уже крутится, отменить нельзя!`, { parse_mode: 'Markdown' });

            const userBets = currentBets.filter(b => b.userId === userId);
            if (userBets.length === 0) {
                return await bot.sendMessage(chatId, `⚠️ ${mentionUser(userId, firstName)}, у тебя нет активных ставок для отмены!`, { parse_mode: 'Markdown' });
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

            if (targetUserId === userId) return await bot.sendMessage(chatId, `❌ Сам себе не переведешь!`, { parse_mode: 'Markdown' });
            if (msg.reply_to_message.from.is_bot) return await bot.sendMessage(chatId, `❌ Ботам деньги не нужны!`, { parse_mode: 'Markdown' });

            const amount = parseInt(payMatch[1]);
            if (amount <= 0) return await bot.sendMessage(chatId, '❌ Сумма должна быть больше 0!');

            if (user.balance < amount) {
                return await bot.sendMessage(chatId, `❌ Нехватка средств! Баланс: **${user.balance.toLocaleString('ru-RU')} Roze 💰**`, { parse_mode: 'Markdown' });
            }

            const recipient = await getUser(targetUserId, targetFirstName);
            user.balance -= amount;
            recipient.balance += amount;
            await user.save();
            await recipient.save();

            return await bot.sendMessage(
                chatId, 
                `💸 **Успешный перевод!**\n\n👤 ${mentionUser(userId, firstName)} перевел **${amount.toLocaleString('ru-RU')} Roze 💰** для ${mentionUser(targetUserId, targetFirstName)}!`, 
                { parse_mode: 'Markdown' }
            );
        }

        // --- МИНЫ (ЗАПУСК ИГРЫ КНОПКАМИ) ---
        const minesMatch = text.match(/^мины\s+(\d+)$/);
        if (minesMatch) {
            if (isPrivate) return await bot.sendMessage(chatId, '⚠️ Играть нужно в чате!');
            const betAmount = parseInt(minesMatch[1]);

            if (user.balance < betAmount || betAmount <= 0) {
                return await bot.sendMessage(chatId, `❌ Недостаточно средств для игры в Мины!`, { parse_mode: 'Markdown' });}

            const gameKey = `${chatId}_${userId}`;
            if (activeMinesGames[gameKey]) {
                return await bot.sendMessage(chatId, `⚠️ Закончи прошлую игру в Мины!`, { parse_mode: 'Markdown' });
            }

            user.balance -= betAmount;
            user.tournamentProfit -= betAmount;
            await user.save();

            let board = Array(9).fill('GEM');
            let m1 = Math.floor(Math.random() * 9);
            let m2 = Math.floor(Math.random() * 9);
            while (m1 === m2) m2 = Math.floor(Math.random() * 9);
            board[m1] = 'MINE';
            board[m2] = 'MINE';

            const game = {
                bet: betAmount,
                board: board,
                revealed: Array(9).fill(false),
                gemsFound: 0,
                multiplier: 1.0,
                gameOver: false
            };

            activeMinesGames[gameKey] = game;

            return await bot.sendMessage(
                chatId, 
                `💣 **Мины** (Ставка: ${betAmount} Roze)\nИгрок: ${mentionUser(userId, firstName)}\nНажми на кнопку чтобы открыть поле (на поле 2 мины):`, 
                { parse_mode: 'Markdown', ...generateMinesKeyboard(game) }
            );
        }

        // --- ТУРНИР / БОНУС / ИСТОРИЯ / ПРАВИЛА ---
        if (text === '🏆 турнир' || text === 'турнир' || text === 'топ') {
            const topUsers = await User.find().sort({ tournamentProfit: -1 }).limit(10);
            let leaderboardText = `🏆 **Суточный Турнир RozeGram**\n\n📊 **Текущий ТОП Лидеров:**\n`;
            if (topUsers.length === 0 || topUsers[0].tournamentProfit <= 0) {
                leaderboardText += `_Пока нет активных участников._`;
            } else {
                topUsers.forEach((u, idx) => {
                    if (u.tournamentProfit > 0) {
                        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
                        leaderboardText += `${medal} ${mentionUser(u.userId, u.firstName)} ➔ +${u.tournamentProfit.toLocaleString('ru-RU')} Roze 💰\n`;
                    }
                });
            }
            return await bot.sendMessage(chatId, leaderboardText, { parse_mode: 'Markdown' });
        }

        if (text === 'бонус' || text === '🎁 бонус') {
            if (!isPrivate) return await bot.sendMessage(chatId, `🎁 ${mentionUser(userId, firstName)}, забрать бонус можно в ЛС бота!`, { parse_mode: 'Markdown' });
            const isSubbed = await checkSubscription(userId);
            if (!isSubbed) {
                const subMenu = { reply_markup: { inline_keyboard: [[{ text: '📢 Подписаться', url: CHANNEL_LINK }], [{ text: '✅ Проверить', callback_data: 'check_sub_and_bonus' }]] } };
                return await bot.sendMessage(chatId, `❌ **Подпишись на канал для получения бонуса!**`, { parse_mode: 'Markdown', ...subMenu });
            }
            const now = Date.now();
            if (now - (user.lastBonus || 0) < 12 * 60 * 60 * 1000) {
                return await bot.sendMessage(chatId, `⏳ Бонус пока недоступен!`, { parse_mode: 'Markdown' });
            }
            user.balance += 10000;
            user.lastBonus = now;
            await user.save();
            return await bot.sendMessage(chatId, `🎉 Зачислено **+10 000 Roze 💰**!`, { parse_mode: 'Markdown' });
        }

        if (text === 'история') {
            const histDoc = await getHistory();
            const historyText = histDoc.results.map((item, index) => `${index + 1}. ${item}`).join('\n') || 'Пусто';
            return await bot.sendMessage(chatId, `📜 **История:**\n\n${historyText}`, { parse_mode: 'Markdown' });
        }

        if (text === '📖 правила игры' || text === 'правила') {
            return await bot.sendMessage(chatId, `🎰 **Правила Casino**\n\n• Ставки: \`100 к\`, \`100 ч\`, \`100 чет\`, \`100 12\`\n• Баланс: буква \`б\`\n• Отмена: \`отмена\`\n• Мины: \`мины 500\`\n• Старт: \`го\``, { parse_mode: 'Markdown' });
        }

        // --- КУБИК ---
        const diceMatch = text.match(/^(\d+)\s+куб\s+(1|2|3|4|5|6|чет|нечет)$/);
        if (diceMatch) {
            if (isPrivate) return await bot.sendMessage(chatId, `⚠️ Играть нужно в чате!`);
            const betAmount = parseInt(diceMatch[1]);
            const target = diceMatch[2];

            if (user.balance < betAmount) return await bot.sendMessage(chatId, `❌ Нехватка средств!`, { parse_mode: 'Markdown' });

            user.balance -= betAmount;
            user.tournamentProfit -= betAmount;

            const roll = Math.floor(Math.random() * 6) + 1;
            let win = false;
            let multiplier = 0;

            if (target === 'чет' && roll % 2 === 0) { win = true; multiplier = 2; }
            else if (target === 'нечет' && roll % 2 !== 0) { win = true; multiplier = 2; }
            else if (parseInt(target) === roll) { win = true; multiplier = 6; }

            let report = `🎲 ${mentionUser(userId, firstName)} бросил кубик! Выпало: **[ ${roll} ]**\n`;
            if (win) {
                const winAmount = betAmount * multiplier;
                user.balance += winAmount;
                user.tournamentProfit += winAmount;
                report += `✅ Победа! Выигрыш: **+${winAmount.toLocaleString('ru-RU')} Roze 💰**`;
            } else {
                report += `❌ Проигрыш! Потеряно ${betAmount.toLocaleString('ru-RU')} Roze.`;
            }
            await user.save();
            return await bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
        }

        // --- ПРИЕМ СТАВОК НА РУЛЕТКУ ---
        const rouletteMatch = text.match(/^(\d+)\s+(к|ч|красное|черное|red|black|чет|нечет|четное|нечетное|even|odd|\d{1,2})$/);
        if (rouletteMatch && !isSpinning) {
            if (isPrivate) return await bot.sendMessage(chatId, `⚠️ Играть нужно в чате!`);
            const betAmount = parseInt(rouletteMatch[1]);
            const target = rouletteMatch[2];

            if (target.match(/^\d+$/) && (parseInt(target) < 0 || parseInt(target) > 36)) {
                return await bot.sendMessage(chatId, `❌ Число от 0 до 36!`);
            }

            if (user.balance < betAmount) {
                return await bot.sendMessage(chatId, `❌ Нехватка средств! Баланс: **${user.balance.toLocaleString('ru-RU')} Roze 💰**`, { parse_mode: 'Markdown' });
            }

            user.balance -= betAmount;
            user.tournamentProfit -= betAmount;
            await user.save();

            currentBets.push({ userId, firstName, amount: betAmount, target });
            return await bot.sendMessage(chatId, `✅ ${mentionUser(userId, firstName)} поставил **${betAmount.toLocaleString('ru-RU')} Roze** на **${target.toUpperCase()}**`, { parse_mode: 'Markdown' });
        }

        // --- ЗАПУСК РУЛЕТКИ (ГО) ---
        if (text === 'го' || text === 'go' || text === 'крутить') {
            if (isPrivate || isSpinning) return;
            if (currentBets.length === 0) return await bot.sendMessage(chatId, '⚠️ Сначала сделайте ставку');

            isSpinning = true;
            
            // 🛡 Устанавливаем таймер безопасности на 5 минут!
            spinSafetyTimer = setTimeout(() => {
                if (isSpinning) emergencyRefund(chatId, 'Превышено время ожидания 5 минут');
            }, 5 * 60 * 1000);

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
                let report = `Рулетка: **${num}${colorEmoji}**\n\n`;

                for (const bet of currentBets) {
                    if (!lastRoundBets[bet.userId]) lastRoundBets[bet.userId] = [];
                    lastRoundBets[bet.userId].push(bet);
                }

                for (const bet of currentBets) {
                    let win = false;
                    let multiplier = 0;
                    const t = bet.target.toLowerCase();

                    if ((t === 'к' || t === 'красное' || t === 'red') && isRed) { win = true; multiplier = 2; }
                    else if ((t === 'ч' || t === 'черное' || t === 'black') && isBlack) { win = true; multiplier = 2; }
                    else if ((t === 'чет' || t === 'четное' || t === 'even') && isEven) { win = true; multiplier = 2; }
                    else if ((t === 'нечет' || t === 'нечетное' || t === 'odd') && isOdd) { win = true; multiplier = 2; }
                    else if (!isNaN(t) && parseInt(t) === num) { win = true; multiplier = 36; }

                    const betUser = await getUser(bet.userId, bet.firstName);

                    let displayTarget = bet.target.toUpperCase();
                    if (['К', 'КРАСНОЕ'].includes(displayTarget)) displayTarget = 'RED';
                    if (['Ч', 'ЧЕРНОЕ'].includes(displayTarget)) displayTarget = 'BLACK';

                    if (win) {
                        const winAmount = Math.floor(bet.amount * multiplier);
                        betUser.balance += winAmount;
                        betUser.tournamentProfit += winAmount;
                        await betUser.save();
                        report += `✅ ${mentionUser(bet.userId, bet.firstName)} ставка ${bet.amount.toLocaleString('ru-RU')} Roze выиграл **${winAmount.toLocaleString('ru-RU')}** на **${displayTarget}**\n`;
                    } else {
                        await betUser.save();
                        report += `❌ ${mentionUser(bet.userId, bet.firstName)} ставка ${bet.amount.toLocaleString('ru-RU')} Roze на ${displayTarget} не сыграла\n`;
                    }
                }

                currentBets = [];
                isSpinning = false;
                if (spinSafetyTimer) clearTimeout(spinSafetyTimer);

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

                await bot.sendMessage(chatId, report.trim(), { parse_mode: 'Markdown', ...actionButtons });

            } catch (err) {
                console.error('[SPIN ERROR]', err.message);
                await emergencyRefund(chatId, err.message);
            }
        }
    } catch (globalErr) {
        console.error('[GLOBAL ERROR]', globalErr.message);
    }
});