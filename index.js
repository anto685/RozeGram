const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const http = require('http');

// Сервер для поддержания жизни 24/7 на Render
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('RozeGram Casino 24/7 Engine is Running!');
}).listen(PORT, '0.0.0.0', () => console.log(`[SERVER] Слушаем порт ${PORT}`));

const token = '8919281816:AAH27A8QQXZzpFx9Q4ObF5x4NDhrU7JPRnM'
const dbPath = path.join(__dirname, 'db.json');

let db = { users: {}, history: [] };
let currentBets = []; 
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
        console.error('[DB ERROR] Ошибка чтения:', e.message);
    }
}

function saveDB() {
    try {
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
    } catch (e) {
        console.error('[DB ERROR] Ошибка записи:', e.message);
    }
}

loadDB();

const bot = new TelegramBot(token, { polling: true });

bot.on('polling_error', (error) => {
    console.error(`[POLLING ERROR] ${error.code}: ${error.message}`);
});

function getUser(userId) {
    if (!db.users[userId]) {
        db.users[userId] = { balance: 1000, lastBonus: 0 };
        saveDB();
    }
    return db.users[userId];
}

const redNumbers = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

        // 1. КОМАНДА /START (ТОЛЬКО В ЛИЧКЕ!)
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
                return await bot.sendMessage(
                    chatId, 
                    `🎰 **Добро пожаловать в казино RozeGram!**\n\nПривет, ${firstName}! Рады видеть тебя за нашим столом.\n💰 Твой начальный баланс: **${user.balance}$**\n\nДобавь бота в свою беседу с друзьями или играй прямо здесь! Пользуйся меню ниже 👇`, 
                    { parse_mode: 'Markdown', ...mainMenu }
                );
            }
            return;
        }

        // 2. КНОПКА ПРАВИЛ ИГРЫ
        if (text === '📖 правила игры' || text === 'правила') {
            const rulesText = 
`🎰 **ПРАВИЛА ИГРЫ В КАЗИНО ROZEGRAM** 🎲

Ставки принимаются в формате: [Сумма] [Тип ставки]

📌 Примеры ставок:
• \`100 к\` или \`100 красное\` — ставка на КРАСНОЕ (X2)
• \`200 ч\` или \`200 черное\` — ставка на ЧЕРНОЕ (X2)
• \`500 чет\` — ставка на ЧЕТНЫЕ числа (X2)
• \`500 нечет\` — ставка на НЕЧЕТНЫЕ числа (X2)
• \`300 12\` — ставка на ТОЧНОЕ число от 0 до 36 (X36!)

🚀 Как запустить игру:
После того как вы (и ваши друзья в беседе) сделали ставки, напишите слово го, старт или крутить!

⚠️ *При выпадении Зеро (0) ставки на красное/черное и чет/нечет сгорают!*`;

            return await bot.sendMessage(chatId, rulesText, { parse_mode: 'Markdown' });
        }

        if (text === 'тест' || text === 'ping') {
            return await bot.sendMessage(chatId, '⚙️ Модуль казино активен! Все системы в норме.');
        }

        if (text === 'баланс' || text === 'бал' || text === '💳 баланс') {
            return await bot.sendMessage(chatId, `💳 Ваш баланс: **${user.balance}$**`, { parse_mode: 'Markdown' });
        }

        // ИСТОРИЯ
        if (text === 'история' || text === 'лог') {
            if (!db.history || db.history.length === 0) {
                return await bot.sendMessage(chatId, '📜 История пока пуста! Сделайте первую ставку.');
            }
            const historyText = db.history.map((item, index) => `${index + 1}. ${item}`).join('\n');
            return await bot.sendMessage(chatId, `📜 **Последние выпавшие числа:**\n\n${historyText}`, { parse_mode: 'Markdown' });
        }

        // БОНУС
        if (text === 'бонус' || text === 'бонусы' || text === '🎁 бонус') {
            const now = Date.now();
            const cooldown = 24 * 60 * 60 * 1000;
            const lastBonus = user.lastBonus || 0;

            if (now - lastBonus < cooldown) {
                const timeLeft = cooldown - (now - lastBonus);
                const hoursLeft = Math.floor(timeLeft / (1000 * 60 * 60));
                const minutesLeft = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
                
                return await bot.sendMessage(chatId, `⏳ Забрать бонус можно через **${hoursLeft} ч.** и **${minutesLeft} мин.**`, { parse_mode: 'Markdown' });
            }

            user.balance += 500;
            user.lastBonus = now;
            saveDB();

            return await bot.sendMessage(chatId, `🎉 Вы получили ежедневный бонус **500$**!\n💰 Ваш баланс: **${user.balance}$**`, { parse_mode: 'Markdown' });
        }

        // 3. ПРИЕМ СТАВОК
        const match = text.match(/^(\d+)\s+(к|красное|ч|черное|чет|четное|even|нечет|нечетное|odd|\d+)$/i);
        if (match) {
            if (isSpinning) {
                return await bot.sendMessage(chatId, '⏳ Рулетка уже крутится! Дождитесь окончания раунда.');
            }

            const amount = parseInt(match[1]);
            const target = match[2];

            if (isNaN(amount) || amount <= 0) {
                return await bot.sendMessage(chatId, '❌ Ставка должна быть больше 0!');
            }

            if (user.balance < amount) {
                return await bot.sendMessage(chatId, `❌ Недостаточно средств! Ваш баланс: **${user.balance}$**`, { parse_mode: 'Markdown' });
            }

            if (!isNaN(target) && (parseInt(target) < 0 || parseInt(target) > 36)) {
                return await bot.sendMessage(chatId, '⚠️ Число должно быть от 0 до 36.');
            }

            user.balance -= amount;
            saveDB();

            currentBets.push({
                userId,
                firstName,
                amount,
                target
            });

            return await bot.sendMessage(chatId, `✅ **${firstName}** поставил **${amount}$** на "${target}"!\n\n💡 Напишите **го** или **старт**, чтобы запустить рулетку!`, { parse_mode: 'Markdown' });
        }

        // 4. ЗАПУСК РУЛЕТКИ (ПРОКАЧАННЫЙ И ПЛАВНЫЙ!)
        if (text === 'го' || text === 'go' || text === 'старт' || text === 'крутить') {
            if (isSpinning) return;

            if (currentBets.length === 0) {
                return await bot.sendMessage(chatId, '⚠️ Нельзя запустить рулетку без ставок! Сначала сделайте ставку (пример: 100 к)', { parse_mode: 'Markdown' });
            }

            isSpinning = true;
            await bot.sendMessage(chatId, '🎲 Ставки приняты! Запускаем рулетку...');
            
            try {
                await bot.sendDice(chatId, { emoji: '🎰' });
            } catch (e) {
                console.error('[DICE ERROR]', e.message);
            }

            // Плавная задержка для интриги
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

                for (const bet of currentBets) {
                    if (!userResults[bet.userId]) {
                        userResults[bet.userId] = {
                            firstName: bet.firstName,
                            totalBet: 0,
                            totalWin: 0
                        };
                    }

                    userResults[bet.userId].totalBet += bet.amount;

                    let win = false;
                    let multiplier = 2;

                    if ((bet.target === 'к' || bet.target === 'красное') && isRed) win = true;
                    if ((bet.target === 'ч' || bet.target === 'черное') && isBlack) win = true;
                    if ((bet.target === 'чет' || bet.target === 'четное' || bet.target === 'even') && isEven) win = true;
                    if ((bet.target === 'нечет' || bet.target === 'нечетное' || bet.target === 'odd') && isOdd) win = true;
                    
                    if (!isNaN(bet.target) && parseInt(bet.target) === num) {
                        win = true;
                        multiplier = 36;
                    }

                    if (win) {
                        userResults[bet.userId].totalWin += (bet.amount * multiplier);
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

                await bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });

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