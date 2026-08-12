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

const t0 = Date.now();
// 5.5초 시점 스냅샷 — 타임아웃이 막 발동했어야 함
await page.waitForTimeout(5500);
const snap1 = await page.evaluate(() => ({
  status: document.getElementById("status").textContent,
  weightBig: document.getElementById("weightBig").textContent,
  failCount: document.getElementById("failCount").textContent,
  successCount: document.getElementById("successCount").textContent,
  elapsed: document.getElementById("elapsed").textContent,
  devError: document.getElementById("devError").textContent,
  rescanHidden: document.getElementById("rescanBtn").hidden,
}));
console.log("=== SNAPSHOT @5.5s ===", JSON.stringify(snap1, null, 2));

// 추가로 6초 더 대기(총 11.5초) — "다시 스캔"을 누르지 않았으므로 실패가 더 늘면 안 됨 (1회만 기록 검증)
await page.waitForTimeout(6000);
const snap2 = await page.evaluate(() => ({
  status: document.getElementById("status").textContent,
  failCount: document.getElementById("failCount").textContent,
}));
console.log("=== SNAPSHOT @11.5s (다시 스캔 안 누름, 그대로 유지되어야 함) ===", JSON.stringify(snap2, null, 2));

// 세션 로그에 TIMEOUT_NO_BARCODE 가 정확히 1건 기록됐는지 확인
const logCheck = await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll("#logList li")).map((li) => li.textContent);
  return items;
});
console.log("=== 세션 로그 목록 ===", JSON.stringify(logCheck, null, 2));

await browser.close();
