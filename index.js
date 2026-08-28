const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const token =  '8919281816:AAH8kCAj1SCptE1V3CeZA0L6XTWHwZBEllc';
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
    fs.writeFileSync(dbPath, JSON.stringify(users, null, 2), 'utf8');
}

const bot = new TelegramBot(token, { polling: true });

function getUser(id) {
    if (!users[id]) {
        users[id] = { balance: 1000 };
        saveDB();
    }
    return users[id];
}

console.log('Бот успешно запущен!');

const redNumbers = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];

bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text ? msg.text.trim().toLowerCase() : '';
    if (!text) return;

    const user = getUser(chatId);

    if (text === 'тест' || text === 'ping') {
        return bot.sendMessage(chatId, 'Работаю!');
    }

    if (text === 'баланс' || text === 'бал') {
        return bot.sendMessage(chatId, `Ваш баланс: ${user.balance}$`);
    }

    const match = text.match(/^(\d+)\s+(к|красное|ч|черное|\d+)$/i);
    if (match) {
        if (user.inGame) {
            return bot.sendMessage(chatId, 'Подождите, ставка уже обрабатывается!');
        }

        const amount = parseInt(match[1]);
        const target = match[2];

        if (isNaN(amount) || amount <= 0 || user.balance < amount) {
            return bot.sendMessage(chatId, 'Некорректная сумма ставки или недостаточно средств.');
        }

        if (!isNaN(target) && (parseInt(target) < 0 || parseInt(target) > 36)) {
            return bot.sendMessage(chatId, 'Число должно быть от 0 до 36.');
        }

        user.inGame = true;
        user.balance -= amount;
        saveDB();

        bot.sendMessage(chatId, 'Крутим рулетку...');

        setTimeout(() => {
            const num = Math.floor(Math.random() * 37);
            let color = num === 0 ? 'зеленое' : (redNumbers.includes(num) ? 'красное' : 'черное');
            let win = false;

            if ((target === 'к' || target === 'красное') && color === 'красное') win = true;
            if ((target === 'ч' || target === 'черное') && color === 'черное') win = true;
            if (!isNaN(target) && parseInt(target) === num) win = true;

            if (win) {
                const winAmt = (!isNaN(target)) ? amount * 36 : amount * 2;
                user.balance += winAmt;
                bot.sendMessage(chatId, `Победа! Выпало: ${num} (${color}). Выигрыш: ${winAmt}$`);
            } else {
                bot.sendMessage(chatId, `Проигрыш! Выпало: ${num} (${color})`);
            }

            user.inGame = false;
            saveDB();
        }, 1500);
    }
});

bot.on('polling_error', () => {});
