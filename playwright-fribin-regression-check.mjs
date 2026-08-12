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
  () => document.getElementById("status").textContent === "확인 필요",
  { timeout: 20000 }
).catch(() => console.log("TIMEOUT: 후보 확인 상태에 도달하지 못함"));

const candidateSnap = await page.evaluate(() => ({
  status: document.getElementById("status").textContent,
  candidates: Array.from(document.querySelectorAll(".candidate-row")).map((r) => r.querySelector(".val")?.textContent),
  rawText: document.getElementById("rawText").textContent,
  devResultCount: document.getElementById("devResultCount").textContent,
  confirmDisabled: document.getElementById("confirmBtn").disabled,
}));
console.log("=== 후보 확인 단계 (실제 라벨 합성 이미지 기준) ===", JSON.stringify(candidateSnap, null, 2));

await page.click("#confirmBtn");
await page.waitForTimeout(300);

const finalSnap = await page.evaluate(() => ({
  status: document.getElementById("status").textContent,
  weightIdle: document.getElementById("weightIdle").textContent,
  successCount: document.getElementById("successCount").textContent,
  failCount: document.getElementById("failCount").textContent,
}));
console.log("=== 확정 후 ===", JSON.stringify(finalSnap, null, 2));

await browser.close();
