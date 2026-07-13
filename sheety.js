// lib/sheety.js
// Wrapper บางๆ สำหรับอ่าน/เขียนแถวใน Google Sheet ผ่าน Sheety API (sheety.co)
// วิธีทำงานของ Sheety: แต่ละแท็บในชีต (เช่น "Leads") จะกลายเป็น endpoint {SHEETY_API_URL}/leads
// เวลาอ่านจะได้ key พหูพจน์ (leads), เวลาโพสต์แถวใหม่ Sheety จะรอ key เอกพจน์ (lead)
// เราจึงตั้งชื่อแท็บทั้งหมดเป็นพหูพจน์ธรรมดา (Leads, Reminders, Financelogs, Notes)
// เพื่อให้เดา key เอกพจน์ได้ตรงเป๊ะด้วยการตัด s ท้ายคำ

const SHEETY_API_URL = process.env.SHEETY_API_URL; // เช่น https://api.sheety.co/xxxxxxxx/kriangsakBusinessTracker

function assertConfigured() {
  if (!SHEETY_API_URL) {
    throw new Error("ยังไม่ได้ตั้งค่า SHEETY_API_URL ใน .env — ดูวิธีตั้งค่าในคู่มือเฟส 2");
  }
}

function singularize(sheetName) {
  const lower = sheetName.toLowerCase();
  return lower.endsWith("s") ? lower.slice(0, -1) : lower;
}

async function getRows(sheetName) {
  assertConfigured();
  const res = await fetch(`${SHEETY_API_URL}/${sheetName.toLowerCase()}`);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sheety GET ${sheetName} ล้มเหลว: ${res.status} ${errText}`);
  }
  const data = await res.json();
  return data[sheetName.toLowerCase()] || [];
}

async function addRow(sheetName, rowObj) {
  assertConfigured();
  const key = singularize(sheetName);
  const res = await fetch(`${SHEETY_API_URL}/${sheetName.toLowerCase()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [key]: rowObj }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sheety POST ${sheetName} ล้มเหลว: ${res.status} ${errText}`);
  }
  const data = await res.json();
  return data[key];
}

async function updateRow(sheetName, rowId, patchObj) {
  assertConfigured();
  const key = singularize(sheetName);
  const res = await fetch(`${SHEETY_API_URL}/${sheetName.toLowerCase()}/${rowId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [key]: patchObj }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sheety PUT ${sheetName} ล้มเหลว: ${res.status} ${errText}`);
  }
  const data = await res.json();
  return data[key];
}

module.exports = { getRows, addRow, updateRow };
