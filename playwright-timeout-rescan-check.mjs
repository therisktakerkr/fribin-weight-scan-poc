import { chromium } from "playwright";

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--use-file-for-fake-video-capture=/tmp/fake_camera_blank.y4m",
  ],
});
const page = await browser.newPage();
await page.goto("http://localhost:8788/index.html", { waitUntil: "load" });
await page.click("#startBtn");
await page.waitForTimeout(5500);
let s = await page.evaluate(() => document.getElementById("failCount").textContent);
console.log("1차 타임아웃 후 failCount:", s);

await page.click("#rescanBtn");
await page.waitForTimeout(5500);
s = await page.evaluate(() => document.getElementById("failCount").textContent);
console.log("다시 스캔 후 2차 타임아웃 failCount (2가 되어야 함):", s);

await browser.close();
