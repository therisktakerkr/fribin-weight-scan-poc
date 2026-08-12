import { chromium } from "playwright";

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--use-file-for-fake-video-capture=/tmp/fake_camera_sequence.y4m",
  ],
});
const page = await browser.newPage();
await page.goto("http://localhost:8788/index.html", { waitUntil: "load" });
await page.click("#startBtn");

await page.waitForTimeout(2500);
const mid = await page.evaluate(() => ({
  status: document.getElementById("status").textContent,
  failCount: document.getElementById("failCount").textContent,
  successCount: document.getElementById("successCount").textContent,
  refLogCount: document.querySelectorAll("#logList li.log-ref").length,
}));
console.log("=== 2.5초(위쪽만 보이는 중) ===", JSON.stringify(mid));

await page.waitForFunction(
  () => document.getElementById("status").textContent === "확인 필요",
  { timeout: 15000 }
).catch(() => console.log("TIMEOUT"));
await page.click("#confirmBtn");
await page.waitForTimeout(300);

const final = await page.evaluate(() => ({
  status: document.getElementById("status").textContent,
  successCount: document.getElementById("successCount").textContent,
  failCount: document.getElementById("failCount").textContent,
}));
console.log("=== 확정 후 ===", JSON.stringify(final));
await browser.close();
