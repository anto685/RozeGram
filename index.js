const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const http = require('http');

// Сервер 24/7 для Render
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('RozeGram Casino Engine Active!');
}).listen(PORT, '0.0.0.0', () => console.log(`[SERVER] Engine running on port ${PORT}`));

const token = 'ВСТАВЬ_СВОЙ_ТОКЕН_СЮДА';
const dbPath = path.join(__dirname, 'db.json');

const CHANNEL_USERNAME = '@anloMorze2k26'; 
const CHANNEL_LINK = 'https://t.me/anloMorze2k26';
const CHAT_LINK = 'https://t.me/+CoDIQuyOcMc2YTFi';

let db = { users: {}, history: [] };
let currentBets = []; 
let lastRoundBets = {}; 
let userBetCooldowns = {}; // Храним анти-спам таймеры юзеров
let isSpinning = false;

function loadDB() {
    try {
        if (fs.existsSync(dbPath)) {
            const raw = fs.readFileSync(dbPath, 'utf8');
            const parsed = JSON.parse(raw);
            db.users = parsed.users || {};
            db.history = parsed.history || [];
        }
    } catch (e) {
        console.error('[DB ERROR]', e.message);
    }
}

function saveDB() {
    try {
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
    } catch (e) {
        console.error('[DB ERROR]', e.message);
    }
}

loadDB();

const bot = new TelegramBot(token, { polling: true });

bot.on('polling_error', (err) => console.error(`[POLLING ERROR] ${err.code}: ${err.message}`));

function getUser(userId) {
    if (!db.users[userId]) {
        db.users[userId] = { balance: 1000, lastBonus: 0 };
        saveDB();
    }
    return db.users[userId];
}

// Проверка подписки
async function checkSubscription(userId) {
    try {
        const member = await bot.getChatMember(CHANNEL_USERNAME, userId);
        return ['creator', 'administrator', 'member'].includes(member.status);
    } catch (e) {
        console.error('[SUB CHECK ERROR]', e.message);
        return false;
    }
}

const redNumbers = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Нижняя клавиатура (Панелька ТОЛЬКО для ЛС)
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: '💳 Баланс' }, { text: '🎁 Бонус' }],
            [{ text: '📖 Правила игры' }]
        ],
        resize_keyboard: true
    }
};

// Инлайн-кнопки
bot.on('callback_query', async (query) => {
    try {
        const userId = query.from.id;
        const firstName = query.from.first_name || 'Игрок';
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;
        const action = query.data;

        // Проверка подписки по кнопке (Работает ТОЛЬКО в ЛС)
        if (action === 'check_sub_and_bonus') {
            const isSubbed = await checkSubscription(userId);
            if (!isSubbed) {
                return await bot.answerCallbackQuery(query.id, { 
                    text: '❌ Ты еще не подписался на канал!', 
                    show_alert: true 
                });
            }

            const user = getUser(userId);
            const now = Date.now();
            const cooldown = 24 * 60 * 60 * 1000;
            const lastBonus = user.lastBonus || 0;

            if (now - lastBonus < cooldown) {
                const timeLeft = cooldown - (now - lastBonus);
                const h = Math.floor(timeLeft / (1000 * 60 * 60));
                const m = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
                
                await bot.answerCallbackQuery(query.id, { text: 'Подписка подтверждена!' });
                return await bot.sendMessage(chatId, `⏳ Бонус уже забран! Приходи через **${h}ч ${m}м**.`, { parse_mode: 'Markdown', ...mainKeyboard });
            }

            user.balance += 500;
            user.lastBonus = now;
            saveDB();

            try { await bot.deleteMessage(chatId, messageId); } catch (e) {}

            await bot.answerCallbackQuery(query.id, { text: '🎉 +500$ зачислено!' });
            return await bot.sendMessage(chatId, `🎉 **Подписка подтверждена! Зачислено +500$!**\nТвой баланс: **${user.balance}$**`, { parse_mode: 'Markdown', ...mainKeyboard });
        }

        // Кнопки Удвоить / Повторить (В чате)
        if (action === 'repeat_bet' || action === 'double_bet') {
            if (isSpinning) {
                return await bot.answerCallbackQuery(query.id, { text: 'Рулетка крутится!', show_alert: true });
            }

            const user = getUser(userId);
            const userLastBets = lastRoundBets[userId];

            if (!userLastBets || userLastBets.length === 0) {
                return await bot.answerCallbackQuery(query.id, { text: 'Нет ставок с прошлого раунда!', show_alert: true });
            }

            let multiplier = (action === 'repeat_bet') ? 1 : 2;
            let totalCost = userLastBets.reduce((sum, b) => sum + (b.amount * multiplier), 0);

            if (user.balance < totalCost) {
                return await bot.answerCallbackQuery(query.id, { text: `Нужно ${totalCost}$, баланс: ${user.balance}$`, show_alert: true });
            }

            user.balance -= totalCost;
            saveDB();

            let addedText = [];
            for (const oldBet of userLastBets) {
                const newAmount = oldBet.amount * multiplier;
                currentBets.push({
                    userId,
                    firstName,
                    amount: newAmount,
                    target: oldBet.target
                });
                addedText.push(`${newAmount}$ на ${oldBet.target}`);
            }

            await bot.answerCallbackQuery(query.id, { text: `Ставка принята` });
            await bot.sendMessage(chatId, `🎰 **${firstName}** ${action === 'repeat_bet' ? 'повторил' : 'удвоил'}: ${addedText.join(', ')}`, { parse_mode: 'Markdown' });
        }

    } catch (e) {
        console.error('[CALLBACK ERROR]', e.message);
    }
});

bot.on('message', async (msg) => {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from ? msg.from.id : null;
        const firstName = msg.from ? msg.from.first_name : 'Игрок';
        const isPrivate = msg.chat.type === 'private';
        if (!userId) return;

        const text = msg.text ? msg.text.trim().toLowerCase() : '';
        if (!text) return;

        const user = getUser(userId);

        // 1. /START В ЛИЧКЕ
        if (text === '/start') {
            if (isPrivate) {
                return await bot.sendMessage(
                    chatId, 
                    `🎰 **Добро пожаловать в RozeGram Casino!**\n\nПривет, **${firstName}**!\nБаланс: **${user.balance}$**\n\n⚠️ **Игры проходят в нашем чате:** ${CHAT_LINK}\nИспользуй меню ниже для проверки баланса и бонуса 👇`, 
                    { parse_mode: 'Markdown', ...mainKeyboard }
                );
            }
            return;
        }

        // 2. БОНУС (Строго в ЛС)
        if (text === 'бонус' || text === 'бонусы' || text === '🎁 бонус') {
            if (!isPrivate) {
                return await bot.sendMessage(chatId, `🎁 **${firstName}**, забрать бонус можно только в ЛС бота!`, { parse_mode: 'Markdown' });
            }
            
            const isSubbed = await checkSubscription(userId);
            if (!isSubbed) {
                const subMenu = {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '📢 Подписаться на Канал', url: CHANNEL_LINK }],
                            [{ text: '💬 Наш Чат', url: CHAT_LINK }],
                            [{ text: '✅ Проверить подписку и забрать 500$', callback_data: 'check_sub_and_bonus' }]
                        ]
                    }
                };
                return await bot.sendMessage(chatId, `❌ **Для получения бонуса необходимо быть подписанным на наш канал и чат!**`, { parse_mode: 'Markdown', ...subMenu });
            }

            const now = Date.now();
            const cooldown = 24 * 60 * 60 * 1000;
            const lastBonus = user.lastBonus || 0;

            if (now - lastBonus < cooldown) {
                const timeLeft = cooldown - (now - lastBonus);
                const h = Math.floor(timeLeft / (1000 * 60 * 60));
                const m = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
                return await bot.sendMessage(chatId, `⏳ Бонус доступен через **${h}ч ${m}м**`, { parse_mode: 'Markdown', ...mainKeyboard });
            }

            user.balance += 500;
            user.lastBonus = now;
            saveDB();
            return await bot.sendMessage(chatId, `🎉 Зачислено **+500$**! Баланс: **${user.balance}$**`, { parse_mode: 'Markdown', ...mainKeyboard });
        }

        // 3. БАЛАНС
        if (text === 'баланс' || text === 'бал' || text === '💳 баланс') {
            if (isPrivate) {
                return await bot.sendMessage(chatId, `💳 Баланс: **${user.balance}$**`, { parse_mode: 'Markdown', ...mainKeyboard });
            } else {
                return await bot.sendMessage(chatId, `💳 **${firstName}**, твой баланс: **${user.balance}$**`, { parse_mode: 'Markdown' });
            }
        }

        // 4. ИСТОРИЯ
        if (text === 'история' || text === 'лог') {
            if (!db.history || db.history.length === 0) return await bot.sendMessage(chatId, '📜 История пуста');
            const historyText = db.history.map((item, index) => `${index + 1}. ${item}`).join('\n');
            return await bot.sendMessage(chatId, `📜 **История:**\n\n${historyText}`, { parse_mode: 'Markdown' });
        }

        // 5. ПРАВИЛА
        if (text === '📖 правила игры' || text === 'правила') {
            const rulesText = 
`🎰 **Правила RozeGram Casino**

Примеры ставок:
• \`100 к\` / \`100 ч\` — Красное / Черное (x2)
• \`500 чет\` / \`500 нечет\` — Чет / Нечет (x2)
• \`300 12\` — Число (x36)
• \`300 12-18\` — Диапазон

Старт игры по команде: го`;
            return await bot.sendMessage(chatId, rulesText, { parse_mode: 'Markdown', ...(isPrivate ? mainKeyboard : {}) });
        }

        // 🎯 ПАРСЕР СТАВОК (ТОЛЬКО В ГРУППАХ!)
        const parts = text.split(/\s+/);
        let numbersSum = 0;
        let targets = [];
        let hasBetTrigger = false;

        for (const p of parts) {
            if (!isNaN(p) && !p.includes('-')) {
                numbersSum += parseInt(p);
            } else if (p.match(/^(\d+)-(\d+)$/)) {
                targets.push(p);
                hasBetTrigger = true;
            } else if (['к', 'красное', 'ч', 'черное', 'чет', 'четное', 'even', 'нечет', 'нечетное', 'odd'].includes(p)) {
                targets.push(p);
                hasBetTrigger = true;
            } else if (!isNaN(p) && parseInt(p) >= 0 && parseInt(p) <= 36) {
                targets.push(p);
                hasBetTrigger = true;
            }
        }

        if (hasBetTrigger && numbersSum > 0 && targets.length > 0) {
            if (isPrivate) {
                return await bot.sendMessage(chatId, `⚠️ **Играть можно ТОЛЬКО в нашем чате!**\nПереходи: ${CHAT_LINK}`, { parse_mode: 'Markdown' });
            }

            if (isSpinning) return await bot.sendMessage(chatId, '⏳ Рулетка крутится!');

            // 🔥 АНТИ-СПАМ ФИЧА (Кулдаун 3 сек на ставки)
            const now = Date.now();
            const lastBetTime = userBetCooldowns[userId] || 0;
            if (now - lastBetTime < 3000) {
                return await bot.sendMessage(chatId, `⚠️ **${firstName}**, не спам! Подожди 3 сек.`, { parse_mode: 'Markdown' });
            }userBetCooldowns[userId] = now;

            const betPerTarget = numbersSum; 
            const totalRequired = betPerTarget * targets.length;

            if (user.balance < totalRequired) {
                return await bot.sendMessage(chatId, `❌ Нехватка средств! Нужно: **${totalRequired}$**, баланс: **${user.balance}$**`, { parse_mode: 'Markdown' });
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
            saveDB();

            let placedText = [];
            for (const t of targets) {
                currentBets.push({
                    userId,
                    firstName,
                    amount: betPerTarget,
                    target: t
                });
                placedText.push(`${betPerTarget}$ на ${t}`);
            }

            return await bot.sendMessage(chatId, `✅ **${firstName}**: ${placedText.join(', ')}`, { parse_mode: 'Markdown' });
        }

        // 🎲 ЗАПУСК РУЛЕТКИ
        if (text === 'го' || text === 'go' || text === 'старт' || text === 'крутить') {
            if (isPrivate) {
                return await bot.sendMessage(chatId, `⚠️ **Играть можно ТОЛЬКО в нашем чате!**\nПереходи: ${CHAT_LINK}`, { parse_mode: 'Markdown' });
            }

            if (isSpinning) return;
            if (currentBets.length === 0) return await bot.sendMessage(chatId, '⚠️ Сначала сделайте ставку');

            isSpinning = true;
            await bot.sendMessage(chatId, '🎲 Крутим...');

            try { await bot.sendDice(chatId, { emoji: '🎰' }); } catch (e) {}
            await sleep(3800);

            try {
                const num = Math.floor(Math.random() * 37);
                let colorStr = num === 0 ? '🟢 0' : (redNumbers.includes(num) ? `🔴 ${num}` : `⚫️ ${num}`);

                if (!Array.isArray(db.history)) db.history = [];
                db.history.unshift(colorStr);
                if (db.history.length > 10) db.history = db.history.slice(0, 10);

                let isRed = redNumbers.includes(num);
                let isBlack = num !== 0 && !isRed;
                let isEven = num !== 0 && num % 2 === 0;
                let isOdd = num !== 0 && num % 2 !== 0;

                let userResults = {};
                lastRoundBets = {}; 

                for (const bet of currentBets) {
                    if (!userResults[bet.userId]) {
                        userResults[bet.userId] = { firstName: bet.firstName, betsList: [], totalBet: 0, totalWin: 0 };
                    }
                    if (!lastRoundBets[bet.userId]) lastRoundBets[bet.userId] = [];

                    lastRoundBets[bet.userId].push(bet);
                    userResults[bet.userId].totalBet += bet.amount;

                    let win = false;
                    let multiplier = 0;

                    if ((bet.target === 'к' || bet.target === 'красное') && isRed) { win = true; multiplier = 2; }
                    else if ((bet.target === 'ч' || bet.target === 'черное') && isBlack) { win = true; multiplier = 2; }
                    else if ((bet.target === 'чет' || bet.target === 'четное' || bet.target === 'even') && isEven) { win = true; multiplier = 2; }
                    else if ((bet.target === 'нечет' || bet.target === 'нечетное' || bet.target === 'odd') && isOdd) { win = true; multiplier = 2; }
                    else if (!isNaN(bet.target) && parseInt(bet.target) === num) { win = true; multiplier = 36; }
                    else if (bet.target.includes('-')) {
                        const [s, e] = bet.target.split('-').map(Number);
                        if (num >= s && num <= e) {
                            win = true;
                            const count = (e - s) + 1;multiplier = 36 / count; 
                        }
                    }

                    let winAmount = win ? Math.floor(bet.amount * multiplier) : 0;
                    userResults[bet.userId].totalWin += winAmount;

                    userResults[bet.userId].betsList.push({
                        amount: bet.amount,
                        target: bet.target,
                        win: win,
                        winAmount: winAmount
                    });
                }

                let report = `🎰 **Выпало:** ${colorStr}\n\n`;

                for (const uId in userResults) {
                    const res = userResults[uId];
                    const betUser = getUser(uId);

                    betUser.balance += res.totalWin;
                    const netProfit = res.totalWin - res.totalBet;

                    report += `👤 **${res.firstName}**\n`;

                    res.betsList.forEach((b) => {
                        if (b.win) {
                            report += `• ${b.amount}$ на ${b.target} ➔ +${b.winAmount}$\n`;
                        } else {
                            report += `• ${b.amount}$ на ${b.target} ➔ мимо\n`;
                        }
                    });

                    if (netProfit > 0) {
                        report += `Итог: **+${netProfit}$** (Баланс: **${betUser.balance}$**)\n\n`;
                    } else if (netProfit < 0) {
                        report += `Итог: **${netProfit}$** (Баланс: **${betUser.balance}$**)\n\n`;
                    } else {
                        report += `Итог: **0$** (Баланс: **${betUser.balance}$**)\n\n`;
                    }
                }

                currentBets = [];
                isSpinning = false;
                saveDB();

                const actionButtons = {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '🔁 Повторить', callback_data: 'repeat_bet' },
                                { text: '✖️2 Удвоить', callback_data: 'double_bet' }
                            ]
                        ]
                    }
                };

                await bot.sendMessage(chatId, report.trim(), { parse_mode: 'Markdown', ...actionButtons });

            } catch (err) {
                isSpinning = false;
                currentBets = [];
                saveDB();
                console.error('[GAME ERROR]', err.message);
            }
        }

    } catch (globalErr) {
        isSpinning = false;
        currentBets = [];
        console.error('[CRITICAL ERROR]', globalErr.message);
    }
});