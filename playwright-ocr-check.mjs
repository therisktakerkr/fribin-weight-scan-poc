import { chromium } from "playwright";

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--use-file-for-fake-video-capture=/tmp/fake_camera_ocrtext.y4m",
  ],
});
const page = await browser.newPage();
page.on("pageerror", (err) => console.log("[page error]", err.message));
page.on("console", (msg) => { if (msg.type() === "error") console.log("[console error]", msg.text()); });

await page.goto("http://localhost:8788/index.html", { waitUntil: "load" });
await page.click("#startBtn");
await page.waitForTimeout(1000); // 카메라 안정화 대기

console.log("OCR 버튼 클릭...");
await page.click("#ocrBtn");

// tesseract 워커 최초 로딩 + 인식까지 넉넉하게 대기 (최대 60초)
await page.waitForFunction(
  () => {
    const t = document.getElementById("ocrCandidate").textContent;
    return t && !t.includes("불러오는 중") && !t.includes("인식 중");
  },
  { timeout: 60000 }
).catch((e) => console.log("TIMEOUT waiting for OCR result:", e.message));

const ocrSnap = await page.evaluate(() => ({
  candidate: document.getElementById("ocrCandidate").textContent,
  rawText: document.getElementById("ocrRawText").textContent,
  confirmDisabled: document.getElementById("ocrConfirmBtn").disabled,
}));
console.log("=== OCR 인식 결과 ===", JSON.stringify(ocrSnap, null, 2));

if (!ocrSnap.confirmDisabled) {
  await page.click("#ocrConfirmBtn");
  await page.waitForTimeout(300);
  const finalSnap = await page.evaluate(() => ({
    status: document.getElementById("status").textContent,
    weightBig: document.getElementById("weightBig").textContent,
    successCount: document.getElementById("successCount").textContent,
  }));
  console.log("=== 확정 후 상태 ===", JSON.stringify(finalSnap, null, 2));

  const logRows = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#logList li")).slice(0, 2).map((li) => li.textContent)
  );
  console.log("=== 최근 로그 ===", JSON.stringify(logRows, null, 2));
} else {
  console.log("확정 버튼이 비활성 상태 — OCR이 중량 문구를 찾지 못함");
}

await page.screenshot({ path: "./playwright-ocr-screenshot.png" });
await browser.close();
