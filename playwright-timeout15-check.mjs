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
const before = await page.evaluate(() => ({
  status: document.getElementById("status").textContent,
  failCount: document.getElementById("failCount").textContent,
}));
console.log("=== 14초 시점(15초 타임아웃 아직 안 됨, 실패 0이어야 함) ===", JSON.stringify(before));

await page.waitForTimeout(2000); // 총 16초
const after = await page.evaluate(() => ({
  status: document.getElementById("status").textContent,
  failCount: document.getElementById("failCount").textContent,
  elapsed: document.getElementById("elapsed").textContent,
  devError: document.getElementById("devError").textContent,
}));
console.log("=== 16초 시점(15초 타임아웃 발동했어야 함) ===", JSON.stringify(after, null, 2));

await browser.close();
