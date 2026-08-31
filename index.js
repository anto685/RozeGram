const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const http = require('http');

// ==========================================
// 1. СЕРВЕР И САМО-ПЕРЕЗАГРУЗКА
// ==========================================
const PORT = process.env.PORT || 10000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('RozeGram Casino Engine v10.0 - ALIVE 🎰');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Запущен на порту ${PORT}`);
});

const FIFTEEN_MINUTES = 14 * 60 * 1000; 
setInterval(() => {
    if (RENDER_URL && RENDER_URL.startsWith('http')) {
        http.get(RENDER_URL, (res) => {}).on('error', () => {});
    }
}, FIFTEEN_MINUTES);

// ==========================================
// 2. КОНФИГУРАЦИЯ И БАЗА ДАННЫХ
// ==========================================
const token = process.env.BOT_TOKEN || '8919281816:AAFBc2Y0HAJnWPiBJO-ThUwI7fCWIDAY8gI';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://garbonretoy_db_user:SuperPass12345@cluster0.lk3ngtu.mongodb.net/RozegramDB?retryWrites=true&w=majority';

const CHANNEL_USERNAME = '@anloMorze2k26';
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
    maxProfitRecord: { type: Number, default: 0 },
    accumulatedProfit: { type: Number, default: 0 }
});

const chatSchema = new mongoose.Schema({
    chatId: { type: Number, required: true, unique: true },
    title: { type: String, default: 'Чат' },
    treasuryActive: { type: Boolean, default: false },
    treasuryBalance: { type: Number, default: 0 },
    totalChatProfit: { type: Number, default: 0 },
    history: { type: [String], default: [] }
});

const User = mongoose.model('User', userSchema);
const Chat = mongoose.model('Chat', chatSchema);

// ==========================================
// 4. ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ И ХЕЛПЕРЫ
// ==========================================
let chatBets = {};         
let lastRoundBets = {};    
let spinningChats = {};    
let activeMinesGames = {}; 

const MAX_BETS_PER_ROUND = 250; 
const bot = new TelegramBot(token, { polling: true });

bot.on('polling_error', (err) => {});

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
            [{ text: '🏆 Турнир' }, { text: '🏆 Топ Чатов' }],
            [{ text: '📖 Правила игры' }]
        ],
        resize_keyboard: true
    }};

const rulesText = 
`🎰 *ROZEGRAM CASINO — ТИПЫ ИГР И ПРАВИЛА* 🎰

🔥 *1. РУЛЕТКА (Тип игры)*
├ 🎯 *Диапазоны:* \`10000 12-18\` или нескольких сразу \`10000 12-18 22-28\`
├ 🎨 *Цвет:* \`10000 к\` / \`10000 ч\` или \`10000 красное\` / \`10000 черное\`
├ 🔢 *Точное число:* \`10000 15\` (Выплата x36!)
└ ⚖️ *Четность:* \`10000 чет\` или \`10000 нечет\`

🎲 *2. КУБИК (Тип игры)*
├ ⚖️ *На четность:* \`куб (сумма) чет\` или \`нечет\`
└ 🎯 *Точное число:* \`куб (сумма) 1-6\` (Выплата x6!)

💣 *3. МИНЫ (Тип игры)*
├ 💰 *Старт:* \`мины (сумма вашей ставки)\`
└ 🕹 *Как играть:* Жмите на кнопки! Ищите кристаллы 💎 и избегайте бомб 💥!

📌 *Команды:*
• \`б\` — Твой баланс
• \`го\` — Запустить рулетку
• \`п (сумма)\` — Перевод игроку (в ответ на сообщение)
• \`отмена\` — Сбросить ставки
• \`/help\` — Вызвать эту справку`;

async function getUser(userId, firstName = 'Игрок') {
    try {
        let user = await User.findOne({ userId });
        if (!user) {
            user = await User.create({ userId, firstName, balance: 1000 });
        } else if (firstName !== 'Игрок' && user.firstName !== firstName) {
            user.firstName = firstName;
            await user.save();
        }
        return user;
    } catch (e) {
        return { userId, firstName, balance: 1000, maxProfitRecord: 0, accumulatedProfit: 0, save: async () => {} };
    }
}

async function getChatData(chatId, title = 'Чат') {
    try {
        let chat = await Chat.findOne({ chatId });
        if (!chat) {
            chat = await Chat.create({ chatId, title });
        } else if (title !== 'Чат' && chat.title !== title) {
            chat.title = title;
            await chat.save();
        }
        return chat;
    } catch (e) {
        return { chatId, title, treasuryActive: false, treasuryBalance: 0, totalChatProfit: 0, history: [], save: async () => {} };
    }
}

async function addNetProfit(user, netAmount, chatId = null, chatTitle = 'Чат') {
    user.accumulatedProfit += netAmount;
    if (user.accumulatedProfit > user.maxProfitRecord) {
        user.maxProfitRecord = user.accumulatedProfit;
    }
    await user.save();

    if (chatId && netAmount > 0) {
        const chat = await getChatData(chatId, chatTitle);
        chat.totalChatProfit += netAmount;
        await chat.save();
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

async function emergencyRefund(chatId, reason = 'Ошибка сервера') {
    const currentBets = chatBets[chatId] || [];
    if (currentBets.length === 0) {
        spinningChats[chatId] = false;
        return;
    }
    for (const bet of currentBets) {
        try {
            const betUser = await getUser(bet.userId, bet.firstName);
            betUser.balance += bet.amount;
            await betUser.save();
        } catch (e) {}
    }
    chatBets[chatId] = [];
    spinningChats[chatId] = false;
    try {
        await bot.sendMessage(chatId, `🚨 **[Защита]** Сбой (${reason}). Все ставки возвращены!`, { parse_mode: 'Markdown' });
    } catch (e) {}
}

// ==========================================
// 5. ТУРНИРНЫЙ СБРОС (00:00 MSK)
// ==========================================
setInterval(async () => {
    const now = new Date();
    const mskHours = (now.getUTCHours() + 3) % 24;
    const mskMinutes = now.getUTCMinutes();
    const mskSeconds = now.getUTCSeconds();

    if (mskHours === 0 && mskMinutes === 0 && mskSeconds === 0) {
        try {
            const topUsers = await User.find().sort({ maxProfitRecord: -1 }).limit(10);
            for (const u of topUsers) {
                if (u.maxProfitRecord > 0) {
                    u.balance += 500000;
                    await u.save();
                }
            }

            const topChats = await Chat.find().sort({ totalChatProfit: -1 }).limit(10);
            for (const c of topChats) {
                if (c.totalChatProfit > 0 && c.treasuryActive) {c.treasuryBalance += 750000;
                    await c.save();
                }
            }

            await User.updateMany({}, { accumulatedProfit: 0, maxProfitRecord: 0 });
            await Chat.updateMany({}, { totalChatProfit: 0 });

            console.log('[MIDNIGHT TOURNAMENT] Награды выплачены, рейтинги обнулены!');
        } catch (e) {
            console.log('[MIDNIGHT ERROR]', e);
        }
    }
}, 1000);

// ==========================================
// 6. МИНЫ (5х5)
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
// 7. ИНВАЙТЫ
// ==========================================
bot.on('new_chat_members', async (msg) => {
    try {
        const chatId = msg.chat.id;
        const inviter = msg.from;
        if (!inviter || inviter.is_bot) return;

        const chat = await getChatData(chatId, msg.chat.title);
        if (!chat.treasuryActive || chat.treasuryBalance < 30000) return;

        const newUsers = msg.new_chat_members.filter(m => !m.is_bot && m.id !== inviter.id);
        if (newUsers.length === 0) return;

        for (const newUser of newUsers) {
            if (chat.treasuryBalance < 30000) break;

            let reward = Math.floor(Math.random() * (50000 - 30000 + 1)) + 30000;
            if (reward > chat.treasuryBalance) reward = chat.treasuryBalance;

            chat.treasuryBalance -= reward;
            await chat.save();

            const inviterUser = await getUser(inviter.id, inviter.first_name);
            inviterUser.balance += reward;
            await inviterUser.save();

            await bot.sendMessage(chatId, `🎉 ${mentionUser(inviter.id, inviter.first_name)} получил **+${reward.toLocaleString('ru-RU')} Roze** из КАЗНЫ за приглашение!`, { parse_mode: 'Markdown' });
        }
    } catch (e) {}
});

// ==========================================
// 8. CALLBACK QUERY
// ==========================================
bot.on('callback_query', async (query) => {
    try {
        if (query.message && query.message.date < BOT_START_TIME) return;

        const userId = query.from.id;
        const firstName = query.from.first_name || 'Игрок';
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;
        const action = query.data;

        if (action === 'buy_treasury') {
            const user = await getUser(userId, firstName);
            if (user.balance < 100000) {
                return await bot.answerCallbackQuery(query.id, { text: '❌ У тебя нет 100,000 Roze для активации!', show_alert: true });
            }

            const chat = await getChatData(chatId, query.message.chat.title);
            if (chat.treasuryActive) {
                return await bot.answerCallbackQuery(query.id, { text: '⚠️ Казна в этом чате уже активирована!', show_alert: true });
            }

            user.balance -= 100000;
            await user.save();

            chat.treasuryActive = true;
            chat.treasuryBalance += 100000;
            await chat.save();

            await bot.answerCallbackQuery(query.id, { text: '🎉 Казна успешно активирована!' });
            return await bot.editMessageText(
                `🏛 **КАЗНА ЧАТА АКТИВИРОВАНА!**\n\nИгрок ${mentionUser(userId, firstName)} оплатил **100,000 Roze**!\n💰 Баланс:**${chat.treasuryBalance.toLocaleString('ru-RU')} Roze**`, 
                { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }
            );
        }

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

            user.balance += 100000;
            user.lastBonus = now;
            await user.save();
            return await bot.answerCallbackQuery(query.id, { text: '🎁 Вы получили +100,000 Roze!', show_alert: true });
        }

        if (action === 'repeat_bet' || action === 'double_bet') {
            if (spinningChats[chatId]) {
                return await bot.answerCallbackQuery(query.id, { text: '❌ Рулетка уже крутится!', show_alert: true });
            }

            const chatLastBets = lastRoundBets[chatId] || {};
            const previousBets = chatLastBets[userId];
            if (!previousBets || previousBets.length === 0) {
                return await bot.answerCallbackQuery(query.id, { text: '⚠️ У тебя нет ставок в прошлом раунде!', show_alert: true });
            }

            const multiplier = action === 'double_bet' ? 2 : 1;
            const newBets = previousBets.map(b => ({
                amount: b.amount * multiplier,
                target: b.target,
                type: b.type
            }));

            const totalNeeded = newBets.reduce((sum, b) => sum + b.amount, 0);
            const user = await getUser(userId, firstName);

            if (user.balance < totalNeeded) {
                return await bot.answerCallbackQuery(query.id, { text: `❌ Нехватка средств! Нужно: ${totalNeeded.toLocaleString('ru-RU')} Roze`, show_alert: true });
            }

            if (!chatBets[chatId]) chatBets[chatId] = [];
            user.balance -= totalNeeded;
            await user.save();

            let responseLines = [];
            for (const b of newBets) {
                chatBets[chatId].push({ userId, firstName, amount: b.amount, target: b.target, type: b.type });
                responseLines.push(`🎰 Ставка принята: ${mentionUser(userId, firstName)} **${b.amount.toLocaleString('ru-RU')} Roze** на **${b.target.toUpperCase()}**`);
            }

            await bot.answerCallbackQuery(query.id, { text: '✅ Ставка сделана!' });
            return await bot.sendMessage(chatId, responseLines.join('\n'), { parse_mode: 'Markdown' });
        }

        const gameKey = `${chatId}_${userId}`;
        const game = activeMinesGames[gameKey];

        if (action.startsWith('mine_click_') && game && !game.gameOver) {
            const idx = parseInt(action.replace('mine_click_', ''));
            if (game.revealed[idx]) return await bot.answerCallbackQuery(query.id, { text: 'Уже открыто!' });

            game.revealed[idx] = true;

            if (game.board[idx] === 'MINE') {
                game.gameOver = true;
                delete activeMinesGames[gameKey];
                const user = await getUser(userId, firstName);
                await addNetProfit(user, -game.bet);

                await bot.answerCallbackQuery(query.id, { text: '💥 БУМ! Подорвался!', show_alert: true });
                return await bot.editMessageText(
                    `💥 **Мины | Взрыв!**\n\n${mentionUser(userId, firstName)} наступил на мину и потерял ${game.bet.toLocaleString('ru-RU')} Roze!`, 
                    { chat_id: chatId, message_id: messageId, ...generateMinesKeyboard(game), parse_mode: 'Markdown' }
                );
            } else {
                game.gemsFound++;
                game.multiplier +=0.12;
                await bot.answerCallbackQuery(query.id, { text: '💎 Алмаз!' });

                if (game.gemsFound === 19) {
                    const winAmount = Math.floor(game.bet * game.multiplier);
                    const user = await getUser(userId, firstName);
                    user.balance += winAmount;
                    await addNetProfit(user, winAmount - game.bet, chatId, query.message.chat.title);
                    game.gameOver = true;
                    delete activeMinesGames[gameKey];

                    return await bot.editMessageText(
                        `🏆 **Мины | ПОБЕДА!**\n\n${mentionUser(userId, firstName)} поднял **${winAmount.toLocaleString('ru-RU')} Roze!**`, 
                        { chat_id: chatId, message_id: messageId, ...generateMinesKeyboard(game), parse_mode: 'Markdown' }
                    );
                }

                return await bot.editMessageText(
                    `💣 **Мины (6 мин)**\nИгрок: ${mentionUser(userId, firstName)}\nСтавка: **${game.bet.toLocaleString('ru-RU')} Roze** | Множитель: **x${game.multiplier.toFixed(2)}**`, 
                    { chat_id: chatId, message_id: messageId, ...generateMinesKeyboard(game), parse_mode: 'Markdown' }
                );
            }
        }

        if (action === 'mine_take' && game && !game.gameOver) {
            const winAmount = Math.floor(game.bet * game.multiplier);
            const user = await getUser(userId, firstName);
            user.balance += winAmount;
            await addNetProfit(user, winAmount - game.bet, chatId, query.message.chat.title);
            game.gameOver = true;
            delete activeMinesGames[gameKey];

            await bot.answerCallbackQuery(query.id, { text: `💰 Вы забрали ${winAmount.toLocaleString('ru-RU')} Roze!` });
            return await bot.editMessageText(
                `💰 **Мины | Забрал выигрыш!**\n\n${mentionUser(userId, firstName)} поднял **+${winAmount.toLocaleString('ru-RU')} Roze**!`, 
                { chat_id: chatId, message_id: messageId, ...generateMinesKeyboard(game), parse_mode: 'Markdown' }
            );
        }
    } catch (e) {}
});

// ==========================================
// 9. СООБЩЕНИЯ И КОМАНДЫ
// ==========================================
bot.on('message', async (msg) => {
    try {
        if (msg.date < BOT_START_TIME) return;

        const chatId = msg.chat.id;
        const userId = msg.from ? msg.from.id : null;
        const firstName = msg.from ? msg.from.first_name : 'Игрок';
        const isPrivate = msg.chat.type === 'private';
        if (!userId) return;

        const text = msg.text ? msg.text.trim() : '';
        if (!text) return;

        const lowerText = text.toLowerCase();
        const user = await getUser(userId, firstName);

        if (lowerText === '/start') {
            return await bot.sendMessage(
                chatId, 
                `🎰 **Добро пожаловать в RozeGram Casino!**\n\nПривет, ${mentionUser(userId, firstName)}!\nБаланс: **${user.balance.toLocaleString('ru-RU')} Roze 💰**\n\n📌 Пиши /help для вызова правил!`, 
                { parse_mode: 'Markdown', ...mainKeyboard }
            );
        }

        if (lowerText === '/help' || lowerText === '📖 правила игры' || lowerText === 'правила') {
            return await bot.sendMessage(chatId, rulesText, { parse_mode: 'Markdown' });
        }

        if (lowerText === 'б' || lowerText === 'баланс' || lowerText === 'бал' || lowerText === '💰 баланс') {
            return await bot.sendMessage(
                chatId, 
                `${mentionUser(userId, firstName)}\n💰 Баланс: **${user.balance.toLocaleString('ru-RU')} Roze**`, 
                { parse_mode: 'Markdown' }
            );
        }

        // МЕХАНИКА: ПЕРЕВОД (п сумма)
        const transferMatch = text.match(/^(п|перевод)\s+(\d+)$/i);
        if (transferMatch) {
            if (isPrivate) return await bot.sendMessage(chatId, '⚠️ Переводы работают только в чатах!');
            if (!msg.reply_to_message) return await bot.sendMessage(chatId, '⚠️ Ответь на сообщение того, кому хочешь перевести!');

            const targetUserRaw = msg.reply_to_message.from;
            if (!targetUserRaw || targetUserRaw.is_bot) return await bot.sendMessage(chatId, '⚠️ Нельзя переводить ботам!');
            if (targetUserRaw.id === userId) return await bot.sendMessage(chatId, '⚠️ Самому себе переводить нельзя, умник!');

            const amount = parseInt(transferMatch[2]);
            if (amount <= 0) return await bot.sendMessage(chatId, '⚠️ Сумма перевода должна быть больше 0!');
            if (user.balance < amount) return await bot.sendMessage(chatId, '❌ Недостаточно средств для перевода!');

            const recipient = await getUser(targetUserRaw.id, targetUserRaw.first_name);

            user.balance -= amount;
            recipient.balance += amount;

            await user.save();
            await recipient.save();

            return await bot.sendMessage(
                chatId, 
                `${mentionUser(userId, firstName)} перевел **${amount.toLocaleString('ru-RU')} Roze** для ${mentionUser(recipient.userId, recipient.firstName)}`, 
                { parse_mode: 'Markdown' }
            );
        }

        if (lowerText === 'казна') {
            if (isPrivate) return await bot.sendMessage(chatId, '⚠️ Казна есть только в группах!');
            const chat = await getChatData(chatId, msg.chat.title);

            if (!chat.treasuryActive) {
                const buyKb = {
                    reply_markup: { inline_keyboard: [[{ text: '💳 Активировать казну (100,000 Roze)', callback_data: 'buy_treasury' }]] }
                };
                return await bot.sendMessage(chatId, '🏛 **Казна чата НЕ активирована!**\n\nКупите активацию за 100k Roze!', { parse_mode: 'Markdown', ...buyKb });
            } else {
                return await bot.sendMessage(chatId, `🏛 **Казна чата:**\n\n💰 Баланс: **${chat.treasuryBalance.toLocaleString('ru-RU')} Roze**\n🎁 Авто-выплата за инвайт: **30k - 50k Roze**`, { parse_mode: 'Markdown' });
            }
        }

        if (lowerText === '🎁 бонус' || lowerText === 'бонус') {
            const isSubbed = await checkSubscription(userId);
            if (!isSubbed) {
                const subKeyboard = {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '📢 Подписаться на канал', url: `https://t.me/${CHANNEL_USERNAME.replace('@', '')}` }],
                            [{ text: '✅ Проверить подписку', callback_data: 'check_sub_and_bonus' }]
                        ]
                    }
                };
                return await bot.sendMessage(chatId, '⚠️ Подпишись на наш канал, чтобы получать бонус!', { parse_mode: 'Markdown', ...subKeyboard });
            }

            const now = Date.now();
            if (now - (user.lastBonus || 0) < 12 * 60 * 60 * 1000) {
                return await bot.sendMessage(chatId, `⏳ ${mentionUser(userId, firstName)}, бонус доступен раз в 12 часов!`, { parse_mode: 'Markdown' });
            }

            user.balance += 100000;
            user.lastBonus = now;
            await user.save();
            return await bot.sendMessage(chatId, `🎁 ${mentionUser(userId, firstName)}, ты получил ежедневно **+100,000 Roze 💰**!`, { parse_mode: 'Markdown' });
        }

        if (lowerText === '🏆 турнир' || lowerText === 'турнир' || lowerText === 'топ') {
            const topUsers = await User.find().sort({ maxProfitRecord: -1 }).limit(10);
            let leaderboardText = `🏆 **ТОП-10 Игроков (Суточный Заработок)**\n\n📊 **Лидеры Дня:**\n`;
            topUsers.forEach((u, idx) => {
                if (u.maxProfitRecord > 0) {
                    const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
                    leaderboardText += `${medal} ${mentionUser(u.userId, u.firstName)} ➔ +${u.maxProfitRecord.toLocaleString('ru-RU')} Roze\n`;
                }
            });
            return await bot.sendMessage(chatId, leaderboardText, { parse_mode: 'Markdown' });
        }

        if (lowerText === '🏆 топчатов' || lowerText === 'топ чатов') {
            const topChats = await Chat.find().sort({ totalChatProfit: -1 }).limit(10);
            let leaderboardText = `🏆 **ТОП-10 Чатов Дня**\n🎁 *В 00:00 MSK ТОП-10 чатам капает +750,000 Roze в казну!*\n\n📊 **Рейтинг Групп:**\n`;
            topChats.forEach((c, idx) => {
                if (c.totalChatProfit > 0) {
                    const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
                    leaderboardText += `${medal} **${c.title}** ➔ +${c.totalChatProfit.toLocaleString('ru-RU')} Roze\n`;
                }
            });
            return await bot.sendMessage(chatId, leaderboardText, { parse_mode: 'Markdown' });
        }

        if (lowerText === 'стата' || lowerText === 'админ стата' || lowerText === 'статистика') {
            if (userId === ADMIN_ID) {
                const totalUsers = await User.countDocuments();
                const totalChats = await Chat.countDocuments();
                const activeTreasuries = await Chat.countDocuments({ treasuryActive: true });
                
                const adminReport = 
`👑 --- [ ИМПЕРИЯ СУЕТОЛОГА ] ---

👥 Всего игроков в базе: ${totalUsers.toLocaleString('ru-RU')}
💬 Чатов захвачено: ${totalChats.toLocaleString('ru-RU')}
🏛 Активировано казн: ${activeTreasuries.toLocaleString('ru-RU')}
⚙️ Статус бота: ONLINE (Чистый 50/50 рандом!)`;

                return await bot.sendMessage(chatId, adminReport, { parse_mode: 'Markdown' });
            }
        }

        if (lowerText === 'лог' || lowerText === 'история') {
            const chat = await getChatData(chatId, msg.chat.title);
            const historyText = chat.history.length > 0 ? chat.history.join('\n') : 'Пусто';
            return await bot.sendMessage(chatId, historyText, { parse_mode: 'Markdown' });
        }

        if (lowerText === 'отмена' || lowerText === 'отменить') {
            if (spinningChats[chatId]) return await bot.sendMessage(chatId, '❌ Рулетка уже крутится!', { parse_mode: 'Markdown' });
            if (!chatBets[chatId]) chatBets[chatId] = [];

            const userBets = chatBets[chatId].filter(b => b.userId === userId);
            if (userBets.length === 0) return await bot.sendMessage(chatId, '⚠️ У тебя нет активных ставок!', { parse_mode: 'Markdown' });

            const totalRefund = userBets.reduce((sum, b) => sum + b.amount, 0);
            user.balance += totalRefund;
            await user.save();

            chatBets[chatId] = chatBets[chatId].filter(b => b.userId !== userId);
            return await bot.sendMessage(chatId, `✅ Возвращено: ${totalRefund.toLocaleString('ru-RU')} Roze 💰`, { parse_mode: 'Markdown' });
        }

        // РУЧНОЙ ЗАПУСК РУЛЕТКИ СТРОГО ПО КОМАНДЕ (ГО / GO)
        if (lowerText === 'го' || lowerText === 'go') {
            if (isPrivate) return await bot.sendMessage(chatId, '⚠️ Играть можно только в группах!');
            if (spinningChats[chatId]) return await bot.sendMessage(chatId, '⚠️ Рулетка уже крутится!');

            const currentBets = chatBets[chatId] || [];
            if (currentBets.length === 0) return await bot.sendMessage(chatId, '⚠️ Сначала сделайте ставки!');

            await runRoulette(chatId, msg);
            return;
        }

        const minesMatch = text.match(/^мины\s+(\d+)$/i);
        if (minesMatch) {
            if (isPrivate) return await bot.sendMessage(chatId, '⚠️ Играть можно только в группах!');
            const betAmount = parseInt(minesMatch[1]);

            if (user.balance < betAmount || betAmount <= 0) return await bot.sendMessage(chatId, '❌ Нехватка средств!', { parse_mode: 'Markdown' });

            const gameKey = `${chatId}_${userId}`;
            if (activeMinesGames[gameKey]) return await bot.sendMessage(chatId, '⚠️ Закончи текущую игру!', { parse_mode: 'Markdown' });

            user.balance -= betAmount;
            await user.save();

            let board = Array(25).fill('GEM');
            let minesPlaced = 0;
            while (minesPlaced < 6) {
                let idx = Math.floor(Math.random() * 25);
                if (board[idx] !== 'MINE') { board[idx] = 'MINE'; minesPlaced++; }
            }

            const game = { bet: betAmount, board, revealed: Array(25).fill(false), gemsFound: 0, multiplier: 1.0, gameOver: false };
            activeMinesGames[gameKey] = game;

            return await bot.sendMessage(chatId, `💣 **Мины (6 мин)**\nИгрок: ${mentionUser(userId, firstName)}\nСтавка: **${betAmount.toLocaleString('ru-RU')} Roze**`, { parse_mode: 'Markdown', ...generateMinesKeyboard(game) });
        }

        const diceMatch = text.match(/^куб\s+(\d+)\s+(1|2|3|4|5|6|чет|нечет)$/i);
        if (diceMatch) {
            if (isPrivate) return await bot.sendMessage(chatId, '⚠️ Играть можно только в группах!');
            const betAmount = parseInt(diceMatch[1]);
            const target = diceMatch[2].toLowerCase();

            if (user.balance < betAmount || betAmount <= 0) return await bot.sendMessage(chatId, '❌ Нехватка средств!', { parse_mode: 'Markdown' });

            user.balance -= betAmount;
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
                await addNetProfit(user, winAmount - betAmount, chatId, msg.chat.title);
                report += `✅ Победа! Твой выигрыш: **+${winAmount.toLocaleString('ru-RU')} Roze**!`;
            } else {
                await addNetProfit(user, -betAmount);
                report += `❌ Проигрыш! Потеряно: **-${betAmount.toLocaleString('ru-RU')} Roze**!`;
            }

            return await bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
        }

        // ==========================================
        // 10. РУЛЕТКА ОБРАБОТЧИК СТАВОК (МУЛЬТИ-СТАВКА В ОДНОЙ СТРОКЕ!)
        // ==========================================
        const rouletteMatch = text.match(/^(\d+)\s+(.+)$/);
        if (rouletteMatch && !lowerText.startsWith('куб') && !lowerText.startsWith('мины') && !lowerText.startsWith('п ')) {
            if (isPrivate) return await bot.sendMessage(chatId, '⚠️ Играть можно только в группах!');
            if (spinningChats[chatId]) return await bot.sendMessage(chatId, '⚠️ Рулетка уже крутится, ждите окончания раунда!');

            const betAmount = parseInt(rouletteMatch[1]);
            const targetsRaw = rouletteMatch[2].trim().toLowerCase().split(/\s+/);

            let validTargets = [];

            for (let target of targetsRaw) {
                const isColor = ['к', 'красное', 'red', 'ч', 'черное', 'black'].includes(target);
                const isEvenOdd = ['чет', 'четное', 'even', 'нечет', 'нечетное', 'odd'].includes(target);
                const isExactNumber = /^\d+$/.test(target) && parseInt(target) >= 0 && parseInt(target) <= 36;
                
                let isRange = false;
                if (/^\d+-\d+$/.test(target)) {
                    const [min, max] = target.split('-').map(Number);
                    if (min >= 0 && max <= 36 && min < max) {
                        isRange = true;
                    }
                }

                if (isColor || isEvenOdd || isExactNumber || isRange) {
                    validTargets.push(target);
                }
            }

            if (validTargets.length === 0) return;

            const totalCost = betAmount * validTargets.length;

            if (user.balance < totalCost || betAmount <= 0) {
                return await bot.sendMessage(chatId, `❌Нехватка средств! На ${validTargets.length} шт. ставок нужно: **${totalCost.toLocaleString('ru-RU')} Roze**`, { parse_mode: 'Markdown' });
            }

            if (!chatBets[chatId]) chatBets[chatId] = [];

            if (chatBets[chatId].length + validTargets.length > MAX_BETS_PER_ROUND) {
                return await bot.sendMessage(chatId, '⚠️ Достигнут лимит ставок на этот раунд!');
            }

            user.balance -= totalCost;
            await user.save();

            let acceptedLines = [];
            for (let t of validTargets) {
                chatBets[chatId].push({ userId, firstName, amount: betAmount, target: t, type: 'roulette' });
                acceptedLines.push(t.toUpperCase());
            }

            await bot.sendMessage(chatId, `🎰 Ставка принята: ${mentionUser(userId, firstName)} **${betAmount.toLocaleString('ru-RU')} Roze** на **${acceptedLines.join(', ')}** (Всего: ${totalCost.toLocaleString('ru-RU')} Roze)`, { parse_mode: 'Markdown' });
        }

    } catch (e) {
        console.log('[ERROR]', e);
    }
});

// ==========================================
// 11. ЗАПУСК И РАСЧЕТ РУЛЕТКИ
// ==========================================
async function runRoulette(chatId, msg) {
    try {
        const bets = chatBets[chatId] || [];
        if (bets.length === 0) {
            spinningChats[chatId] = false;
            return;
        }

        spinningChats[chatId] = true;

        const spinMsg = await bot.sendDice(chatId, { emoji: '🎰' });
        await sleep(3000);

        const winningNum = Math.floor(Math.random() * 37);
        const isZero = winningNum === 0;
        const isRed = redNumbers.includes(winningNum);
        const colorEmoji = isZero ? '🟢' : isRed ? '🔴' : '⚫️';
        const colorName = isZero ? 'ЗЕРО' : isRed ? 'КРАСНОЕ' : 'ЧЕРНОЕ';

        let resultsByPlayer = {};
        for (const b of bets) {
            if (!resultsByPlayer[b.userId]) resultsByPlayer[b.userId] = { firstName: b.firstName, bet: 0, win: 0 };
            resultsByPlayer[b.userId].bet += b.amount;

            let isWin = false;
            let coeff = 0;
            const target = b.target.toLowerCase();

            if (/^\d+$/.test(target) && parseInt(target) === winningNum) { 
                isWin = true; 
                coeff = 36; 
            }
            else if (target.includes('-')) {
                const [min, max] = target.split('-').map(Number);
                if (winningNum >= min && winningNum <= max) { 
                    isWin = true; 
                    coeff = Math.floor(36 / (max - min + 1)); 
                }
            }
            else if (['к', 'красное', 'red'].includes(target) && isRed && !isZero) { 
                isWin = true; 
                coeff = 2; 
            }
            else if (['ч', 'черное', 'black'].includes(target) && !isRed && !isZero) { 
                isWin = true; 
                coeff = 2; 
            }
            else if (['чет', 'четное', 'even'].includes(target) && winningNum !== 0 && winningNum % 2 === 0) { 
                isWin = true; 
                coeff = 2; 
            }
            else if (['нечет', 'нечетное', 'odd'].includes(target) && winningNum !== 0 && winningNum % 2 !== 0) { 
                isWin = true; 
                coeff = 2; 
            }

            if (isWin) {
                resultsByPlayer[b.userId].win += b.amount * coeff;
            }
        }

        for (const uid in resultsByPlayer) {
            const res = resultsByPlayer[uid];
            const playerUser = await getUser(Number(uid), res.firstName);
            if (res.win > 0) playerUser.balance += res.win;
            await addNetProfit(playerUser, res.win - res.bet, chatId, msg.chat.title);
        }

        const chat = await getChatData(chatId, msg.chat.title);
        chat.history.unshift(`${winningNum}${colorEmoji}`);
        if (chat.history.length > 5) chat.history.pop();
        await chat.save();

        lastRoundBets[chatId] = {};
        for (const b of bets) {
            if (!lastRoundBets[chatId][b.userId]) lastRoundBets[chatId][b.userId] = [];
            lastRoundBets[chatId][b.userId].push(b);
        }

        chatBets[chatId] = [];
        spinningChats[chatId] = false;

        let reportText = `🎰 **Выпало:** ${colorEmoji} **${winningNum}** (${colorName})\n\n`;
        for (const uid in resultsByPlayer) {
            const res = resultsByPlayer[uid];
            const net = res.win - res.bet;
            if (net > 0) reportText += `✅ ${mentionUser(uid, res.firstName)} ➔ **+${net.toLocaleString('ru-RU')} Roze**\n`;
            else if (net < 0) reportText += `❌ ${mentionUser(uid, res.firstName)} ➔ **-${Math.abs(net).toLocaleString('ru-RU')} Roze**\n`;
            else reportText += `⚖️ ${mentionUser(uid, res.firstName)} ➔ **В нуле**\n`;
        }

        const replayKeyboard = {
            reply_markup: {
                inline_keyboard: [[{ text: '🔄 Повторить', callback_data: 'repeat_bet' }, { text: '✖️2 Удвоить', callback_data: 'double_bet' }]]
            }
        };

        await bot.sendMessage(chatId, reportText, { parse_mode: 'Markdown', ...replayKeyboard });

    } catch (e) {
        console.log('[ROULETTE RUN ERROR]', e);
        await emergencyRefund(chatId, 'Ошибка в рулетке');
    }
}

console.log('🎰 RozeGram Casino Bot готов раздавать кэш! Запуск прошёл успешно.');