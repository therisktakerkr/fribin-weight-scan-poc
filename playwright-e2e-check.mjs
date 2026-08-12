// 실제 물리 휴대폰이 아니라, Chromium의 "가짜 카메라" 기능(--use-fake-device-for-media-stream +
// --use-file-for-fake-video-capture)으로 합성 바코드 영상을 카메라 입력인 것처럼 흘려보내
// index.html + app.js + gs1-parser.js 전체 파이프라인이 실제로 동작하는지 확인하는 사전 점검 스크립트다.
// 이것은 "휴대폰 실기 테스트"를 대체하지 않는다 — FRIBIN 실물 라벨 인식은 이 스크립트로 증명되지 않으며,
// 오직 "카메라 프레임 → zxing-wasm 디코딩 → GS1 파서 → 화면 표시"라는 코드 경로 자체가
// 하드코딩 없이 실제로 작동하는지만 증명한다.
import { chromium } from "playwright";

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--use-file-for-fake-video-capture=/tmp/fake_camera.y4m",
    "--auto-select-desktop-capture-source=Entire screen",
  ],
});
const page = await browser.newPage();
page.on("console", (msg) => console.log("[page console]", msg.type(), msg.text()));
page.on("pageerror", (err) => console.log("[page error]", err.message));

await page.goto("http://localhost:8788/index.html", { waitUntil: "load" });
await page.click("#startBtn");

// 성공 또는 실패 상태로 바뀔 때까지 최대 15초 대기
await page.waitForFunction(
  () => {
    const s = document.getElementById("status").textContent;
    return s.startsWith("성공") || s.startsWith("실패");
  },
  { timeout: 15000 }
).catch(() => console.log("TIMEOUT: 15초 내에 성공/실패 상태로 전환되지 않음"));

const snapshot = await page.evaluate(() => ({
  status: document.getElementById("status").textContent,
  weightBig: document.getElementById("weightBig").textContent,
  rawText: document.getElementById("rawText").textContent,
  elapsed: document.getElementById("elapsed").textContent,
  successCount: document.getElementById("successCount").textContent,
  failCount: document.getElementById("failCount").textContent,
  devFormat: document.getElementById("devFormat").textContent,
  devSymbologyId: document.getElementById("devSymbologyId").textContent,
  devGsFlag: document.getElementById("devGsFlag").textContent,
  devAi: document.getElementById("devAi").textContent,
  devRawDigits: document.getElementById("devRawDigits").textContent,
  devFinalKg: document.getElementById("devFinalKg").textContent,
  devContentType: document.getElementById("devContentType").textContent,
  cameraError: document.getElementById("cameraError").textContent,
}));

console.log("=== PAGE STATE SNAPSHOT (가짜 카메라 입력 기준) ===");
console.log(JSON.stringify(snapshot, null, 2));

await page.screenshot({ path: "./playwright-e2e-screenshot.png" });
await browser.close();
