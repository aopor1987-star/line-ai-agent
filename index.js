// index.js
// LINE OA AI Agent - ผู้เชี่ยวชาญถ่ายภาพ/ตัดต่อ พร้อมเก็บ Lead ลูกค้า
// ดูคู่มือติดตั้งแบบละเอียดในไฟล์ "คู่มือติดตั้ง.docx" ที่มาพร้อมโปรเจกต์นี้

require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const { buildSystemPrompt } = require("./systemPrompt");
const { handleCommand, fmtDate } = require("./commands");
const sheety = require("./lib/sheety");

const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  GROQ_API_KEY,
  OWNER_LINE_USER_ID,
  BUSINESS_NAME,
  WEBSITE_URL,
  PORT,
  SHEETY_API_URL,
  CRON_SECRET,
} = process.env;

// ตรวจสอบว่ากรอก .env ครบหรือยัง (เตือนตั้งแต่ตอน start ไม่ใช่ตอนมีคนทักมา)
const required = {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  GROQ_API_KEY,
};
for (const [key, value] of Object.entries(required)) {
  if (!value) {
    console.warn(`[คำเตือน] ยังไม่ได้กรอกค่า ${key} ใน .env — บอทจะทำงานไม่ได้จนกว่าจะกรอกค่านี้`);
  }
}

const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};
const client = new line.Client(lineConfig);
const app = express();

// เก็บประวัติคุยล่าสุดของแต่ละคนไว้ในหน่วยความจำ (ง่ายสุดสำหรับเริ่มต้น ไม่ต้องมีฐานข้อมูล)
// หมายเหตุ: ถ้า server รีสตาร์ท (เช่น Render free tier sleep แล้วตื่น) ประวัติจะรีเซ็ต ซึ่งรับได้สำหรับบอทให้คำแนะนำทั่วไป
const conversationHistory = new Map(); // userId -> [{role, content}]  (รูปแบบ OpenAI-compatible ของ Groq)
const MAX_TURNS = 8; // เก็บย้อนหลังกี่รอบสนทนา กันไม่ให้ prompt ยาวเกิน (ประหยัด token)

const SYSTEM_PROMPT = buildSystemPrompt({
  businessName: BUSINESS_NAME || "สตูดิโอของเรา",
  websiteUrl: WEBSITE_URL || "",
});

// โมเดลของ Groq (ฟรี ไม่ต้องผูกบัตร) — ตัวข้อความล้วนใช้ตัวเร็ว/ฉลาด ตัวรูปภาพต้องใช้รุ่นที่รองรับ vision โดยเฉพาะ
// หมายเหตุ (15 ก.ค. 69): เดิมตัว vision ใช้ meta-llama/llama-4-scout-17b-16e-instruct แต่ Groq ประกาศ
// เลิกใช้รุ่นนี้ตั้งแต่ 17 ก.ค. 69 (ดู https://console.groq.com/docs/deprecations) จึงเปลี่ยนมาใช้
// qwen/qwen3.6-27b ซึ่งเป็นรุ่น vision ที่ Groq รองรับอย่างเป็นทางการอยู่ในปัจจุบัน
const GROQ_TEXT_MODEL = "openai/gpt-oss-120b";
const GROQ_VISION_MODEL = "qwen/qwen3.6-27b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// ดาวน์โหลดไฟล์ภาพที่ลูกค้าส่งเข้ามาทาง LINE แล้วแปลงเป็น base64 เพื่อส่งให้โมเดล vision วิเคราะห์
// (ใช้แค่ชั่วคราวสำหรับวิเคราะห์ภาพ 1 ครั้ง ไม่ได้เก็บไฟล์ไว้ในเซิร์ฟเวอร์ — ภาพต้นฉบับจริงๆ
// เจ้าของร้านดูและดาวน์โหลดได้เองจากแอป LINE Official Account Manager)
async function downloadLineImageAsBase64(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`ดาวน์โหลดภาพจาก LINE ไม่สำเร็จ: ${res.status}`);
  }
  const mimeType = res.headers.get("content-type") || "image/jpeg";
  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  return { base64, mimeType };
}

// เรียก Groq (รูปแบบเดียวกับ OpenAI Chat Completions API) — currentContent เป็นได้ทั้ง string ล้วน
// หรือ array แบบ [{type:"text",...},{type:"image_url",...}] สำหรับข้อความที่แนบรูป
// historyLabel คือข้อความสั้นๆ ที่จะถูกบันทึกแทนของจริงในประวัติแชท (กันไม่ให้ส่งรูป base64 ซ้ำทุกรอบถัดไป ประหยัด token)
async function callGroq(userId, currentContent, { historyLabel, model = GROQ_TEXT_MODEL } = {}) {
  const history = conversationHistory.get(userId) || [];
  history.push({ role: "user", content: currentContent });

  const body = {
    model,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
    temperature: 0.6,
    max_tokens: 600,
  };

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Groq API error:", res.status, errText);
    // ถ้าพลาด ให้เอาข้อความที่เพิ่ง push ออกจาก history เพื่อไม่ให้ค้าง
    history.pop();
    conversationHistory.set(userId, history);
    return "ขออภัยค่ะ ตอนนี้ระบบขัดข้องชั่วคราว รบกวนลองใหม่อีกครั้ง หรือทักตรงมาที่เจ้าของเพจได้เลยค่ะ";
  }

  const data = await res.json();
  const reply =
    data?.choices?.[0]?.message?.content?.trim() ||
    "ขออภัยค่ะ ยังไม่เข้าใจคำถาม รบกวนลองพิมพ์อีกครั้งได้ไหมคะ";

  // แทนที่ content จริงในประวัติด้วยข้อความสั้นๆ (historyLabel) เพื่อไม่ให้ base64 รูปภาพค้างอยู่ใน context ทุกรอบ
  if (historyLabel) {
    history[history.length - 1] = { role: "user", content: historyLabel };
  }
  history.push({ role: "assistant", content: reply });

  // ตัดประวัติให้ไม่เกิน MAX_TURNS รอบ (1 รอบ = user+assistant = 2 ข้อความ)
  const trimmed = history.slice(-MAX_TURNS * 2);
  conversationHistory.set(userId, trimmed);

  return reply;
}

// แยกบรรทัด LEAD_DATA ออกจากคำตอบก่อนส่งให้ลูกค้า และแจ้งเตือนเจ้าของถ้ามี lead
function extractLeadAndClean(replyText, userId) {
  const leadMatch = replyText.match(/LEAD_DATA:\s*(\{.*\})/s);
  let cleanText = replyText;
  let lead = null;

  if (leadMatch) {
    cleanText = replyText.replace(leadMatch[0], "").trim();
    try {
      lead = JSON.parse(leadMatch[1]);
    } catch (e) {
      console.error("แปลง LEAD_DATA ไม่สำเร็จ:", e);
    }
  }

  if (lead && OWNER_LINE_USER_ID) {
    const isPhotoOrder = /แต่งภาพ|preset/i.test(lead.jobType || "");
    const extraLines = isPhotoOrder
      ? `จำนวนภาพ: ${lead.photoCount || "-"}\nสไตล์ที่เลือก: ${lead.style || "-"}\n📷 ภาพต้นฉบับดูได้ในแอป LINE Official Account Manager (แชทกับลูกค้าคนนี้)\n`
      : "";

    const notifyText =
      `🔔 มีลูกค้าสนใจ${isPhotoOrder ? "สั่งแต่งภาพ" : "จ้างงาน"}ใหม่!\n` +
      `ชื่อ: ${lead.name || "-"}\n` +
      `ติดต่อ: ${lead.contact || "-"}\n` +
      `ประเภทงาน: ${lead.jobType || "-"}\n` +
      extraLines +
      `วันที่ต้องการ: ${lead.date || "-"}\n` +
      `งบประมาณ: ${lead.budget || "-"}\n` +
      `(LINE userId ของลูกค้า: ${userId})`;

    client
      .pushMessage(OWNER_LINE_USER_ID, { type: "text", text: notifyText })
      .catch((e) => console.error("แจ้งเตือนเจ้าของไม่สำเร็จ:", e));

    // บันทึกลงชีต Leads ด้วย (ถ้าตั้งค่า Sheety ไว้แล้ว) กันข้อมูลหายตอน server รีสตาร์ท
    if (SHEETY_API_URL) {
      sheety
        .addRow("leads", {
          name: lead.name || "-",
          contact: lead.contact || "-",
          jobtype: lead.jobType || "-",
          date: lead.date || "-",
          budget: lead.budget || "-",
          photocount: lead.photoCount || "-",
          style: lead.style || "-",
          status: "new",
          lineuserid: userId,
        })
        .catch((e) => console.error("บันทึก Lead ลงชีตไม่สำเร็จ:", e));
    }
  }

  return cleanText;
}

async function handleEvent(event) {
  if (event.type !== "message") return null;

  const userId = event.source.userId;

  if (event.message.type === "text") {
    // เช็คคำสั่งพิเศษก่อน (จด/เตือน/จ่าย/รับ/สรุปเดือนนี้) ถ้าตรง ให้ตอบทันทีโดยไม่ต้องเรียก Groq
    if (SHEETY_API_URL) {
      try {
        const commandResult = await handleCommand(userId, event.message.text);
        if (commandResult.handled) {
          return client.replyMessage(event.replyToken, { type: "text", text: commandResult.reply });
        }
      } catch (e) {
        console.error("ประมวลผลคำสั่งพิเศษไม่สำเร็จ (จะข้ามไปคุยแบบปกติแทน):", e);
      }
    }

    const rawReply = await callGroq(userId, event.message.text);
    const cleanReply = extractLeadAndClean(rawReply, userId);
    return client.replyMessage(event.replyToken, { type: "text", text: cleanReply });
  }

  if (event.message.type === "image") {
    let rawReply;
    try {
      const { base64, mimeType } = await downloadLineImageAsBase64(event.message.id);
      const content = [
        {
          type: "text",
          text:
            "ลูกค้าส่งรูปภาพนี้เข้ามาเพื่อขอใช้บริการแต่งภาพจาก Preset ของเรา " +
            "ช่วยชมภาพสั้นๆ แล้วแนะนำสไตล์ preset ที่เหมาะกับภาพนี้ตามหัวข้อ 'บริการแต่งภาพจาก Preset' ในคำสั่งระบบ",
        },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
      ];
      rawReply = await callGroq(userId, content, {
        historyLabel: "[ลูกค้าส่งรูปภาพเข้ามา 1 ภาพ เพื่อขอใช้บริการแต่งภาพ]",
        model: GROQ_VISION_MODEL,
      });
    } catch (e) {
      console.error("ประมวลผลรูปภาพไม่สำเร็จ:", e);
      rawReply =
        "ได้รับรูปภาพแล้วค่ะ แต่ระบบวิเคราะห์ภาพขัดข้องชั่วคราว รบกวนแจ้งสไตล์ที่ต้องการและช่องทางติดต่อกลับ ทีมงานจะดำเนินการให้นะคะ";
    }
    const cleanReply = extractLeadAndClean(rawReply, userId);
    return client.replyMessage(event.replyToken, { type: "text", text: cleanReply });
  }

  return null;
}

app.get("/", (req, res) => {
  res.send("LINE AI Agent กำลังทำงานอยู่ ✅");
});

app.post("/webhook", line.middleware(lineConfig), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// ป้องกัน endpoint ที่ให้บริการภายนอกเรียก (cron-job.org / Shortcuts) ด้วยรหัสลับ
// ใส่ ?key=xxxx ต่อท้าย URL ให้ตรงกับค่า CRON_SECRET ใน .env ไม่งั้นจะถูกปฏิเสธ
function checkSecret(req, res) {
  if (!CRON_SECRET) {
    res.status(500).send("ยังไม่ได้ตั้งค่า CRON_SECRET ใน .env");
    return false;
  }
  if (req.query.key !== CRON_SECRET) {
    res.status(403).send("รหัสไม่ถูกต้อง");
    return false;
  }
  return true;
}

// เรียกวันละครั้งโดย cron-job.org (ฟรี) เช่น ทุกเช้า 7 โมง
// ทำ 2 อย่าง: 1) เช็คเตือนความจำที่ครบกำหนดวันนี้ แล้วส่งแจ้งเตือนเข้า LINE เจ้าของร้าน
//            2) ถ้าเป็นวันที่ 1 ของเดือน สรุปการเงินเดือนก่อนหน้าส่งให้ด้วย
app.get("/cron/daily", async (req, res) => {
  if (!checkSecret(req, res)) return;
  if (!SHEETY_API_URL || !OWNER_LINE_USER_ID) {
    return res.status(200).send("ข้ามการทำงาน: ยังไม่ได้ตั้งค่า SHEETY_API_URL หรือ OWNER_LINE_USER_ID");
  }

  const messages = [];
  const today = fmtDate(new Date());

  try {
    const reminders = await sheety.getRows("reminders");
    const dueToday = reminders.filter((r) => r.duedate === today && !r.notified);
    for (const r of dueToday) {
      messages.push(`⏰ เตือนความจำวันนี้: ${r.task}`);
      try {
        await sheety.updateRow("reminders", r.id, { notified: true });
      } catch (e) {
        console.error("อัปเดตสถานะเตือนความจำไม่สำเร็จ:", e);
      }
    }
  } catch (e) {
    console.error("ดึงเตือนความจำไม่สำเร็จ:", e);
  }

  // สรุปการเงินเดือนก่อนหน้า (ทำเฉพาะวันที่ 1 ของเดือน)
  const now = new Date();
  if (now.getDate() === 1) {
    try {
      const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const prevMonthKey = fmtDate(prevMonthDate).slice(0, 7);
      const rows = await sheety.getRows("financelogs");
      const monthRows = rows.filter((r) => (r.date || "").startsWith(prevMonthKey));
      const income = monthRows
        .filter((r) => r.type === "income")
        .reduce((s, r) => s + Number(r.amount || 0), 0);
      const expense = monthRows
        .filter((r) => r.type === "expense")
        .reduce((s, r) => s + Number(r.amount || 0), 0);
      messages.push(
        `📊 สรุปการเงินเดือน ${prevMonthKey}\nรายรับ: ${income.toLocaleString()} บาท\nรายจ่าย: ${expense.toLocaleString()} บาท\nคงเหลือ: ${(income - expense).toLocaleString()} บาท`
      );
    } catch (e) {
      console.error("สรุปการเงินรายเดือนไม่สำเร็จ:", e);
    }
  }

  if (messages.length > 0) {
    try {
      await client.pushMessage(OWNER_LINE_USER_ID, { type: "text", text: messages.join("\n\n") });
    } catch (e) {
      console.error("ส่งข้อความสรุปประจำวันไม่สำเร็จ:", e);
    }
  }

  res.json({ ok: true, sentCount: messages.length });
});

// Apple Shortcuts บนไอโฟนจะเรียก endpoint นี้เพื่อดึงโน้ตที่ยังไม่ถูกซิงก์เข้า Apple Notes
app.get("/notes/pending", async (req, res) => {
  if (!checkSecret(req, res)) return;
  if (!SHEETY_API_URL) return res.status(200).json({ notes: [] });
  try {
    const rows = await sheety.getRows("notes");
    const pending = rows.filter((r) => !r.sent).map((r) => ({ id: r.id, content: r.content, createdAt: r.createdat }));
    res.json({ notes: pending });
  } catch (e) {
    console.error("ดึงโน้ตค้างส่งไม่สำเร็จ:", e);
    res.status(500).json({ notes: [], error: String(e) });
  }
});

// Apple Shortcuts เรียก endpoint นี้หลัง Append to Note สำเร็จ เพื่อแจ้งว่าโน้ตไหนซิงก์แล้วบ้าง
// body: { "ids": [1,2,3] }
app.post("/notes/mark-sent", express.json(), async (req, res) => {
  if (!checkSecret(req, res)) return;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  try {
    for (const id of ids) {
      await sheety.updateRow("notes", id, { sent: true });
    }
    res.json({ ok: true, updated: ids.length });
  } catch (e) {
    console.error("อัปเดตสถานะโน้ตไม่สำเร็จ:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

const port = PORT || 3000;
app.listen(port, () => {
  console.log(`Server พร้อมทำงานที่พอร์ต ${port}`);
});
