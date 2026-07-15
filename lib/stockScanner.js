// lib/stockScanner.js
// ดึงข้อมูลหุ้นล่าสุดจากเว็บ "Thai Stock Uptrend Scanner" (deploy อยู่บน Netlify)
// หน้าเว็บฝังข้อมูลดิบไว้เป็น JSON สะอาดใน <script type="application/json" id="stock-data"> อยู่แล้ว
// เพื่อให้ฝั่ง server (ที่นี่) อ่านได้ตรงๆ โดยไม่ต้อง eval JS ของหน้าเว็บ

const SCANNER_URL = "https://rococo-sorbet-32afdf.netlify.app/";

// ดึงและ parse ข้อมูลหุ้นทั้งหมดจากหน้าเว็บ คืนค่า { stocks, asOf }
// asOf คือวันที่ข้อมูลบนหน้าเว็บระบุไว้ (เช่น "15 ก.ค. 2569") ใช้เตือนผู้ใช้ว่าข้อมูลอาจไม่ใช่วันปัจจุบันถ้ายังไม่ได้รีเฟรช
async function fetchAllStocks() {
  const res = await fetch(SCANNER_URL);
  if (!res.ok) {
    throw new Error(`ดึงข้อมูลจากเว็บสแกนหุ้นไม่สำเร็จ (HTTP ${res.status})`);
  }
  const html = await res.text();

  const dataMatch = html.match(/<script type="application\/json" id="stock-data">([\s\S]*?)<\/script>/);
  if (!dataMatch) {
    throw new Error("ไม่พบข้อมูลหุ้นฝังอยู่ในหน้าเว็บ (โครงสร้างหน้าเว็บอาจเปลี่ยนไป)");
  }
  const stocks = JSON.parse(dataMatch[1]);

  const dateMatch = html.match(/ข้อมูล ณ\s*([^(<]*)\(/);
  const asOf = dateMatch ? dateMatch[1].trim() : null;

  return { stocks, asOf };
}

// ดึงเฉพาะ Top N ตัวแรก (เรียงตามคะแนน/อันดับที่หน้าเว็บจัดไว้แล้ว)
async function fetchTopPicks(limit = 5) {
  const { stocks, asOf } = await fetchAllStocks();
  return { stocks: stocks.slice(0, limit), asOf, total: stocks.length };
}

// จัดรูปแบบข้อความสรุปสำหรับส่งเข้า LINE (ทั้งแบบ push อัตโนมัติ และแบบตอบคำถามในแชท)
function formatSummary(stocks, asOf, total) {
  const lines = [`📊 หุ้นขาขึ้นเด่น SET100${asOf ? ` (ข้อมูล ณ ${asOf})` : ""}`, ""];

  stocks.forEach((s) => {
    const wSign = s.w >= 0 ? "+" : "";
    const mSign = s.m >= 0 ? "+" : "";
    lines.push(`${s.rank}. ${s.t} — ${s.name}`);
    lines.push(`   ราคา ${s.price} ${s.cur}  |  1สัปดาห์ ${wSign}${s.w.toFixed(2)}%  |  1เดือน ${mSign}${s.m.toFixed(2)}%`);
  });

  lines.push("");
  if (total) lines.push(`(แสดง ${stocks.length} จากทั้งหมด ${total} ตัวที่ผ่านเกณฑ์ขาขึ้น)`);
  lines.push(`ดูรายละเอียด + ลิงก์กราฟ TradingView รายตัว: ${SCANNER_URL}`);
  lines.push("⚠️ ข้อมูลเพื่อการศึกษาเท่านั้น ไม่ใช่คำแนะนำการลงทุน โปรดวิเคราะห์เพิ่มเติมก่อนตัดสินใจ");

  return lines.join("\n");
}

module.exports = { fetchAllStocks, fetchTopPicks, formatSummary, SCANNER_URL };
