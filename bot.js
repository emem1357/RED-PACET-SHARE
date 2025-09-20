// bot.js
// Telegram Bot — updated for "one code = one day" model and auto groups
// Requires: telegraf, pg, dotenv, node-cron, express

import { Telegraf, Markup } from "telegraf";
import fs from "fs";
import pkg from "pg";
import dotenv from "dotenv";
import cron from "node-cron";
import express from "express";

dotenv.config();

// ====== Init Bot & DB ======
const bot = new Telegraf(process.env.BOT_TOKEN);
const { Pool } = pkg;

// Read optional CA cert safely (if present)
let sslConfig = false;
try {
  const ca = fs.readFileSync("./supabase-ca.crt").toString();
  sslConfig = {
    ca,
    rejectUnauthorized: true,
  };
} catch (e) {
  // file not found or can't read -> skip ssl (useful for local/dev)
  console.warn("⚠️ supabase-ca.crt not found or unreadable — continuing without custom SSL CA.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(sslConfig ? { ssl: sslConfig } : {}),
});

// ====== Admin ID (owner) ======
const ADMIN_ID = process.env.ADMIN_ID; // keep as string from env

// ====== simple DB query wrapper ======
async function q(sql, params) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } catch (err) {
    console.error("❌ DB Error:", err.message, "\nSQL:", sql, "\nParams:", params);
    throw err;
  } finally {
    client.release();
  }
}

// ====== Ensure admin_settings exists and defaults ======
async function ensureAdminSettings() {
  try {
    await q(
      `INSERT INTO admin_settings (id, daily_codes_limit, distribution_days, group_size, send_time, is_scheduler_active)
       VALUES (1, 50, 20, 1000, '09:00:00', $1)
       ON CONFLICT (id) DO NOTHING`,
      [false] // ✅ use parameterized boolean
    );
  } catch (err) {
    // ignore intentionally (we want getSettings to fallback)
    console.warn("ensureAdminSettings warning:", err?.message || err);
  }
}

async function getSettings() {
  try {
    await ensureAdminSettings();
    const res = await q(`SELECT * FROM admin_settings WHERE id = 1 LIMIT 1`);
    if (!res.rows || res.rows.length === 0) {
      return {
        daily_codes_limit: 50,
        distribution_days: 20,
        group_size: 1000,
        send_time: "09:00:00",
        is_scheduler_active: false,
      };
    }
    return res.rows[0];
  } catch (err) {
    console.error("❌ getSettings error:", err.message);
    return {
      daily_codes_limit: 50,
      distribution_days: 20,
      group_size: 1000,
      send_time: "09:00:00",
      is_scheduler_active: false,
    };
  }
}

async function updateSettings(field, value) {
  try {
    await q(`UPDATE admin_settings SET ${field}=$1 WHERE id=1`, [value]);
  } catch (err) {
    console.error("❌ updateSettings error:", err.message);
    throw err;
  }
}

// ====== state ======
const userState = {}; // keyed by telegram_id string
let lastRunDate = null; // to prevent duplicate scheduler runs
let adminBroadcastMode = false;

// ====== helpers: groups & auto-name ======
async function assignGroupIdBySettings(groupSize) {
  try {
    const res = await q(
      `SELECT g.id, COALESCE(u_count.count, 0) as members_count, g.max_users
       FROM groups g
       LEFT JOIN (
         SELECT group_id, COUNT(*) as count FROM users GROUP BY group_id
       ) u_count ON u_count.group_id = g.id
       WHERE COALESCE(u_count.count, 0) < g.max_users
       ORDER BY g.created_at NULLS FIRST
       LIMIT 1`
    );
    if (res.rowCount > 0) {
      return res.rows[0].id;
    }

    const insert = await q(
      `INSERT INTO groups (name, max_users, created_at)
       VALUES ($1, $2, NOW())
       RETURNING id`,
      [`Group-${Date.now()}`, groupSize]
    );
    return insert.rows[0].id;
  } catch (err) {
    console.error("❌ assignGroupIdBySettings error:", err.message);
    return null;
  }
}

async function autoNameInGroup(groupId) {
  const res = await q(`SELECT COUNT(*) FROM users WHERE group_id=$1`, [groupId]);
  const count = parseInt(res.rows[0].count, 10) + 1;
  return `User${count}`;
}

// ====== main keyboard ======
function mainKeyboard(userId) {
  const isAdmin = userId?.toString() === ADMIN_ID?.toString();

  const buttons = [
    [Markup.button.text("/تسجيل"), Markup.button.text("/رفع_اكواد")],
    [Markup.button.text("/اكواد_اليوم"), Markup.button.text("/اكوادى")],
    [Markup.button.contactRequest("📱 إرسال رقم الهاتف")],
  ];

  if (isAdmin) {
    buttons.push([Markup.button.text("/admin")]);
  }

  return Markup.keyboard(buttons).resize();
}

// ====== /start ======
bot.start((ctx) => {
  ctx.reply(
    "👋 أهلاً بك في البوت!\n\n" +
      "استخدم الأزرار بالأسفل أو الأوامر التالية:\n" +
      "/تسجيل - للتسجيل\n" +
      "/رفع_اكواد - لرفع الأكواد (ستُطلب عدد الأيام ثم ترسل الأكواد عددياً)\n" +
      "/اكواد_اليوم - لعرض أكواد اليوم\n" +
      "/اكوادى - لعرض أكوادك",
    mainKeyboard(ctx.from.id)
  );
});

// ====== registration ======
bot.hears(/^\/تسجيل/, async (ctx) => {
  try {
    const tgId = ctx.from.id.toString();
    const exists = await q(`SELECT id FROM users WHERE telegram_id=$1`, [tgId]);
    if (exists.rowCount > 0) {
      await ctx.reply("أنت مسجل بالفعل ✅");
      return;
    }
    userState[tgId] = { stage: "awaiting_binance" };
    await ctx.reply("أدخل معرف بينانس الخاص بك:");
  } catch (err) {
    console.error("❌ registration error:", err.message);
    await ctx.reply("❌ حدث خطأ داخلي. حاول لاحقًا.");
  }
});

// ====== text handler ======
bot.on("text", async (ctx) => {
  const uid = ctx.from.id.toString();

  // Broadcast mode
  if (uid.toString() === ADMIN_ID?.toString() && adminBroadcastMode) {
    adminBroadcastMode = false;
    const message = ctx.message.text;
    try {
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
    } catch (err) {
      console.error("❌ broadcast error:", err.message);
      await ctx.reply("❌ حدث خطأ أثناء الإرسال.");
    }
    return;
  }

  const st = userState[uid];
  if (!st) return;

  // registration binance -> ask phone
  if (st.stage === "awaiting_binance") {
    const binance = ctx.message.text.trim();
    if (!binance || binance.length > 100) {
      await ctx.reply("⚠️ معرف غير صالح، حاول مجددًا.");
      return;
    }
    st.binance = binance;
    st.stage = "awaiting_phone";
    await ctx.reply("أرسل رقم هاتفك عبر زر المشاركة:", {
      reply_markup: {
        keyboard: [[{ text: "📱 إرسال رقم الهاتف", request_contact: true }]],
        one_time_keyboard: true,
        resize_keyboard: true,
      },
    });
    return;
  }

  // upload codes flow: first ask for number of days
  if (st.stage === "awaiting_days") {
    const n = parseInt(ctx.message.text.trim(), 10);
    if (isNaN(n) || n <= 0 || n > 365) {
      await ctx.reply("⚠️ أكتب عدد أيام صالح (1 - 365).");
      return;
    }
    st.expectedCodes = n;
    st.codes = [];
    st.stage = "uploading_codes";
    await ctx.reply(`تمام. أرسل ${n} أكواد واحدًا في كل رسالة. اكتب /done عند الانتهاء.`);
    return;
  }

  // collecting codes
  if (st.stage === "uploading_codes") {
    const text = ctx.message.text.trim();
    if (text === "/done" || text === "/انتهيت") {
      const codes = st.codes || [];
      if (codes.length === 0) {
        await ctx.reply("لم يتم استلام أي كود.");
        delete userState[uid];
        return;
      }
      if (st.expectedCodes && codes.length !== st.expectedCodes) {
        await ctx.reply(`⚠️ عدد الأكواد غير متطابق مع عدد الأيام (${st.expectedCodes}). أرسل باقي الأكواد أو اكتب /انتهيت لإلغاء.`);
        return;
      }

      // insert codes for this user
      try {
        const userrow = await q("SELECT id FROM users WHERE telegram_id=$1", [uid]);
        if (userrow.rowCount === 0) {
          await ctx.reply("⚠️ لم يتم العثور على المستخدم في قاعدة البيانات. يرجى التسجيل أولًا.");
          delete userState[uid];
          return;
        }
        const owner_id = userrow.rows[0].id;
        const settings = await getSettings();
        const viewsPerDay = settings ? settings.daily_codes_limit : 50;

        // insert each code as one row (one day)
        let inserted = 0;
        for (const c of codes) {
          try {
            await q(
              `INSERT INTO codes (owner_id, code_text, views_per_day, status, created_at)
               VALUES ($1,$2,$3,'active', NOW())`,
              [owner_id, c, viewsPerDay]
            );
            inserted++;
          } catch (err) {
            console.error("❌ insert code error:", err.message);
          }
        }
        await ctx.reply(`✅ تم حفظ ${inserted} أكواد. شكراً!`);
      } catch (err) {
        console.error("❌ finishing upload codes error:", err.message);
        await ctx.reply("❌ حدث خطأ أثناء حفظ الأكواد.");
      }

      delete userState[uid];
      return;
    }

    // otherwise push code
    st.codes.push(text);
    await ctx.reply(`استلمت الكود رقم ${st.codes.length}.`);
    return;
  }
});

// ====== contact handler ======
bot.on("contact", async (ctx) => {
  try {
    const contact = ctx.message.contact;
    const tgId = ctx.from.id.toString();
    const st = userState[tgId];
    if (!st || st.stage !== "awaiting_phone") {
      await ctx.reply("ابدأ التسجيل بكتابة /تسجيل");
      return;
    }

    if (contact.user_id && contact.user_id.toString() !== tgId) {
      await ctx.reply("✋ يجب مشاركة رقم هاتفك الخاص فقط باستخدام زر '📱 إرسال رقم الهاتف'.");
      delete userState[tgId];
      return;
    }

    const phone = contact.phone_number;
    const dupPhone = await q("SELECT id FROM users WHERE phone=$1", [phone]);
    if (dupPhone.rowCount > 0) {
      await ctx.reply("⚠️ هذا الرقم مستخدم بالفعل.");
      delete userState[tgId];
      return;
    }

    const dupTelegram = await q("SELECT id FROM users WHERE telegram_id=$1", [tgId]);
    if (dupTelegram.rowCount > 0) {
      await ctx.reply("⚠️ أنت مسجل بالفعل.");
      delete userState[tgId];
      return;
    }

    if (st.binance) {
      const dupBinance = await q("SELECT id FROM users WHERE binance_id=$1", [st.binance]);
      if (dupBinance.rowCount > 0) {
        await ctx.reply("⚠️ معرف بينانس هذا مسجل مسبقًا.");
        delete userState[tgId];
        return;
      }
    }

    const settings = await getSettings();
    const groupSize = settings ? settings.group_size : 1000;
    const groupId = await assignGroupIdBySettings(groupSize);
    const autoName = await autoNameInGroup(groupId);

    try {
      await q(
        `INSERT INTO users (telegram_id, binance_id, phone, auto_name, group_id, verified, created_at)
         VALUES ($1,$2,$3,$4,$5,true,NOW())`,
        [tgId, st.binance || null, phone, autoName, groupId]
      );
    } catch (err) {
      console.error("❌ failed to insert user:", err.message);
      await ctx.reply("❌ حدث خطأ أثناء حفظ بياناتك، حاول لاحقًا.");
      delete userState[tgId];
      return;
    }

    await ctx.reply(
      `✅ تم التسجيل بنجاح!\nالمجموعة: ${groupId}\nاسمك التلقائي: ${autoName}`,
      mainKeyboard(ctx.from.id)
    );
    delete userState[tgId];
  } catch (err) {
    console.error("❌ contact handler error:", err.message);
    await ctx.reply("❌ حدث خطأ داخلي أثناء التسجيل.");
  }
});

// ====== upload shortcut (starts days prompt) ======
bot.hears(/^\/رفع_اكواد/, async (ctx) => {
  try {
    const uid = ctx.from.id.toString();
    const res = await q("SELECT id FROM users WHERE telegram_id=$1", [uid]);
    if (res.rowCount === 0) {
      await ctx.reply("سجل أولًا باستخدام /تسجيل");
      return;
    }
    userState[uid] = { stage: "awaiting_days" };
    await ctx.reply("كم عدد الأيام (عدد الأكواد) التي تريد رفعها؟ اكتب رقماً:");
  } catch (err) {
    console.error("❌ رفع_اكواد start error:", err.message);
    await ctx.reply("❌ حدث خطأ، حاول لاحقًا.");
  }
});

// ====== اكواد اليوم ======
bot.hears(/^\/اكواد_اليوم/, async (ctx) => {
  try {
    const uid = ctx.from.id.toString();
    const u = await q("SELECT id FROM users WHERE telegram_id=$1", [uid]);
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
      const used = row.used ? "✅ مستخدم" : "🔲 غير مستخدم";
      await ctx.reply(`${row.code_text}\nالحالة: ${used}`);
    }
  } catch (err) {
    console.error("❌ اكواد_اليوم error:", err.message);
    await ctx.reply("❌ حدث خطأ، حاول لاحقًا.");
  }
});

// ====== اكوادى ======
bot.hears(/^\/اكوادى/, async (ctx) => {
  try {
    const uid = ctx.from.id.toString();
    const res = await q("SELECT id FROM users WHERE telegram_id=$1", [uid]);
    if (res.rowCount === 0) {
      await ctx.reply("سجل أولًا باستخدام /تسجيل");
      return;
    }
    const userId = res.rows[0].id;
    const codes = await q("SELECT code_text, status, created_at FROM codes WHERE owner_id=$1 ORDER BY created_at DESC", [userId]);
    if (codes.rowCount === 0) {
      await ctx.reply("❌ لا توجد لديك أكواد.");
      return;
    }
    const list = codes.rows.map((c, i) => `${i + 1}. ${c.code_text} (${c.status || 'active'})`).join("\n");
    await ctx.reply(`📋 أكوادك:\n${list}`);
  } catch (err) {
    console.error("❌ اكوادى error:", err.message);
    await ctx.reply("❌ حدث خطأ، حاول لاحقًا.");
  }
});

// ====== daily distribution (each code is one day; assign each active code once) ======
async function runDailyDistribution() {
  console.log("📌 Starting daily distribution...");
  try {
    const settings = await getSettings();

    const codesRes = await q(
      `SELECT id, owner_id, views_per_day
       FROM codes
       WHERE status = 'active'
       ORDER BY created_at ASC`
    );

    const usersRes = await q(`SELECT id FROM users`);
    const allUserIds = usersRes.rows.map(r => r.id);

    const today = new Date().toISOString().slice(0, 10);

    for (const c of codesRes.rows) {
      const viewersNeeded = c.views_per_day || (settings ? settings.daily_codes_limit : 50);
      if (!viewersNeeded || viewersNeeded <= 0) {
        continue;
      }

      let candidates = allUserIds.filter(uid => uid !== c.owner_id);
      candidates = candidates.sort(() => 0.5 - Math.random());

      let assignedCount = 0;
      for (const candidateId of candidates) {
        if (assignedCount >= viewersNeeded) break;

        const seenBefore = await q(
          `SELECT 1 FROM code_view_assignments a
           JOIN codes cc ON a.code_id = cc.id
           WHERE a.assigned_to_user_id=$1 AND cc.owner_id=$2 LIMIT 1`,
          [candidateId, c.owner_id]
        );
        if (seenBefore.rowCount > 0) continue;

        const alreadyAssignedToday = await q(
          `SELECT 1 FROM code_view_assignments WHERE code_id=$1 AND assigned_to_user_id=$2 AND assigned_date=$3 LIMIT 1`,
          [c.id, candidateId, today]
        );
        if (alreadyAssignedToday.rowCount > 0) continue;

        try {
          await q(
            `INSERT INTO code_view_assignments (code_id, assigned_to_user_id, assigned_date, presented_at, used, verified)
             VALUES ($1,$2,$3,NOW(), false, false)`,
            [c.id, candidateId, today]
          );
          assignedCount++;
        } catch (err) {
          console.error("❌ Failed to insert assignment:", err.message);
        }
      }

      try {
        await q(`UPDATE codes SET status = 'distributed' WHERE id = $1`, [c.id]);
      } catch (err) {
        console.error("❌ Failed to update code status:", err.message);
      }

      console.log(`Code ${c.id} distributed to ${assignedCount}/${viewersNeeded}`);
    }

    console.log("✅ Distribution complete");
  } catch (err) {
    console.error("❌ runDailyDistribution error:", err.message);
  }
}

// ====== monthly reset cycle (1st day of each month at 00:00) ======
cron.schedule("0 0 1 * *", async () => {
  try {
    console.log("🔄 بدء دورة جديدة - مسح الأكواد والتوزيعات...");
    await q("DELETE FROM code_view_assignments");
    await q("DELETE FROM codes");
    console.log("✅ تم مسح الأكواد والتوزيعات. دورة جديدة بدأت!");
  } catch (err) {
    console.error("❌ خطأ أثناء بدء دورة جديدة:", err);
  }
});

// ====== scheduler ======
cron.schedule("* * * * *", async () => {
  try {
    const s = await getSettings();
    if (!s || !s.is_scheduler_active) return;
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const ymdhm = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${hour}:${minute}`;
    const sendHour = parseInt((s.send_time || "09:00:00").split(":")[0], 10);
    if (hour === sendHour && minute === 0 && lastRunDate !== ymdhm) {
      lastRunDate = ymdhm;
      await runDailyDistribution();
    }
  } catch (err) {
    console.error("Scheduler error:", err);
  }
});

// ====== Admin panel ======
bot.command("admin", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID?.toString()) {
    return ctx.reply("❌ مخصص للأدمن فقط.");
  }

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("📴 Toggle Scheduler", "toggle_scheduler")],
    [Markup.button.callback("⏰ Set Send Time", "set_time")],
    [Markup.button.callback("👁️ Set Daily Limit", "set_limit")],
    [Markup.button.callback("📅 Set Days", "set_days")],
    [Markup.button.callback("👥 Set Group Size", "set_group")],
    [Markup.button.callback("📢 Broadcast", "broadcast")],
    [Markup.button.callback("📊 Stats", "stats")],
  ]);

  await ctx.reply("🔐 Admin Panel:", keyboard);
});

// ====== reset cycle for admin ======
bot.hears(/^\/reset_cycle/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID?.toString()) {
    return ctx.reply("❌ مخصص للأدمن فقط.");
  }
  try {
    await q("DELETE FROM code_view_assignments");
    await q("DELETE FROM codes");
    await ctx.reply("🔄 تم بدء دورة جديدة ومسح الأكواد والتوزيعات بنجاح!");
  } catch (err) {
    console.error(err);
    await ctx.reply("❌ حدث خطأ أثناء بدء الدورة الجديدة.");
  }
});

// ====== callback handler ======
bot.on("callback_query", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID?.toString()) {
    return ctx.answerCbQuery("❌ Not allowed");
  }
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
    await ctx.reply(
      `📊 Users: ${u.rows[0].count}\n` +
        `Codes: ${c.rows[0].count}\n` +
        `Scheduler: ${s.is_scheduler_active ? "On" : "Off"}\n` +
        `Limit: ${s.daily_codes_limit}\n` +
        `Days: ${s.distribution_days}\n` +
        `Group: ${s.group_size}\n` +
        `Time: ${s.send_time}`
    );
  }
  await ctx.answerCbQuery();
});

// ====== Admin text commands ======
bot.hears(/^\/set_time/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID?.toString()) {
    return;
  }
  const time = ctx.message.text.split(" ")[1];
  if (!/^\d{2}:\d{2}$/.test(time)) return ctx.reply("❌ Invalid format. Example: /set_time 09:00");
  await updateSettings("send_time", time);
  await ctx.reply(`✅ Send time set to ${time}`);
});

bot.hears(/^\/set_limit/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID?.toString()) {
    return;
  }
  const val = parseInt(ctx.message.text.split(" ")[1], 10);
  if (isNaN(val)) return ctx.reply("❌ Invalid number");
  await updateSettings("daily_codes_limit", val);
  await ctx.reply(`✅ Daily limit set to ${val}`);
});

bot.hears(/^\/set_days/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID?.toString()) {
    return;
  }
  const val = parseInt(ctx.message.text.split(" ")[1], 10);
  if (isNaN(val)) return ctx.reply("❌ Invalid number");
  await updateSettings("distribution_days", val);
  await ctx.reply(`✅ Distribution days set to ${val}`);
});

bot.hears(/^\/set_group/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID?.toString()) {
    return;
  }
  const val = parseInt(ctx.message.text.split(" ")[1], 10);
  if (isNaN(val)) return ctx.reply("❌ Invalid number");
  // update admin_settings
  await updateSettings("group_size", val);
  // update groups.max_users so DB reflects the change for future groups
  try {
    await q("UPDATE groups SET max_users = $1", [val]);
  } catch (err) {
    console.error("❌ Failed to update groups.max_users:", err.message);
  }
  await ctx.reply(`✅ Group size set to ${val}`);
});

// ====== Webhook / Web Service setup ======
const RENDER_URL = process.env.RENDER_URL || "";
const SECRET_PATH = process.env.SECRET_PATH || "bot-webhook";

if (RENDER_URL) {
  (async () => {
    try {
      const app = express();

      // ====== Express Middleware ======
      app.use(express.json());

      // Debug middleware: log all requests
      app.use((req, res, next) => {
        console.log("🔔 INCOMING REQUEST:", req.method, req.originalUrl);
        let body = "";
        req.on("data", chunk => { body += chunk.toString().slice(0, 10000); });
        req.on("end", () => {
          if (body) console.log("🔸 body (trunc 1k):", body.slice(0,1000));
        });
        next();
      });

      // ====== Telegraf Middleware ======
      bot.use((ctx, next) => {
        try {
          console.log("🪪 Telegraf update:", ctx.updateType, "from:", ctx.from?.id, "text:", ctx.message?.text);
        } catch(e) {}
        return next();
      });

      bot.catch((err, ctx) => {
        console.error("❌ Telegraf unhandled error:", err?.stack || err, "update:", JSON.stringify(ctx.update).slice(0,1000));
      });

  // ====== Webhook route ======
  await bot.telegram.setWebhook(`${RENDER_URL.replace(/\/$/, "")}/${SECRET_PATH}`);
  app.use(express.json());
  app.use(bot.webhookCallback(`/${SECRET_PATH}`));

      // ====== Health-check endpoint ======
      app.get("/", (req, res) => res.send("✅ Bot server is running!"));

      // ====== Start server ======
      const PORT = process.env.PORT || 10000;
      app.listen(PORT, () => {
        console.log(`🚀 Webhook running on port ${PORT}`);
        console.log(`🔗 Webhook endpoint: /${SECRET_PATH}`);
        console.log("🟢 Mode: webhook");
      });
    } catch (err) {
      console.error("❌ Failed to start webhook:", err);
      process.exit(1);
    }
  })();
} else {
  (async () => {
    try {
      await bot.telegram.deleteWebhook();
      bot.launch();
      console.log("🚀 Bot running with long polling...");
      console.log("🟢 Mode: polling");
    } catch (err) {
      console.error("❌ Failed to start bot:", err);
    }
  })();
}
