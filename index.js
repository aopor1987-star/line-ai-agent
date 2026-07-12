// index.js
// LINE OA AI Agent - ผู้เชี่ยวชาญถ่ายภาพ/ตัดต่อ พร้อมเก็บ Lead ลูกค้า
// ดูคู่มือติดตั้งแบบละเอียดในไฟล์ "คู่มือติดตั้ง.docx" ที่มาพร้อมโปรเจกต์นี้

require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const { buildSystemPrompt } = require("./systemPrompt");

const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  GROQ_API_KEY,
  OWNER_LINE_USER_ID,
  BUSINESS_NAME,
  WEBSITE_URL,
  PORT,
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
const GROQ_TEXT_MODEL = "openai/gpt-oss-120b";
const GROQ_VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
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
  }

  return cleanText;
}

async function handleEvent(event) {
  if (event.type !== "message") return null;

  const userId = event.source.userId;

  if (event.message.type === "text") {
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

const port = PORT || 3000;
app.listen(port, () => {
  console.log(`Server พร้อมทำงานที่พอร์ต ${port}`);
});
