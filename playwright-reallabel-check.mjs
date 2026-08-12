import { chromium } from "playwright";

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--use-file-for-fake-video-capture=/tmp/fake_camera_reallabel.y4m",
  ],
});
const page = await browser.newPage();
page.on("pageerror", (err) => console.log("[page error]", err.message));
await page.goto("http://localhost:8788/index.html", { waitUntil: "load" });
await page.click("#startBtn");

await page.waitForFunction(
  () => {
    const s = document.getElementById("status").textContent;
    return s.startsWith("성공") || s.startsWith("실패");
  },
  { timeout: 20000 }
).catch(() => console.log("TIMEOUT: 20초 내에 성공/실패로 전환되지 않음"));

const snapshot = await page.evaluate(() => ({
  status: document.getElementById("status").textContent,
  weightBig: document.getElementById("weightBig").textContent,
  rawText: document.getElementById("rawText").textContent,
  elapsed: document.getElementById("elapsed").textContent,
  successCount: document.getElementById("successCount").textContent,
  failCount: document.getElementById("failCount").textContent,
  devSymbologyId: document.getElementById("devSymbologyId").textContent,
  devAi: document.getElementById("devAi").textContent,
  devRawDigits: document.getElementById("devRawDigits").textContent,
  devFinalKg: document.getElementById("devFinalKg").textContent,
  devResultCount: document.getElementById("devResultCount").textContent,
  devCameraCaps: document.getElementById("devCameraCaps").textContent,
}));
console.log("=== 최종 상태 (실제 라벨 합성 이미지 기준) ===");
console.log(JSON.stringify(snapshot, null, 2));

const logRows = await page.evaluate(() =>
  Array.from(document.querySelectorAll("#logList li")).map((li) => ({ text: li.textContent, cls: li.className }))
);
console.log("=== 세션 로그 (최근 -> 과거 순) ===");
logRows.forEach((r) => console.log(`[${r.cls}] ${r.text}`));

await page.screenshot({ path: "./playwright-reallabel-screenshot.png" });
await browser.close();
