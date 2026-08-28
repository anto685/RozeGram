const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('RozeGram Casino 24/7 is Live!');
}).listen(PORT, () => console.log(`[SERVER] Слушаем порт ${PORT}`));

const token = 'ВСТАВЬ_СВОЙ_ТОКЕН_СЮДА';
const dbPath = path.join(__dirname, 'db.json');

let db = { users: {}, history: [] };
// Очередь ставок текущего стола
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

bot.on('message', async (msg) => {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from ? msg.from.id : null;
        const firstName = msg.from ? msg.from.first_name : 'Игрок';
        if (!userId) return;

        const text = msg.text ? msg.text.trim().toLowerCase() : '';
        if (!text) return;

        const user = getUser(userId);

        if (text === 'тест' || text === 'ping') {
            return await bot.sendMessage(chatId, '⚙️ Казик на базе! Все системы в норме.');
        }

        if (text === 'баланс' || text === 'бал') {
            return await bot.sendMessage(chatId, `💳 Ваш баланс: ${user.balance}$`);
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
        if (text === 'бонус' || text === 'бонусы') {
            const now = Date.now();
            const cooldown = 24 * 60 * 60 * 1000;
            const lastBonus = user.lastBonus || 0;

            if (now - lastBonus < cooldown) {
                const timeLeft = cooldown - (now - lastBonus);
                const hoursLeft = Math.floor(timeLeft / (1000 * 60 * 60));
                const minutesLeft = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
                
                return await bot.sendMessage(chatId, `⏳ Забрать бонус можно через ${hoursLeft}ч. и ${minutesLeft} мин.`);
            }

            user.balance += 500;
            user.lastBonus = now;
            saveDB();

            return await bot.sendMessage(chatId, `🎉 Вы получили ежедневный бонус 500$!\n💰 Ваш баланс: ${user.balance}$`);
        }

        // 1. ПРИЕМ СТАВКИ (Пример: "100 к", "500 чет", "300 12")
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
                return await bot.sendMessage(chatId, `❌ Недостаточно средств! Ваш баланс: ${user.balance}$`);
            }

            if (!isNaN(target) && (parseInt(target) < 0 || parseInt(target) > 36)) {
                return await bot.sendMessage(chatId, '⚠️ Число должно быть от 0 до 36.');
            }

            // Списываем баланс и добавляем в банк стола
            user.balance -= amount;
            saveDB();

            currentBets.push({
                userId,
                firstName,
                amount,
                target
            });

            return await bot.sendMessage(chatId, `✅ **${firstName}** поставил ${amount}$ на "${target}"!\n\n💡 Напишите **го** или **старт**, чтобы запустить рулетку!`, { parse_mode: 'Markdown' });
        }

        // 2. ЗАПУСК РУЛЕТКИ (Команды: "го", "go", "старт", "крутить")
        if (text === 'го' || text === 'go' || text === 'старт' || text === 'крутить') {
            if (isSpinning) return;

            if (currentBets.length === 0) {
                return await bot.sendMessage(chatId, '❌ На столе нет ставок! Сначала сделайте ставку (например: `100 к`)', { parse_mode: 'Markdown' });
            }

            isSpinning = true;
            await bot.sendMessage(chatId, `🎲 Ставки сделаны! Запускаем рулетку...`);
            
            try {
                await bot.sendDice(chatId, { emoji: '🎰' });
            } catch (e) {
                console.error('[DICE ERROR]', e.message);
            }

            setTimeout(async () => {
                try {
                    const num = Math.floor(Math.random() * 37);
                    let colorStr = num === 0 ? '🟢 0 (Зеро)' : (redNumbers.includes(num) ? `🔴 ${num} (Красное)` : `⚫️ ${num} (Черное)`);
                    
                    // Обновляем историю
                    if (!Array.isArray(db.history)) db.history = [];
                    db.history.unshift(colorStr);
                    if (db.history.length > 10) db.history = db.history.slice(0, 10);

                    let isRed = redNumbers.includes(num);
                    let isBlack = num !== 0 && !isRed;
                    let isEven = num !== 0 && num % 2 === 0;
                    let isOdd = num !== 0 && num % 2 !== 0;

                    let report = `🎰 **Выпало: ${colorStr}!**\n\n📝 **Результаты раунда:**\n`;

                    // Подсчет результатов для каждого игрока
                    for (const bet of currentBets) {
                        const betUser = getUser(bet.userId);
                        let win = false;
                        let multiplier = 2;

                        if ((bet.target === 'к' || bet.target === 'красное') && isRed) win = true;
                        if ((bet.target === 'ч' || bet.target === 'черное') && isBlack) win = true;
                        if ((bet.target === 'чет' || bet.target === 'четное' || bet.target === 'even') && isEven) win = true;
                        if ((bet.target === 'нечет' || bet.target === 'нечетное' || bet.target === 'odd') && isOdd) win = true;
                        
                        if (!isNaN(bet.target) && parseInt(bet.target) === num) {win = true;
                            multiplier = 36;
                        }

                        if (win) {
                            const totalWin = bet.amount * multiplier;
                            betUser.balance += totalWin;
                            report += `🎉 ${bet.firstName}: +${totalWin}$ (Баланс: ${betUser.balance}$)\n`;
                        } else {
                            report += `❌ ${bet.firstName}: -${bet.amount}$ (Баланс: ${betUser.balance}$)\n`;
                        }
                    }

                    // Очищаем стол для новых ставок
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
            }, 3500);
        }

    } catch (globalErr) {
        console.error('[CRITICAL ERROR]', globalErr.message);
    }
});