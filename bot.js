// bot.js (integrated with full admin_settings fields)
// Requires: telegraf, pg, dotenv, node-cron, express
import { Telegraf, Markup } from 'telegraf';
import pkg from 'pg';
import dotenv from 'dotenv';
import cron from 'node-cron';
import express from 'express';

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const { Pool } = pkg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ====== Admin ID ======
const ADMIN_ID = 6305481147;

// ====== simple DB query wrapper ======
async function q(sql, params) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } catch (err) {
    console.error("❌ DB Error:", err.message);
    throw err;
  } finally {
    client.release();
  }
}

// ====== helpers for admin_settings ======
async function getSettings() {
  const res = await q(`SELECT * FROM admin_settings LIMIT 1`);
  return res.rows[0];
}

async function updateSettings(field, value) {
  await q(`UPDATE admin_settings SET ${field}=$1 WHERE id=1`, [value]);
}

// ====== state ======
const userState = {};
let lastRunDate = null; // to prevent duplicate runs
let adminBroadcastMode = false;

// ====== helpers: group assign & auto-name ======
async function assignGroup(groupSize) {
  const res = await q(`SELECT COUNT(*) FROM users`);
  const total = parseInt(res.rows[0].count, 10);
  return Math.floor(total / groupSize) + 1;
}

async function autoNameInGroup(groupId) {
  const res = await q(`SELECT COUNT(*) FROM users WHERE group_id=$1`, [groupId]);
  const count = parseInt(res.rows[0].count, 10) + 1;
  return `User${count}`;
}

// ====== main keyboard ======
const mainKeyboard = Markup.keyboard([
  ["/تسجيل", "/رفع_اكواد"],
  ["/اكواد_اليوم", "/اكوادى"],
  [{ text: "📱 إرسال رقم الهاتف", request_contact: true }],
  ["/مساعدة"]
]).resize();

// ====== /start ======
bot.start((ctx) => {
  ctx.reply(
    "👋 أهلاً بك في البوت!\n\nاستخدم الأزرار بالأسفل أو الأوامر التالية:\n/تسجيل - للتسجيل\n/رفع_اكواد - لرفع الأكواد\n/اكواد_اليوم - لعرض أكواد اليوم\n/اكوادى - لعرض أكوادك",
    mainKeyboard
  );
});

// ====== registration ======
bot.command('تسجيل', async (ctx) => {
  const tgId = ctx.from.id;
  const exists = await q(`SELECT id FROM users WHERE telegram_id=$1`, [tgId]);
  if (exists.rowCount > 0) {
    await ctx.reply("أنت مسجل بالفعل ✅");
    return;
  }
  userState[tgId] = { stage: 'awaiting_binance' };
  await ctx.reply("أدخل معرف بينانس الخاص بك:");
});

// ====== text handler ======
bot.on('text', async (ctx) => {
  const uid = ctx.from.id;

  // Admin broadcast
  if (uid === ADMIN_ID && adminBroadcastMode) {
    adminBroadcastMode = false;
    const message = ctx.message.text;
    const users = await q(`SELECT telegram_id FROM users`);
    let success = 0;
    for (const row of users.rows) {
      try {
        await bot.telegram.sendMessage(row.telegram_id, `📢 رسالة من الأدمن:\n\n${message}`);
        success++;
      } catch (err) {
        console.error(`❌ Failed to send to ${row.telegram_id}:`, err.message);
      }
    }
    await ctx.reply(`✅ تم إرسال الرسالة إلى ${success} مستخدم.`);
    return;
  }

  // User flow
  const st = userState[uid];
  if (!st) return;

  if (st.stage === 'awaiting_binance') {
    st.binance = ctx.message.text.trim();
    st.stage = 'awaiting_phone';
    await ctx.reply("أرسل رقم هاتفك عبر زر المشاركة:", {
      reply_markup: {
        keyboard: [[{ text: "📱 إرسال رقم الهاتف", request_contact: true }]],
        one_time_keyboard: true,
        resize_keyboard: true
      }
    });
    return;
  }

  if (st.stage === 'uploading_codes') {
    if (ctx.message.text.trim() === '/done' || ctx.message.text.trim() === '/انتهيت') {
      const codes = st.codes || [];
      if (codes.length === 0) {
        await ctx.reply("لم يتم استلام أي كود.");
        delete userState[uid];
        return;
      }
      const userrow = await q('SELECT id FROM users WHERE telegram_id=$1', [uid]);
      const owner_id = userrow.rows[0].id;
      const settings = await getSettings();
      for (const c of codes) {
        await q(
          'INSERT INTO codes (owner_id, code_text, days_count, views_per_day) VALUES ($1,$2,$3,$4)',
          [owner_id, c, settings.distribution_days, settings.daily_codes_limit]
        );
      }
      await ctx.reply(`تم حفظ ${codes.length} أكواد ✅`);
      delete userState[uid];
    } else {
      st.codes.push(ctx.message.text.trim());
      await ctx.reply(`استلمت الكود رقم ${st.codes.length}. اكتب /done عند الانتهاء.`);
    }
    return;
  }
});

// ====== contact handler ======
bot.on('contact', async (ctx) => {
  const contact = ctx.message.contact;
  const tgId = ctx.from.id;
  const st = userState[tgId];
  if (!st || st.stage !== 'awaiting_phone') {
    await ctx.reply("ابدأ التسجيل بكتابة /تسجيل");
    return;
  }

  const phone = contact.phone_number;
  const dupPhone = await q('SELECT id FROM users WHERE phone=$1', [phone]);
  if (dupPhone.rowCount > 0) {
    await ctx.reply('⚠️ هذا الرقم مستخدم بالفعل.');
    delete userState[tgId];
    return;
  }

  const settings = await getSettings();
  const groupId = await assignGroup(settings.group_size);
  const autoName = await autoNameInGroup(groupId);

  await q(
    `INSERT INTO users (telegram_id, binance_id, phone, auto_name, group_id, verified) 
     VALUES ($1,$2,$3,$4,$5,true)`,
    [tgId, st.binance, phone, autoName, groupId]
  );

  await ctx.reply(`✅ تم التسجيل بنجاح!\nالمجموعة: ${groupId}\nاسمك التلقائي: ${autoName}`, mainKeyboard);
  delete userState[tgId];
});

// ====== upload codes ======
bot.command('رفع_اكواد', async (ctx) => {
  const uid = ctx.from.id;
  const res = await q('SELECT id FROM users WHERE telegram_id=$1', [uid]);
  if (res.rowCount === 0) {
    await ctx.reply("سجل أولًا باستخدام /تسجيل");
    return;
  }
  userState[uid] = { stage: 'uploading_codes', codes: [] };
  await ctx.reply("ارسل الأكواد واحدًا في كل رسالة.\nاكتب /done عند الانتهاء.");
});

// ====== today codes ======
bot.command('اكواد_اليوم', async (ctx) => {
  const uid = ctx.from.id;
  const u = await q('SELECT id FROM users WHERE telegram_id=$1', [uid]);
  if (u.rowCount === 0) {
    await ctx.reply("سجل أولًا باستخدام /تسجيل");
    return;
  }
  const userId = u.rows[0].id;
  const today = new Date().toISOString().slice(0, 10);
  const res = await q(
    `SELECT a.id as a_id, c.code_text, a.used 
     FROM code_view_assignments a 
     JOIN codes c ON a.code_id=c.id 
     WHERE a.assigned_to_user_id=$1 AND a.assigned_date=$2`,
    [userId, today]
  );
  if (res.rowCount === 0) {
    await ctx.reply("لا يوجد أكواد اليوم.");
    return;
  }
  for (const row of res.rows) {
    const used = row.used ? '✅ مستخدم' : '🔲 غير مستخدم';
    await ctx.reply(`${row.code_text}\nالحالة: ${used}`);
  }
});

// ====== my codes ======
bot.command('اكوادى', async (ctx) => {
  const uid = ctx.from.id;
  const res = await q('SELECT id FROM users WHERE telegram_id=$1', [uid]);
  if (res.rowCount === 0) {
    await ctx.reply("سجل أولًا باستخدام /تسجيل");
    return;
  }
  const userId = res.rows[0].id;
  const codes = await q('SELECT code_text FROM codes WHERE owner_id=$1', [userId]);
  if (codes.rowCount === 0) {
    await ctx.reply("❌ لا توجد لديك أكواد.");
    return;
  }
  const list = codes.rows.map((c, i) => `${i + 1}. ${c.code_text}`).join("\n");
  await ctx.reply(`📋 أكوادك:\n${list}`);
});

// ====== daily distribution ======
async function runDailyDistribution() {
  console.log("📌 Starting daily distribution...");
  const settings = await getSettings();
  const usersRes = await q(`SELECT id FROM users`);
  const codesRes = await q(`SELECT id, owner_id, days_count, views_per_day FROM codes WHERE days_count > 0`);

  const users = usersRes.rows.map(r => r.id);
  const codes = codesRes.rows;
  const today = new Date().toISOString().slice(0, 10);

  for (const c of codes) {
    if (c.days_count <= 0) continue;

    const availableUsers = users.filter(uid => uid !== c.owner_id);
    if (availableUsers.length === 0) continue;

    const shuffled = availableUsers.sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, c.views_per_day);

    for (const uid of selected) {
      try {
        await q(
          `INSERT INTO code_view_assignments (code_id, assigned_to_user_id, assigned_date) 
           VALUES ($1,$2,$3)`,
          [c.id, uid, today]
        );
      } catch {}
    }
    await q(`UPDATE codes SET days_count = days_count - 1 WHERE id=$1`, [c.id]);
  }
  console.log("✅ Distribution complete");
}

// ====== scheduler ======
cron.schedule('* * * * *', async () => {
  try {
    const s = await getSettings();
    if (!s.is_scheduler_active) return;
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const ymdhm = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()} ${hour}:${minute}`;
    const sendHour = parseInt(s.send_time.split(":")[0], 10);
    if (hour === sendHour && minute === 0 && lastRunDate !== ymdhm) {
      lastRunDate = ymdhm;
      await runDailyDistribution();
    }
  } catch (err) {
    console.error("Scheduler error:", err);
  }
});

// ====== Admin panel ======
bot.command('admin', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply("❌ مخصص للأدمن فقط.");

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("📴 Toggle Scheduler", "toggle_scheduler")],
    [Markup.button.callback("⏰ Set Send Time", "set_time")],
    [Markup.button.callback("👁️ Set Daily Limit", "set_limit")],
    [Markup.button.callback("📅 Set Days", "set_days")],
    [Markup.button.callback("👥 Set Group Size", "set_group")],
    [Markup.button.callback("📢 Broadcast", "broadcast")],
    [Markup.button.callback("📊 Stats", "stats")]
  ]);

  await ctx.reply("🔐 Admin Panel:", keyboard);
});

// ====== callback handler ======
bot.on('callback_query', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Not allowed");
  const action = ctx.callbackQuery.data;

  if (action === "toggle_scheduler") {
    const s = await getSettings();
    await updateSettings("is_scheduler_active", !s.is_scheduler_active);
    await ctx.reply(`✅ Scheduler: ${!s.is_scheduler_active ? "Enabled" : "Disabled"}`);
  } else if (action === "set_time") {
    await ctx.reply("⏰ Send: /set_time 09:00");
  } else if (action === "set_limit") {
    await ctx.reply("👁️ Send: /set_limit 50");
  } else if (action === "set_days") {
    await ctx.reply("📅 Send: /set_days 20");
  } else if (action === "set_group") {
    await ctx.reply("👥 Send: /set_group 1000");
  } else if (action === "broadcast") {
    adminBroadcastMode = true;
    await ctx.reply("📢 Send message to broadcast:");
  } else if (action === "stats") {
    const u = await q(`SELECT COUNT(*) FROM users`);
    const c = await q(`SELECT COUNT(*) FROM codes`);
    const s = await getSettings();
    await ctx.reply(`📊 Users: ${u.rows[0].count}\nCodes: ${c.rows[0].count}\nScheduler: ${s.is_scheduler_active ? "On" : "Off"}\nLimit: ${s.daily_codes_limit}\nDays: ${s.distribution_days}\nGroup: ${s.group_size}\nTime: ${s.send_time}`);
  }
  await ctx.answerCbQuery();
});

// ====== Admin text commands ======
bot.command("set_time", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const time = ctx.message.text.split(" ")[1];
  if (!/^\d{2}:\d{2}$/.test(time)) return ctx.reply("❌ Invalid format. Example: /set_time 09:00");
  await updateSettings("send_time", time);
  await ctx.reply(`✅ Send time set to ${time}`);
});

bot.command("set_limit", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const val = parseInt(ctx.message.text.split(" ")[1], 10);
  if (isNaN(val)) return ctx.reply("❌ Invalid number");
  await updateSettings("daily_codes_limit", val);
  await ctx.reply(`✅ Daily limit set to ${val}`);
});

bot.command("set_days", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const val = parseInt(ctx.message.text.split(" ")[1], 10);
  if (isNaN(val)) return ctx.reply("❌ Invalid number");
  await updateSettings("distribution_days", val);
  await ctx.reply(`✅ Distribution days set to ${val}`);
});

bot.command("set_group", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const val = parseInt(ctx.message.text.split(" ")[1], 10);
  if (isNaN(val)) return ctx.reply("❌ Invalid number");
  await updateSettings("group_size", val);
  await ctx.reply(`✅ Group size set to ${val}`);
});

// ====== Webhook / Web Service setup ======
const RENDER_URL = process.env.RENDER_URL || "";
const secretPath = process.env.SECRET_PATH || "/bot-webhook";

if (RENDER_URL) {
  (async () => {
    try {
      const app = express();
      app.use(express.json());

      const fullWebhookUrl = `${RENDER_URL.replace(/\/$/, "")}${secretPath}`;
      await bot.telegram.setWebhook(fullWebhookUrl);
      app.use(bot.webhookCallback(secretPath));

      app.get('/', (req, res) => res.send('✅ Bot server is running!'));

      const PORT = process.env.PORT || 3000;
      app.listen(PORT, () => console.log(`🚀 Webhook running on ${PORT}, URL: ${fullWebhookUrl}`));
    } catch (err) {
      console.error("Failed to start webhook:", err);
      process.exit(1);
    }
  })();
} else {
  (async () => {
    try {
      await bot.telegram.deleteWebhook();
      bot.launch();
      console.log("🚀 Bot running with long polling...");
    } catch (err) {
      console.error("Failed to start bot:", err);
    }
  })();
}
