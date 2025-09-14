import { Telegraf, Markup } from 'telegraf';
import pkg from 'pg';
import dotenv from 'dotenv';
import cron from 'node-cron';

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const { Pool } = pkg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ====== قاعدة البيانات ======
async function initDB() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE,
      binance_id TEXT,
      phone TEXT UNIQUE,
      auto_name TEXT,
      group_id INT,
      verified BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS codes (
      id SERIAL PRIMARY KEY,
      owner_id INT REFERENCES users(id),
      code_text TEXT,
      days_count INT,
      views_per_day INT,
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS code_view_assignments (
      id SERIAL PRIMARY KEY,
      code_id INT REFERENCES codes(id),
      assigned_to_user_id INT REFERENCES users(id),
      assigned_date DATE,
      used BOOLEAN DEFAULT false
    );
  `);
}

// ====== استدعاء مبسط للـ DB ======
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

// ====== State مؤقت ======
const userState = {};
const GROUP_SIZE = parseInt(process.env.GROUP_SIZE || "1000");

// ====== حساب رقم المجموعة ======
async function assignGroup() {
  const res = await q(`SELECT COUNT(*) FROM users`);
  const total = parseInt(res.rows[0].count, 10);
  return Math.floor(total / GROUP_SIZE) + 1;
}

// ====== اسم تلقائي في المجموعة ======
async function autoNameInGroup(groupId) {
  const res = await q(`SELECT COUNT(*) FROM users WHERE group_id=$1`, [groupId]);
  const count = parseInt(res.rows[0].count, 10) + 1;
  return `User${count}`;
}

// ====== ✅ لوحة الأزرار الرئيسية ======
const mainKeyboard = Markup.keyboard([
  ["/register", "/upload_codes"],
  ["/today", "/mycodes"],
  [{ text: "📱 إرسال رقم الهاتف", request_contact: true }],
  ["/help"]
]).resize();

// ====== ✅ أمر /start ======
bot.start((ctx) => {
  ctx.reply(
    "👋 أهلاً بك في البوت!\n\nاستخدم الأزرار بالأسفل أو الأوامر التالية:\n/register - للتسجيل\n/upload_codes - لرفع الأكواد\n/today - لعرض أكواد اليوم\n/mycodes - لعرض الأكواد الخاصة بك",
    mainKeyboard
  );
});

// ====== تسجيل جديد ======
bot.command('register', async (ctx) => {
  const tgId = ctx.from.id;

  const exists = await q(`SELECT id FROM users WHERE telegram_id=$1`, [tgId]);
  if (exists.rowCount > 0) {
    await ctx.reply("أنت مسجل بالفعل ✅");
    return;
  }

  userState[tgId] = { stage: 'awaiting_binance' };
  await ctx.reply("أدخل معرف بينانس الخاص بك:");
});

// ====== استلام معرف بينانس ======
bot.on('text', async (ctx) => {
  const uid = ctx.from.id;
  const st = userState[uid];
  if (!st) return;

  if (st.stage === 'awaiting_binance') {
    st.binance = ctx.message.text.trim();
    st.stage = 'awaiting_phone';
    await ctx.reply("أرسل رقم هاتفك من خلال زر المشاركة:", {
      reply_markup: {
        keyboard: [[{ text: "📱 إرسال رقم الهاتف", request_contact: true }]],
        one_time_keyboard: true,
        resize_keyboard: true
      }
    });
    return;
  }

  if (st.stage === 'uploading_codes') {
    if (ctx.message.text.trim() === '/done') {
      const codes = st.codes || [];
      if (codes.length === 0) {
        await ctx.reply("لم يتم استلام أي كود.");
        delete userState[uid];
        return;
      }
      const userrow = await q('SELECT id FROM users WHERE telegram_id=$1', [uid]);
      const owner_id = userrow.rows[0].id;
      for (const c of codes) {
        await q(
          'INSERT INTO codes (owner_id, code_text, days_count, views_per_day) VALUES ($1,$2,$3,$4)',
          [owner_id, c, 20, 50]
        );
      }
      await ctx.reply(`تم حفظ ${codes.length} أكواد ✅`);
      delete userState[uid];
    } else {
      st.codes.push(ctx.message.text.trim());
      await ctx.reply(`استلمت الكود رقم ${st.codes.length}. اكتب /done عند الانتهاء.`);
    }
  }
});

// ====== استلام رقم الهاتف ======
bot.on('contact', async (ctx) => {
  const contact = ctx.message.contact;
  const tgId = ctx.from.id;
  const st = userState[tgId];
  if (!st || st.stage !== 'awaiting_phone') {
    await ctx.reply("ابدأ التسجيل بكتابة /register");
    return;
  }

  const phone = contact.phone_number;

  const dupPhone = await q('SELECT id FROM users WHERE phone=$1', [phone]);
  if (dupPhone.rowCount > 0) {
    await ctx.reply('⚠️ هذا الرقم مستخدم بالفعل.');
    delete userState[tgId];
    return;
  }

  const groupId = await assignGroup();
  const autoName = await autoNameInGroup(groupId);

  await q(
    `INSERT INTO users (telegram_id, binance_id, phone, auto_name, group_id, verified) 
     VALUES ($1,$2,$3,$4,$5,true)`,
    [tgId, st.binance, phone, autoName, groupId]
  );

  await ctx.reply(`✅ تم التسجيل بنجاح!\nالمجموعة: ${groupId}\nاسمك التلقائي: ${autoName}`, mainKeyboard);
  delete userState[tgId];
});

// ====== رفع الأكواد ======
bot.command('upload_codes', async (ctx) => {
  const uid = ctx.from.id;
  const res = await q('SELECT id FROM users WHERE telegram_id=$1', [uid]);
  if (res.rowCount === 0) {
    await ctx.reply("سجل أولًا باستخدام /register");
    return;
  }
  userState[uid] = { stage: 'uploading_codes', codes: [] };
  await ctx.reply("ارسل الأكواد واحدًا في كل رسالة.\nاكتب /done عند الانتهاء.");
});

// ====== عرض أكواد اليوم ======
bot.command('today', async (ctx) => {
  const uid = ctx.from.id;
  const u = await q('SELECT id, auto_name FROM users WHERE telegram_id=$1', [uid]);
  if (u.rowCount === 0) {
    await ctx.reply("سجل أولًا باستخدام /register");
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
    await ctx.reply("لا يوجد أكواد مخصصة لك اليوم.");
    return;
  }
  for (const row of res.rows) {
    const used = row.used ? '✅ مستخدم' : '🔲 غير مستخدم';
    await ctx.reply(`${row.code_text}\nالحالة: ${used}`);
  }
});

// ====== عرض الأكواد الخاصة بالمستخدم ======
bot.command('mycodes', async (ctx) => {
  const uid = ctx.from.id;
  const res = await q('SELECT id FROM users WHERE telegram_id=$1', [uid]);
  if (res.rowCount === 0) {
    await ctx.reply("سجل أولًا باستخدام /register");
    return;
  }
  const userId = res.rows[0].id;
  const codes = await q('SELECT code_text FROM codes WHERE owner_id=$1', [userId]);
  if (codes.rowCount === 0) {
    await ctx.reply("❌ لا توجد لديك أكواد بعد.");
    return;
  }
  const list = codes.rows.map((c, i) => `${i + 1}. ${c.code_text}`).join("\n");
  await ctx.reply(`📋 أكوادك:\n${list}`);
});

// ====== توزيع الأكواد يومياً ======
cron.schedule('0 0 * * *', async () => {
  console.log("📌 بدء توزيع الأكواد اليومي...");
  const users = await q(`SELECT id FROM users`);
  const codes = await q(`SELECT id, owner_id, days_count, views_per_day FROM codes`);

  const today = new Date().toISOString().slice(0, 10);

  for (const c of codes.rows) {
    if (c.days_count <= 0) continue;

    const availableUsers = users.rows
      .map(u => u.id)
      .filter(uid => uid !== c.owner_id);

    const selected = availableUsers
      .sort(() => 0.5 - Math.random())
      .slice(0, c.views_per_day);

    for (const uid of selected) {
      await q(
        `INSERT INTO code_view_assignments (code_id, assigned_to_user_id, assigned_date) 
         VALUES ($1,$2,$3)`,
        [c.id, uid, today]
      );
    }

    await q(`UPDATE codes SET days_count = days_count - 1 WHERE id=$1`, [c.id]);
  }

  console.log("✅ تم توزيع الأكواد لهذا اليوم");
});

// ====== تشغيل البوت ======
(async () => {
  await initDB();
  bot.launch();
  console.log("🤖 Bot started...");
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
