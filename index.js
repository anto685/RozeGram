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
if (fs.existsSync(dbPath)) {
    try {
        users = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    } catch (e) {
        users = {};
    }
}

function saveDB() {
    try {
        fs.writeFileSync(dbPath, JSON.stringify(users, null, 2), 'utf8');
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

console.log('🎰 Казино RozeGram закрутилось 24/7!');

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

    const match = text.match(/^(\d+)\s+(к|красное|ч|черное|\d+)$/i);
    if (match) {
        if (user.inGame) {
            return bot.sendMessage(chatId, '⏳ Подождите, ваша рулетка еще крутится!');
        }

        const amount = parseInt(match[1]);
        const target = match[2];

        if (isNaN(amount) || amount <= 0 || user.balance < amount) {
            return bot.sendMessage(chatId, '❌ Некорректная сумма ставки или недостаточно средств.');
        }

        if (!isNaN(target) && (parseInt(target) < 0 || parseInt(target) > 36)) {
            return bot.sendMessage(chatId, '⚠️ Число должно быть от 0 до 36.');
        }

        user.inGame = true;
        user.balance -= amount;
        saveDB();

        bot.sendMessage(chatId, '🎲 Ставка принята! Крутим рулетку...');

        setTimeout(() => {
            const num = Math.floor(Math.random() * 37);
            let color = num === 0 ? 'зеленое (зеро)' : (redNumbers.includes(num) ? 'красное' : 'черное');
            let win = false;
            let multiplier = 2;

            if ((target === 'к' || target === 'красное') && color === 'красное') win = true;
            if ((target === 'ч' || target === 'черное') && color === 'черное') win = true;
            if (!isNaN(target) && parseInt(target) === num) {
                win = true;
                multiplier = 36;
            }

            user.inGame = false;

            if (win) {
                const winAmount = amount * multiplier;
                user.balance += winAmount;
                saveDB();
                bot.sendMessage(chatId, `🎰 Выпало: ${num} (${color})!\n🎉 ПОБЕДА! Вы выиграли ${winAmount}$!\n💰 Баланс: ${user.balance}$`);
            } else {
                saveDB();
                bot.sendMessage(chatId, `🎰 Выпало: ${num} (${color})!\n❌ Вы проиграли ${amount}$.\n💰 Баланс: ${user.balance}$`);
            }
        }, 3000);
    }
});