import { chromium } from "playwright";

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--use-file-for-fake-video-capture=/tmp/fake_camera_multi.y4m",
  ],
});
const page = await browser.newPage();
await page.goto("http://localhost:8788/index.html", { waitUntil: "load" });
await page.click("#startBtn");
await page.waitForTimeout(1000);
await page.click("#ocrBtn");
await page.waitForFunction(
  () => document.getElementById("status").textContent === "확인 필요" || document.getElementById("status").textContent.startsWith("실패"),
  { timeout: 90000 }
).catch((e) => console.log("TIMEOUT:", e.message));

const candidates = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".candidate-row")).map((r, i) => ({
    idx: i, val: r.querySelector(".val")?.textContent, reason: r.querySelector(".reason")?.textContent,
    selected: r.classList.contains("selected"), excluded: r.classList.contains("excluded"),
  }))
);
console.log("=== 후보 목록(자동 선택 상태 포함) ===", JSON.stringify(candidates, null, 2));

// 일부러 권장(Net)이 아닌 다른 후보(Gross)를 사람이 직접 선택해본다 — 선택권이 실제로 동작하는지 확인
const grossIdx = candidates.findIndex((c) => c.val === "14.70kg");
if (grossIdx >= 0) {
  await page.click(`.candidate-row:nth-child(${grossIdx + 1})`);
  await page.click("#confirmBtn");
  await page.waitForTimeout(300);
  const final = await page.evaluate(() => document.getElementById("weightIdle").textContent);
  console.log("=== 일부러 총중량(Gross)을 선택해 확정한 결과(선택권이 실제로 동작하는지 확인) ===", final);
}

await browser.close();
