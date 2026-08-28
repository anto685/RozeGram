const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const http = require('http');

// Сервер 24/7 для Render
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('RozeGram Casino 24/7 Flex Engine Active!');
}).listen(PORT, '0.0.0.0', () => console.log(`[SERVER] Engine running on port ${PORT}`));

const token = '8919281816:AAEcEKc7U5qz5lZpCRRSdMDkx1T9pIlstI0';
const dbPath = path.join(__dirname, 'db.json');

let db = { users: {}, history: [] };
let currentBets = []; 
let lastRoundBets = {}; 
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

const redNumbers = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Кнопки Удвоить / Повторить
bot.on('callback_query', async (query) => {
    try {
        const userId = query.from.id;
        const firstName = query.from.first_name || 'Игрок';
        const chatId = query.message.chat.id;
        const action = query.data;

        if (isSpinning) {
            return await bot.answerCallbackQuery(query.id, { text: '⏳ Рулетка крутится, подожди!', show_alert: true });
        }

        const user = getUser(userId);
        const userLastBets = lastRoundBets[userId];

        if (!userLastBets || userLastBets.length === 0) {
            return await bot.answerCallbackQuery(query.id, { text: '⚠️ Нет ставок с прошлого раунда!', show_alert: true });
        }

        let multiplier = (action === 'repeat_bet') ? 1 : 2;
        let totalCost = userLastBets.reduce((sum, b) => sum + (b.amount * multiplier), 0);

        if (user.balance < totalCost) {
            return await bot.answerCallbackQuery(query.id, { text: `❌ Нужно ${totalCost}$, а у тебя ${user.balance}$`, show_alert: true });
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
            addedText.push(`${newAmount}$ на "${oldBet.target}"`);
        }

        await bot.answerCallbackQuery(query.id, { text: `✅ Ставка сделана!` });
        await bot.sendMessage(chatId, `🎰 **${firstName}** ${action === 'repeat_bet' ? 'повторил' : 'удвоил'} ставку: ${addedText.join(', ')}!\n\n💡 Напишите **го**, чтобы крутить!`, { parse_mode: 'Markdown' });

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

        if (text === '/start') {
            if (isPrivate) {
                const mainMenu = {
                    reply_markup: {
                        keyboard: [
                            [{ text: '💳 Баланс' }, { text: '🎁 Бонус' }],
                            [{ text: '📖 Правила игры' }]
                        ],
                        resize_keyboard: true
                    }
                };
                return await bot.sendMessage(chatId, `🎰 **Добро пожаловать в RozeGram Casino!**\n\nПривет, ${firstName}!\n💰 Твой баланс: **${user.balance}$**\n\nИграй прямо тут или добавь бота в беседу!`, { parse_mode: 'Markdown', ...mainMenu });
            }
            return;
        }

        if (text === '📖 правила игры' || text === 'правила') {
            const rulesText = 
`🎰 **ПРАВИЛА И СТАВКИ ROZEGRAM CASINO** 🎲

📌 **Форматы ставок (УЛЬТРА ГИБКИЕ):**

• \`100 к\` или \`к 1000 1000 1000\` — Ставка на Красное (сложит в 3000$)!
• \`500 чет\` / \`500 нечет\` — Чет / Нечет (x2)
• \`300 12\` — Число от 0 до 36 (x36!)
• \`300 12-18 22-28\` — Поставит по 300$ на ДВА диапазона сразу!

🚀 Напиши **го** или **старт**, когда сделаешь ставки!`;
            return await bot.sendMessage(chatId, rulesText, { parse_mode: 'Markdown' });
        }

        if (text === 'баланс' || text === 'бал' || text === '💳 баланс') {
            return await bot.sendMessage(chatId, `💳 Ваш баланс: **${user.balance}$**`, { parse_mode: 'Markdown' });
        }

        if (text === 'история' || text === 'лог') {
            if (!db.history || db.history.length === 0) return await bot.sendMessage(chatId, '📜 История пока пуста!');
            const historyText = db.history.map((item, index) => `${index + 1}. ${item}`).join('\n');
            return await bot.sendMessage(chatId, `📜 **Последние выпавшие числа:**\n\n${historyText}`, { parse_mode: 'Markdown' });
        }

        if (text === 'бонус' || text === 'бонусы' || text === '🎁 бонус') {
            const now = Date.now();
            const cooldown = 24 * 60 * 60 * 1000;
            const lastBonus = user.lastBonus || 0;

            if (now - lastBonus < cooldown) {
                const timeLeft = cooldown - (now - lastBonus);
                const h = Math.floor(timeLeft / (1000 * 60 * 60));
                const m = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
                return await bot.sendMessage(chatId, `⏳ Бонус доступен через **${h} ч.** и **${m} мин.**`, { parse_mode: 'Markdown' });
            }

            user.balance += 500;
            user.lastBonus = now;
            saveDB();
            return await bot.sendMessage(chatId, `🎉 Вы получили бонус **500$**!\n💰 Баланс: **${user.balance}$**`, { parse_mode: 'Markdown' });
        }

        // 🎯 УМНЫЙ ПАРСЕР СТАВОК (СЛОЖЕНИЕ И МУЛЬТИ-ДИАПАЗОНЫ)
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

        // Если нашли ставки и хотя бы одну цель
        if (hasBetTrigger && numbersSum > 0 && targets.length > 0) {
            if (isSpinning) return await bot.sendMessage(chatId, '⏳ Рулетка крутится! Жди окончания раунда.');

            const betPerTarget = numbersSum; 
            const totalRequired = betPerTarget * targets.length;

            if (user.balance < totalRequired) {
                return await bot.sendMessage(chatId, `❌ Недостаточно средств! Нужно: **${totalRequired}$**, твой баланс: **${user.balance}$**`, { parse_mode: 'Markdown' });
            }

            // Валидация диапазонов
            for (const t of targets) {
                if (t.includes('-')) {
                    const [s, e] = t.split('-').map(Number);
                    if (s < 0 || e > 36 || s >= e) {
                        return await bot.sendMessage(chatId, `❌ **Кринж диапазон "${t}"!** Числа от 0 до 36, первое МЕНЬШЕ второго.`, { parse_mode: 'Markdown' });
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
                placedText.push(`**${betPerTarget}$** на "${t}"`);
            }

            return await bot.sendMessage(chatId, `✅ **${firstName}** поставил: ${placedText.join(', ')}!\n\n💡 Напишите **го**, чтобы запустить рулетку!`, { parse_mode: 'Markdown' });
        }

        // 🎲 ЗАПУСК РУЛЕТКИ
        if (text === 'го' || text === 'go' || text === 'старт' || text === 'крутить') {
            if (isSpinning) return;
            if (currentBets.length === 0) return await bot.sendMessage(chatId, '⚠️ Нет ставок! Сначала сделайте ставку.');

            isSpinning = true;
            await bot.sendMessage(chatId, '🎲 Ставки приняты! Запускаем рулетку...');

            try { await bot.sendDice(chatId, { emoji: '🎰' }); } catch (e) {}
            await sleep(3800);

            try {
                const num = Math.floor(Math.random() * 37);
                let colorStr = num === 0 ? '🟢 0 (Зеро)' : (redNumbers.includes(num) ? `🔴 ${num} (Красное)` : `⚫️ ${num} (Черное)`);

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
                        userResults[bet.userId] = { firstName: bet.firstName, totalBet: 0, totalWin: 0 };
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
                            const count = (e - s) + 1;
                            multiplier = 36 / count; 
                        }
                    }

                    if (win) {
                        userResults[bet.userId].totalWin += Math.floor(bet.amount * multiplier);
                    }
                }

                let report = `🎰 **Выпало: ${colorStr}!**\n\n📝 **Результаты раунда:**\n\n`;

                for (const uId in userResults) {
                    const res = userResults[uId];
                    const betUser = getUser(uId);

                    betUser.balance += res.totalWin;
                    const netProfit = res.totalWin - res.totalBet;

                    if (netProfit > 0) {
                        report += `🎉 **${res.firstName}**: +${netProfit}$ 💸 (Баланс: ${betUser.balance}$)\n`;
                    } else if (netProfit < 0) {
                        report += `❌ **${res.firstName}**: ${netProfit}$ 🔻 (Баланс: ${betUser.balance}$)\n`;
                    } else {
                        report += `⚖️ **${res.firstName}**: В нуле 🤝 (Баланс: ${betUser.balance}$)\n`;
                    }
                }

                currentBets = [];
                isSpinning = false;
                saveDB();

                const actionButtons = {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '🔁 Повторить ставку', callback_data: 'repeat_bet' },
                                { text: '✖️2 Удвоить', callback_data: 'double_bet' }
                            ]
                        ]
                    }
                };

                await bot.sendMessage(chatId, report, { parse_mode: 'Markdown', ...actionButtons });

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