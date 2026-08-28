const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('RozeGram Casino 24/7 is Live!');
}).listen(PORT, () => console.log(`Веб-сервер слушает порт ${PORT}`));

const token = '8919281816:AAH8kCAj1SCptE1V3CeZA0L6XTWHwZBEllc';
const dbPath = path.join(__dirname, 'db.json');

let users = {};
let history = []; // Массив для истории результатов

if (fs.existsSync(dbPath)) {
    try {
        const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        users = data.users || {};
        history = data.history || [];
    } catch (e) {
        users = {};
        history = [];
    }
}

function saveDB() {
    try {
        fs.writeFileSync(dbPath, JSON.stringify({ users, history }, null, 2), 'utf8');
    } catch (e) {
        console.error("Ошибка сохранения БД:", e);
    }
}

const bot = new TelegramBot(token, { polling: true });

function getUser(id) {
    if (!users[id]) {
        users[id] = { balance: 1000, lastBonus: 0, inGame: false };
        saveDB();
    }
    return users[id];
}

const redNumbers = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];

bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text ? msg.text.trim().toLowerCase() : '';
    if (!text) return;

    const user = getUser(chatId);

    if (text === 'тест' || text === 'ping') {
        return bot.sendMessage(chatId, 'Работаю! Казино 24/7!');
    }

    if (text === 'баланс' || text === 'бал') {
        return bot.sendMessage(chatId, `💳 Ваш баланс: ${user.balance}$`);
    }

    // ИСТОРИЯ ВЫПАДЕНИЙ
    if (text === 'история' || text === 'лог' || text === 'история ставок') {
        if (history.length === 0) {
            return bot.sendMessage(chatId, '📜 История рулетки пока пуста!');
        }
        const historyText = history.map((item, index) => `${index + 1}. ${item}`).join('\n');
        return bot.sendMessage(chatId, `📜 **Последние выпавшие числа:**\n\n${historyText}`, { parse_mode: 'Markdown' });
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
            
            return bot.sendMessage(chatId, `⏳ Вы уже забирали бонус! Заходите через ${hoursLeft} ч. и ${minutesLeft} мин.`);
        }

        user.balance += 500;
        user.lastBonus = now;
        saveDB();

        return bot.sendMessage(chatId, `🎉 Вы получили ежедневный бонус 500$!\n💰 Ваш баланс: ${user.balance}$`);
    }

    // РУЛЕТКА
    const match = text.match(/^(\d+)\s+(к|красное|ч|черное|чет|четное|even|нечет|нечетное|odd|\d+)$/i);
    if (match) {
        if (user.inGame) return;

        const amount = parseInt(match[1]);
        const target = match[2];

        if (isNaN(amount) || amount <= 0) {
            return bot.sendMessage(chatId, '❌ Ставка должна быть больше 0!');
        }

        if (user.balance < amount) {
            return bot.sendMessage(chatId, `❌ Недостаточно средств! Ваш баланс: ${user.balance}$`);
        }

        if (!isNaN(target) && (parseInt(target) < 0 || parseInt(target) > 36)) {
            return bot.sendMessage(chatId,'⚠️ Число должно быть от 0 до 36.');
        }

        user.inGame = true;
        user.balance -= amount;
        saveDB();

        bot.sendMessage(chatId, `🎲 Ставка ${amount}$ принята! Крутим...`);

        setTimeout(() => {
            const num = Math.floor(Math.random() * 37);
            let color = num === 0 ? '🟢 0 (Зеро)' : (redNumbers.includes(num) ? `🔴 ${num} (Красное)` : `⚫️ ${num} (Черное)`);
            
            // Сохраняем в историю (максимум 10 последних)
            history.unshift(color);
            if (history.length > 10) history.pop();

            let isRed = redNumbers.includes(num);
            let isBlack = num !== 0 && !isRed;
            let isEven = num !== 0 && num % 2 === 0;
            let isOdd = num !== 0 && num % 2 !== 0;

            let win = false;
            let multiplier = 2;

            if ((target === 'к' || target === 'красное') && isRed) win = true;
            if ((target === 'ч' || target === 'черное') && isBlack) win = true;
            if ((target === 'чет' || target === 'четное' || target === 'even') && isEven) win = true;
            if ((target === 'нечет' || target === 'нечетное' || target === 'odd') && isOdd) win = true;
            
            if (!isNaN(target) && parseInt(target) === num) {
                win = true;
                multiplier = 36;
            }

            user.inGame = false;

            if (win) {
                const totalWin = amount * multiplier;
                user.balance += totalWin;
                saveDB();
                bot.sendMessage(chatId, `🎰 Выпало: ${color}!\n🎉 ПОБЕДА! Вы выиграли ${totalWin}$!\n💰 Баланс: ${user.balance}$`);
            } else {
                saveDB();
                bot.sendMessage(chatId, `🎰 Выпало: ${color}!\n❌ Проигрыш ${amount}$.\n💰 Баланс: ${user.balance}$`);
            }
        }, 3000);
    }
});