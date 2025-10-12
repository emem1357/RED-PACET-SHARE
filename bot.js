// bot.js - COMPLETE VERSION with enhanced per-group management
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
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

const ADMIN_ID = process.env.ADMIN_ID;

async function q(sql, params) {
  let retries = 3;
  while (retries > 0) {
    const client = await pool.connect();
    try {
      return await client.query(sql, params);
    } catch (err) {
      console.error("❌ DB Error:", err.message);
      retries--;
      if (retries === 0) throw err;
      await new Promise(r => setTimeout(r, 1000));
    } finally {
      client.release();
    }
  }
}

async function ensureAdminSettings() {
  try {
    await q(
      `INSERT INTO admin_settings (id, daily_codes_limit, distribution_days, group_size, send_time, is_scheduler_active, max_groups)
       VALUES (1, 50, 20, 1000, '09:00:00', $1, NULL) ON CONFLICT (id) DO NOTHING`,
      [false]
    );
  } catch (err) {
    console.warn("ensureAdminSettings:", err?.message);
  }
}

async function getAdminSettings() {
  try {
    await ensureAdminSettings();
    const res = await q(`SELECT * FROM admin_settings WHERE id = 1 LIMIT 1`);
    if (!res.rows || res.rows.length === 0) {
      return { daily_codes_limit: 50, distribution_days: 20, group_size: 1000, send_time: "09:00:00", is_scheduler_active: false, max_groups: null };
    }
    return res.rows[0];
  } catch (err) {
    console.error("❌ getAdminSettings error:", err.message);
    return { daily_codes_limit: 50, distribution_days: 20, group_size: 1000, send_time: "09:00:00", is_scheduler_active: false, max_groups: null };
  }
}

async function getGroupSettings(groupId) {
  try {
    const res = await q(`SELECT daily_codes_limit, distribution_days, send_time, is_scheduler_active FROM groups WHERE id=$1`, [groupId]);
    if (res.rowCount > 0) {
      return res.rows[0];
    }
    return { daily_codes_limit: 50, distribution_days: 20, send_time: "09:00:00", is_scheduler_active: false };
  } catch (err) {
    console.error("❌ getGroupSettings error:", err.message);
    return { daily_codes_limit: 50, distribution_days: 20, send_time: "09:00:00", is_scheduler_active: false };
  }
}

async function updateAdminSettings(field, value) {
  const allowedFields = ["daily_codes_limit", "distribution_days", "group_size", "send_time", "is_scheduler_active", "max_groups"];
  if (!allowedFields.includes(field)) throw new Error("Invalid field");
  await q(`UPDATE admin_settings SET ${field}=$1 WHERE id=1`, [value]);
}

async function updateGroupSettings(groupId, field, value) {
  const allowedFields = ["daily_codes_limit", "distribution_days", "send_time", "is_scheduler_active"];
  if (!allowedFields.includes(field)) throw new Error("Invalid field");
  await q(`UPDATE groups SET ${field}=$1 WHERE id=$2`, [value, groupId]);
}

const userState = {};
let lastRunDate = null;
let adminBroadcastMode = false;
let groupBroadcastMode = {};

async function assignGroupIdBySettings(groupSize) {
  try {
    const adminSettings = await getAdminSettings();
    
    if (adminSettings.max_groups) {
      const totalGroups = await q(`SELECT COUNT(*) FROM groups`);
      if (parseInt(totalGroups.rows[0].count) >= adminSettings.max_groups) {
        return null;
      }
    }

    const res = await q(
      `SELECT g.id FROM groups g LEFT JOIN (SELECT group_id, COUNT(*) as count FROM users GROUP BY group_id) u_count 
       ON u_count.group_id = g.id WHERE COALESCE(u_count.count, 0) < g.max_users ORDER BY g.created_at LIMIT 1`
    );
    if (res.rowCount > 0) return res.rows[0].id;
    
    const adminSet = await getAdminSettings();
    const insert = await q(
      `INSERT INTO groups (name, max_users, created_at, daily_codes_limit, distribution_days, send_time, is_scheduler_active) 
       VALUES ($1, $2, NOW(), $3, $4, $5, false) RETURNING id`,
      [`Group-${Date.now()}`, groupSize, adminSet.daily_codes_limit, adminSet.distribution_days, adminSet.send_time]
    );
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

    const adminSettings = await getAdminSettings();
    const groupId = await assignGroupIdBySettings(adminSettings.group_size);
    
    if (!groupId) {
      delete userState[tgId];
      return safeReply(ctx, "❌ عذراً، تم الوصول للحد الأقصى من المجموعات. لا يمكن التسجيل حالياً.");
    }

    const autoName = await autoNameInGroup(groupId);

    await q(`INSERT INTO users (telegram_id, binance_id, phone, auto_name, group_id, verified, created_at) VALUES ($1,$2,$3,$4,$5,true,NOW())`, [tgId, st.binance || null, phone, autoName, groupId]);
    delete userState[tgId];
    return safeReply(ctx, `✅ تم التسجيل بنجاح!\nالمجموعة: ${groupId}\nاسمك التلقائي: ${autoName}`, mainKeyboard(ctx.from.id));
  } catch (err) {
    console.error("❌ contact handler:", err.message);
    return safeReply(ctx, "❌ حدث خطأ داخلي أثناء التسجيل.");
  }
});

bot.command("admin", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) {
    return safeReply(ctx, "❌ مخصص للأدمن فقط.");
  }
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🌐 Global Settings", "global_settings")],
    [Markup.button.callback("📦 Manage Groups", "manage_groups")],
    [Markup.button.callback("🗑️ Delete Cycle Now", "delete_cycle")],
    [Markup.button.callback("📊 Stats", "stats")],
  ]);
  return safeReply(ctx, "🔐 Admin Panel:", keyboard);
});

bot.hears(/^\/set_time/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const time = ctx.message.text.split(" ")[1];
  if (!/^\d{2}:\d{2}$/.test(time)) return safeReply(ctx, "❌ Invalid format. Example: /set_time 09:00");
  await updateAdminSettings("send_time", time);
  await q("UPDATE groups SET send_time = $1", [time]);
  return safeReply(ctx, `✅ Send time set to ${time} for all groups`);
});

bot.hears(/^\/set_limit/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const val = parseInt(ctx.message.text.split(" ")[1], 10);
  if (isNaN(val)) return safeReply(ctx, "❌ Invalid number");
  await updateAdminSettings("daily_codes_limit", val);
  await q("UPDATE groups SET daily_codes_limit = $1", [val]);
  return safeReply(ctx, `✅ Daily limit set to ${val} for all groups`);
});

bot.hears(/^\/set_days/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const val = parseInt(ctx.message.text.split(" ")[1], 10);
  if (isNaN(val)) return safeReply(ctx, "❌ Invalid number");
  await updateAdminSettings("distribution_days", val);
  await q("UPDATE groups SET distribution_days = $1", [val]);
  return safeReply(ctx, `✅ Distribution days set to ${val} for all groups`);
});

bot.hears(/^\/set_group/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const val = parseInt(ctx.message.text.split(" ")[1], 10);
  if (isNaN(val)) return safeReply(ctx, "❌ Invalid number");
  await updateAdminSettings("group_size", val);
  await q("UPDATE groups SET max_users = $1", [val]);
  return safeReply(ctx, `✅ Group size set to ${val}`);
});

bot.hears(/^\/set_max_groups/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const input = ctx.message.text.split(" ")[1];
  if (!input) return safeReply(ctx, "❌ Usage: /set_max_groups 15 (or NULL for unlimited)");
  
  const val = input.toUpperCase() === "NULL" ? null : parseInt(input, 10);
  if (input.toUpperCase() !== "NULL" && isNaN(val)) return safeReply(ctx, "❌ Invalid number");
  
  await updateAdminSettings("max_groups", val);
  return safeReply(ctx, `✅ Max groups set to ${val === null ? 'Unlimited' : val}`);
});

bot.hears(/^\/reset_cycle/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  try {
    await q("DELETE FROM code_view_assignments");
    await q("DELETE FROM codes");
    await q("DELETE FROM user_penalties");
    return safeReply(ctx, "🔄 تم بدء دورة جديدة!");
  } catch (err) {
    console.error(err);
    return safeReply(ctx, "❌ حدث خطأ.");
  }
});

bot.hears(/^\/distribute_now/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  try {
    console.log("🔄 Manual distribution started by admin");
    await runDailyDistribution();
    return safeReply(ctx, "✅ تم توزيع الأكواد يدوياً!\n\nتحقق من /اكواد_اليوم الآن.");
  } catch (err) {
    console.error(err);
    return safeReply(ctx, "❌ حدث خطأ أثناء التوزيع.");
  }
});

bot.hears(/^\/set_group_days/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const parts = ctx.message.text.split(" ");
  if (parts.length < 3) return safeReply(ctx, "❌ Usage: /set_group_days <group_id_prefix> <days>");
  
  const groupPrefix = parts[1];
  const val = parseInt(parts[2], 10);
  if (isNaN(val)) return safeReply(ctx, "❌ Invalid number");
  
  try {
    const groups = await q(`SELECT id FROM groups WHERE id::text LIKE $1`, [`${groupPrefix}%`]);
    if (groups.rowCount === 0) return safeReply(ctx, "❌ Group not found");
    
    const groupId = groups.rows[0].id;
    await updateGroupSettings(groupId, 'distribution_days', val);
    return safeReply(ctx, `✅ Distribution days set to ${val} days for group ${groupId.slice(0, 8)}`);
  } catch (err) {
    console.error(err);
    return safeReply(ctx, "❌ Error updating group");
  }
});

bot.hears(/^\/set_group_limit/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const parts = ctx.message.text.split(" ");
  if (parts.length < 3) return safeReply(ctx, "❌ Usage: /set_group_limit <group_id_prefix> <limit>");
  
  const groupPrefix = parts[1];
  const val = parseInt(parts[2], 10);
  if (isNaN(val)) return safeReply(ctx, "❌ Invalid number");
  
  try {
    const groups = await q(`SELECT id FROM groups WHERE id::text LIKE $1`, [`${groupPrefix}%`]);
    if (groups.rowCount === 0) return safeReply(ctx, "❌ Group not found");
    
    const groupId = groups.rows[0].id;
    await updateGroupSettings(groupId, 'daily_codes_limit', val);
    return safeReply(ctx, `✅ Daily codes limit set to ${val} views per code for group ${groupId.slice(0, 8)}`);
  } catch (err) {
    console.error(err);
    return safeReply(ctx, "❌ Error updating group");
  }
});

bot.hears(/^\/set_group_time/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const parts = ctx.message.text.split(" ");
  if (parts.length < 3) return safeReply(ctx, "❌ Usage: /set_group_time <group_id_prefix> 09:00");
  
  const groupPrefix = parts[1];
  const time = parts[2];
  if (!/^\d{2}:\d{2}$/.test(time)) return safeReply(ctx, "❌ Invalid format. Example: 09:00");
  
  try {
    const groups = await q(`SELECT id FROM groups WHERE id::text LIKE $1`, [`${groupPrefix}%`]);
    if (groups.rowCount === 0) return safeReply(ctx, "❌ Group not found");
    
    const groupId = groups.rows[0].id;
    await updateGroupSettings(groupId, 'send_time', time);
    return safeReply(ctx, `✅ Send time set to ${time} for group ${groupId.slice(0, 8)}`);
  } catch (err) {
    console.error(err);
    return safeReply(ctx, "❌ Error updating group");
  }
});

bot.on("text", async (ctx) => {
  const uid = ctx.from.id.toString();
  const text = ctx.message.text;

  if (text === "/رفع_اكواد" || (text.includes("رفع") && text.includes("اكواد"))) {
    try {
      const userRes = await q("SELECT id, group_id FROM users WHERE telegram_id=$1", [uid]);
      if (userRes.rowCount === 0) {
        return safeReply(ctx, "سجل أولًا باستخدام /تسجيل");
      }

      const userId = userRes.rows[0].id;
      const groupId = userRes.rows[0].group_id;

      const penalty = await q("SELECT missed_days, codes_deleted FROM user_penalties WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1", [userId]);
      if (penalty.rowCount > 0 && penalty.rows[0].missed_days >= 2 && !penalty.rows[0].codes_deleted) {
        return safeReply(ctx, "❌ تم إيقاف إمكانية رفع الأكواد لمدة يومين بسبب عدم إكمال الأكواد اليومية. حاول لاحقاً.");
      }

      const groupSettings = await getGroupSettings(groupId);
      const message = `📋 قم برفع ${groupSettings.distribution_days} كوداً (كود واحد لكل يوم)\n\n` +
                      `📌 كل كود متاح لـ ${groupSettings.daily_codes_limit} مستخدم\n\n` +
                      `أرسل الأكواد واحداً تلو الآخر بالترتيب:\n` +
                      `الكود الأول → اليوم الأول\n` +
                      `الكود الثاني → اليوم الثاني\n` +
                      `وهكذا...\n\n` +
                      `ثم اكتب /done عند الانتهاء.`;

      userState[uid] = { 
        stage: "uploading_codes", 
        expectedCodes: groupSettings.distribution_days,
        codes: [],
        groupId: groupId
      };
      return safeReply(ctx, message);
    } catch (err) {
      console.error("❌ رفع_اكواد:", err.message);
      return safeReply(ctx, "❌ حدث خطأ، حاول لاحقًا.");
    }
  }

  if (text === "/اكواد_اليوم" || (text.includes("اكواد") && text.includes("اليوم"))) {
    try {
      const u = await q("SELECT id, group_id FROM users WHERE telegram_id=$1", [uid]);
      if (u.rowCount === 0) {
        return safeReply(ctx, "سجل أولًا باستخدام /تسجيل");
      }
      const userId = u.rows[0].id;
      const groupId = u.rows[0].group_id;
      
      const groupSettings = await getGroupSettings(groupId);
      if (!groupSettings.is_scheduler_active) {
        return safeReply(ctx, "⏸️ التوزيع متوقف حالياً من قبل الأدمن.\n\نسيتم استئناف التوزيع عند إعادة التفعيل.");
      }
      
      const today = new Date().toISOString().slice(0, 10);
      const res = await q(
        `SELECT a.id as a_id, c.code_text, a.used FROM code_view_assignments a 
         JOIN codes c ON a.code_id=c.id 
         WHERE a.assigned_to_user_id=$1 AND a.assigned_date=$2 AND a.used=false
         ORDER BY c.day_number ASC, c.created_at ASC LIMIT 1`,
        [userId, today]
      );
      
      if (res.rowCount === 0) {
        return safeReply(ctx, "✅ تم إكمال جميع الأكواد اليوم! أحسنت 🎉");
      }

      const row = res.rows[0];
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("✅ تم الاستخدام", `done_${row.a_id}`)],
      ]);

      return safeReply(ctx, `📦 كود اليوم:\n\n<code>${row.code_text}</code>\n\n💡 اضغط على الكود لنسخه، ثم استخدمه\nبعد ذلك اضغط "تم الاستخدام"`, { ...keyboard, parse_mode: 'HTML' });
    } catch (err) {
      console.error("❌ اكواد_اليوم:", err.message);
      return safeReply(ctx, "❌ حدث خطأ، حاول لاحقًا.");
    }
  }

  if (text === "/اكوادى" || text.includes("اكوادى")) {
    try {
      const res = await q("SELECT id FROM users WHERE telegram_id=$1", [uid]);
      if (res.rowCount === 0) {
        return safeReply(ctx, "سجل أولًا باستخدام /تسجيل");
      }
      const userId = res.rows[0].id;
      const codes = await q("SELECT code_text, status, day_number FROM codes WHERE owner_id=$1 ORDER BY day_number ASC, created_at ASC", [userId]);
      if (codes.rowCount === 0) {
        return safeReply(ctx, "❌ لا توجد لديك أكواد.");
      }
      const list = codes.rows.map((c, i) => `${i + 1}. ${c.code_text} - Day ${c.day_number || i+1} (${c.status || 'active'})`).join("\n");
      return safeReply(ctx, `📋 أكوادك:\n${list}`);
    } catch (err) {
      console.error("❌ اكوادى:", err.message);
      return safeReply(ctx, "❌ حدث خطأ، حاول لاحقًا.");
    }
  }

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

  if (uid === ADMIN_ID && groupBroadcastMode[uid]) {
    const groupId = groupBroadcastMode[uid];
    delete groupBroadcastMode[uid];
    const message = ctx.message.text;
    try {
      const users = await q(`SELECT telegram_id FROM users WHERE group_id=$1`, [groupId]);
      let success = 0;
      for (const row of users.rows) {
        try {
          await bot.telegram.sendMessage(row.telegram_id, `📢 رسالة من الأدمن (Group ${groupId.slice(0, 8)}):\n\n${message}`);
          success++;
          await new Promise(r => setTimeout(r, 50));
        } catch (err) {
          console.error(`❌ Failed to send to ${row.telegram_id}`);
        }
      }
      return safeReply(ctx, `✅ تم إرسال الرسالة إلى ${success} مستخدم في المجموعة.`);
    } catch (err) {
      console.error("❌ group broadcast error:", err.message);
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

  if (st.stage === "uploading_codes") {
    const codeText = ctx.message.text.trim();
    if (codeText === "/done" || codeText === "/انتهيت") {
      const codes = st.codes || [];
      if (codes.length === 0) {
        delete userState[uid];
        return safeReply(ctx, "لم يتم استلام أي كود.");
      }

      try {
        const userrow = await q("SELECT id, group_id FROM users WHERE telegram_id=$1", [uid]);
        if (userrow.rowCount === 0) {
          delete userState[uid];
          return safeReply(ctx, "⚠️ لم يتم العثور على المستخدم.");
        }
        const owner_id = userrow.rows[0].id;
        const groupId = userrow.rows[0].group_id;
        const groupSettings = await getGroupSettings(groupId);

        let inserted = 0;
        for (let i = 0; i < codes.length; i++) {
          try {
            await q(
              `INSERT INTO codes (owner_id, code_text, views_per_day, status, day_number, created_at) VALUES ($1,$2,$3,'active',$4, NOW())`,
              [owner_id, codes[i], groupSettings.daily_codes_limit, i + 1]
            );
            inserted++;
          } catch (err) {
            console.error("❌ insert code error:", err.message);
          }
        }
        delete userState[uid];
        return safeReply(ctx, `✅ تم حفظ ${inserted} أكواد بالترتيب.\n\n📅 الكود 1 → اليوم 1\n📅 الكود 2 → اليوم 2\nوهكذا...\n\nكل كود سيظهر لـ ${groupSettings.daily_codes_limit} مستخدم.`);
      } catch (err) {
        console.error("❌ finishing upload:", err.message);
        delete userState[uid];
        return safeReply(ctx, "❌ حدث خطأ أثناء حفظ الأكواد.");
      }
    }

    st.codes.push(codeText);
    return safeReply(ctx, `✅ تم استلام الكود رقم ${st.codes.length} (سيظهر في اليوم ${st.codes.length}).\nأرسل الكود التالي أو اكتب /done للانتهاء.`);
  }
});

bot.on("callback_query", async (ctx) => {
  const action = ctx.callbackQuery.data;

  if (action.startsWith("done_")) {
    const assignmentId = action.replace("done_", "");
    try {
      await q("UPDATE code_view_assignments SET used=true, last_interaction_date=CURRENT_DATE WHERE id=$1", [assignmentId]);
      
      const uid = ctx.from.id.toString();
      const u = await q("SELECT id FROM users WHERE telegram_id=$1", [uid]);
      if (u.rowCount > 0) {
        const userId = u.rows[0].id;
        await q("DELETE FROM user_penalties WHERE user_id=$1", [userId]);
        
        const today = new Date().toISOString().slice(0, 10);
        const nextCode = await q(
          `SELECT a.id as a_id, c.code_text FROM code_view_assignments a 
           JOIN codes c ON a.code_id=c.id 
           WHERE a.assigned_to_user_id=$1 AND a.assigned_date=$2 AND a.used=false
           ORDER BY c.day_number ASC, c.created_at ASC LIMIT 1`,
          [userId, today]
        );
        
        if (nextCode.rowCount > 0) {
          const row = nextCode.rows[0];
          const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback("✅ تم الاستخدام", `done_${row.a_id}`)],
          ]);
          await ctx.answerCbQuery("✅ رائع! إليك الكود التالي");
          await safeReply(ctx, `📦 الكود التالي:\n\n<code>${row.code_text}</code>\n\n💡 اضغط على الكود لنسخه`, { ...keyboard, parse_mode: 'HTML' });
        } else {
          await ctx.answerCbQuery("🎉 تم إكمال كل الأكواد!");
          await safeReply(ctx, "✅ تم إكمال جميع الأكواد اليوم! أحسنت 🎉");
        }
      }
    } catch (err) {
      console.error("❌ done callback:", err.message);
      await ctx.answerCbQuery("❌ خطأ");
    }
    return;
  }

  if (ctx.from.id.toString() !== ADMIN_ID) {
    return ctx.answerCbQuery("❌ Not allowed");
  }

  try {
    if (action === "global_settings") {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("📴 Toggle All Schedulers", "toggle_all_schedulers")],
        [Markup.button.callback("🔄 Distribute Now (All)", "distribute_now")],
        [Markup.button.callback("⏰ Set Send Time", "set_time")],
        [Markup.button.callback("👁️ Set Daily Limit", "set_limit")],
        [Markup.button.callback("📅 Set Days", "set_days")],
        [Markup.button.callback("👥 Set Group Size", "set_group")],
        [Markup.button.callback("🔢 Set Max Groups", "set_max_groups")],
        [Markup.button.callback("📢 Broadcast", "broadcast")],
        [Markup.button.callback("◀️ Back", "back_to_main")],
      ]);
      await ctx.editMessageText("🌐 Global Settings (Apply to all groups):", { reply_markup: keyboard.reply_markup });
      await ctx.answerCbQuery();
      return;
    }
    
    if (action === "manage_groups") {
      const groups = await q(`SELECT id, name, is_scheduler_active FROM groups ORDER BY created_at`);
      if (groups.rowCount === 0) {
        await ctx.answerCbQuery("لا توجد مجموعات");
        return;
      }
      const keyboard = groups.rows.map(g => [
        Markup.button.callback(`${g.is_scheduler_active ? '✅' : '❌'} Group ${g.id.toString().slice(0, 8)}`, `groupdetails_${g.id}`)
      ]);
      keyboard.push([Markup.button.callback("◀️ Back", "back_to_main")]);
      await ctx.editMessageText("📦 Manage Groups (Click to view details):", { reply_markup: { inline_keyboard: keyboard } });
      await ctx.answerCbQuery();
      return;
    }
    
    if (action.startsWith("groupdetails_")) {
      const groupId = action.replace("groupdetails_", "");
      
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(groupId)) {
        await ctx.answerCbQuery("❌ Invalid group ID - please refresh /admin");
        return;
      }
      
      const g = await q(`SELECT is_scheduler_active, daily_codes_limit, distribution_days, send_time FROM groups WHERE id=$1`, [groupId]);
      if (g.rowCount > 0) {
        const group = g.rows[0];
        const userCount = await q(`SELECT COUNT(*) FROM users WHERE group_id=$1`, [groupId]);
        
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback(`${group.is_scheduler_active ? '✅ Disable' : '❌ Enable'} Scheduler`, `grouptoggle_${groupId}`)],
          [Markup.button.callback(`📅 Set Days (${group.distribution_days})`, `groupdays_${groupId}`)],
          [Markup.button.callback(`👁️ Set Limit (${group.daily_codes_limit})`, `grouplimit_${groupId}`)],
          [Markup.button.callback(`⏰ Set Time (${group.send_time})`, `grouptime_${groupId}`)],
          [Markup.button.callback(`📢 Broadcast to Group`, `groupbroadcast_${groupId}`)],
          [Markup.button.callback("◀️ Back to Groups", "manage_groups")],
        ]);
        
        await ctx.editMessageText(
          `📦 Group ${groupId.slice(0, 8)}\n\n` +
          `👥 Users: ${userCount.rows[0].count}\n` +
          `🔄 Scheduler: ${group.is_scheduler_active ? '✅ Active' : '❌ Inactive'}\n` +
          `📅 Distribution Days: ${group.distribution_days}\n` +
          `👁️ Daily Limit: ${group.daily_codes_limit}\n` +
          `⏰ Send Time: ${group.send_time}`,
          { reply_markup: keyboard.reply_markup }
        );
        await ctx.answerCbQuery();
      } else {
        await ctx.answerCbQuery("❌ Group not found");
      }
      return;
    }
    
    if (action.startsWith("grouptoggle_")) {
      const groupId = action.replace("grouptoggle_", "");
      
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(groupId)) {
        await ctx.answerCbQuery("❌ Invalid group ID");
        return;
      }
      
      const g = await q(`SELECT is_scheduler_active FROM groups WHERE id=$1`, [groupId]);
      if (g.rowCount > 0) {
        const newStatus = !g.rows[0].is_scheduler_active;
        await updateGroupSettings(groupId, 'is_scheduler_active', newStatus);
        await ctx.answerCbQuery(`✅ Scheduler ${newStatus ? 'Enabled' : 'Disabled'}`);
        
        const updated = await q(`SELECT is_scheduler_active, daily_codes_limit, distribution_days, send_time FROM groups WHERE id=$1`, [groupId]);
        const group = updated.rows[0];
        const userCount = await q(`SELECT COUNT(*) FROM users WHERE group_id=$1`, [groupId]);
        
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback(`${group.is_scheduler_active ? '✅ Disable' : '❌ Enable'} Scheduler`, `grouptoggle_${groupId}`)],
          [Markup.button.callback(`📅 Set Days (${group.distribution_days})`, `groupdays_${groupId}`)],
          [Markup.button.callback(`👁️ Set Limit (${group.daily_codes_limit})`, `grouplimit_${groupId}`)],
          [Markup.button.callback(`⏰ Set Time (${group.send_time})`, `grouptime_${groupId}`)],
          [Markup.button.callback(`📢 Broadcast to Group`, `groupbroadcast_${groupId}`)],
          [Markup.button.callback("◀️ Back to Groups", "manage_groups")],
        ]);
        
        await ctx.editMessageText(
          `📦 Group ${groupId.slice(0, 8)}\n\n` +
          `👥 Users: ${userCount.rows[0].count}\n` +
          `🔄 Scheduler: ${group.is_scheduler_active ? '✅ Active' : '❌ Inactive'}\n` +
          `📅 Distribution Days: ${group.distribution_days}\n` +
          `👁️ Daily Limit: ${group.daily_codes_limit}\n` +
          `⏰ Send Time: ${group.send_time}`,
          { reply_markup: keyboard.reply_markup }
        );
      }
      return;
    }
    
    if (action.startsWith("groupdays_")) {
      const groupId = action.replace("groupdays_", "");
      await safeReply(ctx, `📅 Use command: /gdays ${groupId.slice(0, 8)} 20\n\nExample: /gdays ${groupId.slice(0, 8)} 15`);
      await ctx.answerCbQuery();
      return;
    }
    
    if (action.startsWith("grouplimit_")) {
      const groupId = action.replace("grouplimit_", "");
      await safeReply(ctx, `👁️ Use command: /glimit ${groupId.slice(0, 8)} 50\n\nExample: /glimit ${groupId.slice(0, 8)} 60`);
      await ctx.answerCbQuery();
      return;
    }
    
    if (action.startsWith("grouptime_")) {
      const groupId = action.replace("grouptime_", "");
      await safeReply(ctx, `⏰ Use command: /gtime ${groupId.slice(0, 8)} 09:00\n\nExample: /gtime ${groupId.slice(0, 8)} 15:30`);
      await ctx.answerCbQuery();
      return;
    }
    
    if (action.startsWith("groupbroadcast_")) {
      const groupId = action.replace("groupbroadcast_", "");
      groupBroadcastMode[ctx.from.id.toString()] = groupId;
      await safeReply(ctx, `📢 Send your message to broadcast to Group ${groupId.slice(0, 8)}:`);
      await ctx.answerCbQuery();
      return;
    }
    
    if (action === "delete_cycle") {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("⚠️ Confirm Delete", "confirm_delete_cycle")],
        [Markup.button.callback("◀️ Cancel", "back_to_main")],
      ]);
      await ctx.editMessageText("⚠️ هل أنت متأكد من حذف كل الأكواد والتوزيعات؟", { reply_markup: keyboard.reply_markup });
      await ctx.answerCbQuery();
      return;
    }
    
    if (action === "confirm_delete_cycle") {
      await q("DELETE FROM code_view_assignments");
      await q("DELETE FROM codes");
      await q("DELETE FROM user_penalties");
      await safeReply(ctx, "🗑️ تم حذف جميع الأكواد والتوزيعات!");
      await ctx.answerCbQuery("✅ Deleted");
      return;
    }
    
    if (action === "back_to_main") {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🌐 Global Settings", "global_settings")],
        [Markup.button.callback("📦 Manage Groups", "manage_groups")],
        [Markup.button.callback("🗑️ Delete Cycle Now", "delete_cycle")],
        [Markup.button.callback("📊 Stats", "stats")],
      ]);
      await ctx.editMessageText("🔐 Admin Panel:", { reply_markup: keyboard.reply_markup });
      await ctx.answerCbQuery();
      return;
    }
    
    if (action === "toggle_all_schedulers") {
      const s = await getAdminSettings();
      await updateAdminSettings("is_scheduler_active", !s.is_scheduler_active);
      await q("UPDATE groups SET is_scheduler_active = $1", [!s.is_scheduler_active]);
      await safeReply(ctx, `✅ All Schedulers: ${!s.is_scheduler_active ? "Enabled" : "Disabled"}`);
    } else if (action === "distribute_now") {
      console.log("🔄 Manual distribution started");
      await runDailyDistribution();
      await safeReply(ctx, "✅ تم توزيع الأكواد يدوياً!");
    } else if (action === "set_time") {
      await safeReply(ctx, "⏰ Send: /set_time 21:00");
    } else if (action === "set_limit") {
      await safeReply(ctx, "👁️ Send: /set_limit 50");
    } else if (action === "set_days") {
      await safeReply(ctx, "📅 Send: /set_days 20");
    } else if (action === "set_group") {
      await safeReply(ctx, "👥 Send: /set_group_size 1000");
    } else if (action === "set_max_groups") {
      await safeReply(ctx, "🔢 Send: /set_max_groups 10 (or NULL)");
    } else if (action === "broadcast") {
      adminBroadcastMode = true;
      await safeReply(ctx, "📢 Send message to broadcast:");
    } else if (action === "stats") {
      const u = await q(`SELECT COUNT(*) FROM users`);
      const c = await q(`SELECT COUNT(*) FROM codes WHERE status='active'`);
      const g = await q(`SELECT COUNT(*) FROM groups`);
      const s = await getAdminSettings();
      await safeReply(ctx, `📊 Stats:\n\nUsers: ${u.rows[0].count}\nActive Codes: ${c.rows[0].count}\nGroups: ${g.rows[0].count}\nMax Groups: ${s.max_groups || 'Unlimited'}\nScheduler: ${s.is_scheduler_active ? "On" : "Off"}`);
    }
    await ctx.answerCbQuery();
  } catch (err) {
    console.error("❌ callback error:", err.message);
    await ctx.answerCbQuery();
  }
});

async function runDailyDistribution() {
  console.log("📦 بدء توزيع الأكواد...");
  try {
    const groups = await q(`SELECT id FROM groups WHERE is_scheduler_active=true`);
    
    for (const group of groups.rows) {
      const groupSettings = await getGroupSettings(group.id);
      
      const currentCycleDay = await q(
        `SELECT COALESCE(MAX(day_number), 0) as max_day FROM code_view_assignments a
         JOIN codes c ON a.code_id = c.id
         JOIN users u ON c.owner_id = u.id
         WHERE u.group_id = $1`,
        [group.id]
      );
      
      const nextDay = parseInt(currentCycleDay.rows[0].max_day) + 1;
      
      const codesRes = await q(
        `SELECT c.id, c.owner_id, c.views_per_day, c.day_number FROM codes c 
         JOIN users u ON c.owner_id=u.id 
         WHERE c.status='active' AND u.group_id=$1 AND c.day_number=$2
         ORDER BY c.created_at ASC`,
        [group.id, nextDay]
      );

      if (codesRes.rowCount === 0) {
        console.log(`⏭️ No codes for day ${nextDay} in group ${group.id}`);
        continue;
      }

      const usersRes = await q(`SELECT id FROM users WHERE group_id=$1`, [group.id]);
      const allUserIds = usersRes.rows.map(r => r.id);
      const today = new Date().toISOString().slice(0, 10);

      for (const c of codesRes.rows) {
        const viewersNeeded = c.views_per_day || groupSettings.daily_codes_limit;
        
        let candidates = allUserIds.filter(uid => uid !== c.owner_id);
        
        const alreadySeenOwnerCodes = await q(
          `SELECT DISTINCT a.assigned_to_user_id 
           FROM code_view_assignments a 
           JOIN codes cc ON a.code_id = cc.id 
           WHERE cc.owner_id=$1`,
          [c.owner_id]
        );
        const seenUserIds = alreadySeenOwnerCodes.rows.map(r => r.assigned_to_user_id);
        candidates = candidates.filter(uid => !seenUserIds.includes(uid));
        
        candidates = candidates.sort(() => 0.5 - Math.random());

        let assignedCount = 0;
        for (const candidateId of candidates) {
          if (assignedCount >= viewersNeeded) break;

          try {
            await q(
              `INSERT INTO code_view_assignments (code_id, assigned_to_user_id, assigned_date, presented_at, used, verified) 
               VALUES ($1,$2,$3,NOW(), false, false)`,
              [c.id, candidateId, today]
            );
            assignedCount++;
          } catch (err) {
            console.error("❌ Failed assignment:", err.message);
          }
        }
        console.log(`🔸 Group ${group.id} - Day ${nextDay} - Code ${c.id} distributed to ${assignedCount}/${viewersNeeded} users`);
      }
    }
    console.log(`✅ Distribution complete`);
  } catch (err) {
    console.error("❌ runDailyDistribution:", err.message);
  }
}

async function handleUnusedCodes() {
  console.log("🔍 Checking for unused codes...");
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    const unusedYesterday = await q(
      `SELECT DISTINCT a.assigned_to_user_id FROM code_view_assignments a 
       WHERE a.assigned_date=$1 AND a.used=false`,
      [yesterdayStr]
    );

    for (const row of unusedYesterday.rows) {
      const userId = row.assigned_to_user_id;
      
      const todayAssignments = await q(
        `SELECT id FROM code_view_assignments 
         WHERE assigned_to_user_id=$1 AND assigned_date=$2`,
        [userId, today]
      );

      if (todayAssignments.rowCount === 0) {
        await q(
          `UPDATE code_view_assignments 
           SET assigned_date=$1, reminder_sent=false 
           WHERE assigned_to_user_id=$2 AND assigned_date=$3 AND used=false`,
          [today, userId, yesterdayStr]
        );
        console.log(`📅 Moved unused codes for user ${userId} to today`);
      }

      const penalty = await q(
        `SELECT id, missed_days FROM user_penalties WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );

      if (penalty.rowCount > 0) {
        const missedDays = penalty.rows[0].missed_days + 1;
        await q(`UPDATE user_penalties SET missed_days=$1, penalty_date=CURRENT_DATE WHERE id=$2`, [missedDays, penalty.rows[0].id]);
        
        if (missedDays >= 2) {
          await q(
            `UPDATE codes SET status='suspended' 
             WHERE owner_id=$1 AND status='active'`,
            [userId]
          );
          await q(`UPDATE user_penalties SET codes_deleted=true WHERE id=$1`, [penalty.rows[0].id]);
          console.log(`❌ Suspended codes for user ${userId} (2 days penalty)`);
        }
      } else {
        await q(
          `INSERT INTO user_penalties (user_id, missed_days, penalty_date) VALUES ($1, 1, CURRENT_DATE)`,
          [userId]
        );
      }
    }
  } catch (err) {
    console.error("❌ handleUnusedCodes:", err.message);
  }
}

async function sendMotivationalReminders() {
  console.log("📢 Sending motivational reminders...");
  try {
    const today = new Date().toISOString().slice(0, 10);
    
    const incompleteUsers = await q(
      `SELECT DISTINCT u.telegram_id, a.assigned_to_user_id 
       FROM code_view_assignments a 
       JOIN users u ON a.assigned_to_user_id = u.id 
       WHERE a.assigned_date=$1 AND a.used=false AND a.reminder_sent=false`,
      [today]
    );

    const messages = [
      "💪 أنت قريب من الهدف! أكمل أكوادك اليوم.",
      "🎯 كل كود تستخدمه يقربك من النجاح!",
      "⭐ لا تتوقف الآن! أكمل أكوادك اليومية.",
      "🔥 الاستمرارية هي السر! أكمل أكوادك.",
      "✨ خطوة صغيرة كل يوم = نجاح كبير!"
    ];

    for (const row of incompleteUsers.rows) {
      try {
        const randomMsg = messages[Math.floor(Math.random() * messages.length)];
        await bot.telegram.sendMessage(row.telegram_id, `${randomMsg}\n\nاكتب /اكواد_اليوم للمتابعة.`);
        
        await q(
          `UPDATE code_view_assignments SET reminder_sent=true 
           WHERE assigned_to_user_id=$1 AND assigned_date=$2 AND used=false`,
          [row.assigned_to_user_id, today]
        );
        
        await new Promise(r => setTimeout(r, 100));
      } catch (err) {
        console.error(`❌ Failed to send reminder to ${row.telegram_id}`);
      }
    }
    console.log(`✅ Sent ${incompleteUsers.rowCount} reminders`);
  } catch (err) {
    console.error("❌ sendMotivationalReminders:", err.message);
  }
}

async function reactivateSuspendedCodes() {
  console.log("🔄 Reactivating suspended codes after penalty period...");
  try {
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const twoDaysAgoStr = twoDaysAgo.toISOString().slice(0, 10);

    const penalties = await q(
      `SELECT user_id FROM user_penalties 
       WHERE codes_deleted=true AND penalty_date <= $1`,
      [twoDaysAgoStr]
    );

    for (const row of penalties.rows) {
      await q(`UPDATE codes SET status='active' WHERE owner_id=$1 AND status='suspended'`, [row.user_id]);
      await q(`DELETE FROM user_penalties WHERE user_id=$1`, [row.user_id]);
      console.log(`✅ Reactivated codes for user ${row.user_id}`);
    }
  } catch (err) {
    console.error("❌ reactivateSuspendedCodes:", err.message);
  }
}

cron.schedule("0 0 1 * *", async () => {
  try {
    console.log("🔄 بدء دورة جديدة...");
    await q("DELETE FROM code_view_assignments");
    await q("DELETE FROM codes");
    await q("DELETE FROM user_penalties");
    console.log("✅ تم مسح البيانات");
  } catch (err) {
    console.error("❌ خطأ دورة جديدة:", err);
  }
});

cron.schedule("* * * * *", async () => {
  try {
    const groups = await q(`SELECT id, send_time, is_scheduler_active FROM groups WHERE is_scheduler_active=true`);
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    
    for (const group of groups.rows) {
      const [targetHour, targetMinute] = group.send_time.split(':').map(Number);
      
      if (currentHour === targetHour && currentMinute === targetMinute) {
        console.log(`🌅 Running distribution for group ${group.id} at ${group.send_time}`);
        await runDailyDistribution();
        await handleUnusedCodes();
        break;
      }
    }
  } catch (err) {
    console.error("❌ Scheduler error:", err);
  }
});

cron.schedule("0 18 * * *", async () => {
  try {
    await sendMotivationalReminders();
  } catch (err) {
    console.error("❌ Evening reminder error:", err);
  }
});

cron.schedule("0 0 * * *", async () => {
  try {
    await reactivateSuspendedCodes();
  } catch (err) {
    console.error("❌ Reactivation error:", err);
  }
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

process.once("SIGINT", () => {
  try {
    bot.stop("SIGINT");
  } catch (e) {
    console.log("Stopping...");
    process.exit(0);
  }
});

process.once("SIGTERM", () => {
  try {
    bot.stop("SIGTERM");
  } catch (e) {
    console.log("Stopping...");
    process.exit(0);
  }
});