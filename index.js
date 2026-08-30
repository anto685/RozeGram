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
    res.end('RozeGram Casino Engine v9.0 - ALIVE 🎰');
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
// 3. СХЕМЫ ДАННЫХ (ОБНОВЛЕННЫЕ)
// ==========================================
const userSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    firstName: { type: String, default: 'Игрок' },
    balance: { type: Number, default: 1000 },
    lastBonus: { type: Number, default: 0 },
    maxProfitRecord: { type: Number, default: 0 }, // Рекордный несгораемый профит
    accumulatedProfit: { type: Number, default: 0 } // Текущий плюс для подсчета рекорда
});

const chatSchema = new mongoose.Schema({
    chatId: { type: Number, required: true, unique: true },
    title: { type: String, default: 'Чат' },
    treasuryActive: { type: Boolean, default: false },
    treasuryBalance: { type: Number, default: 0 },
    totalChatProfit: { type: Number, default: 0 } // Для топа чатов
});

const historySchema =new mongoose.Schema({ results: { type: [String], default: [] } });

const User = mongoose.model('User', userSchema);
const Chat = mongoose.model('Chat', chatSchema);
const History = mongoose.model('History', historySchema);

// ==========================================
// 4. ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ И ХЕЛПЕРЫ
// ==========================================
let currentBets = [];
let lastRoundBets = {}; 
let isSpinning = false;
let spinSafetyTimer = null;
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
    }
};

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
        return { chatId, title, treasuryActive: false, treasuryBalance: 0, totalChatProfit: 0, save: async () => {} };
    }
}

// Вспомогательная функция для обновления Рекордного Профита
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

async function emergencyRefund(chatId, reason = 'Ошибка сервера') {
    if (currentBets.length === 0) {
        isSpinning = false;
        return;
    }
    for (const bet of currentBets) {
        try {
            const betUser = await getUser(bet.userId, bet.firstName);
            betUser.balance += bet.amount;
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
// 5. МИНЫ (5х5) — 6 МИН, УРЕЗАННЫЙ КОЭФ
// ==========================================
function generateMinesKeyboard(game) {
    let inline_keyboard = [];
    for (let r =0; r < 5; r++) {
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
// 6. ОБРАБОТКА ИНВАЙТОВ (АВТО-ВЫДАЧА ИЗ КАЗНЫ)
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

            // Рандом от 30k до 50k
            let reward = Math.floor(Math.random() * (50000 - 30000 + 1)) + 30000;
            if (reward > chat.treasuryBalance) reward = chat.treasuryBalance;

            chat.treasuryBalance -= reward;
            await chat.save();

            const inviterUser = await getUser(inviter.id, inviter.first_name);
            inviterUser.balance += reward;
            await inviterUser.save();

            await bot.sendMessage(chatId, `🎉 ${mentionUser(inviter.id, inviter.first_name)} получил **+${reward.toLocaleString('ru-RU')} Roze** из КАЗНЫ за приглашение участника!`, { parse_mode: 'Markdown' });
        }
    } catch (e) {}
});

// ==========================================
// 7. ОБРАБОТКА CALLBACK QUERY
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
            chat.treasuryBalance += 100000; // 100k идут в баланс казны
            await chat.save();

            await bot.answerCallbackQuery(query.id, { text: '🎉 Казна успешно активирована!' });
            return await bot.editMessageText(
                `🏛 **КАЗНА ЧАТА АКТИВИРОВАНА!**\n\nИгрок ${mentionUser(userId, firstName)} оплатил **100,000 Roze** и запустил казну!\n\n💰 Баланс казны: **${chat.treasuryBalance.toLocaleString('ru-RU')} Roze**\n🎁 Авто-выплата за инвайт: **30,000 - 50,000 Roze**`, 
                { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' }
            );
        }

        if (action === 'check_sub_and_bonus') {
            const isSubbed = await checkSubscription(userId);
            if (!isSubbed) {
                return await bot.answerCallbackQuery(query.id, { text: '❌ Ты еще не подписался на канал!', show_alert: true });}

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

        if (action === 'repeat_bet' || action === 'double_bet') {
            if (query.message.chat.type === 'private') {
                return await bot.answerCallbackQuery(query.id, { text: '⚠️ Играть можно только в группах!', show_alert: true });
            }

            if (isSpinning) {
                return await bot.answerCallbackQuery(query.id, { text: '❌ Рулетка уже крутится!', show_alert: true });
            }

            const previousBets = lastRoundBets[userId];
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

            if (currentBets.length + newBets.length > MAX_BETS_PER_ROUND) {
                return await bot.answerCallbackQuery(query.id, { text: `❌ Превышен лимит стола (${MAX_BETS_PER_ROUND} ставок)!`, show_alert: true });
            }

            user.balance -= totalNeeded;
            await user.save();

            let targetsList = [];
            for (const b of newBets) {
                currentBets.push({ userId, firstName, amount: b.amount, target: b.target, type: b.type });
                targetsList.push(b.target.toUpperCase());
            }

            const actName = action === 'double_bet' ? 'УДВОИЛ' : 'ПОВТОРИЛ';
            await bot.answerCallbackQuery(query.id, { text: '✅ Ставка сделана!' });
            return await bot.sendMessage(chatId, `🔄 ${mentionUser(userId, firstName)} **${actName}** прошлые ставки на сумму **${totalNeeded.toLocaleString('ru-RU')} Roze**! [ ${targetsList.join(', ')} ]`, { parse_mode: 'Markdown' });
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
                
                // Фиксируем чистый убыток в профит
                const user = await getUser(userId, firstName);
                await addNetProfit(user, -game.bet);

                await bot.answerCallbackQuery(query.id, { text: '💥 БУМ! Подорвался!', show_alert: true });
                return await bot.editMessageText(
                    `💥 **Мины (6 мин) | Взрыв!**\n\n${mentionUser(userId, firstName)} наступил на мину и потерял **${game.bet.toLocaleString('ru-RU')} Roze**!`, 
                    { chat_id: chatId, message_id: messageId, ...generateMinesKeyboard(game), parse_mode: 'Markdown' }
                );
            } else {
                game.gemsFound++;game.multiplier += 0.12; // СРЕЗАННЫЙ КОЭФФИЦИЕНТ
                await bot.answerCallbackQuery(query.id, { text: '💎 Алмаз!' });

                if (game.gemsFound === 19) { // 25 - 6 мин = 19 кристаллов
                    const winAmount = Math.floor(game.bet * game.multiplier);
                    const user = await getUser(userId, firstName);
                    user.balance += winAmount;
                    
                    const netProfit = winAmount - game.bet;
                    await addNetProfit(user, netProfit, chatId, query.message.chat.title);

                    game.gameOver = true;
                    delete activeMinesGames[gameKey];
                    return await bot.editMessageText(
                        `🏆 **Мины | ПОБЕДА!**\n\n${mentionUser(userId, firstName)} очистил все кристаллы и поднял **${winAmount.toLocaleString('ru-RU')} Roze!**`, 
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
            
            const netProfit = winAmount - game.bet;
            await addNetProfit(user, netProfit, chatId, query.message.chat.title);

            game.gameOver = true;
            delete activeMinesGames[gameKey];

            await bot.answerCallbackQuery(query.id, { text: `💰 Вы забрали ${winAmount.toLocaleString('ru-RU')} Roze!` });
            return await bot.editMessageText(
                `💰 **Мины | Забрал выигрыш!**\n\n${mentionUser(userId, firstName)} зафиксировал выигрыш **+${winAmount.toLocaleString('ru-RU')} Roze**!`, 
                { chat_id: chatId, message_id: messageId, ...generateMinesKeyboard(game), parse_mode: 'Markdown' }
            );
        }
    } catch (e) {}
});

// ==========================================
// 8. ОБРАБОТКА СООБЩЕНИЙ
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
            return await bot.sendMessage(
                chatId, 
                `🎰 **Добро пожаловать в RozeGram Casino!**\n\nПривет, ${mentionUser(userId, firstName)}!\nБаланс: **${user.balance.toLocaleString('ru-RU')} Roze 💰**\n\n📌 *Играть и делать ставки можно только в группах!*`, 
                { parse_mode: 'Markdown', ...mainKeyboard }
            );
        }

        if (text === 'б' || text === 'баланс' || text === 'бал' || text === '💰 баланс') {
            return await bot.sendMessage(chatId, `💰 ${mentionUser(userId, firstName)}, твой баланс: **${user.balance.toLocaleString('ru-RU')} Roze 💰**`, { parse_mode: 'Markdown' });
        }

        // ==========================================
        // КАЗНА ЧАТА (КОМАНДЫ)
        // ==========================================
        if (text === 'казна') {
            if (isPrivate) return await bot.sendMessage(chatId, '⚠️ Казна есть только в группах!');
            const chat = await getChatData(chatId, msg.chat.title);

            if (!chat.treasuryActive){
                const buyKb = {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '💳 Активировать казну (100,000 Roze)', callback_data: 'buy_treasury' }]
                        ]
                    }
                };
                return await bot.sendMessage(chatId, `🏛 **Казна чата НЕ активирована!**\n\nКупите активацию казны за **100,000 Roze**, чтобы активировать авто-выдачи за добавление людей в чат!`, { parse_mode: 'Markdown', ...buyKb });
            } else {
                return await bot.sendMessage(chatId, `🏛 **Казна чата:**\n\n💰 Баланс: **${chat.treasuryBalance.toLocaleString('ru-RU')} Roze**\n🎁 Авто-выплата за инвайт: **30k - 50k Roze**\n\nПополнить казну: \`пополнить казну [сумма]\``, { parse_mode: 'Markdown' });
            }
        }

        const topUpMatch = text.match(/^пополнить\s+казну\s+(\d+)$/);
        if (topUpMatch) {
            if (isPrivate) return await bot.sendMessage(chatId, '⚠️ Казна есть только в группах!');
            const amount = parseInt(topUpMatch[1]);
            const chat = await getChatData(chatId, msg.chat.title);

            if (!chat.treasuryActive) {
                return await bot.sendMessage(chatId, '⚠️ Казна еще не активирована! Напиши `казна` чтобы купить.', { parse_mode: 'Markdown' });
            }

            if (amount <= 0 || user.balance < amount) {
                return await bot.sendMessage(chatId, '❌ Ошибка суммы или нехватка средств!', { parse_mode: 'Markdown' });
            }

            user.balance -= amount;
            chat.treasuryBalance += amount;
            await user.save();
            await chat.save();

            return await bot.sendMessage(chatId, `🏛 **Казна пополнилась!**\n\n${mentionUser(userId, firstName)} закинул **+${amount.toLocaleString('ru-RU')} Roze**!\nТекущий баланс казны: **${chat.treasuryBalance.toLocaleString('ru-RU')} Roze**`, { parse_mode: 'Markdown' });
        }

        if (text === '🎁 бонус') {
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
                return await bot.sendMessage(chatId, `⚠️ **Подпишись на наш канал, чтобы получать бонус!**`, { parse_mode: 'Markdown', ...subKeyboard });
            }

            const now = Date.now();
            const cooldown = 12 * 60 * 60 * 1000;
            if (now - (user.lastBonus || 0) < cooldown) {
                return await bot.sendMessage(chatId, `⏳ ${mentionUser(userId, firstName)}, бонус доступен раз в 12 часов!`, { parse_mode: 'Markdown' });
            }

            user.balance += 500;
            user.lastBonus = now;
            await user.save();
            return await bot.sendMessage(chatId, `🎁 ${mentionUser(userId, firstName)}, ты получил ежедневный бонус **+500 Roze 💰**!`, { parse_mode: 'Markdown' });
        }

        // ==========================================
        // ТУРНИРЫ (ОБНОВЛЕННЫЕ)
        // ==========================================
        if (text === '🏆 турнир' || text === 'турнир' || text === 'топ') {
            const topUsers = await User.find().sort({ maxProfitRecord: -1 }).limit(10);
            let leaderboardText = `🏆 **Рекордный Заработок (Чистый профит)**\n*(Показывает пиковый выигрыш, не уменьшается при сливах!)*\n\n📊 **ТОП Лидеров:**\n`;
            topUsers.forEach((u, idx) => {
                if (u.maxProfitRecord > 0) {
                    const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
                    leaderboardText += `${medal} ${mentionUser(u.userId, u.firstName)} ➔ +${u.maxProfitRecord.toLocaleString('ru-RU')} Roze\n`;
                }});
            return await bot.sendMessage(chatId, leaderboardText, { parse_mode: 'Markdown' });
        }

        if (text === '🏆 топ чатов' || text === 'топ чатов') {
            const topChats = await Chat.find().sort({ totalChatProfit: -1 }).limit(10);
            let leaderboardText = `🏆 **ТОП Самых Богатых Чатов**\n\n📊 **Рейтинг Групп:**\n`;
            topChats.forEach((c, idx) => {
                if (c.totalChatProfit > 0) {
                    const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
                    leaderboardText += `${medal} **${c.title}** ➔ +${c.totalChatProfit.toLocaleString('ru-RU')} Roze\n`;
                }
            });
            return await bot.sendMessage(chatId, leaderboardText, { parse_mode: 'Markdown' });
        }

        if (text === '📖 правила игры' || text === 'правила') {
            return await bot.sendMessage(chatId, `🎰 **Правила Casino**\n\n• Ставка: \`100 к\`, \`2000 0 1 2 3 4 5 12-18\`\n• Лимит ставок за раунд: **250 шт.**\n• Баланс: кнопка или буква \`б\`\n• Отмена: \`отмена\`\n• Мины (6 мин): \`мины 500\`\n• Кубик: \`100 куб 6\`\n• Казна: слово \`казна\`\n• История выпадений: команда \`лог\`\n• Старт рулетки: \`го\`\n\n⚠️ *Ставки принимаются строго в группах!*`, { parse_mode: 'Markdown' });
        }

        if (text === 'лог' || text === 'история') {
            const histDoc = await getHistory();
            const historyText = histDoc.results.length > 0 ? histDoc.results.map((item, index) => `${index + 1}. ${item}`).join('\n') : 'Пусто';
            return await bot.sendMessage(chatId, `📜 **Последние 10 выпадений:**\n\n${historyText}`, { parse_mode: 'Markdown' });
        }

        const giveSelfMatch = text.match(/^(?:себе|админ)\s+(\d+)$/);
        if (giveSelfMatch && userId === ADMIN_ID) {
            const amount = parseInt(giveSelfMatch[1]);
            user.balance += amount;
            await user.save();
            return await bot.sendMessage(chatId, `👑 **Админ-выдача!** Начислено **+${amount.toLocaleString('ru-RU')} Roze 💰**`, { parse_mode: 'Markdown' });
        }
                if (text === 'стата' || text === 'админ стата' || text === 'статистика') {
            if (userId === ADMIN_ID) {
                const totalUsers = await User.countDocuments();
                const totalChats = await Chat.countDocuments();
                const activeTreasuries = await Chat.countDocuments({ treasuryActive: true });
                
                const adminReport = 
`👑 *--- [ ИМПЕРИЯ СУЕТОЛОГА ] ---*

👥 Всего игроков в базе: *${totalUsers.toLocaleString('ru-RU')}*
💬 Чатов захвачено: *${totalChats.toLocaleString('ru-RU')}*
🏛 Активировано казн: *${activeTreasuries.toLocaleString('ru-RU')}*
⚙️ Статус бота: *ONLINE (Жара идет! 🚀)*`;

                return await bot.sendMessage(chatId, adminReport, { parse_mode: 'Markdown' });
            }
        }


        if (text === 'отмена' || text === 'отменить') {
            if (isPrivate) return await bot.sendMessage(chatId, '⚠️ Играть и управлять ставками можно только в группах!');
            if (isSpinning) return await bot.sendMessage(chatId, `❌ ${mentionUser(userId, firstName)}, рулетка уже крутится!`, { parse_mode: 'Markdown' });

            const userBets = currentBets.filter(b => b.userId === userId);
            if (userBets.length === 0) {
                return await bot.sendMessage(chatId, `⚠️ ${mentionUser(userId, firstName)}, у тебя нет активных ставок!`, { parse_mode: 'Markdown' });
            }

            const totalRefund = userBets.reduce((sum, b) => sum + b.amount, 0);
            user.balance += totalRefund;
            await user.save();

            currentBets = currentBets.filter(b => b.userId !== userId);
            return await bot.sendMessage(chatId, `✅ ${mentionUser(userId, firstName)} отменил все свои ставки! Возвращено: **${totalRefund.toLocaleString('ru-RU')} Roze 💰**`, { parse_mode: 'Markdown' });
        }

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
            if (amount <= 0 || user.balance < amount) return await bot.sendMessage(chatId, '❌ Ошибка перевода или нехваткасредств!', { parse_mode: 'Markdown' });

            const recipient = await getUser(targetUserId, targetFirstName);
            user.balance -= amount;
            recipient.balance += amount;
            await user.save();
            await recipient.save();

            return await bot.sendMessage(chatId, `💸 **Успешный перевод!**\n\n${mentionUser(userId, firstName)} ➔ ${mentionUser(targetUserId, targetFirstName)}: **${amount.toLocaleString('ru-RU')} Roze 💰**`, { parse_mode: 'Markdown' });
        }

        // ==========================================
        // МИНЫ (6 МИН)
        // ==========================================
        const minesMatch = text.match(/^мины\s+(\d+)$/);
        if (minesMatch) {
            if (isPrivate) return await bot.sendMessage(chatId, '⚠️ Играть можно только в группах!');
            const betAmount = parseInt(minesMatch[1]);

            if (user.balance < betAmount || betAmount <= 0) {
                return await bot.sendMessage(chatId, '❌ Нехватка средств!', { parse_mode: 'Markdown' });
            }

            const gameKey = `${chatId}_${userId}`;
            if (activeMinesGames[gameKey]) {
                return await bot.sendMessage(chatId, '⚠️ Закончи текущую игру в мины!', { parse_mode: 'Markdown' });
            }

            user.balance -= betAmount;
            await user.save();

            let board = Array(25).fill('GEM');
            let minesPlaced = 0;
            while (minesPlaced < 6) { // 6 МИН
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
                `💣 **Мины (6 мин)**\nИгрок: ${mentionUser(userId, firstName)}\nСтавка: **${betAmount.toLocaleString('ru-RU')} Roze**\nНажми на ячейку чтобы открыть:`, 
                { parse_mode: 'Markdown', ...generateMinesKeyboard(game) }
            );
        }

        const diceMatch = text.match(/^(\d+)\s+куб\s+(1|2|3|4|5|6|чет|нечет)$/);
        if (diceMatch) {
            if (isPrivate) return await bot.sendMessage(chatId, '⚠️ Играть можно только в группах!');
            const betAmount = parseInt(diceMatch[1]);
            const target = diceMatch[2];

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
                report += `✅ Победа! Выигрыш: **+${winAmount.toLocaleString('ru-RU')} Roze 💰**`;
            } else {
                await addNetProfit(user, -betAmount);
                report += `❌ Проигрыш! Потеряно **${betAmount.toLocaleString('ru-RU')} Roze**`;
            }
            await user.save();
            return await bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
        }

        // ==========================================
        // ПАРСИНГ СТАВОК РУЛЕТКИ (БЕЗ ИЗМЕНЕНИЙ)
        // ==========================================
        const tokens = text.split(/\s+/);
        const firstNum = parseInt(tokens[0]);

        if (!isSpinning && !isNaN(firstNum) && firstNum > 0 && tokens.length >= 2 && !['мины', 'куб', 'передать', 'перевод', 'себе', 'админ', 'выдать', 'пополнить'].includes(tokens[0])) {
            if (isPrivate) return await bot.sendMessage(chatId, '⚠️ Делать ставки в рулетку можно только в группах!');

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
                    const max = parseInt(rangeMatch[2]);
                    if (min >= max || min < 0 || max > 36) { parseError = true; break; }
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
                    return await bot.sendMessage(chatId, `❌ **${mentionUser(userId, firstName)}**, НЕЛЬЗЯ мешать категории!`, { parse_mode: 'Markdown' });
                }

                parsedBets.push({ amount: betAmount, target: target, type: currentType });
            }

            if (!parseError && parsedBets.length > 0) {
                const totalSum = parsedBets.reduce((s, b) => s + b.amount, 0);
                if (user.balance < totalSum) {
                    return await bot.sendMessage(chatId, `❌ Нехватка средств! Нужно: **${totalSum.toLocaleString('ru-RU')} Roze**`, { parse_mode: 'Markdown' });
                }

                user.balance -= totalSum;
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
        // ЗАПУСК РУЛЕТКИ (ПРОФИТ ТЕПЕРЬ СЧИТАЕТСЯ ПО-НОВОМУ)
        // ==========================================
        if(text === 'го' || text === 'go' || text === 'крутить' || text === 'spin') {
            if (isPrivate) return await bot.sendMessage(chatId, '⚠️ Запускать рулетку можно только в группах!');
            if (isSpinning) return await bot.sendMessage(chatId, '⏳ Рулетка уже крутится!');
            if (currentBets.length === 0) return await bot.sendMessage(chatId, '⚠️ Нет активных ставок! Сначала сделайте ставку.');

            isSpinning = true;

            spinSafetyTimer = setTimeout(() => {
                emergencyRefund(chatId, 'Таймаут рулетки');
            }, 30000);

            try {
                const slotMsg = await bot.sendDice(chatId, { emoji: '🎰' });
                await sleep(4000);
                try { await bot.deleteMessage(chatId, slotMsg.message_id); } catch(e) {}

                const num = Math.floor(Math.random() * 37);
                const isRed = redNumbers.includes(num);
                const isBlack = num !== 0 && !isRed;
                const isEven = num !== 0 && num % 2 === 0;

                let colorEmoji = num === 0 ? '🟢' : (isRed ? '🔴' : '⚫');
                let winningRange = '0';
                if (num >= 1 && num <= 12) winningRange = '1-12';
                else if (num >= 13 && num <= 24) winningRange = '13-24';
                else if (num >= 25 && num <= 36) winningRange = '25-36';

                const histDoc = await getHistory();
                histDoc.results.unshift(`${colorEmoji} ${num}`);
                if (histDoc.results.length > 10) histDoc.results.pop();
                await histDoc.save();

                let userSummary = {};
                lastRoundBets = {};

                for (const bet of currentBets) {
                    if (!lastRoundBets[bet.userId]) lastRoundBets[bet.userId] = [];
                    lastRoundBets[bet.userId].push(bet);

                    if (!userSummary[bet.userId]) {
                        userSummary[bet.userId] = { firstName: bet.firstName, totalWin: 0, totalCost: 0 };
                    }

                    userSummary[bet.userId].totalCost += bet.amount;

                    let isWin = false;
                    let mult = 0;

                    if (bet.type === 'NUMBERS') {
                        const rangeMatch = bet.target.match(/^(\d{1,2})-(\d{1,2})$/);
                        if (rangeMatch) {
                            const min = parseInt(rangeMatch[1]);
                            const max = parseInt(rangeMatch[2]);
                            if (num >= min && num <= max) {
                                isWin = true;
                                mult = Math.floor(36 / (max - min + 1));
                            }
                        } else if (parseInt(bet.target) === num) {
                            isWin = true;
                            mult = 36;
                        }
                    } else if (bet.type === 'COLORS') {
                        if (['к', 'красное', 'red'].includes(bet.target) && isRed) { isWin = true; mult = 2; }
                        else if (['ч', 'черное', 'black'].includes(bet.target) && isBlack) { isWin = true; mult = 2; }
                    } else if (bet.type === 'EVENODD') {
                        if (['чет', 'четное', 'even'].includes(bet.target) && isEven) { isWin = true; mult = 2; }
                        else if (['нечет', 'нечетное', 'odd'].includes(bet.target) && !isEven && num !== 0) { isWin = true; mult = 2; }
                    }

                    if (isWin) {
                        userSummary[bet.userId].totalWin += (bet.amount * mult);
                    }
                }

                let playersSheet = '';
                for (const uId in userSummary) {
                    const data = userSummary[uId];
                    const betUser = await getUser(uId, data.firstName);
                    const netProfit = data.totalWin - data.totalCost;

                    // Добавляем профит в накопительную систему
                    await addNetProfit(betUser, netProfit, chatId, msg.chat.title);

                    if (data.totalWin > 0) {
                        betUser.balance += data.totalWin;
                        await betUser.save();
                        playersSheet += `├ 🎉 ${mentionUser(uId, data.firstName)}: **ВИН +${data.totalWin.toLocaleString('ru-RU')} Roze** (Профит: +${netProfit.toLocaleString('ru-RU')})\n`;
                    } else {
                        await betUser.save();
                        playersSheet += `├ 📉 ${mentionUser(uId, data.firstName)}: Минус **${data.totalCost.toLocaleString('ru-RU')} Roze**\n`;
                    }
                }

                if (!playersSheet) playersSheet = '├ Ставок не было\n';

                const report = 
`📜 **--- [ ЛИСТОЧЕК РАУНДА ] ---**

🎰 Выпало: [ ${num} ${colorEmoji} ]

📊 **ДИАПАЗОН И СВОЙСТВА ВИНА:**
├ 🎯 Выигравший диапазон: ${winningRange}
├ 🎨 Цвет: ${colorEmoji} ${isRed ? 'Красное' : (isBlack ? 'Черное' : 'Зеро')}
└ ⚖️ Четность: ${num === 0 ? 'Зеро' : (isEven ? 'Четное' : 'Нечетное')}

💰 ИТОГИ ИГРОКОВ:
${playersSheet.trim()}`;

                currentBets = [];
                isSpinning = false;
                if (spinSafetyTimer) clearTimeout(spinSafetyTimer);

                const actionButtons = {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '🔄 Повторить', callback_data: 'repeat_bet' },
                                { text: '✖️2 Удвоить', callback_data: 'double_bet' }
                            ]
                        ]
                    }
                };

                await bot.sendMessage(chatId, report.trim(), { parse_mode: 'Markdown', ...actionButtons });

            } catch (err) {
                await emergencyRefund(chatId, err.message);
            }
        }

    } catch (globalErr) {}
});