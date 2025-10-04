// bot.js - FINAL CLEAN VERSION
import { Telegraf, Markup } from "telegraf";
import fs from "fs";
import pkg from "pg";
import dotenv from "dotenv";
import cron from "node-cron";
import express from "express";

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const { Pool } = pkg;

let sslConfig = false;
try {
  const ca = fs.readFileSync("./supabase-ca.crt").toString();
  sslConfig = { ca, rejectUnauthorized: true };
} catch (e) {
  console.warn("⚠️ supabase-ca.crt not found — continuing without SSL CA.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(sslConfig ? { ssl: sslConfig } : {}),
});

const ADMIN_ID = process.env.ADMIN_ID;

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

async function ensureAdminSettings() {
  try {
    await q(
      `INSERT INTO admin_settings (id, daily_codes_limit, distribution_days, group_size, send_time, is_scheduler_active)
       VALUES (1, 50, 20, 1000, '09:00:00', $1) ON CONFLICT (id) DO NOTHING`,
      [false]
    );
  } catch (err) {
    console.warn("ensureAdminSettings:", err?.message);
  }
}

async function getSettings() {
  try {
    await ensureAdminSettings();
    const res = await q(`SELECT * FROM admin_settings WHERE id = 1 LIMIT 1`);
    if (!res.rows || res.rows.length === 0) {
      return { daily_codes_limit: 50, distribution_days: 20, group_size: 1000, send_time: "09:00:00", is_scheduler_active: false };
    }
    return res.rows[0];
  } catch (err) {
    console.error("❌ getSettings error:", err.message);
    return { daily_codes_limit: 50, distribution_days: 20, group_size: 1000, send_time: "09:00:00", is_scheduler_active: false };
  }
}

async function updateSettings(field, value) {
  const allowedFields = ["daily_codes_limit", "distribution_days", "group_size", "send_time", "is_scheduler_active"];
  if (!allowedFields.includes(field)) throw new Error("Invalid field");
  await q(`UPDATE admin_settings SET ${field}=$1 WHERE id=1`, [value]);
}

const userState = {};
let lastRunDate = null;
let adminBroadcastMode = false;

async function assignGroupIdBySettings(groupSize) {
  try {
    const res = await q(
      `SELECT g.id FROM groups g LEFT JOIN (SELECT group_id, COUNT(*) as count FROM users GROUP BY group_id) u_count 
       ON u_count.group_id = g.id WHERE COALESCE(u_count.count, 0) < g.max_users ORDER BY g.created_at LIMIT 1`
    );
    if (res.rowCount > 0) return res.rows[0].id;
    const insert = await q(`INSERT INTO groups (name, max_users, created_at) VALUES ($1, $2, NOW()) RETURNING id`, [`Group-${Date.now()}`, groupSize]);
    return insert.rows[0].id;
  } catch (err) {
    console.error("❌ assignGroupIdBySettings:", err.message);
    return null;
  }
}

async function autoNameInGroup(groupId) {
  const res = await q(`SELECT COUNT(*) FROM users WHERE group_id=$1`, [groupId]);
  return `User${parseInt(res.rows[0].count, 10) + 1}`;
}

async function safeReply(ctx, message, extra) {
  try {
    await ctx.reply(message, extra);
  } catch (err) {
    console.error("❌ Failed to send reply:", err.message);
  }
}

function mainKeyboard(userId) {
  const buttons = [
    [Markup.button.text("/تسجيل"), Markup.button.text("/رفع_اكواد")],
    [Markup.button.text("/اكواد_اليوم"), Markup.button.text("/اكوادى")],
    [Markup.button.contactRequest("📱 إرسال رقم الهاتف")],
  ];
  if (userId?.toString() === ADMIN_ID?.toString()) {
    buttons.push([Markup.button.text("/admin")]);
  }
  return Markup.keyboard(buttons).resize();
}

bot.start(async (ctx) => {
  await safeReply(ctx, "👋 أهلاً بك في البوت!\n\n/تسجيل - للتسجيل\n/رفع_اكواد - لرفع الأكواد\n/اكواد_اليوم - لعرض أكواد اليوم\n/اكوادى - لعرض أكوادك", mainKeyboard(ctx.from.id));
});

bot.hears(/^\/تسجيل/, async (ctx) => {
  try {
    const tgId = ctx.from.id.toString();
    const exists = await q(`SELECT id FROM users WHERE telegram_id=$1`, [tgId]);
    if (exists.rowCount > 0) {
      return safeReply(ctx, "أنت مسجل بالفعل ✅");
    }
    userState[tgId] = { stage: "awaiting_binance" };
    return safeReply(ctx, "أدخل معرف بينانس الخاص بك:");
  } catch (err) {
    console.error("❌ registration error:", err.message);
    return safeReply(ctx, "❌ حدث خطأ داخلي. حاول لاحقًا.");
  }
});

bot.on("text", async (ctx) => {
  const uid = ctx.from.id.toString();

  if (uid === ADMIN_ID && adminBroadcastMode) {
    adminBroadcastMode = false;
    const message = ctx.message.text;
    try {
      const users = await q(`SELECT telegram_id FROM users`);
      let success = 0;
      for (const row of users.rows) {
        try {
          await bot.telegram.sendMessage(row.telegram_id, `📢 رسالة من الأدمن:\n\n${message}`);
          success++;
          await new Promise(r => setTimeout(r, 50));
        } catch (err) {
          console.error(`❌ Failed to send to ${row.telegram_id}`);
        }
      }
      return safeReply(ctx, `✅ تم إرسال الرسالة إلى ${success} مستخدم.`);
    } catch (err) {
      console.error("❌ broadcast error:", err.message);
      return safeReply(ctx, "❌ حدث خطأ أثناء الإرسال.");
    }
  }

  const st = userState[uid];
  if (!st) return;

  if (st.stage === "awaiting_binance") {
    const binance = ctx.message.text.trim();
    if (!binance || binance.length > 100) {
      return safeReply(ctx, "⚠️ معرف غير صالح، حاول مجددًا.");
    }
    st.binance = binance;
    st.stage = "awaiting_phone";
    return safeReply(ctx, "أرسل رقم هاتفك عبر زر المشاركة:", {
      reply_markup: { keyboard: [[{ text: "📱 إرسال رقم الهاتف", request_contact: true }]], one_time_keyboard: true, resize_keyboard: true }
    });
  }

  if (st.stage === "awaiting_days") {
    const n = parseInt(ctx.message.text.trim(), 10);
    if (isNaN(n) || n <= 0 || n > 365) {
      return safeReply(ctx, "⚠️ أكتب عدد أيام صالح (1 - 365).");
    }
    st.expectedCodes = n;
    st.codes = [];
    st.stage = "uploading_codes";
    return safeReply(ctx, `تمام. أرسل ${n} أكواد واحدًا في كل رسالة. اكتب /done عند الانتهاء.`);
  }

  if (st.stage === "uploading_codes") {
    const text = ctx.message.text.trim();
    if (text === "/done" || text === "/انتهيت") {
      const codes = st.codes || [];
      if (codes.length === 0) {
        delete userState[uid];
        return safeReply(ctx, "لم يتم استلام أي كود.");
      }
      if (st.expectedCodes && codes.length !== st.expectedCodes) {
        return safeReply(ctx, `⚠️ عدد الأكواد غير متطابق (${codes.length}/${st.expectedCodes}).`);
      }

      try {
        const userrow = await q("SELECT id FROM users WHERE telegram_id=$1", [uid]);
        if (userrow.rowCount === 0) {
          delete userState[uid];
          return safeReply(ctx, "⚠️ لم يتم العثور على المستخدم. يرجى التسجيل أولًا.");
        }
        const owner_id = userrow.rows[0].id;
        const settings = await getSettings();
        const viewsPerDay = settings.daily_codes_limit;

        let inserted = 0;
        for (const c of codes) {
          try {
            await q(`INSERT INTO codes (owner_id, code_text, views_per_day, status, created_at) VALUES ($1,$2,$3,'active', NOW())`, [owner_id, c, viewsPerDay]);
            inserted++;
          } catch (err) {
            console.error("❌ insert code error:", err.message);
          }
        }
        delete userState[uid];
        return safeReply(ctx, `✅ تم حفظ ${inserted} أكواد. شكراً!`);
      } catch (err) {
        console.error("❌ finishing upload:", err.message);
        delete userState[uid];
        return safeReply(ctx, "❌ حدث خطأ أثناء حفظ الأكواد.");
      }
    }

    st.codes.push(text);
    return safeReply(ctx, `استلمت الكود رقم ${st.codes.length}.`);
  }
});

bot.on("contact", async (ctx) => {
  try {
    const contact = ctx.message.contact;
    const tgId = ctx.from.id.toString();
    const st = userState[tgId];
    if (!st || st.stage !== "awaiting_phone") {
      return safeReply(ctx, "ابدأ التسجيل بكتابة /تسجيل");
    }

    if (contact.user_id && contact.user_id.toString() !== tgId) {
      delete userState[tgId];
      return safeReply(ctx, "✋ يجب مشاركة رقم هاتفك الخاص فقط.");
    }

    const phone = contact.phone_number;
    const dupPhone = await q("SELECT id FROM users WHERE phone=$1", [phone]);
    const dupTelegram = await q("SELECT id FROM users WHERE telegram_id=$1", [tgId]);
    let dupBinance = { rowCount: 0 };
    if (st.binance) {
      dupBinance = await q("SELECT id FROM users WHERE binance_id=$1", [st.binance]);
    }
    if (dupPhone.rowCount > 0 || dupTelegram.rowCount > 0 || dupBinance.rowCount > 0) {
      delete userState[tgId];
      return safeReply(ctx, "⚠️ لا يمكنك التسجيل أكثر من مرة");
    }

    const settings = await getSettings();
    const groupId = await assignGroupIdBySettings(settings.group_size);
    const autoName = await autoNameInGroup(groupId);

    await q(`INSERT INTO users (telegram_id, binance_id, phone, auto_name, group_id, verified, created_at) VALUES ($1,$2,$3,$4,$5,true,NOW())`, [tgId, st.binance || null, phone, autoName, groupId]);
    delete userState[tgId];
    return safeReply(ctx, `✅ تم التسجيل بنجاح!\nالمجموعة: ${groupId}\nاسمك التلقائي: ${autoName}`, mainKeyboard(ctx.from.id));
  } catch (err) {
    console.error("❌ contact handler:", err.message);
    return safeReply(ctx, "❌ حدث خطأ داخلي أثناء التسجيل.");
  }
});

bot.hears(/^\/رفع_اكواد/, async (ctx) => {
  try {
    const uid = ctx.from.id.toString();
    const res = await q("SELECT id FROM users WHERE telegram_id=$1", [uid]);
    if (res.rowCount === 0) {
      return safeReply(ctx, "سجل أولًا باستخدام /تسجيل");
    }
    userState[uid] = { stage: "awaiting_days" };
    return safeReply(ctx, "كم عدد الأيام (عدد الأكواد) التي تريد رفعها؟ اكتب رقماً:");
  } catch (err) {
    console.error("❌ رفع_اكواد start:", err.message);
    return safeReply(ctx, "❌ حدث خطأ، حاول لاحقًا.");
  }
});

bot.hears(/^\/اكواد_اليوم/, async (ctx) => {
  try {
    const uid = ctx.from.id.toString();
    const u = await q("SELECT id FROM users WHERE telegram_id=$1", [uid]);
    if (u.rowCount === 0) {
      return safeReply(ctx, "سجل أولًا باستخدام /تسجيل");
    }
    const userId = u.rows[0].id;
    const today = new Date().toISOString().slice(0, 10);
    const res = await q(`SELECT a.id as a_id, c.code_text, a.used FROM code_view_assignments a JOIN codes c ON a.code_id=c.id WHERE a.assigned_to_user_id=$1 AND a.assigned_date=$2`, [userId, today]);
    if (res.rowCount === 0) {
      return safeReply(ctx, "لا يوجد أكواد اليوم.");
    }
    for (const row of res.rows) {
      const used = row.used ? "✅ مستخدم" : "🔲 غير مستخدم";
      await safeReply(ctx, `${row.code_text}\nالحالة: ${used}`);
    }
  } catch (err) {
    console.error("❌ اكواد_اليوم:", err.message);
    return safeReply(ctx, "❌ حدث خطأ، حاول لاحقًا.");
  }
});

bot.hears(/^\/اكوادى/, async (ctx) => {
  try {
    const uid = ctx.from.id.toString();
    const res = await q("SELECT id FROM users WHERE telegram_id=$1", [uid]);
    if (res.rowCount === 0) {
      return safeReply(ctx, "سجل أولًا باستخدام /تسجيل");
    }
    const userId = res.rows[0].id;
    const codes = await q("SELECT code_text, status FROM codes WHERE owner_id=$1 ORDER BY created_at DESC", [userId]);
    if (codes.rowCount === 0) {
      return safeReply(ctx, "❌ لا توجد لديك أكواد.");
    }
    const list = codes.rows.map((c, i) => `${i + 1}. ${c.code_text} (${c.status || 'active'})`).join("\n");
    return safeReply(ctx, `📋 أكوادك:\n${list}`);
  } catch (err) {
    console.error("❌ اكوادى:", err.message);
    return safeReply(ctx, "❌ حدث خطأ، حاول لاحقًا.");
  }
});

async function runDailyDistribution() {
  console.log("📦 بدء توزيع الأكواد...");
  try {
    const settings = await getSettings();
    const codesRes = await q(`SELECT id, owner_id, views_per_day FROM codes WHERE status = 'active' ORDER BY created_at ASC`);
    const usersRes = await q(`SELECT id FROM users`);
    const allUserIds = usersRes.rows.map(r => r.id);
    const today = new Date().toISOString().slice(0, 10);

    for (const c of codesRes.rows) {
      const viewersNeeded = c.views_per_day || settings.daily_codes_limit;
      let candidates = allUserIds.filter(uid => uid !== c.owner_id).sort(() => 0.5 - Math.random());
      let assignedCount = 0;

      for (const candidateId of candidates) {
        if (assignedCount >= viewersNeeded) break;
        const seenBefore = await q(`SELECT 1 FROM code_view_assignments a JOIN codes cc ON a.code_id = cc.id WHERE a.assigned_to_user_id=$1 AND cc.owner_id=$2 LIMIT 1`, [candidateId, c.owner_id]);
        if (seenBefore.rowCount > 0) continue;
        const alreadyAssigned = await q(`SELECT 1 FROM code_view_assignments WHERE code_id=$1 AND assigned_to_user_id=$2 AND assigned_date=$3 LIMIT 1`, [c.id, candidateId, today]);
        if (alreadyAssigned.rowCount > 0) continue;

        try {
          await q(`INSERT INTO code_view_assignments (code_id, assigned_to_user_id, assigned_date, presented_at, used, verified) VALUES ($1,$2,$3,NOW(), false, false)`, [c.id, candidateId, today]);
          assignedCount++;
        } catch (err) {
          console.error("❌ Failed assignment:", err.message);
        }
      }
      console.log(`🔸 Code ${c.id} distributed to ${assignedCount}/${viewersNeeded}`);
    }
    console.log(`✅ Distribution complete. Codes: ${codesRes.rows.length}`);
  } catch (err) {
    console.error("❌ runDailyDistribution:", err.message);
  }
}

cron.schedule("0 0 1 * *", async () => {
  try {
    console.log("🔄 بدء دورة جديدة...");
    await q("DELETE FROM code_view_assignments");
    await q("DELETE FROM codes");
    console.log("✅ تم مسح البيانات");
  } catch (err) {
    console.error("❌ خطأ دورة جديدة:", err);
  }
});

cron.schedule("* * * * *", async () => {
  try {
    const s = await getSettings();
    if (!s.is_scheduler_active) return;
    const now = new Date();
    const pad = n => n.toString().padStart(2, '0');
    const ymdhm = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const sendHour = parseInt(s.send_time.split(":")[0], 10);
    if (now.getHours() === sendHour && now.getMinutes() === 0 && lastRunDate !== ymdhm) {
      lastRunDate = ymdhm;
      await runDailyDistribution();
    }
  } catch (err) {
    console.error("Scheduler error:", err);
  }
});

bot.command("admin", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) {
    return safeReply(ctx, "❌ مخصص للأدمن فقط.");
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
  return safeReply(ctx, "🔐 Admin Panel:", keyboard);
});

bot.hears(/^\/reset_cycle/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  try {
    await q("DELETE FROM code_view_assignments");
    await q("DELETE FROM codes");
    return safeReply(ctx, "🔄 تم بدء دورة جديدة!");
  } catch (err) {
    console.error(err);
    return safeReply(ctx, "❌ حدث خطأ.");
  }
});

bot.on("callback_query", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) {
    return ctx.answerCbQuery("❌ Not allowed");
  }
  const action = ctx.callbackQuery.data;

  try {
    if (action === "toggle_scheduler") {
      const s = await getSettings();
      await updateSettings("is_scheduler_active", !s.is_scheduler_active);
      await safeReply(ctx, `✅ Scheduler: ${!s.is_scheduler_active ? "Enabled" : "Disabled"}`);
    } else if (action === "set_time") {
      await safeReply(ctx, "⏰ Send: /set_time 09:00");
    } else if (action === "set_limit") {
      await safeReply(ctx, "👁️ Send: /set_limit 50");
    } else if (action === "set_days") {
      await safeReply(ctx, "📅 Send: /set_days 20");
    } else if (action === "set_group") {
      await safeReply(ctx, "👥 Send: /set_group 1000");
    } else if (action === "broadcast") {
      adminBroadcastMode = true;
      await safeReply(ctx, "📢 Send message to broadcast:");
    } else if (action === "stats") {
      const u = await q(`SELECT COUNT(*) FROM users`);
      const c = await q(`SELECT COUNT(*) FROM codes`);
      const s = await getSettings();
      await safeReply(ctx, `📊 Users: ${u.rows[0].count}\nCodes: ${c.rows[0].count}\nScheduler: ${s.is_scheduler_active ? "On" : "Off"}\nLimit: ${s.daily_codes_limit}\nDays: ${s.distribution_days}\nGroup: ${s.group_size}\nTime: ${s.send_time}`);
    }
    await ctx.answerCbQuery();
  } catch (err) {
    console.error("❌ callback error:", err.message);
    await ctx.answerCbQuery();
  }
});

bot.hears(/^\/set_time/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const time = ctx.message.text.split(" ")[1];
  if (!/^\d{2}:\d{2}$/.test(time)) return safeReply(ctx, "❌ Invalid format. Example: /set_time 09:00");
  await updateSettings("send_time", time);
  return safeReply(ctx, `✅ Send time set to ${time}`);
});

bot.hears(/^\/set_limit/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const val = parseInt(ctx.message.text.split(" ")[1], 10);
  if (isNaN(val)) return safeReply(ctx, "❌ Invalid number");
  await updateSettings("daily_codes_limit", val);
  return safeReply(ctx, `✅ Daily limit set to ${val}`);
});

bot.hears(/^\/set_days/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const val = parseInt(ctx.message.text.split(" ")[1], 10);
  if (isNaN(val)) return safeReply(ctx, "❌ Invalid number");
  await updateSettings("distribution_days", val);
  return safeReply(ctx, `✅ Distribution days set to ${val}`);
});

bot.hears(/^\/set_group/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const val = parseInt(ctx.message.text.split(" ")[1], 10);
  if (isNaN(val)) return safeReply(ctx, "❌ Invalid number");
  await updateSettings("group_size", val);
  try {
    await q("UPDATE groups SET max_users = $1", [val]);
  } catch (err) {
    console.error("❌ Failed to update groups.max_users");
  }
  return safeReply(ctx, `✅ Group size set to ${val}`);
});

bot.catch((err, ctx) => {
  console.error("❌ Telegraf error:", err?.stack || err);
  console.error("Update:", JSON.stringify(ctx.update).slice(0, 500));
});

const RENDER_URL = process.env.RENDER_URL || "";
const SECRET_PATH = process.env.SECRET_PATH || "bot-webhook";

if (RENDER_URL) {
  (async () => {
    try {
      const app = express();
      app.use(express.json());

      app.use((req, res, next) => {
        console.log("🔔 REQUEST:", req.method, req.originalUrl);
        next();
      });

      app.get("/", (req, res) => {
        res.send("✅ Bot is live and webhook active");
      });

      const webhookPath = `/${SECRET_PATH}`;
      const finalWebhookURL = `${RENDER_URL.replace(/\/$/, '')}${webhookPath}`;

      console.log(`🟡 Setting webhook: ${finalWebhookURL}`);
      await bot.telegram.setWebhook(finalWebhookURL);
      console.log(`✅ Webhook registered`);

      app.post(webhookPath, (req, res) => {
        bot.handleUpdate(req.body, res);
      });

      const PORT = process.env.PORT || 10000;
      app.listen(PORT, () => {
        console.log(`🚀 Webhook running on port ${PORT}`);
        console.log(`🔗 Endpoint: ${webhookPath}`);
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
      console.log("🚀 Bot running with long polling");
      console.log("🟢 Mode: polling");
    } catch (err) {
      console.error("❌ Failed to start bot:", err);
    }
  })();
}

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));