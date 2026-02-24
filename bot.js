// bot.js - COMPLETE FINAL VERSION v2.1
// ==========================================
// الإصدار: 2.1
// بناءً على: الكود الأصلي 1909 سطر (UPDATED VERSION with verification system)
// التعديل المُضاف: معالجة أزرار verify_ و reject_ في callback_query
// ==========================================

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

const ADMIN_ID = process.env.ADMIN_ID;

// تحقق من DATABASE_URL
const dbUrl = process.env.DATABASE_URL;
console.log("📊 DATABASE_URL starts with:", dbUrl?.substring(0, 50) + "...");
console.log("🔌 Connecting to:", dbUrl?.split('@')[1]?.split('/')[0] || "unknown");

// Force close old pool and create new one
let pool;
try {
  const poolConfig = {
    connectionString: process.env.DATABASE_URL,
    ...(sslConfig ? { ssl: sslConfig } : {}),
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 20000,
    statement_timeout: 30000,
    application_name: 'render_bot_' + Date.now(),
  };
  
  console.log("🔄 Creating new pool...");
  pool = new Pool(poolConfig);
  
  // Test connection immediately
  (async () => {
    try {
      console.log("🔍 Testing database connection...");
      const client = await pool.connect();
      const result = await client.query('SELECT NOW()');
      console.log("✅ Database connected successfully!");
      console.log("⏰ Database time:", result.rows[0].now);
      client.release();
    } catch (err) {
      console.error("❌ Database connection test failed:");
      console.error("   Error message:", err.message);
      console.error("   Error code:", err.code);
      if (err.code === 'ECONNREFUSED') {
        console.error("   🔴 Connection refused");
        console.error("   💡 Supabase may be paused or unreachable from your region");
      } else if (err.code === '28P01') {
        console.error("   🔴 Authentication failed - check password in DATABASE_URL");
      }
    }
  })();
} catch (err) {
  console.error("❌ Pool creation error:", err);
}

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
      `INSERT INTO admin_settings (id, daily_codes_limit, distribution_days, group_size, send_time, is_scheduler_active, max_groups, penalties_active)
       VALUES (1, 50, 20, 1000, '09:00:00', $1, NULL, true) ON CONFLICT (id) DO NOTHING`,
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
      return { daily_codes_limit: 50, distribution_days: 20, group_size: 1000, send_time: "09:00:00", is_scheduler_active: false, max_groups: null, penalties_active: true };
    }
    return res.rows[0];
  } catch (err) {
    console.error("❌ getAdminSettings error:", err.message);
    return { daily_codes_limit: 50, distribution_days: 20, group_size: 1000, send_time: "09:00:00", is_scheduler_active: false, max_groups: null, penalties_active: true };
  }
}

async function getGroupSettings(groupId) {
  try {
    const res = await q(`SELECT daily_codes_limit, distribution_days, send_time, is_scheduler_active, payment_day, payment_mode_active, payment_mode_started, payment_mode_day FROM groups WHERE id=$1`, [groupId]);
    if (res.rowCount > 0) {
      return res.rows[0];
    }
    return { daily_codes_limit: 50, distribution_days: 20, send_time: "09:00:00", is_scheduler_active: false, payment_day: 1, payment_mode_active: false, payment_mode_started: null, payment_mode_day: 0 };
  } catch (err) {
    console.error("❌ getGroupSettings error:", err.message);
    return { daily_codes_limit: 50, distribution_days: 20, send_time: "09:00:00", is_scheduler_active: false, payment_day: 1, payment_mode_active: false, payment_mode_started: null, payment_mode_day: 0 };
  }
}

async function updateAdminSettings(field, value) {
  const allowedFields = ["daily_codes_limit", "distribution_days", "group_size", "send_time", "is_scheduler_active", "max_groups", "penalties_active"];
  if (!allowedFields.includes(field)) throw new Error("Invalid field");
  await q(`UPDATE admin_settings SET ${field}=$1 WHERE id=1`, [value]);
}

async function updateGroupSettings(groupId, field, value) {
  const allowedFields = ["daily_codes_limit", "distribution_days", "send_time", "is_scheduler_active", "payment_day", "payment_mode_active", "payment_mode_started", "payment_mode_day"];
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

// 🆕 دالة لإنشاء الأزرار الديناميكية بناءً على حالة المستخدم
async function getDynamicKeyboard(userId, groupId = null) {
  const buttons = [];
  
  // التحقق من تسجيل المستخدم
  const userRes = await q("SELECT id, group_id FROM users WHERE telegram_id=$1", [userId.toString()]);
  const isRegistered = userRes.rowCount > 0;
  
  if (!isRegistered) {
    // المستخدم غير مسجل - إظهار أزرار التسجيل فقط
    buttons.push([Markup.button.text("/تسجيل")]);
  } else {
    // المستخدم مسجل - إظهار الأزرار الرئيسية
    const userGroupId = groupId || userRes.rows[0].group_id;
    buttons.push(
      [Markup.button.text("/رفع_اكواد"), Markup.button.text("/اكواد_اليوم")],
      [Markup.button.text("/اكوادى"), Markup.button.text("✅ تأكيد الاستخدام")]
    );
    
    // التحقق من يوم الدفع أو وضع الدفع النشط
    const groupSettings = await getGroupSettings(userGroupId);
    
    // إظهار زر الدفع إذا كان وضع الدفع نشطاً (أولوية قصوى)
    if (groupSettings.payment_mode_active) {
      buttons.push([Markup.button.text("📸 إرسال إثبات الدفع")]);
    } else {
      // إظهار زر الدفع في يوم الدفع أو ±2 أيام
      const now = new Date();
      const currentDay = now.getDate();
      const paymentDay = groupSettings.payment_day || 1;
      const daysDiff = Math.abs(currentDay - paymentDay);
      if (daysDiff <= 2 || daysDiff >= 26) { // 26 لتغطية نهاية/بداية الشهر
        buttons.push([Markup.button.text("📸 إرسال إثبات الدفع")]);
      }
    }
  }
  
  // زر الأدمن (إذا كان أدمن)
  if (userId?.toString() === ADMIN_ID?.toString()) {
    buttons.push([Markup.button.text("/admin")]);
  }
  
  return Markup.keyboard(buttons).resize();
}

bot.start(async (ctx) => {
  const rulesMessage = `👋 أهلاً بك في البوت!\n\n` +
    `📜 قواعد الاستخدام:\n\n` +
    `✅ استخدم الكود يومياً قبل منتصف الليل\n` +
    `✅ اضغط "تم الاستخدام" في البوت\n` +
    `✅ قم بتأكيد من استخدم أكوادك\n` +
    `✅ الالتزام مهم\n\n` +
    `⚠️ العقوبات:\n` +
    `❌ يوم واحد: تذكير ونقل باقى الأكواد الى اليوم التالى\n` +
    `❌ يومين: تحذير نهائي\n` +
    `❌ 3 أيام: إيقاف تلقائي + حذف أكوادك\n\n` +
    `/تسجيل - للتسجيل\n` +
    `/رفع_اكواد - لرفع الأكواد\n` +
    `/اكواد_اليوم - لعرض أكواد اليوم\n` +
    `/اكوادى - لعرض أكوادك`;
  
  await safeReply(ctx, rulesMessage, await getDynamicKeyboard(ctx.from.id));
});

// أمر للحصول على Chat ID للجروب (للأدمن فقط)
bot.command("get_chat_id", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  
  const chatId = ctx.chat.id;
  const chatType = ctx.chat.type;
  const chatTitle = ctx.chat.title || "Private Chat";
  
  await safeReply(ctx, 
    `📊 معلومات الـ Chat:\n\n` +
    `🆔 Chat ID: <code>${chatId}</code>\n` +
    `📝 النوع: ${chatType}\n` +
    `🏷️ الاسم: ${chatTitle}\n\n` +
    `💡 استخدم هذا Chat ID لإرسال رسائل تلقائية لهذا الجروب`,
    { parse_mode: 'HTML' }
  );
});

bot.hears(/^\/تسجيل/, async (ctx) => {
  try {
    const tgId = ctx.from.id.toString();
    const exists = await q(`SELECT id FROM users WHERE telegram_id=$1`, [tgId]);
    if (exists.rowCount > 0) {
      return safeReply(ctx, "أنت مسجل بالفعل ✅");
    }
    userState[tgId] = { stage: "awaiting_binance" };
    return safeReply(ctx, "🔰 التسجيل - الخطوة 1/2\n\nأدخل اسم المستخدم الخاص بك في بينانس:\n\n💡 هذا الاسم سيُستخدم للتحقق من استخدام الأكواد");
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
    
    // التحقق من القائمة السوداء
    const blacklisted = await q("SELECT * FROM blacklist WHERE phone=$1 OR telegram_id=$2", [phone, tgId]);
    if (blacklisted.rowCount > 0) {
      delete userState[tgId];
      return safeReply(ctx, `🚫 تم حظرك من استخدام البوت\n\n📋 السبب: ${blacklisted.rows[0].reason || 'غير محدد'}\n\n⚠️ للاستفسار تواصل مع الإدارة`);
    }
    
    const dupPhone = await q("SELECT id FROM users WHERE phone=$1", [phone]);
    const dupTelegram = await q("SELECT id FROM users WHERE telegram_id=$1", [tgId]);
    let dupBinance = { rowCount: 0 };
    if (st.binance_username) {
      dupBinance = await q("SELECT id FROM users WHERE binance_username=$1", [st.binance_username]);
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

    await q(
      `INSERT INTO users (telegram_id, binance_username, phone, auto_name, group_id, verified, created_at) 
       VALUES ($1,$2,$3,$4,$5,true,NOW())`,
      [tgId, st.binance_username || null, phone, autoName, groupId]
    );
    delete userState[tgId];
    
    const welcomeMessage = `🎉 أهلاً بك فى بوت تبادل أكواد الظرف الأحمر\n\n` +
      `✅ تم التسجيل بنجاح!\n\n` +
      `🆔 المجموعة: ${groupId.toString().slice(0, 8)}\n` +
      `👤 اسمك: ${autoName}\n` +
      `💼 اسم بينانس: ${st.binance_username}\n\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `📜 قواعد الاستخدام:\n\n` +
      `✅ استخدم الكود يومياً قبل منتصف الليل\n` +
      `✅ اضغط "تم الاستخدام" في البوت\n` +
      `✅ قم بتأكيد من استخدم أكوادك يومياً\n` +
      `✅ الالتزام مهم\n\n` +
      `⚠️ العقوبات:\n\n` +
      `❌ عدم التأكيد على الأكواد:\n` +
      `   • يوم 1: حجب أكوادك يوم واحد\n` +
      `   • يوم 2: حجب يومين\n` +
      `   • يوم 3: حذف الحساب نهائياً\n\n` +
      `❌ الاعتراض الكاذب:\n` +
      `   • مرة 1: حجب أكوادك يوم واحد\n` +
      `   • مرة 2: حجب يومين\n` +
      `   • مرة 3: حذف الحساب نهائياً\n\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `💡 استخدم /start لعرض القائمة الرئيسية`;
    
    return safeReply(ctx, welcomeMessage, await getDynamicKeyboard(ctx.from.id, groupId));
  } catch (err) {
    console.error("❌ contact handler:", err.message);
    return safeReply(ctx, "❌ حدث خطأ داخلي أثناء التسجيل.");
  }
});

bot.on("photo", async (ctx) => {
  try {
    const tgId = ctx.from.id.toString();
    
    const userRes = await q("SELECT id, group_id, auto_name FROM users WHERE telegram_id=$1", [tgId]);
    if (userRes.rowCount === 0) {
      return safeReply(ctx, "⚠️ يجب التسجيل أولاً باستخدام /تسجيل");
    }
    
    const user = userRes.rows[0];
    const groupId = user.group_id;
    const userName = user.auto_name;
    const userId = user.id;
    
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const caption = ctx.message.caption || "";
    
    // تسجيل إثبات الدفع
    const currentMonth = new Date().toISOString().slice(0, 7);
    try {
      await q(
        `INSERT INTO payments (user_id, group_id, payment_month, proof_sent, proof_sent_at) 
         VALUES ($1, $2, $3, true, NOW()) 
         ON CONFLICT (user_id, payment_month) 
         DO UPDATE SET proof_sent=true, proof_sent_at=NOW()`,
        [userId, groupId, currentMonth]
      );
    } catch (err) {
      console.log("Payment tracking error:", err.message);
    }
    
    try {
      await bot.telegram.sendPhoto(ADMIN_ID, photo.file_id, {
        caption: `📸 إثبات دفع جديد\n\n` +
                 `👤 المستخدم: ${userName}\n` +
                 `🆔 Group: ${groupId.toString().slice(0, 8)}\n` +
                 `📱 Telegram ID: ${tgId}\n` +
                 `📅 الشهر: ${currentMonth}\n` +
                 `💬 الرسالة: ${caption || 'لا توجد رسالة'}`,
        parse_mode: 'HTML'
      });
      
      await safeReply(ctx, "✅ تم إرسال إثبات الدفع بنجاح!\n\n⏳ سيتم مراجعته من قبل الإدارة قريباً.");
    } catch (err) {
      console.error("❌ Error sending to admin:", err.message);
      await safeReply(ctx, "❌ حدث خطأ أثناء إرسال الصورة. حاول مرة أخرى.");
    }
  } catch (err) {
    console.error("❌ photo handler:", err.message);
    await safeReply(ctx, "❌ حدث خطأ. تأكد من تسجيلك أولاً.");
  }
});

bot.command("admin", async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) {
    return safeReply(ctx, "❌ مخصص للأدمن فقط.");
  }
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🌐 Global Settings", "global_settings")],
    [Markup.button.callback("📦 Manage Groups", "manage_groups")],
    [Markup.button.callback("💰 Payment Management", "payment_menu")],
    [Markup.button.callback("🚫 Blacklist", "blacklist_menu")],
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

bot.hears(/^\/set_group_chat_id/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const parts = ctx.message.text.split(" ");
  if (parts.length < 3) return safeReply(ctx, "❌ Usage: /set_group_chat_id <group_id_prefix> <chat_id>\n\nExample: /set_group_chat_id 5d124af3 -1001234567890");
  
  const groupPrefix = parts[1];
  const chatId = parts[2];
  
  try {
    const groups = await q(`SELECT id FROM groups WHERE id::text LIKE $1`, [`${groupPrefix}%`]);
    if (groups.rowCount === 0) return safeReply(ctx, "❌ Group not found");
    
    const groupId = groups.rows[0].id;
    await q(`UPDATE groups SET telegram_group_chat_id = $1 WHERE id = $2`, [chatId, groupId]);
    return safeReply(ctx, `✅ Telegram Group Chat ID set to ${chatId} for group ${groupId.slice(0, 8)}`);
  } catch (err) {
    console.error(err);
    return safeReply(ctx, "❌ Error updating group");
  }
});

bot.hears(/^\/ban /, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const parts = ctx.message.text.split(" ");
  if (parts.length < 2) return safeReply(ctx, "❌ Usage: /ban <phone> <reason>\n\nExample: /ban +201234567890 لم يدفع");
  
  const phone = parts[1];
  const reason = parts.slice(2).join(" ") || "غير محدد";
  
  try {
    await q(`INSERT INTO blacklist (phone, reason, banned_by) VALUES ($1, $2, $3) ON CONFLICT (phone) DO UPDATE SET reason=$2, banned_at=NOW()`, [phone, reason, ADMIN_ID]);
    return safeReply(ctx, `✅ تم إضافة ${phone} للقائمة السوداء\n\n📋 السبب: ${reason}`);
  } catch (err) {
    console.error(err);
    return safeReply(ctx, "❌ حدث خطأ");
  }
});

bot.hears(/^\/unban /, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const parts = ctx.message.text.split(" ");
  if (parts.length < 2) return safeReply(ctx, "❌ Usage: /unban <phone_or_telegram_id>");
  
  const identifier = parts[1];
  
  try {
    const result = await q(`DELETE FROM blacklist WHERE phone=$1 OR telegram_id=$1`, [identifier]);
    if (result.rowCount > 0) {
      return safeReply(ctx, `✅ تم إزالة ${identifier} من القائمة السوداء`);
    } else {
      return safeReply(ctx, `❌ ${identifier} غير موجود في القائمة السوداء`);
    }
  } catch (err) {
    console.error(err);
    return safeReply(ctx, "❌ حدث خطأ");
  }
});

bot.hears(/^\/banuser /, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const parts = ctx.message.text.split(" ");
  if (parts.length < 2) return safeReply(ctx, "❌ Usage: /banuser <user_name_or_phone> <reason>\n\nExample: /banuser User5 غير نزيه");
  
  const identifier = parts[1];
  const reason = parts.slice(2).join(" ") || "مخالفة القواعد";
  
  try {
    const user = await q(`SELECT * FROM users WHERE auto_name=$1 OR phone=$1 OR telegram_id=$1`, [identifier]);
    
    if (user.rowCount === 0) {
      return safeReply(ctx, `❌ المستخدم ${identifier} غير موجود`);
    }
    
    const userData = user.rows[0];
    
    // 1. إضافة للقائمة السوداء
    await q(`INSERT INTO blacklist (phone, telegram_id, reason, banned_by) VALUES ($1, $2, $3, $4) ON CONFLICT (phone) DO UPDATE SET reason=$3, banned_at=NOW()`, 
      [userData.phone, userData.telegram_id, reason, ADMIN_ID]);
    
    // 2. حذف كل الأكواد
    await q(`DELETE FROM codes WHERE owner_id=$1`, [userData.id]);
    
    // 3. حذف كل التوزيعات
    await q(`DELETE FROM code_view_assignments WHERE assigned_to_user_id=$1`, [userData.id]);
    
    // 4. حذف العقوبات
    await q(`DELETE FROM user_penalties WHERE user_id=$1`, [userData.id]);
    await q(`DELETE FROM confirmation_penalties WHERE user_id=$1`, [userData.id]);
    await q(`DELETE FROM verification_penalties WHERE user_id=$1`, [userData.id]);
    
    // 5. حذف سجلات الدفع
    await q(`DELETE FROM payments WHERE user_id=$1`, [userData.id]);
    
    // 6. حذف المستخدم
    await q(`DELETE FROM users WHERE id=$1`, [userData.id]);
    
    // 7. إرسال رسالة للمستخدم
    try {
      await bot.telegram.sendMessage(userData.telegram_id, `🚫 تم حظرك من البوت\n\n📋 السبب: ${reason}\n\n⚠️ تم حذف حسابك وجميع أكوادك\n❌ لن تتمكن من التسجيل مرة أخرى`);
    } catch (e) {
      console.log("Could not send ban message to user");
    }
    
    return safeReply(ctx, `✅ تم حظر ${userData.auto_name} بنجاح\n\n📋 السبب: ${reason}\n🗑️ تم حذف الحساب والأكواد\n🚫 تم إضافته للقائمة السوداء`);
  } catch (err) {
    console.error(err);
    return safeReply(ctx, "❌ حدث خطأ");
  }
});

bot.hears(/^\/warn_nonpayers/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  
  try {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const nonPayers = await q(`
      SELECT u.telegram_id, u.auto_name
      FROM users u
      LEFT JOIN payments p ON p.user_id = u.id AND p.payment_month = $1
      WHERE p.id IS NULL OR p.proof_sent = false
    `, [currentMonth]);
    
    if (nonPayers.rowCount === 0) {
      return safeReply(ctx, "✅ الجميع دفع!");
    }
    
    let success = 0;
    for (const user of nonPayers.rows) {
      try {
        await bot.telegram.sendMessage(user.telegram_id, 
          `⚠️ تحذير نهائي - عدم الدفع\n\n` +
          `👤 ${user.auto_name}\n` +
          `📅 الشهر: ${currentMonth}\n\n` +
          `🚨 لم نستلم إثبات الدفع منك حتى الآن\n\n` +
          `📸 يرجى إرسال إثبات الدفع فوراً عبر زر "📸 إرسال إثبات الدفع"\n\n` +
          `⛔ عدم الدفع خلال 24 ساعة سيؤدي لحظر حسابك نهائياً`
        );
        success++;
        await new Promise(r => setTimeout(r, 100));
      } catch (e) {
        console.error(`Failed to warn ${user.telegram_id}`);
      }
    }
    
    return safeReply(ctx, `✅ تم إرسال التحذير لـ ${success} مستخدم`);
  } catch (err) {
    console.error(err);
    return safeReply(ctx, "❌ حدث خطأ");
  }
});

bot.hears(/^\/set_payment_day/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  const parts = ctx.message.text.split(" ");
  if (parts.length < 3) return safeReply(ctx, "❌ Usage: /set_payment_day <group_id_prefix> <day>\n\nExample: /set_payment_day 5d124af3 15");
  
  const groupPrefix = parts[1];
  const day = parseInt(parts[2], 10);
  
  if (isNaN(day) || day < 1 || day > 28) {
    return safeReply(ctx, "❌ اليوم يجب أن يكون بين 1 و 28");
  }
  
  try {
    const groups = await q(`SELECT id FROM groups WHERE id::text LIKE $1`, [`${groupPrefix}%`]);
    if (groups.rowCount === 0) return safeReply(ctx, "❌ Group not found");
    
    const groupId = groups.rows[0].id;
    await updateGroupSettings(groupId, 'payment_day', day);
    return safeReply(ctx, `✅ تم تحديد يوم الدفع إلى ${day} للمجموعة ${groupId.slice(0, 8)}`);
  } catch (err) {
    console.error(err);
    return safeReply(ctx, "❌ Error updating group");
  }
});

bot.hears(/^\/reset_cycle/, async (ctx) => {
  if (ctx.from.id.toString() !== ADMIN_ID) return;
  try {
    await q("DELETE FROM code_view_assignments");
    await q("DELETE FROM codes");
    await q("DELETE FROM user_penalties");
    await q("DELETE FROM confirmation_penalties");
    await q("DELETE FROM verification_penalties");
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

  if (uid === ADMIN_ID) {
    if (text.startsWith("/gdays ")) {
      const parts = text.split(" ");
      if (parts.length < 3) return safeReply(ctx, "❌ Usage: /gdays <group_id_prefix> <days>");
      
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
    }

    if (text.startsWith("/glimit ")) {
      const parts = text.split(" ");
      if (parts.length < 3) return safeReply(ctx, "❌ Usage: /glimit <group_id_prefix> <limit>");
      
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
    }

    if (text.startsWith("/gtime ")) {
      const parts = text.split(" ");
      if (parts.length < 3) return safeReply(ctx, "❌ Usage: /gtime <group_id_prefix> 09:00");
      
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
    }
  }

  // 🆕 زر إرسال إثبات الدفع
  if (text === "📸 إرسال إثبات الدفع") {
    try {
      const userRes = await q("SELECT id FROM users WHERE telegram_id=$1", [uid]);
      if (userRes.rowCount === 0) {
        return safeReply(ctx, "⚠️ يجب التسجيل أولاً باستخدام /تسجيل");
      }
      
      return safeReply(ctx, "📸 أرسل الآن صورة إثبات الدفع\n\n💡 يمكنك إضافة رسالة مع الصورة إذا أردت\n\n⚠️ تأكد من وضوح الصورة");
    } catch (err) {
      console.error("❌ payment proof button:", err.message);
      return safeReply(ctx, "❌ حدث خطأ، حاول لاحقًا.");
    }
  }

  // 🆕 زر تأكيد الاستخدام - عرض الأكواد التي تحتاج تأكيد
  if (text === "✅ تأكيد الاستخدام") {
    try {
      const userRes = await q("SELECT id, binance_username FROM users WHERE telegram_id=$1", [uid]);
      if (userRes.rowCount === 0) {
        return safeReply(ctx, "⚠️ يجب التسجيل أولاً باستخدام /تسجيل");
      }
      
      const userId = userRes.rows[0].id;
      const today = new Date().toISOString().slice(0, 10);
      
      // الحصول على الأكواد التي استُخدمت ولم يتم التأكيد عليها بعد
      const pendingVerifications = await q(
        `SELECT 
          a.id as assignment_id,
          c.code_text,
          u.auto_name as user_name,
          u.binance_username,
          a.used,
          a.verified
         FROM code_view_assignments a
         JOIN codes c ON a.code_id = c.id
         JOIN users u ON a.assigned_to_user_id = u.id
         WHERE c.owner_id = $1 
           AND a.assigned_date = $2 
           AND a.used = true 
           AND a.verified = false
         ORDER BY a.presented_at ASC
         LIMIT 10`,
        [userId, today]
      );
      
      if (pendingVerifications.rowCount === 0) {
        return safeReply(ctx, "✅ لا توجد أكواد تحتاج تأكيد حالياً\n\n💡 سيتم إرسال إشعار لك عند استخدام أي شخص لأكوادك");
      }
      
      let message = `📋 الأكواد التي تحتاج تأكيد (${pendingVerifications.rowCount}):\n\n`;
      
      const keyboard = [];
      pendingVerifications.rows.forEach((row, i) => {
        message += `${i + 1}. الكود: ${row.code_text}\n`;
        message += `   👤 المستخدم: ${row.user_name}\n`;
        message += `   💼 بينانس: ${row.binance_username || 'غير محدد'}\n\n`;
        
        keyboard.push([
          Markup.button.callback(`✅ تأكيد ${i + 1}`, `verify_${row.assignment_id}`),
          Markup.button.callback(`❌ اعتراض ${i + 1}`, `reject_${row.assignment_id}`)
        ]);
      });
      
      message += `━━━━━━━━━━━━━━━━━\n\n`;
      message += `💡 راجع قائمة من استخدم أكوادك في بينانس\n`;
      message += `✅ اضغط "تأكيد" إذا وجدت الاسم\n`;
      message += `❌ اضغط "اعتراض" إذا لم تجد الاسم`;
      
      return safeReply(ctx, message, Markup.inlineKeyboard(keyboard));
    } catch (err) {
      console.error("❌ verification button:", err.message);
      return safeReply(ctx, "❌ حدث خطأ، حاول لاحقًا.");
    }
  }

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
      
      // التحقق من وضع الدفع
      if (groupSettings.payment_mode_active) {
        const currentMonth = new Date().toISOString().slice(0, 7);
        const userPayment = await q(`SELECT proof_sent FROM payments WHERE user_id=$1 AND payment_month=$2`, [userId, currentMonth]);
        
        if (userPayment.rowCount === 0 || !userPayment.rows[0].proof_sent) {
          return safeReply(ctx, 
            `💰 وضع الدفع نشط\n\n` +
            `⏸️ التوزيع متوقف حالياً لحين استكمال الدفعات\n\n` +
            `📸 يرجى إرسال إثبات الدفع عبر زر "📸 إرسال إثبات الدفع"\n\n` +
            `⚠️ بعد إرسال الإثبات، سيتم استئناف التوزيع تلقائياً`
          );
        }
      }
      
      if (!groupSettings.is_scheduler_active) {
        return safeReply(ctx, "⏸️ التوزيع متوقف حالياً من قبل الأدمن.\n\nسيتم استئناف التوزيع عند إعادة التفعيل.");
      }
      
      // التحقق من وجود أكواد معلقة (توقف مؤقت)
      const today = new Date().toISOString().slice(0, 10);
      const pendingCodes = await q(
        `SELECT COUNT(*) FROM code_view_assignments 
         WHERE assigned_to_user_id=$1 AND marked_unused=true AND assigned_date=$2`,
        [userId, today]
      );
      
      if (parseInt(pendingCodes.rows[0].count) > 0) {
        return safeReply(ctx, 
          `⏸️ أنت في وضع التوقف المؤقت\n\n` +
          `💡 الهدف: زيادة فرصك في استخدام الأكواد\n\n` +
          `📊 في بينانس: كلما استخدم الآخرون كودك، زادت فرصك\n\n` +
          `⏳ ستستأنف تلقائياً عند استخدام أي شخص لكودك\n\n` +
          `🔔 ستصلك رسالة فورية مع الكود التالي\n\n` +
          `📋 استخدم /my_codes_status لمعرفة حالة أكوادك`
        );
      }
      
      const res = await q(
        `SELECT a.id as a_id, c.code_text, a.used FROM code_view_assignments a 
         JOIN codes c ON a.code_id=c.id 
         WHERE a.assigned_to_user_id=$1 AND a.assigned_date=$2 AND a.used=false AND a.marked_unused=false
         ORDER BY c.day_number ASC, c.created_at ASC LIMIT 1`,
        [userId, today]
      );
      
      if (res.rowCount === 0) {
        return safeReply(ctx, "✅ تم إكمال جميع الأكواد اليوم! أحسنت 🎉");
      }

      const row = res.rows[0];
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback("✅ تم الاستخدام", `done_${row.a_id}`),
          Markup.button.callback("❌ توقف مؤقت", `notdone_${row.a_id}`)
        ],
      ]);

      return safeReply(ctx, `📦 كود اليوم:\n\n<code>${row.code_text}</code>\n\n💡 اضغط على الكود لنسخه، ثم استخدمه\n\n✅ تم الاستخدام - إذا استخدمته في بينانس\n❌ توقف مؤقت - لزيادة فرصك (سيستأنف تلقائياً)`, { ...keyboard, parse_mode: 'HTML' });
    } catch (err) {
      console.error("❌ اكواد_اليوم:", err.message);
      return safeReply(ctx, "❌ حدث خطأ، حاول لاحقًا.");
    }
  }

  if (text === "/my_codes_status" || text.includes("my_codes_status")) {
    try {
      const res = await q("SELECT id FROM users WHERE telegram_id=$1", [uid]);
      if (res.rowCount === 0) {
        return safeReply(ctx, "سجل أولًا باستخدام /تسجيل");
      }
      const userId = res.rows[0].id;
      const today = new Date().toISOString().slice(0, 10);
      
      const myCodes = await q(
        `SELECT c.id, c.code_text, c.views_per_day, c.day_number,
                COUNT(a.id) FILTER (WHERE a.used=true) as used_count,
                COUNT(a.id) FILTER (WHERE a.used=true AND a.verified=true) as verified_count,
                STRING_AGG(u.auto_name, ', ') FILTER (WHERE a.used=true) as users_list,
                STRING_AGG(u.binance_username, ', ') FILTER (WHERE a.used=true) as binance_list
         FROM codes c
         LEFT JOIN code_view_assignments a ON a.code_id = c.id AND a.assigned_date=$2
         LEFT JOIN users u ON a.assigned_to_user_id = u.id
         WHERE c.owner_id=$1 AND c.status='active'
         GROUP BY c.id, c.code_text, c.views_per_day, c.day_number
         ORDER BY c.day_number ASC`,
        [userId, today]
      );
      
      if (myCodes.rowCount === 0) {
        return safeReply(ctx, "❌ لا توجد لديك أكواد نشطة اليوم");
      }
      
      let message = `📊 حالة أكوادك اليوم:\n\n`;
      
      myCodes.rows.forEach((code, i) => {
        const usedCount = parseInt(code.used_count) || 0;
        const verifiedCount = parseInt(code.verified_count) || 0;
        const maxCount = code.views_per_day || 50;
        const percentage = Math.round((usedCount / maxCount) * 100);
        const pendingVerification = usedCount - verifiedCount;
        
        message += `${i + 1}. ${code.code_text}\n`;
        message += `   📊 ${usedCount}/${maxCount} (${percentage}%)\n`;
        message += `   ✅ تم التأكيد: ${verifiedCount}\n`;
        if (pendingVerification > 0) {
          message += `   ⏳ بانتظار التأكيد: ${pendingVerification}\n`;
        }
        
        if (code.users_list) {
          const users = code.users_list.split(', ');
          const binanceUsers = code.binance_list ? code.binance_list.split(', ') : [];
          if (users.length <= 3) {
            users.forEach((user, idx) => {
              const binance = binanceUsers[idx] || 'غير محدد';
              message += `   👤 ${user} (${binance})\n`;
            });
          } else {
            for (let idx = 0; idx < 3; idx++) {
              const binance = binanceUsers[idx] || 'غير محدد';
              message += `   👤 ${users[idx]} (${binance})\n`;
            }
            message += `   ... +${users.length - 3} آخرين\n`;
          }
        }
        message += `\n`;
      });
      
      message += `💡 استخدم زر "✅ تأكيد الاستخدام" للتأكيد على من استخدم أكوادك`;
      
      return safeReply(ctx, message);
    } catch (err) {
      console.error("❌ my_codes_status:", err.message);
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
      return safeReply(ctx, "⚠️ اسم مستخدم غير صالح، حاول مجددًا.");
    }
    st.binance_username = binance;
    st.stage = "awaiting_phone";
    return safeReply(ctx, "🔰 التسجيل - الخطوة 2/2\n\nأرسل رقم هاتفك عبر زر المشاركة:", {
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

// ==================== CALLBACK QUERY HANDLER ====================

bot.on("callback_query", async (ctx) => {
  const action = ctx.callbackQuery.data;

  // ==========================================
  // 🆕 التعديل المُضاف: معالجة verify_ و reject_
  // ==========================================

  // ✅ تأكيد الاستخدام - صاحب الكود يؤكد أن الشخص استخدم الكود فعلاً
  if (action.startsWith("verify_")) {
    const assignmentId = action.replace("verify_", "");
    try {
      await q("UPDATE code_view_assignments SET verified=true WHERE id=$1", [assignmentId]);
      await ctx.answerCbQuery("✅ تم التأكيد بنجاح!");
      await safeReply(ctx, "✅ تم تأكيد الاستخدام بنجاح!\n\n💡 شكراً على الالتزام بالتأكيد اليومي");
    } catch (err) {
      console.error("❌ verify callback:", err.message);
      await ctx.answerCbQuery("❌ خطأ في التأكيد");
    }
    return;
  }

  // ❌ الاعتراض - صاحب الكود يعترض على أن الشخص لم يستخدم الكود فعلاً
  if (action.startsWith("reject_")) {
    const assignmentId = action.replace("reject_", "");
    try {
      // الحصول على بيانات المستخدم المخالف
      const assignInfo = await q(
        `SELECT a.assigned_to_user_id, u.telegram_id, u.auto_name, u.id as violator_db_id
         FROM code_view_assignments a
         JOIN users u ON a.assigned_to_user_id = u.id
         WHERE a.id=$1`,
        [assignmentId]
      );

      if (assignInfo.rowCount > 0) {
        const violator = assignInfo.rows[0];

        // التحقق من عقوبات الاعتراض السابقة
        const existing = await q(
          `SELECT id, false_claim_count FROM verification_penalties WHERE user_id=$1`,
          [violator.violator_db_id]
        );

        let falseCount = 1;
        if (existing.rowCount > 0) {
          falseCount = existing.rows[0].false_claim_count + 1;
          await q(
            `UPDATE verification_penalties SET false_claim_count=$1, last_false=NOW() WHERE user_id=$2`,
            [falseCount, violator.violator_db_id]
          );
        } else {
          await q(
            `INSERT INTO verification_penalties (user_id, false_claim_count, last_false) VALUES ($1, 1, NOW())`,
            [violator.violator_db_id]
          );
        }

        // تطبيق العقوبة بناءً على عدد المخالفات
        let penaltyMsg = "";
        if (falseCount === 1) {
          // المخالفة الأولى: حجب الأكواد يوم واحد
          await q(
            `UPDATE codes SET status='suspended', suspension_until=(NOW() + INTERVAL '1 day')
             WHERE owner_id=$1 AND status='active'`,
            [violator.violator_db_id]
          );
          penaltyMsg = `⚠️ تم الاعتراض على استخدامك للكود!\n\n` +
            `🚫 العقوبة: حجب أكوادك لمدة يوم واحد\n\n` +
            `⚠️ هذه المرة الأولى - كن حذراً!\n` +
            `💡 يجب استخدام الأكواد فعلياً في بينانس`;
        } else if (falseCount === 2) {
          // المخالفة الثانية: حجب الأكواد يومين
          await q(
            `UPDATE codes SET status='suspended', suspension_until=(NOW() + INTERVAL '2 days')
             WHERE owner_id=$1 AND status='active'`,
            [violator.violator_db_id]
          );
          penaltyMsg = `⚠️ اعتراض ثانٍ على استخدامك للكود!\n\n` +
            `🚫 العقوبة: حجب أكوادك لمدة يومين\n\n` +
            `🚨 هذا تحذير نهائي!\n` +
            `💡 المرة القادمة = حذف الحساب نهائياً`;
        } else {
          // المخالفة الثالثة: حذف الحساب نهائياً
          await q(`DELETE FROM codes WHERE owner_id=$1`, [violator.violator_db_id]);
          await q(`DELETE FROM code_view_assignments WHERE assigned_to_user_id=$1`, [violator.violator_db_id]);
          await q(`DELETE FROM verification_penalties WHERE user_id=$1`, [violator.violator_db_id]);
          await q(`DELETE FROM confirmation_penalties WHERE user_id=$1`, [violator.violator_db_id]);
          await q(`DELETE FROM user_penalties WHERE user_id=$1`, [violator.violator_db_id]);
          await q(`DELETE FROM payments WHERE user_id=$1`, [violator.violator_db_id]);
          await q(`DELETE FROM users WHERE id=$1`, [violator.violator_db_id]);
          penaltyMsg = `🚫 تم حذف حسابك نهائياً من البوت!\n\n` +
            `❌ السبب: اعتراض كاذب 3 مرات\n\n` +
            `⚠️ تم حذف جميع أكوادك وحسابك`;
        }

        // إرسال إشعار العقوبة للمخالف
        try {
          await bot.telegram.sendMessage(violator.telegram_id, penaltyMsg);
        } catch (e) {
          console.log(`Could not send rejection penalty to ${violator.telegram_id}`);
        }

        // إعادة التوزيع: تعليم الكود كـ غير مستخدم حتى يُعاد توزيعه
        if (falseCount < 3) {
          await q("UPDATE code_view_assignments SET verified=false, used=false WHERE id=$1", [assignmentId]);
        }
      }

      await ctx.answerCbQuery("✅ تم تسجيل الاعتراض");
      await safeReply(ctx, "✅ تم تسجيل الاعتراض وتطبيق العقوبة المناسبة");
    } catch (err) {
      console.error("❌ reject callback:", err.message);
      await ctx.answerCbQuery("❌ خطأ في تسجيل الاعتراض");
    }
    return;
  }

  // ==========================================
  // باقي الـ callbacks الأصلية
  // ==========================================

  if (action.startsWith("done_")) {
    const assignmentId = action.replace("done_", "");
    try {
      await q("UPDATE code_view_assignments SET used=true, last_interaction_date=CURRENT_DATE WHERE id=$1", [assignmentId]);
      
      const uid = ctx.from.id.toString();
      const u = await q("SELECT id, auto_name, group_id FROM users WHERE telegram_id=$1", [uid]);
      if (u.rowCount > 0) {
        const userId = u.rows[0].id;
        const userName = u.rows[0].auto_name;
        
        await q("DELETE FROM user_penalties WHERE user_id=$1", [userId]);
        
        // إشعار صاحب الكود عند الاستخدام
        const codeInfo = await q(
          `SELECT c.id as code_id, c.owner_id, c.code_text, u.telegram_id as owner_telegram_id, u.auto_name as owner_name
           FROM code_view_assignments a
           JOIN codes c ON a.code_id = c.id
           JOIN users u ON c.owner_id = u.id
           WHERE a.id = $1`,
          [assignmentId]
        );
        
        if (codeInfo.rowCount > 0 && codeInfo.rows[0].owner_id !== userId) {
          const codeData = codeInfo.rows[0];
          const today = new Date().toISOString().slice(0, 10);
          
          const usageCount = await q(
            `SELECT COUNT(*) as count FROM code_view_assignments
             WHERE code_id=$1 AND assigned_date=$2 AND used=true`,
            [codeData.code_id, today]
          );
          
          // التحقق من أكواد الانتظار لصاحب الكود (وضع التوقف المؤقت)
          const ownerPendingCodes = await q(
            `SELECT a.id as a_id, c.code_text FROM code_view_assignments a
             JOIN codes c ON a.code_id = c.id
             WHERE a.assigned_to_user_id=$1 AND a.marked_unused=true AND a.assigned_date=$2
             ORDER BY c.day_number ASC LIMIT 1`,
            [codeData.owner_id, today]
          );
          
          try {
            let notificationMsg = `🔔 تم استخدام كودك!\n\n` +
              `📦 الكود: ${codeData.code_text}\n` +
              `👤 استخدمه: ${userName}\n\n` +
              `📊 إجمالي الاستخدام اليوم: ${usageCount.rows[0].count}\n\n` +
              `💡 قارن هذا العدد بعدد الاستخدام في بينانس`;
            
            if (ownerPendingCodes.rowCount > 0) {
              const pendingCode = ownerPendingCodes.rows[0];
              await q(`UPDATE code_view_assignments SET marked_unused=false WHERE id=$1`, [pendingCode.a_id]);
              notificationMsg += `\n\n━━━━━━━━━━━━━━━━━\n\n✅ تم زيادة فرصك! يمكنك الاستمرار\n\n📦 استكمل من هنا:\n\n<code>${pendingCode.code_text}</code>`;
              const pendingKeyboard = Markup.inlineKeyboard([[
                Markup.button.callback("✅ تم الاستخدام", `done_${pendingCode.a_id}`),
                Markup.button.callback("❌ توقف مؤقت", `notdone_${pendingCode.a_id}`)
              ]]);
              await bot.telegram.sendMessage(codeData.owner_telegram_id, notificationMsg, { parse_mode: 'HTML', reply_markup: pendingKeyboard.reply_markup });
            } else {
              await bot.telegram.sendMessage(codeData.owner_telegram_id, notificationMsg);
            }
          } catch (e) {
            console.log(`Could not notify code owner ${codeData.owner_telegram_id}`);
          }
        }
        
        // عرض الكود التالي
        const today = new Date().toISOString().slice(0, 10);
        const nextCode = await q(
          `SELECT a.id as a_id, c.code_text FROM code_view_assignments a 
           JOIN codes c ON a.code_id=c.id 
           WHERE a.assigned_to_user_id=$1 AND a.assigned_date=$2 AND a.used=false AND a.marked_unused=false
           ORDER BY c.day_number ASC LIMIT 1`,
          [userId, today]
        );
        
        if (nextCode.rowCount > 0) {
          const row = nextCode.rows[0];
          const keyboard = Markup.inlineKeyboard([[
            Markup.button.callback("✅ تم الاستخدام", `done_${row.a_id}`),
            Markup.button.callback("❌ توقف مؤقت", `notdone_${row.a_id}`)
          ]]);
          await ctx.answerCbQuery("✅ رائع! إليك الكود التالي");
          await safeReply(ctx, `✅ تم تسجيل الاستخدام!\n\n📦 الكود التالي:\n\n<code>${row.code_text}</code>\n\n✅ تم الاستخدام - إذا استخدمته\n❌ توقف مؤقت - لزيادة فرصك`, { ...keyboard, parse_mode: 'HTML' });
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

  if (action.startsWith("notdone_")) {
    const assignmentId = action.replace("notdone_", "");
    try {
      await q("UPDATE code_view_assignments SET marked_unused=true WHERE id=$1", [assignmentId]);
      await ctx.answerCbQuery("⏸️ تم التوقف مؤقتاً");
      await safeReply(ctx, 
        `⏸️ تم التوقف المؤقت\n\n` +
        `💡 الهدف: زيادة فرصك في استخدام الأكواد\n\n` +
        `📊 في بينانس: كلما استخدم الآخرون كودك، زادت فرصك\n\n` +
        `⏳ ستستأنف تلقائياً عند استخدام أي شخص لكودك\n\n` +
        `🔔 ستصلك رسالة فورية مع الكود التالي`
      );
    } catch (err) {
      console.error("❌ notdone callback:", err.message);
      await ctx.answerCbQuery("❌ خطأ");
    }
    return;
  }

  // Admin callbacks
  if (ctx.from.id.toString() !== ADMIN_ID) {
    return ctx.answerCbQuery("❌ مخصص للأدمن فقط");
  }

  try {
    if (action === "global_settings") {
      const s = await getAdminSettings();
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("📴 Toggle All Schedulers", "toggle_all_schedulers")],
        [Markup.button.callback(`${s.penalties_active ? '🔴 Disable' : '🟢 Enable'} Penalties`, "toggle_penalties")],
        [Markup.button.callback("🔄 Distribute Now (All)", "distribute_now")],
        [Markup.button.callback("⏰ Set Send Time", "set_time")],
        [Markup.button.callback("👁️ Set Daily Limit", "set_limit")],
        [Markup.button.callback("📅 Set Days", "set_days")],
        [Markup.button.callback("👥 Set Group Size", "set_group")],
        [Markup.button.callback("🔢 Set Max Groups", "set_max_groups")],
        [Markup.button.callback("📢 Broadcast to All", "broadcast")],
        [Markup.button.callback("◀️ Back", "back_to_main")],
      ]);
      await ctx.editMessageText(
        `🌐 Global Settings\n\nPenalties System: ${s.penalties_active ? '✅ Active' : '❌ Inactive'}`,
        { reply_markup: keyboard.reply_markup }
      );
      await ctx.answerCbQuery();
      return;
    }

    if (action === "manage_groups") {
      const groups = await q(`SELECT id, name, is_scheduler_active FROM groups ORDER BY created_at`);
      if (groups.rowCount === 0) {
        await ctx.answerCbQuery("لا توجد مجموعات بعد");
        return;
      }
      const keyboard = groups.rows.map(g => [
        Markup.button.callback(`${g.is_scheduler_active ? '✅' : '❌'} Group ${g.id.toString().slice(0, 8)}`, `groupdetails_${g.id}`)
      ]);
      keyboard.push([Markup.button.callback("◀️ Back", "back_to_main")]);
      await ctx.editMessageText("📦 Manage Groups:", { reply_markup: { inline_keyboard: keyboard } });
      await ctx.answerCbQuery();
      return;
    }

    if (action.startsWith("groupdetails_")) {
      const groupId = action.replace("groupdetails_", "");
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(groupId)) { await ctx.answerCbQuery("❌ Invalid group ID"); return; }
      const g = await q(`SELECT is_scheduler_active, daily_codes_limit, distribution_days, send_time, payment_day FROM groups WHERE id=$1`, [groupId]);
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
          `📦 Group ${groupId.slice(0, 8)}\n\n👥 Users: ${userCount.rows[0].count}\n🔄 Scheduler: ${group.is_scheduler_active ? '✅ Active' : '❌ Inactive'}\n📅 Days: ${group.distribution_days}\n👁️ Limit: ${group.daily_codes_limit}\n⏰ Time: ${group.send_time}\n💰 Payment Day: ${group.payment_day || 1}`,
          { reply_markup: keyboard.reply_markup }
        );
        await ctx.answerCbQuery();
      }
      return;
    }

    if (action.startsWith("grouptoggle_")) {
      const groupId = action.replace("grouptoggle_", "");
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(groupId)) { await ctx.answerCbQuery("❌ Invalid group ID"); return; }
      const g = await q(`SELECT is_scheduler_active FROM groups WHERE id=$1`, [groupId]);
      if (g.rowCount > 0) {
        const newStatus = !g.rows[0].is_scheduler_active;
        await updateGroupSettings(groupId, 'is_scheduler_active', newStatus);
        await ctx.answerCbQuery(`✅ Scheduler ${newStatus ? 'Enabled' : 'Disabled'}`);
        const updated = await q(`SELECT is_scheduler_active, daily_codes_limit, distribution_days, send_time, payment_day FROM groups WHERE id=$1`, [groupId]);
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
          `📦 Group ${groupId.slice(0, 8)}\n\n👥 Users: ${userCount.rows[0].count}\n🔄 Scheduler: ${group.is_scheduler_active ? '✅ Active' : '❌ Inactive'}\n📅 Days: ${group.distribution_days}\n👁️ Limit: ${group.daily_codes_limit}\n⏰ Time: ${group.send_time}`,
          { reply_markup: keyboard.reply_markup }
        );
      }
      return;
    }

    if (action.startsWith("groupdays_")) {
      const groupId = action.replace("groupdays_", "");
      await safeReply(ctx, `📅 لتغيير عدد الأيام، أرسل:\n\n/gdays ${groupId.slice(0, 8)} 20`);
      await ctx.answerCbQuery();
      return;
    }

    if (action.startsWith("grouplimit_")) {
      const groupId = action.replace("grouplimit_", "");
      await safeReply(ctx, `👁️ لتغيير الحد اليومي، أرسل:\n\n/glimit ${groupId.slice(0, 8)} 50`);
      await ctx.answerCbQuery();
      return;
    }

    if (action.startsWith("grouptime_")) {
      const groupId = action.replace("grouptime_", "");
      await safeReply(ctx, `⏰ لتغيير وقت الإرسال، أرسل:\n\n/gtime ${groupId.slice(0, 8)} 09:00`);
      await ctx.answerCbQuery();
      return;
    }

    if (action.startsWith("groupbroadcast_")) {
      const groupId = action.replace("groupbroadcast_", "");
      groupBroadcastMode[ctx.from.id.toString()] = groupId;
      await safeReply(ctx, `📢 أرسل الرسالة الآن لإرسالها لجميع أعضاء Group ${groupId.slice(0, 8)}:`);
      await ctx.answerCbQuery();
      return;
    }

    if (action === "delete_cycle") {
      const confirmKeyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback("⚠️ نعم، احذف كل شيء", "confirm_delete_cycle"),
          Markup.button.callback("◀️ إلغاء", "back_to_main")
        ]
      ]);
      await ctx.editMessageText(
        `⚠️ تحذير!\n\nهل أنت متأكد من حذف جميع الأكواد والتوزيعات؟\n\n❌ هذا الإجراء لا يمكن التراجع عنه`,
        { reply_markup: confirmKeyboard.reply_markup }
      );
      await ctx.answerCbQuery();
      return;
    }

    if (action === "confirm_delete_cycle") {
      await q("DELETE FROM code_view_assignments");
      await q("DELETE FROM codes");
      await q("DELETE FROM user_penalties");
      await q("DELETE FROM confirmation_penalties");
      await q("DELETE FROM verification_penalties");
      await safeReply(ctx, "🗑️ تم حذف جميع الأكواد والتوزيعات!\n\n✅ جاهز لدورة جديدة.");
      await ctx.answerCbQuery("✅ تم الحذف");
      return;
    }

    if (action === "payment_menu") {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("📢 Send Payment Reminder (All)", "payment_remind_all")],
        [Markup.button.callback("▶️ Resume Distribution (All)", "payment_resume_all")],
        [Markup.button.callback("📋 Check Payment Status", "payment_status")],
        [Markup.button.callback("⚠️ Non-Payers List", "payment_nonpayers")],
        [Markup.button.callback("📦 Group Payment Settings", "payment_groups")],
        [Markup.button.callback("◀️ Back", "back_to_main")],
      ]);
      await ctx.editMessageText("💰 Payment Management:", { reply_markup: keyboard.reply_markup });
      await ctx.answerCbQuery();
      return;
    }

    if (action === "payment_resume_all") {
      await q(`UPDATE groups SET payment_mode_active=false, payment_mode_day=0, is_scheduler_active=true`);
      await safeReply(ctx, `✅ تم استئناف التوزيع لجميع المجموعات\n\n▶️ الأكواد ستُوزع في موعدها`);
      await ctx.answerCbQuery("✅ تم استئناف التوزيع");
      return;
    }

    if (action === "payment_remind_all") {
      const currentMonth = new Date().toISOString().slice(0, 7);
      const users = await q(`SELECT u.telegram_id, u.auto_name FROM users u`);
      await q(`UPDATE groups SET payment_mode_active=true, payment_mode_started=NOW(), payment_mode_day=1, is_scheduler_active=false`);
      let success = 0;
      for (const user of users.rows) {
        try {
          // ✅ إرسال الكيبورد المحدث مع زر إثبات الدفع
          const userKeyboard = await getDynamicKeyboard(user.telegram_id);
          await bot.telegram.sendMessage(user.telegram_id, 
            `💰 تذكير دفع الاشتراك الشهري\n\n` +
            `📅 الشهر: ${currentMonth}\n` +
            `👤 ${user.auto_name}\n\n` +
            `⏸️ تم إيقاف توزيع الأكواد مؤقتاً\n\n` +
            `📸 يرجى إرسال إثبات الدفع عبر زر "📸 إرسال إثبات الدفع"\n\n` +
            `⚠️ لديك 3 أيام لإرسال الإثبات`,
            userKeyboard
          );
          success++;
          await new Promise(r => setTimeout(r, 100));
        } catch (e) {}
      }
      await q(`UPDATE groups SET last_payment_reminder=NOW()`);
      await safeReply(ctx, `✅ تم إرسال التذكير لـ ${success} مستخدم\n\n⏸️ تم إيقاف التوزيع حتى استلام الدفعات`);
      await ctx.answerCbQuery();
      return;
    }

    if (action === "payment_status") {
      const currentMonth = new Date().toISOString().slice(0, 7);
      const total = await q(`SELECT COUNT(*) FROM users`);
      const paid = await q(`SELECT COUNT(*) FROM payments WHERE payment_month=$1 AND proof_sent=true`, [currentMonth]);
      const groups = await q(
        `SELECT g.id, COUNT(u.id) as total_users, COUNT(p.id) FILTER (WHERE p.proof_sent=true) as paid_users
         FROM groups g LEFT JOIN users u ON u.group_id = g.id LEFT JOIN payments p ON p.user_id = u.id AND p.payment_month = $1
         GROUP BY g.id ORDER BY g.created_at`,
        [currentMonth]
      );
      let message = `💰 حالة الدفع - ${currentMonth}\n\n📊 الإجمالي: ${paid.rows[0].count}/${total.rows[0].count}\n\n📦 حسب المجموعات:\n\n`;
      groups.rows.forEach(g => {
        const paidCount = parseInt(g.paid_users) || 0;
        const totalCount = parseInt(g.total_users) || 0;
        const rate = totalCount > 0 ? Math.round((paidCount/totalCount)*100) : 0;
        message += `• Group ${g.id.toString().slice(0, 8)}: ${paidCount}/${totalCount} (${rate}%)\n`;
      });
      await safeReply(ctx, message);
      await ctx.answerCbQuery();
      return;
    }

    if (action === "payment_nonpayers") {
      const currentMonth = new Date().toISOString().slice(0, 7);
      const nonPayers = await q(
        `SELECT u.auto_name, u.phone, u.group_id FROM users u
         LEFT JOIN payments p ON p.user_id = u.id AND p.payment_month = $1
         WHERE p.id IS NULL OR p.proof_sent = false ORDER BY u.group_id, u.auto_name`,
        [currentMonth]
      );
      if (nonPayers.rowCount === 0) {
        await ctx.answerCbQuery("✅ الجميع دفع!");
        return;
      }
      let message = `⚠️ قائمة من لم يدفع - ${currentMonth}\n📊 العدد: ${nonPayers.rowCount}\n\n`;
      const byGroup = {};
      nonPayers.rows.forEach(u => {
        const gid = u.group_id.toString().slice(0, 8);
        if (!byGroup[gid]) byGroup[gid] = [];
        byGroup[gid].push(u);
      });
      for (const [gid, users] of Object.entries(byGroup)) {
        message += `📦 Group ${gid}:\n`;
        users.forEach(u => { message += `  • ${u.auto_name} (${u.phone || 'N/A'})\n`; });
        message += `\n`;
      }
      await safeReply(ctx, message);
      await ctx.answerCbQuery();
      return;
    }

    if (action === "payment_groups") {
      const groups = await q(`SELECT id, name, payment_day FROM groups ORDER BY created_at`);
      if (groups.rowCount === 0) { await ctx.answerCbQuery("لا توجد مجموعات"); return; }
      const keyboard = groups.rows.map(g => [
        Markup.button.callback(`Group ${g.id.toString().slice(0, 8)} (Day: ${g.payment_day || 1})`, `payment_group_${g.id}`)
      ]);
      keyboard.push([Markup.button.callback("◀️ Back", "payment_menu")]);
      await ctx.editMessageText("📦 اختر مجموعة:", { reply_markup: { inline_keyboard: keyboard } });
      await ctx.answerCbQuery();
      return;
    }

    if (action.startsWith("payment_group_")) {
      const groupId = action.replace("payment_group_", "");
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(groupId)) { await ctx.answerCbQuery("❌ Invalid group ID"); return; }
      const g = await q(`SELECT payment_day, payment_mode_active FROM groups WHERE id=$1`, [groupId]);
      if (g.rowCount > 0) {
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback("📢 Send Payment Reminder", `payment_remind_group_${groupId}`)],
          [Markup.button.callback(`▶️ Resume Distribution`, `payment_resume_group_${groupId}`)],
          [Markup.button.callback(`📅 Set Payment Day (${g.rows[0].payment_day})`, `payment_setday_${groupId}`)],
          [Markup.button.callback("◀️ Back", "payment_groups")],
        ]);
        await ctx.editMessageText(
          `💰 Payment Settings\nGroup ${groupId.slice(0, 8)}\n\nPayment Day: ${g.rows[0].payment_day}\nStatus: ${g.rows[0].payment_mode_active ? "⏸️ Paused" : "▶️ Active"}`,
          { reply_markup: keyboard.reply_markup }
        );
        await ctx.answerCbQuery();
      }
      return;
    }

    if (action.startsWith("payment_resume_group_")) {
      const groupId = action.replace("payment_resume_group_", "");
      await q(`UPDATE groups SET payment_mode_active=false, payment_mode_day=0, is_scheduler_active=true WHERE id=$1`, [groupId]);
      await safeReply(ctx, `✅ تم استئناف التوزيع للمجموعة ${groupId.slice(0, 8)}`);
      await ctx.answerCbQuery();
      return;
    }

    if (action.startsWith("payment_remind_group_")) {
      const groupId = action.replace("payment_remind_group_", "");
      const currentMonth = new Date().toISOString().slice(0, 7);
      const users = await q(`SELECT telegram_id, auto_name FROM users WHERE group_id=$1`, [groupId]);
      await q(`UPDATE groups SET payment_mode_active=true, payment_mode_started=NOW(), payment_mode_day=1, is_scheduler_active=false WHERE id=$1`, [groupId]);
      let success = 0;
      for (const user of users.rows) {
        try {
          const userKeyboard2 = await getDynamicKeyboard(user.telegram_id);
          await bot.telegram.sendMessage(user.telegram_id,
            `💰 تذكير دفع الاشتراك الشهري\n\n` +
            `📅 الشهر: ${currentMonth}\n` +
            `👤 ${user.auto_name}\n\n` +
            `⏸️ تم إيقاف توزيع الأكواد مؤقتاً\n\n` +
            `📸 يرجى إرسال إثبات الدفع`,
            userKeyboard2
          );
          success++;
          await new Promise(r => setTimeout(r, 100));
        } catch (e) {}
      }
      await q(`UPDATE groups SET last_payment_reminder=NOW() WHERE id=$1`, [groupId]);
      await safeReply(ctx, `✅ تم إرسال التذكير لـ ${success} مستخدم في Group ${groupId.slice(0, 8)}`);
      await ctx.answerCbQuery();
      return;
    }

    if (action.startsWith("payment_setday_")) {
      const groupId = action.replace("payment_setday_", "");
      await safeReply(ctx, `📅 لتعيين يوم الدفع، أرسل:\n\n/set_payment_day ${groupId.slice(0, 8)} 15`);
      await ctx.answerCbQuery();
      return;
    }

    if (action === "blacklist_menu") {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("➕ Add to Blacklist", "blacklist_add")],
        [Markup.button.callback("📋 View Blacklist", "blacklist_view")],
        [Markup.button.callback("🗑️ Remove from Blacklist", "blacklist_remove")],
        [Markup.button.callback("👤 Ban User Completely", "blacklist_ban_user")],
        [Markup.button.callback("◀️ Back", "back_to_main")],
      ]);
      await ctx.editMessageText("🚫 Blacklist Management:", { reply_markup: keyboard.reply_markup });
      await ctx.answerCbQuery();
      return;
    }

    if (action === "blacklist_add") {
      await safeReply(ctx, "➕ لإضافة للقائمة السوداء:\n\n/ban +201234567890 سبب الحظر");
      await ctx.answerCbQuery();
      return;
    }

    if (action === "blacklist_remove") {
      await safeReply(ctx, "🗑️ لإزالة من القائمة السوداء:\n\n/unban +201234567890");
      await ctx.answerCbQuery();
      return;
    }

    if (action === "blacklist_ban_user") {
      await safeReply(ctx, "👤 لحظر مستخدم مسجل:\n\n/banuser User5 سبب الحظر");
      await ctx.answerCbQuery();
      return;
    }

    if (action === "blacklist_view") {
      const blacklist = await q(`SELECT * FROM blacklist ORDER BY banned_at DESC LIMIT 20`);
      if (blacklist.rowCount === 0) {
        await ctx.answerCbQuery("القائمة السوداء فارغة");
        return;
      }
      let message = "🚫 القائمة السوداء:\n\n";
      blacklist.rows.forEach((item, i) => {
        message += `${i + 1}. 📱 ${item.phone || 'N/A'}\n   🆔 ${item.telegram_id || 'N/A'}\n   📋 ${item.reason || 'غير محدد'}\n\n`;
      });
      await safeReply(ctx, message);
      await ctx.answerCbQuery();
      return;
    }

    if (action === "toggle_penalties") {
      const s = await getAdminSettings();
      const newVal = !s.penalties_active;
      await updateAdminSettings("penalties_active", newVal);
      await ctx.answerCbQuery(`✅ Penalties ${newVal ? 'Enabled' : 'Disabled'}`);
      const updated = await getAdminSettings();
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("📴 Toggle All Schedulers", "toggle_all_schedulers")],
        [Markup.button.callback(`${updated.penalties_active ? '🔴 Disable' : '🟢 Enable'} Penalties`, "toggle_penalties")],
        [Markup.button.callback("🔄 Distribute Now (All)", "distribute_now")],
        [Markup.button.callback("⏰ Set Send Time", "set_time")],
        [Markup.button.callback("👁️ Set Daily Limit", "set_limit")],
        [Markup.button.callback("📅 Set Days", "set_days")],
        [Markup.button.callback("👥 Set Group Size", "set_group")],
        [Markup.button.callback("🔢 Set Max Groups", "set_max_groups")],
        [Markup.button.callback("📢 Broadcast to All", "broadcast")],
        [Markup.button.callback("◀️ Back", "back_to_main")],
      ]);
      await ctx.editMessageText(
        `🌐 Global Settings\n\nPenalties System: ${updated.penalties_active ? '✅ Active' : '❌ Inactive'}`,
        { reply_markup: keyboard.reply_markup }
      );
      return;
    }

    if (action === "toggle_all_schedulers") {
      const s = await getAdminSettings();
      const newVal = !s.is_scheduler_active;
      await updateAdminSettings("is_scheduler_active", newVal);
      await q("UPDATE groups SET is_scheduler_active = $1", [newVal]);
      await safeReply(ctx, `✅ All Schedulers: ${newVal ? "✅ Enabled" : "❌ Disabled"}`);
      await ctx.answerCbQuery(`✅ ${newVal ? 'Enabled' : 'Disabled'}`);
      return;
    }

    if (action === "distribute_now") {
      await runDailyDistribution();
      await safeReply(ctx, "✅ تم توزيع الأكواد يدوياً!");
      await ctx.answerCbQuery("✅ Done");
      return;
    }

    if (action === "set_time") { await safeReply(ctx, "⏰ لتغيير وقت الإرسال:\n\n/set_time 09:00"); await ctx.answerCbQuery(); return; }
    if (action === "set_limit") { await safeReply(ctx, "👁️ لتغيير الحد اليومي:\n\n/set_limit 50"); await ctx.answerCbQuery(); return; }
    if (action === "set_days") { await safeReply(ctx, "📅 لتغيير عدد الأيام:\n\n/set_days 20"); await ctx.answerCbQuery(); return; }
    if (action === "set_group") { await safeReply(ctx, "👥 لتغيير حجم المجموعة:\n\n/set_group 1000"); await ctx.answerCbQuery(); return; }
    if (action === "set_max_groups") { await safeReply(ctx, "🔢 لتحديد الحد الأقصى للمجموعات:\n\n/set_max_groups 10\n\nأو لعدم تحديد حد:\n/set_max_groups NULL"); await ctx.answerCbQuery(); return; }

    if (action === "broadcast") {
      adminBroadcastMode = true;
      await safeReply(ctx, "📢 أرسل الرسالة الآن لإرسالها لجميع المستخدمين:");
      await ctx.answerCbQuery();
      return;
    }

    if (action === "stats") {
      const totalUsers = await q(`SELECT COUNT(*) FROM users`);
      const activeCodes = await q(`SELECT COUNT(*) FROM codes WHERE status='active'`);
      const totalGroups = await q(`SELECT COUNT(*) FROM groups`);
      const blacklisted = await q(`SELECT COUNT(*) FROM blacklist`);
      const s = await getAdminSettings();
      const today = new Date().toISOString().slice(0, 10);
      const completedToday = await q(`SELECT COUNT(DISTINCT assigned_to_user_id) FROM code_view_assignments WHERE assigned_date=$1 AND used=true`, [today]);
      const totalToday = await q(`SELECT COUNT(DISTINCT assigned_to_user_id) FROM code_view_assignments WHERE assigned_date=$1`, [today]);
      
      const statsMessage = `📊 إحصائيات البوت:\n\n` +
        `👥 المستخدمون: ${totalUsers.rows[0].count}\n` +
        `📦 الأكواد النشطة: ${activeCodes.rows[0].count}\n` +
        `🏢 المجموعات: ${totalGroups.rows[0].count}\n` +
        `🚫 المحظورون: ${blacklisted.rows[0].count}\n` +
        `🔢 الحد الأقصى للمجموعات: ${s.max_groups || 'غير محدد'}\n\n` +
        `📅 اليوم:\n` +
        `✅ أكملوا: ${completedToday.rows[0].count}/${totalToday.rows[0].count}\n\n` +
        `⚙️ الإعدادات:\n` +
        `🔄 الجدول: ${s.is_scheduler_active ? '✅ نشط' : '❌ متوقف'}\n` +
        `⚖️ العقوبات: ${s.penalties_active ? '✅ نشطة' : '❌ متوقفة'}`;
      
      await safeReply(ctx, statsMessage);
      await ctx.answerCbQuery();
      return;
    }

    if (action === "back_to_main") {
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🌐 Global Settings", "global_settings")],
        [Markup.button.callback("📦 Manage Groups", "manage_groups")],
        [Markup.button.callback("💰 Payment Management", "payment_menu")],
        [Markup.button.callback("🚫 Blacklist", "blacklist_menu")],
        [Markup.button.callback("🗑️ Delete Cycle Now", "delete_cycle")],
        [Markup.button.callback("📊 Stats", "stats")],
      ]);
      await ctx.editMessageText("🔐 Admin Panel:", { reply_markup: keyboard.reply_markup });
      await ctx.answerCbQuery();
      return;
    }

    await ctx.answerCbQuery();
  } catch (err) {
    console.error("❌ Admin callback error:", err.message);
    try { await ctx.answerCbQuery("❌ حدث خطأ"); } catch (e) {}
  }
});

// ==================== CRON JOBS & DISTRIBUTION ====================

async function runDailyDistribution() {
  console.log("📦 بدء توزيع الأكواد...");
  try {
    const groups = await q(`SELECT id, payment_mode_active FROM groups WHERE is_scheduler_active=true AND payment_mode_active=false`);
    
    console.log(`✅ Found ${groups.rowCount} active groups (not in payment mode)`);
    
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

// 🆕 دالة التأكيد التلقائي عند بداية التوزيع
async function autoConfirmPendingVerifications() {
  console.log("🔄 Auto-confirming pending verifications...");
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);
    
    // الحصول على جميع الأكواد التي لم يتم التأكيد عليها من الأمس
    const unverifiedAssignments = await q(
      `SELECT DISTINCT c.owner_id, u.telegram_id
       FROM code_view_assignments a
       JOIN codes c ON a.code_id = c.id
       JOIN users u ON c.owner_id = u.id
       WHERE a.assigned_date = $1 AND a.used = true AND a.verified = false`,
      [yesterdayStr]
    );
    
    // تأكيد جميع الأكواد تلقائياً
    await q(
      `UPDATE code_view_assignments 
       SET verified = true 
       WHERE assigned_date = $1 AND used = true AND verified = false`,
      [yesterdayStr]
    );
    
    console.log(`✅ Auto-confirmed ${unverifiedAssignments.rowCount} pending verifications`);
    
    // تطبيق عقوبات على من لم يؤكد
    for (const row of unverifiedAssignments.rows) {
      const ownerId = row.owner_id;
      const ownerTelegramId = row.telegram_id;
      
      // التحقق من عقوبات التأكيد السابقة
      const existingPenalty = await q(
        `SELECT no_confirmation_count FROM confirmation_penalties WHERE user_id=$1`,
        [ownerId]
      );
      
      let noConfirmCount = 1;
      if (existingPenalty.rowCount > 0) {
        noConfirmCount = existingPenalty.rows[0].no_confirmation_count + 1;
        await q(
          `UPDATE confirmation_penalties SET no_confirmation_count=$1, last_missed=NOW() WHERE user_id=$2`,
          [noConfirmCount, ownerId]
        );
      } else {
        await q(
          `INSERT INTO confirmation_penalties (user_id, no_confirmation_count, last_missed) VALUES ($1, 1, NOW())`,
          [ownerId]
        );
      }
      
      // تطبيق العقوبة
      let penaltyMessage = "";
      if (noConfirmCount === 1) {
        // حجب الأكواد ليوم واحد
        await q(
          `UPDATE codes SET status='suspended', suspension_until=(NOW() + INTERVAL '1 day')
           WHERE owner_id=$1 AND status='active'`,
          [ownerId]
        );
        penaltyMessage = `⚠️ لم تقم بتأكيد من استخدم أكوادك أمس!\n\n` +
          `🚫 العقوبة: حجب أكوادك لمدة يوم واحد\n\n` +
          `⚠️ هذه المرة الأولى - كن حذراً!\n` +
          `💡 يجب تأكيد الأكواد يومياً عبر زر "✅ تأكيد الاستخدام"`;
      } else if (noConfirmCount === 2) {
        // حجب الأكواد ليومين
        await q(
          `UPDATE codes SET status='suspended', suspension_until=(NOW() + INTERVAL '2 days')
           WHERE owner_id=$1 AND status='active'`,
          [ownerId]
        );
        penaltyMessage = `⚠️ لم تقم بتأكيد من استخدم أكوادك مرة ثانية!\n\n` +
          `🚫 العقوبة: حجب أكوادك لمدة يومين\n\n` +
          `⚠️ هذا تحذير نهائي!\n` +
          `💡 المرة القادمة = حذف الحساب نهائياً`;
      } else if (noConfirmCount >= 3) {
        // حذف المستخدم نهائياً
        await q(`DELETE FROM codes WHERE owner_id=$1`, [ownerId]);
        await q(`DELETE FROM code_view_assignments WHERE assigned_to_user_id=$1`, [ownerId]);
        await q(`DELETE FROM confirmation_penalties WHERE user_id=$1`, [ownerId]);
        await q(`DELETE FROM verification_penalties WHERE user_id=$1`, [ownerId]);
        await q(`DELETE FROM user_penalties WHERE user_id=$1`, [ownerId]);
        await q(`DELETE FROM users WHERE id=$1`, [ownerId]);
        
        penaltyMessage = `🚫 تم حذف حسابك نهائياً من البوت!\n\n` +
          `❌ السبب: عدم تأكيد الأكواد 3 مرات\n\n` +
          `⚠️ تم حذف جميع أكوادك وحسابك\n` +
          `💡 لا يمكنك التسجيل مرة أخرى`;
      }
      
      // إرسال رسالة للمستخدم
      try {
        await bot.telegram.sendMessage(ownerTelegramId, penaltyMessage);
      } catch (e) {
        console.log(`Could not send no-confirmation penalty to ${ownerTelegramId}`);
      }
    }
  } catch (err) {
    console.error("❌ autoConfirmPendingVerifications:", err.message);
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
    await q(
      `UPDATE codes SET status='active', suspension_until=NULL 
       WHERE status='suspended' AND suspension_until IS NOT NULL AND suspension_until <= NOW()`
    );
    console.log(`✅ Reactivated codes after suspension period`);
  } catch (err) {
    console.error("❌ reactivateSuspendedCodes:", err.message);
  }
}

// ==================== CRON JOBS ====================

// 1️⃣ رسالة صباحية (9 صباحاً)
cron.schedule("0 9 * * *", async () => {
  try {
    console.log("📢 Sending morning reminders...");
    const users = await q(`SELECT telegram_id FROM users WHERE verified=true`);
    const message = `🌅 صباح الخير!\n\n📦 كود اليوم جاهز\n\nاكتب /اكواد_اليوم للحصول عليه`;
    
    for (const row of users.rows) {
      try {
        await bot.telegram.sendMessage(row.telegram_id, message);
        await new Promise(r => setTimeout(r, 100));
      } catch (err) {
        console.error(`❌ Failed to send morning reminder to ${row.telegram_id}`);
      }
    }
    console.log(`✅ Sent ${users.rowCount} morning reminders`);
  } catch (err) {
    console.error("❌ Morning reminder error:", err);
  }
});

// 2️⃣ رسالة مسائية (8 مساءً)
cron.schedule("0 20 * * *", async () => {
  try {
    console.log("📢 Sending evening reminders...");
    const today = new Date().toISOString().slice(0, 10);
    
    const incompleteUsers = await q(
      `SELECT DISTINCT u.telegram_id 
       FROM code_view_assignments a 
       JOIN users u ON a.assigned_to_user_id = u.id 
       WHERE a.assigned_date=$1 AND a.used=false`,
      [today]
    );
    
    const message = `⏰ تذكير: هل استخدمت الكود؟\n\n` +
                   `✅ إذا استخدمته: اضغط "تم الاستخدام"\n\n` +
                   `⚠️ المهلة: حتى منتصف الليل`;
    
    for (const row of incompleteUsers.rows) {
      try {
        await bot.telegram.sendMessage(row.telegram_id, message);
        await new Promise(r => setTimeout(r, 100));
      } catch (err) {
        console.error(`❌ Failed to send evening reminder to ${row.telegram_id}`);
      }
    }
    console.log(`✅ Sent ${incompleteUsers.rowCount} evening reminders`);
  } catch (err) {
    console.error("❌ Evening reminder error:", err);
  }
});

// 3️⃣ رسالة منتصف الليل (12 ص) + معالجة الأكواد غير المستخدمة
cron.schedule("0 0 * * *", async () => {
  try {
    console.log("📢 Sending midnight warnings...");
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);
    
    const missedUsers = await q(
      `SELECT DISTINCT u.telegram_id, u.id as user_id, up.missed_days
       FROM code_view_assignments a 
       JOIN users u ON a.assigned_to_user_id = u.id
       LEFT JOIN user_penalties up ON up.user_id = u.id
       WHERE a.assigned_date=$1 AND a.used=false`,
      [yesterdayStr]
    );
    
    for (const row of missedUsers.rows) {
      try {
        const missedDays = (row.missed_days || 0) + 1;
        let message = `❌ فاتك كود اليوم!\n\n`;
        
        if (missedDays === 1) {
          message += `⚠️ هذا اليوم الأول\nيومين آخرين = إيقاف\n\n💡 ضبّط منبه يومياً!`;
        } else if (missedDays === 2) {
          message += `⚠️ هذا اليوم الثاني!\n\n🚨 تحذير نهائي\nيوم واحد آخر = حذف الحساب نهائياً`;
        } else if (missedDays >= 3) {
          message += `❌ 3 أيام متتالية بدون استخدام\n\n🚫 تم حذف حسابك نهائياً من البوت\n📋 تم حذف جميع أكوادك\n\n⚠️ لإعادة التسجيل: استخدم /تسجيل`;
          
          // حذف كامل للمستخدم
          console.log(`🗑️ Deleting user ${row.user_id} after 3 days penalty`);
          
          await q(`DELETE FROM codes WHERE owner_id=$1`, [row.user_id]);
          await q(`DELETE FROM code_view_assignments WHERE assigned_to_user_id=$1`, [row.user_id]);
          await q(`DELETE FROM user_penalties WHERE user_id=$1`, [row.user_id]);
          await q(`DELETE FROM confirmation_penalties WHERE user_id=$1`, [row.user_id]);
          await q(`DELETE FROM verification_penalties WHERE user_id=$1`, [row.user_id]);
          await q(`DELETE FROM users WHERE id=$1`, [row.user_id]);
          
          console.log(`✅ User ${row.user_id} deleted completely from database`);
        }
        
        await bot.telegram.sendMessage(row.telegram_id, message);
        await new Promise(r => setTimeout(r, 100));
      } catch (err) {
        console.error(`❌ Failed to send midnight warning to ${row.telegram_id}`);
      }
    }
    console.log(`✅ Sent ${missedUsers.rowCount} midnight warnings`);
    
    await handleUnusedCodes();
    await reactivateSuspendedCodes();
  } catch (err) {
    console.error("❌ Midnight warning error:", err);
  }
});

// 4️⃣ التوزيع اليومي (يعمل كل دقيقة ويتحقق من وقت كل مجموعة) + التأكيد التلقائي
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
        
        // 🆕 التأكيد التلقائي أولاً
        await autoConfirmPendingVerifications();
        
        // ثم التوزيع
        await runDailyDistribution();
        break;
      }
    }
  } catch (err) {
    console.error("❌ Scheduler error:", err);
  }
});

// 5️⃣ رسائل تحفيزية (6 مساءً)
cron.schedule("0 18 * * *", async () => {
  try {
    await sendMotivationalReminders();
  } catch (err) {
    console.error("❌ Motivational reminder error:", err);
  }
});

// 6️⃣ بدء دورة جديدة (أول كل شهر - 1 صباحاً)
cron.schedule("0 1 1 * *", async () => {
  try {
    console.log("🔄 بدء دورة جديدة...");
    await q("DELETE FROM code_view_assignments");
    await q("DELETE FROM codes");
    await q("DELETE FROM user_penalties");
    await q("DELETE FROM confirmation_penalties");
    await q("DELETE FROM verification_penalties");
    console.log("✅ تم مسح البيانات وبدء دورة جديدة");
  } catch (err) {
    console.error("❌ خطأ دورة جديدة:", err);
  }
});

// 7️⃣ رسائل يومية للجروب (9 مساءً) - تقرير يومي
cron.schedule("0 21 * * *", async () => {
  try {
    console.log("📢 Sending daily group reports...");
    const today = new Date().toISOString().slice(0, 10);
    
    const groups = await q(`SELECT id, telegram_group_chat_id, name FROM groups WHERE telegram_group_chat_id IS NOT NULL`);
    
    for (const group of groups.rows) {
      if (!group.telegram_group_chat_id) continue;
      
      try {
        const totalUsers = await q(`SELECT COUNT(*) FROM users WHERE group_id=$1`, [group.id]);
        const completedToday = await q(
          `SELECT COUNT(DISTINCT a.assigned_to_user_id) 
           FROM code_view_assignments a 
           JOIN users u ON a.assigned_to_user_id = u.id 
           WHERE u.group_id=$1 AND a.assigned_date=$2 AND a.used=true`,
          [group.id, today]
        );
        const incompleteToday = await q(
          `SELECT u.auto_name
           FROM code_view_assignments a 
           JOIN users u ON a.assigned_to_user_id = u.id 
           WHERE u.group_id=$1 AND a.assigned_date=$2 AND a.used=false
           GROUP BY u.id, u.auto_name
           ORDER BY u.auto_name
           LIMIT 10`,
          [group.id, today]
        );
        
        const totalCount = parseInt(totalUsers.rows[0].count);
        const completedCount = parseInt(completedToday.rows[0].count);
        const incompleteCount = totalCount - completedCount;
        const completionRate = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
        
        let message = `📊 تقرير اليوم - Group ${group.id.toString().slice(0, 8)}\n\n`;
        message += `👥 إجمالي المستخدمين: ${totalCount}\n`;
        message += `✅ أكملوا الأكواد: ${completedCount} (${completionRate}%)\n`;
        message += `⚠️ لم يكملوا بعد: ${incompleteCount}\n\n`;
        
        if (incompleteCount > 0 && incompleteToday.rows.length > 0) {
          message += `⏰ المتبقي عليهم:\n`;
          incompleteToday.rows.forEach(u => {
            message += `• ${u.auto_name}\n`;
          });
          
          if (incompleteCount > 10) {
            message += `... وآخرون (${incompleteCount - 10})\n`;
          }
          
          message += `\n⏳ المهلة: حتى منتصف الليل\n`;
          message += `💡 شجّع زملاءك على الالتزام!`;
        } else {
          message += `🎉 ممتاز! الجميع أكمل أكواده اليوم! 🔥`;
        }
        
        await bot.telegram.sendMessage(group.telegram_group_chat_id, message);
        console.log(`✅ Sent daily report to group ${group.id}`);
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.error(`❌ Failed to send to group ${group.id}:`, err.message);
      }
    }
    console.log(`✅ Sent daily reports to ${groups.rowCount} groups`);
  } catch (err) {
    console.error("❌ Daily group report error:", err);
  }
});

// 8️⃣ تحقق تلقائي من الدفعات (كل يوم الساعة 10 صباحاً)
cron.schedule("0 10 * * *", async () => {
  try {
    console.log("💰 Checking payment reminders...");
    const groups = await q(`SELECT id, payment_day, last_payment_reminder FROM groups`);
    const now = new Date();
    const currentDay = now.getDate();
    const currentMonth = now.toISOString().slice(0, 7);
    
    for (const group of groups.rows) {
      const paymentDay = group.payment_day || 1;
      
      // إرسال التذكير في يوم الدفع
      if (currentDay === paymentDay) {
        const lastReminder = group.last_payment_reminder ? new Date(group.last_payment_reminder) : null;
        const sameMonth = lastReminder && lastReminder.toISOString().slice(0, 7) === currentMonth;
        
        if (!sameMonth) {
          console.log(`📢 Sending payment reminder for group ${group.id}`);
          const users = await q(`SELECT telegram_id, auto_name FROM users WHERE group_id=$1`, [group.id]);
          
          let success = 0;
          for (const user of users.rows) {
            try {
              const cronKeyboard = await getDynamicKeyboard(user.telegram_id);
              await bot.telegram.sendMessage(user.telegram_id, 
                `💰 تذكير دفع الاشتراك الشهري\n\n` +
                `📅 الشهر: ${currentMonth}\n` +
                `👤 ${user.auto_name}\n\n` +
                `📸 يرجى إرسال إثبات الدفع عبر زر "📸 إرسال إثبات الدفع"\n\n` +
                `⚠️ عدم الدفع خلال يومين سيؤدي لتحذير نهائي`,
                cronKeyboard
              );
              success++;
              await new Promise(r => setTimeout(r, 100));
            } catch (e) {
              console.error(`Failed to send payment reminder to ${user.telegram_id}`);
            }
          }
          
          await q(`UPDATE groups SET last_payment_reminder=NOW() WHERE id=$1`, [group.id]);
          console.log(`✅ Sent payment reminder to ${success} users in group ${group.id}`);
        }
      }
      
      // تحذير بعد يومين
      const twoDaysAfter = (paymentDay + 2) > 28 ? (paymentDay + 2 - 28) : (paymentDay + 2);
      if (currentDay === twoDaysAfter) {
        console.log(`⚠️ Checking non-payers for group ${group.id}`);
        const nonPayers = await q(`
          SELECT u.id, u.telegram_id, u.auto_name, u.phone
          FROM users u
          LEFT JOIN payments p ON p.user_id = u.id AND p.payment_month = $1
          WHERE u.group_id = $2 AND (p.id IS NULL OR p.proof_sent = false)
        `, [currentMonth, group.id]);
        
        if (nonPayers.rowCount > 0) {
          // إرسال تحذير للمستخدمين
          for (const user of nonPayers.rows) {
            try {
              await bot.telegram.sendMessage(user.telegram_id, 
                `⚠️ تحذير نهائي - عدم الدفع\n\n` +
                `👤 ${user.auto_name}\n` +
                `📅 الشهر: ${currentMonth}\n\n` +
                `🚨 لم نستلم إثبات الدفع منك حتى الآن\n\n` +
                `📸 يرجى إرسال إثبات الدفع فوراً عبر زر "📸 إرسال إثبات الدفع"\n\n` +
                `⛔ عدم الدفع قد يؤدي لحظر حسابك`
              );
              await new Promise(r => setTimeout(r, 100));
            } catch (e) {
              console.error(`Failed to warn ${user.telegram_id}`);
            }
          }
          
          // إرسال قائمة للأدمن
          let adminMsg = `⚠️ قائمة من لم يدفع - Group ${group.id.toString().slice(0, 8)}\n`;
          adminMsg += `📅 الشهر: ${currentMonth}\n`;
          adminMsg += `📊 العدد: ${nonPayers.rowCount}\n\n`;
          
          nonPayers.rows.forEach(u => {
            adminMsg += `• ${u.auto_name} (${u.phone || 'N/A'})\n`;
          });
          
          adminMsg += `\n━━━━━━━━━━━━━━\n\n`;
          adminMsg += `استخدم:\n`;
          adminMsg += `/banuser <name> عدم الدفع - لحظر مستخدم\n`;
          adminMsg += `/warn_nonpayers - لإرسال تحذير إضافي`;
          
          try {
            await bot.telegram.sendMessage(ADMIN_ID, adminMsg);
            console.log(`✅ Sent non-payers list to admin for group ${group.id}`);
          } catch (e) {
            console.error("Failed to send non-payers list to admin");
          }
        }
      }
    }
  } catch (err) {
    console.error("❌ Payment reminder error:", err);
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