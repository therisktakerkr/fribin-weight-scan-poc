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
await page.goto("http://localhost:8788/index.html", { waitUntil: "load" });
await page.click("#startBtn");
await page.waitForTimeout(1000);

console.log("OCR button click (English label Net weight 14,20 Kg)...");
await page.click("#ocrBtn");

await page.waitForFunction(
  () => {
    const s = document.getElementById("status").textContent;
    return s === "확인 필요" || s.startsWith("실패");
  },
  { timeout: 90000 }
).catch((e) => console.log("TIMEOUT:", e.message));

const snap = await page.evaluate(() => ({
  status: document.getElementById("status").textContent,
  rawText: document.getElementById("rawText").textContent,
  ocrLoad: document.getElementById("ocrLoadTime").textContent,
  ocrRecognize: document.getElementById("ocrRecognizeTime").textContent,
  candidates: Array.from(document.querySelectorAll(".candidate-row")).map((r) => ({
    val: r.querySelector(".val")?.textContent,
    reason: r.querySelector(".reason")?.textContent,
  })),
}));
console.log("=== ENG OCR result ===", JSON.stringify(snap, null, 2));

if (snap.candidates.length > 0) {
  await page.click("#confirmBtn");
  await page.waitForTimeout(300);
  const final = await page.evaluate(() => ({
    status: document.getElementById("status").textContent,
    weightIdle: document.getElementById("weightIdle").textContent,
    successCount: document.getElementById("successCount").textContent,
  }));
  console.log("=== after confirm ===", JSON.stringify(final));
}

await browser.close();
