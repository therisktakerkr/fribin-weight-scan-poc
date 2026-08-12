import { chromium } from "playwright";

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--use-file-for-fake-video-capture=/tmp/fake_camera_blank17.y4m",
  ],
});
const page = await browser.newPage();
await page.goto("http://localhost:8788/index.html", { waitUntil: "load" });
await page.click("#startBtn");
await page.waitForTimeout(14000);
const before = await page.evaluate(() => ({ status: document.getElementById("status").textContent, failCount: document.getElementById("failCount").textContent }));
console.log("=== 14초 ===", JSON.stringify(before));
await page.waitForTimeout(2000);
const after = await page.evaluate(() => ({ status: document.getElementById("status").textContent, failCount: document.getElementById("failCount").textContent, weightIdle: document.getElementById("weightIdle").textContent }));
console.log("=== 16초(15초 타임아웃) ===", JSON.stringify(after));
await browser.close();
