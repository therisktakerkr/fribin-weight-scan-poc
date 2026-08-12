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

// 2.5초 시점 스냅샷 — 위쪽 바코드만 보이는 구간 한가운데. 여기서 얼어붙지 않고
// "인식 중" 상태를 유지하며, 참고 로그만 쌓이고 있어야 한다(요청사항 1, 3번 핵심 검증).
await page.waitForTimeout(2500);
const midSnap = await page.evaluate(() => ({
  status: document.getElementById("status").textContent,
  failCount: document.getElementById("failCount").textContent,
  successCount: document.getElementById("successCount").textContent,
  refLogCount: document.querySelectorAll("#logList li.log-ref").length,
  rawText: document.getElementById("rawText").textContent,
}));
console.log("=== 2.5초 시점(위쪽 바코드만 보이는 중) ===", JSON.stringify(midSnap, null, 2));

// 이후 전체 라벨이 노출되는 구간까지 대기 → 성공해야 함
await page.waitForFunction(
  () => document.getElementById("status").textContent.startsWith("성공"),
  { timeout: 15000 }
).catch(() => console.log("TIMEOUT: 성공 상태에 도달하지 못함"));

const finalSnap = await page.evaluate(() => ({
  status: document.getElementById("status").textContent,
  weightBig: document.getElementById("weightBig").textContent,
  failCount: document.getElementById("failCount").textContent,
  successCount: document.getElementById("successCount").textContent,
  refLogCount: document.querySelectorAll("#logList li.log-ref").length,
}));
console.log("=== 최종 상태(전체 라벨 노출 이후) ===", JSON.stringify(finalSnap, null, 2));

await browser.close();
