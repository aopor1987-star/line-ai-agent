// commands.js
// ตัวจับ "คำสั่งพิเศษ" จากข้อความ: จดโน้ต / ตั้งเตือน / บันทึกรายรับ-รายจ่าย / สรุปรายเดือน
// ถ้าข้อความไม่ตรงคำสั่งไหนเลย จะคืนค่า { handled:false } เพื่อให้ index.js ส่งข้อความนั้นไปคุยกับ Groq ตามปกติ
// (ทำแบบ prefix-matching ล้วนๆ ไม่พึ่ง AI ตรงนี้ เพื่อความแน่นอนและประหยัด token)

const sheety = require("./lib/sheety");

const OWNER_LINE_USER_ID = process.env.OWNER_LINE_USER_ID;

// รายการลิงก์ที่ใช้งานอยู่ทั้งหมด — แก้ตรงนี้ที่เดียวเวลามีเว็บ/ระบบใหม่เพิ่มเข้ามา
function buildLinksReply() {
  return [
    "📎 ลิงก์ที่ใช้งานอยู่ทั้งหมด",
    "",
    "🌐 เว็บสาธารณะ (แชร์ได้)",
    "• พอร์ตโฟลิโอช่างภาพ ISAD Studio",
    "  https://isad-studio-photography.netlify.app",
    "• เว็บ Story ส่วนตัว Mr. Kriangsak",
    "  https://mr-kriangsak-story.netlify.app",
    "• พอร์ตผลงาน Solar PPA (ไม่มีชื่อลูกค้า)",
    "  https://kriangsak-solar-portfolio.netlify.app",
    "",
    "🔒 เว็บภายใน (ข้อมูลลับ มีรหัสผ่าน)",
    "• Solar PPA Control Dashboard",
    "  https://kriangsak-solar-ppa-dashboard.netlify.app",
    "  รหัส: GYSolar2026!",
    "• Project Control Dashboard (Construction)",
    "  https://kriangsak-pm-control.netlify.app",
    "  รหัส: KriangsakPM2026!",
    "",
    "⚙️ ระบบเบื้องหลัง",
    "• Google Sheet ฐานข้อมูล",
    "  https://docs.google.com/spreadsheets/d/1A-PjngM58U8i-qd5fWaYTGvsOvYwDj0MrdK7I7ngh8M",
    "• Bot backend (Render)",
    "  https://line-ai-agent-9m4s.onrender.com",
    "",
    "พิมพ์ 'ลิงก์' เมื่อไหร่ก็ได้เพื่อดูรายการนี้อีกครั้งค่ะ",
  ].join("\n");
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtDateTime(d) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${fmtDate(d)} ${hh}:${mm}`;
}

// แปลงข้อความวันที่แบบง่ายๆ ที่คนไทยพิมพ์บ่อย ให้เป็น YYYY-MM-DD
// รองรับ: "วันนี้" "พรุ่งนี้" "มะรืนนี้" "20/7" "20/7/2569" (พ.ศ.) และ "20 นี้" (วันที่ 20 ของเดือนถัดไปที่ใกล้ที่สุด)
// ถ้าตีความไม่ได้ คืนค่า null (ให้ถามผู้ใช้กลับ แทนที่จะเดามั่ว)
function parseThaiDate(text) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (/วันนี้/.test(text)) return fmtDate(today);
  if (/พรุ่งนี้/.test(text)) return fmtDate(new Date(today.getTime() + 86400000));
  if (/มะรืนนี้/.test(text)) return fmtDate(new Date(today.getTime() + 2 * 86400000));

  const dmy = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (dmy) {
    const day = parseInt(dmy[1], 10);
    const month = parseInt(dmy[2], 10) - 1;
    let year = dmy[3] ? parseInt(dmy[3], 10) : today.getFullYear();
    if (year > 2400) year -= 543; // พ.ศ. -> ค.ศ.
    if (year < 100) year += 2000;
    const d = new Date(year, month, day);
    if (!isNaN(d.getTime())) return fmtDate(d);
  }

  const dayOnly = text.match(/(?:วันที่\s*)?(\d{1,2})\s*นี้/);
  if (dayOnly) {
    const day = parseInt(dayOnly[1], 10);
    if (day >= 1 && day <= 31) {
      let candidate = new Date(today.getFullYear(), today.getMonth(), day);
      if (candidate < today) candidate = new Date(today.getFullYear(), today.getMonth() + 1, day);
      return fmtDate(candidate);
    }
  }

  return null;
}

// ดึงจำนวนเงิน + คำอธิบาย จากข้อความ เช่น "จ่าย 1,250.50 ค่าอุปกรณ์" -> {amount:1250.5, note:"ค่าอุปกรณ์"}
// ตัด comma (ตัวคั่นหลักพัน) ออกก่อนเสมอ แล้วค่อยจับตัวเลข (จุดทศนิยม) เพื่อไม่ให้ตัดขาดกลางจำนวนเงิน
function parseAmount(text) {
  const noCommas = text.replace(/,/g, "");
  const match = noCommas.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const amount = parseFloat(match[1]);
  const note = noCommas.replace(match[0], "").replace(/^(จ่าย|รับ)/, "").trim();
  return { amount, note: note || "-" };
}

async function handleCommand(userId, text) {
  const trimmed = (text || "").trim();

  // ---------- ลิงก์ / dashboard (เฉพาะเจ้าของบอทเท่านั้น กันคนอื่นที่ทักเข้ามาเห็นรหัสผ่านเว็บลับ) ----------
  if (/^(ลิงก์|ลิ้งค์|ลิ้ง|link|dashboard)/i.test(trimmed)) {
    if (!OWNER_LINE_USER_ID || userId !== OWNER_LINE_USER_ID) {
      return { handled: false }; // ไม่ใช่เจ้าของ -> ปล่อยให้ไปคุยกับ Groq ตามปกติ ไม่บอกใบ้ว่ามีคำสั่งนี้อยู่
    }
    return { handled: true, reply: buildLinksReply() };
  }

  // ---------- จดโน้ต ----------
  if (/^(จด|โน้ต|บันทึกโน้ต)/.test(trimmed)) {
    const content = trimmed.replace(/^(บันทึกโน้ต|จด|โน้ต)/, "").trim();
    if (!content) {
      return {
        handled: true,
        reply: "พิมพ์ต่อท้ายคำว่า 'จด' ได้เลยค่ะ เช่น 'จด ซื้อฟิลเตอร์ ND ให้ลูกค้า A'",
      };
    }
    await sheety.addRow("notes", {
      content,
      createdat: fmtDateTime(new Date()),
      sent: false,
    });
    return {
      handled: true,
      reply: `จดไว้ให้แล้วค่ะ: "${content}" (จะไปโผล่ใน Apple Notes ตามรอบซิงก์ Shortcuts ของคุณ)`,
    };
  }

  // ---------- ตั้งเตือน ----------
  if (/^เตือน/.test(trimmed)) {
    const rest = trimmed.replace(/^เตือน/, "").trim();
    const date = parseThaiDate(rest);
    if (!date) {
      return {
        handled: true,
        reply:
          "ระบุวันที่ไม่ชัดเจนค่ะ ลองพิมพ์แบบ 'เตือน 20/7 ส่งงานลูกค้า A' หรือ 'เตือนพรุ่งนี้ จ่ายค่าเช่า' ดูนะคะ",
      };
    }
    const task =
      rest
        .replace(/(\d{1,2}\/\d{1,2}(\/\d{2,4})?)/, "")
        .replace(/^(วันนี้|พรุ่งนี้|มะรืนนี้)/, "")
        .replace(/(?:วันที่\s*)?\d{1,2}\s*นี้/, "")
        .trim() || rest;
    await sheety.addRow("reminders", {
      task,
      duedate: date,
      notified: false,
      createdat: fmtDateTime(new Date()),
    });
    return { handled: true, reply: `ตั้งเตือนแล้วค่ะ: "${task}" วันที่ ${date}` };
  }

  // ---------- บันทึกรายจ่าย/รายรับ ----------
  if (/^(จ่าย|รับ)/.test(trimmed)) {
    const type = trimmed.startsWith("จ่าย") ? "expense" : "income";
    const parsed = parseAmount(trimmed);
    if (!parsed || !parsed.amount) {
      return {
        handled: true,
        reply: "พิมพ์รูปแบบ 'จ่าย 500 ค่าน้ำมัน' หรือ 'รับ 3000 ค่าแต่งภาพลูกค้า A' นะคะ",
      };
    }
    await sheety.addRow("financelogs", {
      type,
      amount: parsed.amount,
      note: parsed.note,
      date: fmtDate(new Date()),
    });
    return {
      handled: true,
      reply: `บันทึก${type === "expense" ? "รายจ่าย" : "รายรับ"} ${parsed.amount.toLocaleString()} บาท (${parsed.note}) แล้วค่ะ`,
    };
  }

  // ---------- สรุปรายเดือน ----------
  if (/สรุปเดือนนี้|สรุปการเงิน/.test(trimmed)) {
    const rows = await sheety.getRows("financelogs");
    const thisMonth = fmtDate(new Date()).slice(0, 7);
    const monthRows = rows.filter((r) => (r.date || "").startsWith(thisMonth));
    const income = monthRows
      .filter((r) => r.type === "income")
      .reduce((s, r) => s + Number(r.amount || 0), 0);
    const expense = monthRows
      .filter((r) => r.type === "expense")
      .reduce((s, r) => s + Number(r.amount || 0), 0);
    return {
      handled: true,
      reply: `สรุปเดือนนี้ (${thisMonth})\nรายรับ: ${income.toLocaleString()} บาท\nรายจ่าย: ${expense.toLocaleString()} บาท\nคงเหลือ: ${(income - expense).toLocaleString()} บาท`,
    };
  }

  return { handled: false };
}

module.exports = { handleCommand, parseThaiDate, parseAmount, fmtDate, fmtDateTime };
