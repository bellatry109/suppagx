import 'dotenv/config';
import { Bot } from 'grammy';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';

const {
  BOT_TOKEN,
  ANTHROPIC_API_KEY,
  ADMIN_CHAT_ID,
  MODEL = 'claude-haiku-4-5-20251001',
} = process.env;

const bot = new Bot(BOT_TOKEN);
const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const FAQ = fs.readFileSync(new URL('./faq.md', import.meta.url), 'utf8');

const SYSTEM = `Ты — ассистент поддержки ШОПБОТ, маркетплейса с оплатой криптовалютой. Пишут и покупатели, и продавцы.
Отвечай в Telegram кратко (2–4 предложения), дружелюбно, на языке клиента. Без markdown-разметки.
Используй ТОЛЬКО информацию из базы знаний ниже. Не выдумывай цены, комиссии, сроки, сети и адреса кошельков.
Никогда не называй адреса кошельков и не проси seed-фразу, приватные ключи или переводы. Если клиент упоминает, что кто-то этого требует, предупреди о мошенничестве.
Ответь ровно строкой [HANDOFF], если:
- ответа нет в базе или в нужном ответе стоит пометка [ЗАПОЛНИТЬ];
- проблема с конкретным заказом или платежом (не пришла оплата, ошибка суммы/сети, возврат);
- клиент недоволен или просит живого человека.

<база_знаний>
${FAQ}
</база_знаний>`;

const history = new Map(); // chatId -> история диалога
const pending = new Map(); // id сообщения в админ-чате -> chatId клиента
const MAX_TURNS = 10;

bot.command('start', (ctx) =>
  ctx.reply('Привет! Это поддержка ШОПБОТ 🛍 Спросите про заказ, оплату криптой или размещение товаров. Если нужен менеджер, просто напишите об этом.')
);

// Узнать ID чата: напишите /id в группе операторов
bot.command('id', (ctx) => ctx.reply(String(ctx.chat.id)));

bot.on('message:text', async (ctx) => {
  const chatId = ctx.chat.id;

  // Менеджер отвечает клиенту через Reply в админ-чате
  if (String(chatId) === ADMIN_CHAT_ID) {
    const replyTo = ctx.message.reply_to_message?.message_id;
    const clientId = replyTo && pending.get(replyTo);
    if (clientId) {
      await bot.api.sendMessage(clientId, ctx.message.text);
      await ctx.reply('✅ Отправлено клиенту');
    }
    return;
  }

  const msgs = history.get(chatId) ?? [];
  msgs.push({ role: 'user', content: ctx.message.text });
  await ctx.replyWithChatAction('typing');

  let answer;
  try {
    const res = await claude.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: SYSTEM,
      messages: msgs,
    });
    answer = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  } catch (e) {
    console.error(e);
    msgs.pop();
    return ctx.reply('Извините, произошла ошибка. Попробуйте чуть позже.');
  }

  if (answer.includes('[HANDOFF]')) {
    answer = 'Передал ваш вопрос менеджеру — он ответит здесь в ближайшее время.';
    if (ADMIN_CHAT_ID) {
      const u = ctx.from;
      const sent = await bot.api.sendMessage(
        ADMIN_CHAT_ID,
        `❓ ${u.first_name ?? ''} ${u.username ? '@' + u.username : ''} (id ${u.id}):\n\n${ctx.message.text}\n\n↩️ Ответьте на это сообщение (Reply), чтобы написать клиенту.`
      );
      pending.set(sent.message_id, chatId);
    }
  }

  msgs.push({ role: 'assistant', content: answer });
  history.set(chatId, msgs.slice(-MAX_TURNS * 2));
  await ctx.reply(answer);
});

bot.catch((err) => console.error(err));
bot.start();
console.log('Bot started');
