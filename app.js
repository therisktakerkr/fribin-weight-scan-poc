/**
 * app.js — FRIBIN 중량 스캔 POC 메인 로직 (V3 — 실제 라벨 테스트 결과 반영)
 *
 * 사용 라이브러리: zxing-wasm 3.1.2 (바코드), tesseract.js 7.0.0 (OCR 보조) — 둘 다
 * vendor/ 폴더에 로컬로 복사해 CDN 없이 동작. 카메라 프레임/OCR 캡처 화면은 인식 처리에만
 * 일시적으로 쓰이고 저장·전송되지 않는다. 매 시도마다 같은 캔버스를 덮어쓴다.
 *
 * V3 수정사항(실제 FRIBIN 라벨 테스트 결과 반영, 이전 요청 12개 항목):
 *  1) 위쪽 일반 Code128("25789003")이 먼저 잡혀도 스캔을 멈추지 않고 계속 검색한다.
 *  2) 한 프레임에서 인식된 여러 바코드 결과 중, AI 3100~3109(순중량 kg)가 포함된 것만 "성공"으로 처리한다.
 *  3) NO_WEIGHT_AI(원하는 AI가 없는 바코드)는 실패로 멈추지 않고 "참고" 로그만 남긴다.
 *  4) 무인식 타임아웃을 5초 → 15초로 늘렸다(실물 라벨은 길고 촘촘해서 시간이 더 필요).
 *  5) 카메라 해상도를 1920x1080 이상으로 요청하고, 디코딩용 다운스케일 상한을 960px → 1600px로 올렸다.
 *  6) 긴 가로 바코드에 맞춘 중앙 스캔 가이드선을 추가했다(index.html의 .scan-guide).
 *  7) 지원되는 기기에 한해 연속 자동초점/줌/손전등을 추가했다(기능 미지원 기기에서는 조용히 숨김).
 *  8) 세로 화면에서도 원본 해상도를 그대로 쓰고 임의로 자르지 않아, 가로로 긴 바코드의 화소가 손실되지 않게 했다.
 *  9) GS1-128 인식이 어려운 경우를 위한 OCR 보조 버튼을 추가했다("Net weight: 14,20 Kg" 문구 인식).
 * 10) OCR 결과는 자동 저장하지 않고, 직원이 화면에서 확인 후 "이 값으로 확정"을 눌러야 반영된다.
 * 11) 이번에도 DB, 로그인, 거래처, 저장 기능은 추가하지 않았다.
 */

// ── 1. 라이브러리 로드 (정확한 버전 고정, 전부 로컬 vendor 사용) ───────────
const ZXING_WASM_VERSION = "3.1.2";
const TESSERACT_JS_VERSION = "7.0.0";
import { readBarcodes, prepareZXingModule } from "./vendor/zxing-wasm/reader/index.js";
import { parseNetWeightKg } from "./gs1-parser.js";
import { extractNetWeightFromOcrText } from "./ocr-weight-parser.js";

prepareZXingModule({
  overrides: {
    locateFile: (fileName) => `./vendor/zxing-wasm/reader/${fileName}`,
  },
});

// ── 2. DOM 참조 ──────────────────────────────────────────────────────────
const video = document.getElementById("video");
const canvas = document.getElementById("workCanvas"); // 화면에 보이지 않음, 저장/전송 없음
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const ocrCanvas = document.getElementById("ocrCanvas"); // OCR용 캡처, 마찬가지로 저장/전송 없음
const ocrCtx = ocrCanvas.getContext("2d", { willReadFrequently: true });

const statusEl = document.getElementById("status");
const weightBigEl = document.getElementById("weightBig");
const rawTextEl = document.getElementById("rawText");
const elapsedEl = document.getElementById("elapsed");
const successCountEl = document.getElementById("successCount");
const failCountEl = document.getElementById("failCount");
const rescanBtn = document.getElementById("rescanBtn");
const startBtn = document.getElementById("startBtn");
const logListEl = document.getElementById("logList");
const copyLogBtn = document.getElementById("copyLogBtn");
const cameraErrorEl = document.getElementById("cameraError");

const devFormat = document.getElementById("devFormat");
const devSymbology = document.getElementById("devSymbology");
const devSymbologyId = document.getElementById("devSymbologyId");
const devGsFlag = document.getElementById("devGsFlag");
const devAi = document.getElementById("devAi");
const devRawDigits = document.getElementById("devRawDigits");
const devFinalKg = document.getElementById("devFinalKg");
const devElapsed = document.getElementById("devElapsed");
const devContentType = document.getElementById("devContentType");
const devError = document.getElementById("devError");
const devResultCount = document.getElementById("devResultCount");
const devCameraCaps = document.getElementById("devCameraCaps");

const torchBtn = document.getElementById("torchBtn");
const zoomWrap = document.getElementById("zoomWrap");
const zoomRange = document.getElementById("zoomRange");

const ocrBtn = document.getElementById("ocrBtn");
const ocrPanel = document.getElementById("ocrPanel");
const ocrCandidateEl = document.getElementById("ocrCandidate");
const ocrRawTextEl = document.getElementById("ocrRawText");
const ocrConfirmBtn = document.getElementById("ocrConfirmBtn");
const ocrCancelBtn = document.getElementById("ocrCancelBtn");

// ── 3. 상태값 ────────────────────────────────────────────────────────────
let successCount = 0;
let failCount = 0;
let scanStartTs = 0;
let frozen = false; // 성공/타임아웃/OCR확정으로 멈춘 상태 — "다시 스캔"을 눌러야 재개
let decodeInFlight = false;
let intervalHandle = null;
let noBarcodeTimeoutHandle = null;
let audioCtx = null;
let videoTrack = null;
let streamStarted = false; // 카메라가 실제로 켜졌는지 — "대기" vs "인식 중" 상태 표시에 사용(V3 버그수정)
let torchOn = false;
let ocrWorkerPromise = null; // tesseract worker는 최초 OCR 버튼 클릭 시에만 생성(지연 로딩)
const sessionLog = []; // 세션 동안의 시도 기록 (메모리에만 존재, 새로고침하면 사라짐. 서버 전송/저장 없음)

const DECODE_INTERVAL_MS = 250; // 해상도가 올라간 만큼 살짝 여유를 둠(튜닝 가능)
const NO_BARCODE_TIMEOUT_MS = 15000; // V3: 5초 → 15초 (실물 라벨은 길고 촘촘해 시간이 더 필요)
const MAX_DECODE_SIDE_PX = 1600; // V3: 960 → 1600 (긴 가로 바코드가 뭉개지지 않도록)

// 최근 "참고"(성공은 아니지만 뭔가 읽힌) 로그의 중복 기록을 막기 위한 캐시
let lastRefKey = null;
let lastRefLoggedAt = 0;
const REF_LOG_DEDUP_MS = 1500;

// ── 4. 사운드/진동 피드백 ────────────────────────────────────────────────
function unlockAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
}
function beep(freq = 880, durationMs = 130) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.001, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.35, audioCtx.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + durationMs / 1000);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + durationMs / 1000 + 0.02);
}
function successFeedback() {
  beep(1046, 140);
  // 아이폰 Safari는 Vibration API(navigator.vibrate)를 지원하지 않는 것으로 알려져 있음 — 실기 확인 필요.
  if (navigator.vibrate) navigator.vibrate(200);
}
function failFeedback() {
  beep(220, 220);
  if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
}

// ── 5. 카메라 시작 (V3: 고해상도 + 연속 자동초점 + 줌/손전등 감지) ─────────
async function startCamera() {
  unlockAudio();
  cameraErrorEl.textContent = "";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920, min: 1280 },
        height: { ideal: 1080, min: 720 },
        // 연속 자동초점은 표준화가 덜 되어 있어 constraint로 넣어도 무시하는 브라우저가 많음 —
        // 지원 기기에서는 아래 applyCameraCapabilities()에서 한 번 더 시도한다.
        advanced: [{ focusMode: "continuous" }],
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    videoTrack = stream.getVideoTracks()[0];
    streamStarted = true;
    startBtn.hidden = true;
    ocrBtn.hidden = false; // V3 신규: 카메라가 켜진 뒤에만 OCR 보조 버튼을 노출
    await applyCameraCapabilities();
    resetForNextScan(true);
    startLoop();
  } catch (err) {
    cameraErrorEl.textContent =
      "카메라를 시작할 수 없습니다: " + (err && err.message ? err.message : String(err)) +
      " (브라우저의 카메라 권한 설정을 확인해 주세요. 반드시 HTTPS 주소로 접속해야 합니다.)";
    setStatus("실패");
  }
}
startBtn.addEventListener("click", startCamera);

// V3 신규: 연속 자동초점 재시도 + 줌/손전등 지원 여부 감지 후 UI 노출
async function applyCameraCapabilities() {
  if (!videoTrack || typeof videoTrack.getCapabilities !== "function") {
    devCameraCaps.textContent = "이 브라우저는 getCapabilities()를 지원하지 않음(아이폰 Safari에서 흔함) — 줌/손전등 UI 숨김";
    return;
  }
  let caps;
  try {
    caps = videoTrack.getCapabilities();
  } catch (e) {
    devCameraCaps.textContent = "getCapabilities() 호출 실패: " + e.message;
    return;
  }

  const settings = typeof videoTrack.getSettings === "function" ? videoTrack.getSettings() : {};
  const capsSummary = [];
  capsSummary.push(`해상도 ${settings.width || "?"}x${settings.height || "?"}`);

  // 연속 자동초점
  if (Array.isArray(caps.focusMode) && caps.focusMode.includes("continuous")) {
    try {
      await videoTrack.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
      capsSummary.push("연속AF:지원");
    } catch (e) {
      capsSummary.push("연속AF:적용실패");
    }
  } else {
    capsSummary.push("연속AF:미지원");
  }

  // 줌
  if (caps.zoom && typeof caps.zoom.min === "number" && typeof caps.zoom.max === "number" && caps.zoom.max > caps.zoom.min) {
    zoomRange.min = caps.zoom.min;
    zoomRange.max = caps.zoom.max;
    zoomRange.step = caps.zoom.step || 0.1;
    zoomRange.value = settings.zoom || caps.zoom.min;
    zoomWrap.style.display = "block";
    capsSummary.push(`줌:지원(${caps.zoom.min}~${caps.zoom.max})`);
  } else {
    zoomWrap.style.display = "none";
    capsSummary.push("줌:미지원");
  }

  // 손전등(torch)
  if (caps.torch === true) {
    torchBtn.hidden = false;
    capsSummary.push("손전등:지원");
  } else {
    torchBtn.hidden = true;
    capsSummary.push("손전등:미지원");
  }

  devCameraCaps.textContent = capsSummary.join(" · ");
}

zoomRange.addEventListener("input", async () => {
  if (!videoTrack) return;
  try {
    await videoTrack.applyConstraints({ advanced: [{ zoom: Number(zoomRange.value) }] });
  } catch (e) {
    console.error("zoom apply failed", e);
  }
});

torchBtn.addEventListener("click", async () => {
  if (!videoTrack) return;
  torchOn = !torchOn;
  try {
    await videoTrack.applyConstraints({ advanced: [{ torch: torchOn }] });
    torchBtn.textContent = torchOn ? "🔦 손전등 끄기" : "🔦 손전등";
  } catch (e) {
    console.error("torch apply failed", e);
    torchOn = !torchOn; // 실패 시 상태 원복
  }
});

// ── 6. 스캔 루프 ─────────────────────────────────────────────────────────
function startLoop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(tick, DECODE_INTERVAL_MS);
}

async function tick() {
  if (frozen || decodeInFlight) return;
  if (video.readyState < 2) return;
  decodeInFlight = true;
  try {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    // V3: 다운스케일 상한을 960 → 1600px로 상향. 긴 변 기준으로 스케일하므로
    // 세로로 들고 찍어도(화면 방향과 무관하게) 가로로 긴 바코드의 해상도가 보존된다.
    const scale = Math.min(1, MAX_DECODE_SIDE_PX / Math.max(vw, vh));
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // ↑ 이 imageData는 함수 안에서만 쓰이고 어디에도 저장/전송되지 않음. 다음 tick에서 canvas 내용은 덮어써짐.

    const results = await readBarcodes(imageData, {
      formats: ["Code128"], // GS1-128도 Code128 심볼로지에 포함됨
      tryHarder: true,
      textMode: "Escaped",
      returnErrors: false,
      maxNumberOfSymbols: 0, // V3: 한 프레임에서 여러 바코드를 전부 반환하도록(기본 제한 없음, 명시적으로 표기)
    });

    if (results && results.length > 0) {
      handleDecodeResults(results);
    }
  } catch (e) {
    console.error("decode tick error", e);
  } finally {
    decodeInFlight = false;
  }
}

// ── 7. 디코드 결과 처리 (V3: 여러 결과 중 AI 3100~3109만 성공, 나머지는 참고 로그) ──
function handleDecodeResults(results) {
  devResultCount.textContent = String(results.length);

  let successPick = null;
  const referencePicks = [];

  for (const r of results) {
    const parsed = parseNetWeightKg(r.text);
    if (parsed.ok) {
      successPick = { result: r, parsed };
      break; // 성공하는 바코드를 찾으면 그걸로 확정 (동일 프레임에 두 개 이상 성공 필드가 있을 일은 없다고 가정)
    }
    referencePicks.push({ result: r, parsed });
  }

  if (successPick) {
    commitSuccess(successPick.result, successPick.parsed, "BARCODE");
    return;
  }

  // 성공한 바코드가 없으면: 전부 "참고"로만 기록하고 스캔은 계속한다(요청사항 1, 3번).
  // 타임아웃(15초)은 취소하지 않는다 — "성공적인 중량 인식"만이 타이머를 멈춘다.
  for (const pick of referencePicks) {
    logReferenceOnly(pick.result, pick.parsed);
  }
  // 화면에는 가장 마지막으로 읽힌 것을 실시간으로 보여줘(성공 여부와 무관하게 "뭔가 읽히고 있다"는 확인용)
  if (referencePicks.length > 0) {
    const last = referencePicks[referencePicks.length - 1];
    updateDevPanelLive(last.result, last.parsed);
    rawTextEl.textContent = last.result.text || "(빈 문자열)";
  }
}

function commitSuccess(result, parsed, source) {
  if (noBarcodeTimeoutHandle) {
    clearTimeout(noBarcodeTimeoutHandle);
    noBarcodeTimeoutHandle = null;
  }
  const elapsedMs = Math.round(performance.now() - scanStartTs);

  updateDevPanelLive(result, parsed, elapsedMs);
  rawTextEl.textContent = result.text || "(빈 문자열)";
  elapsedEl.textContent = (elapsedMs / 1000).toFixed(2) + "초";

  const logEntry = {
    ts: new Date().toISOString(),
    source, // "BARCODE" | "OCR"
    rawText: result.text,
    format: result.format ?? null,
    symbologyIdentifier: result.symbologyIdentifier ?? null,
    hasGs: parsed.hasGsSeparator ?? null,
    ok: true,
    ai: parsed.weightAi ?? null,
    rawDigits: parsed.rawWeightDigits ?? null,
    weightKgText: parsed.weightKgText,
    reason: null,
    elapsedMs,
  };
  sessionLog.push(logEntry);
  renderLogRow(logEntry);

  successCount += 1;
  successCountEl.textContent = String(successCount);
  weightBigEl.textContent = parsed.weightKgText;
  weightBigEl.classList.remove("fail");
  weightBigEl.classList.add("ok");
  setStatus("성공" + (source === "OCR" ? " (OCR 확정)" : ""));
  successFeedback();

  frozen = true;
  rescanBtn.hidden = false;
}

// V3 신규: 성공은 아니지만 뭔가 읽힌 경우 — 멈추지 않고 "참고"로만 남김(요청사항 1, 3번)
function logReferenceOnly(result, parsed) {
  const key = `${result.format}|${result.text}|${parsed.reason}`;
  const now = performance.now();
  if (key === lastRefKey && now - lastRefLoggedAt < REF_LOG_DEDUP_MS) {
    return; // 같은 내용이 짧은 시간 안에 반복되면 로그가 도배되지 않도록 건너뜀
  }
  lastRefKey = key;
  lastRefLoggedAt = now;

  const elapsedMs = Math.round(performance.now() - scanStartTs);
  const logEntry = {
    ts: new Date().toISOString(),
    source: "BARCODE",
    rawText: result.text,
    format: result.format ?? null,
    symbologyIdentifier: result.symbologyIdentifier ?? null,
    hasGs: parsed.hasGsSeparator ?? null,
    ok: false,
    ref: true, // 실패가 아니라 "참고"임을 표시 — failCount에 반영 안 됨
    ai: parsed.weightAi ?? null,
    rawDigits: parsed.rawWeightDigits ?? null,
    weightKgText: null,
    reason: parsed.reason, // 예: NO_WEIGHT_AI, INVALID_LENGTH 등
    elapsedMs,
  };
  sessionLog.push(logEntry);
  renderLogRow(logEntry);
}

function updateDevPanelLive(result, parsed, elapsedMsOverride) {
  const elapsedMs = elapsedMsOverride ?? Math.round(performance.now() - scanStartTs);
  devFormat.textContent = result.format ?? "-";
  devSymbology.textContent = result.symbology ?? "-";
  devSymbologyId.textContent = result.symbologyIdentifier || "(빈 값)";
  devGsFlag.textContent = parsed.hasGsSeparator ? "포함됨 (GS 구분자 감지)" : "없음";
  devAi.textContent = parsed.weightAi ?? "(감지 안 됨)";
  devRawDigits.textContent = parsed.rawWeightDigits ?? "-";
  devFinalKg.textContent = parsed.ok ? parsed.weightKgText : "-";
  devElapsed.textContent = elapsedMs + " ms";
  devContentType.textContent = result.contentType ?? "-";
  devError.textContent = result.error || (parsed.ok ? "(없음)" : parsed.reason);
}

function renderLogRow(entry) {
  const li = document.createElement("li");
  const label = entry.ok ? "성공" : entry.ref ? "참고" : "실패";
  li.textContent =
    `${entry.ts.slice(11, 19)} | ${label} | [${entry.source}] ` +
    `${entry.weightKgText ?? entry.reason ?? "-"} | ${entry.elapsedMs}ms | raw="${entry.rawText}"`;
  li.className = entry.ok ? "log-ok" : entry.ref ? "log-ref" : "log-fail";
  logListEl.prepend(li);
}

// ── 8. 다시 스캔 ─────────────────────────────────────────────────────────
function resetForNextScan(isFirst = false) {
  frozen = false;
  scanStartTs = performance.now();
  rescanBtn.hidden = true;
  ocrPanel.classList.remove("show");
  weightBigEl.textContent = "-- kg";
  weightBigEl.classList.remove("ok", "fail");
  rawTextEl.textContent = isFirst ? "(아직 스캔 안 됨)" : "-";
  elapsedEl.textContent = "-";
  // V3 수정: 카메라가 켜져 있는 한 계속 "인식 중"이어야 한다. "대기"는 카메라 시작 버튼을
  // 누르기 전(streamStarted=false)에만 보여준다 — 이전 버전은 최초 1회 "대기"로 고정된 뒤
  // 참고 로그만 쌓이는 동안 상태 문구가 갱신되지 않는 사소한 표시 버그가 있었다(가짜 카메라
  // 시퀀스 테스트로 발견, 아래 12번 항목 참고).
  setStatus(streamStarted ? "인식 중" : "대기");
  [devFormat, devSymbology, devSymbologyId, devGsFlag, devAi, devRawDigits, devFinalKg, devElapsed, devContentType, devError, devResultCount]
    .forEach((el) => (el.textContent = "-"));
  lastRefKey = null;

  if (noBarcodeTimeoutHandle) clearTimeout(noBarcodeTimeoutHandle);
  noBarcodeTimeoutHandle = setTimeout(handleNoBarcodeTimeout, NO_BARCODE_TIMEOUT_MS);
}
rescanBtn.addEventListener("click", () => resetForNextScan(false));

// ── 8-b. 15초 무인식(=무성공) 타임아웃 ─────────────────────────────────────
// V3: "바코드가 전혀 안 잡힘"이 아니라 "15초 동안 AI 3100~3109를 포함한 성공적인
// 중량 인식이 없었음"을 뜻한다 — 그 사이 일반 바코드(예: 위쪽 25789003)는 여러 번
// 읽혔을 수 있고, 그것들은 참고 로그로 남아있다. 로그 사유 코드는 기존과 동일하게
// TIMEOUT_NO_BARCODE를 유지한다(요청하신 원래 로그 형식과의 호환을 위해).
function handleNoBarcodeTimeout() {
  noBarcodeTimeoutHandle = null;
  if (frozen) return;

  const elapsedMs = Math.round(performance.now() - scanStartTs);
  devElapsed.textContent = elapsedMs + " ms";
  devError.textContent = "TIMEOUT_NO_BARCODE";

  elapsedEl.textContent = (elapsedMs / 1000).toFixed(2) + "초";

  const logEntry = {
    ts: new Date().toISOString(),
    source: "BARCODE",
    rawText: null,
    format: null,
    symbologyIdentifier: null,
    hasGs: null,
    ok: false,
    ai: null,
    rawDigits: null,
    weightKgText: null,
    reason: "TIMEOUT_NO_BARCODE",
    elapsedMs,
  };
  sessionLog.push(logEntry);
  renderLogRow(logEntry);

  failCount += 1;
  failCountEl.textContent = String(failCount);
  weightBigEl.textContent = "인식 실패";
  weightBigEl.classList.remove("ok");
  weightBigEl.classList.add("fail");
  setStatus(`실패 — ${NO_BARCODE_TIMEOUT_MS / 1000}초 내 중량 인식 안 됨`);
  failFeedback();

  frozen = true;
  rescanBtn.hidden = false;
}

function setStatus(text) {
  statusEl.textContent = text;
  statusEl.dataset.state = text;
}

// ── 9. 테스트 로그 복사 (요구사항 외 편의 기능) ────────────────────────────
copyLogBtn.addEventListener("click", async () => {
  const header = "번호\t시각\t결과\t경로\t중량/사유\t소요시간\t포맷\t심볼로지ID\tGS포함\t원본문자열\n";
  const text = sessionLog
    .map((e, i) => {
      const label = e.ok ? "성공" : e.ref ? "참고" : "실패";
      return `${i + 1}\t${e.ts}\t${label}\t${e.source}\t${e.weightKgText ?? e.reason ?? ""}\t${e.elapsedMs}ms\t${e.format}\t${e.symbologyIdentifier}\t${e.hasGs}\t${e.rawText}`;
    })
    .join("\n");
  try {
    await navigator.clipboard.writeText(header + text);
    copyLogBtn.textContent = "복사됨 ✓ (붙여넣기 해서 사용하세요)";
    setTimeout(() => (copyLogBtn.textContent = "테스트 로그 복사"), 2500);
  } catch (e) {
    alert("클립보드 복사에 실패했습니다. 화면 하단 로그 목록을 직접 참고해 주세요.");
  }
});

// ── 10. OCR 보조 인식 (V3 신규) ─────────────────────────────────────────
// GS1-128 인식이 어려운 경우를 위한 보조 수단. 라벨에 인쇄된 "Net weight: 14,20 Kg" 문구를
// 읽는다. 무겁기 때문에(약 18MB) 처음 버튼을 눌렀을 때만 라이브러리를 불러온다(지연 로딩).
// 결과는 직원이 "이 값으로 확정"을 눌러야만 반영된다 — 자동 저장 없음(요청사항 10).
ocrBtn.addEventListener("click", async () => {
  frozen = true; // 바코드 스캔 루프 일시 정지
  if (noBarcodeTimeoutHandle) {
    clearTimeout(noBarcodeTimeoutHandle);
    noBarcodeTimeoutHandle = null;
  }
  ocrPanel.classList.add("show");
  ocrCandidateEl.textContent = "OCR 엔진을 불러오는 중... (최초 1회, 네트워크 상태에 따라 다소 걸릴 수 있음)";
  ocrRawTextEl.textContent = "-";
  ocrConfirmBtn.disabled = true;

  try {
    const worker = await getOcrWorker();

    // 라벨 하단부(중량 문구가 인쇄된 영역)를 캡처. 화면 전체가 아니라 비디오 프레임 그대로 사용(1차 버전은
    // 영역 자동 지정 없이 전체 프레임을 넘기고, 필요하면 D-2 설계처럼 ROI 지정을 다음 단계에서 추가한다.
    ocrCanvas.width = video.videoWidth;
    ocrCanvas.height = video.videoHeight;
    ocrCtx.drawImage(video, 0, 0, ocrCanvas.width, ocrCanvas.height);
    // ↑ 이 캔버스 내용은 OCR 처리에만 쓰이고 저장되거나 서버로 전송되지 않는다. 다음 시도에서 덮어써진다.

    ocrCandidateEl.textContent = "글자 인식 중...";
    const ocrStart = performance.now();
    const { data } = await worker.recognize(ocrCanvas);
    const ocrElapsedMs = Math.round(performance.now() - ocrStart);

    const parsed = extractNetWeightFromOcrText(data.text);
    ocrRawTextEl.textContent = `OCR 원문(${ocrElapsedMs}ms): ${data.text || "(인식된 글자 없음)"}`;

    if (parsed.ok) {
      ocrCandidateEl.textContent = `후보값: ${parsed.weightKgText}`;
      ocrConfirmBtn.disabled = false;
      ocrConfirmBtn.dataset.weightKgText = parsed.weightKgText;
      ocrConfirmBtn.dataset.rawText = data.text || "";
    } else {
      ocrCandidateEl.textContent = `중량 문구를 찾지 못했습니다 (${parsed.reason}). 아래 원문을 참고해 다시 촬영해 주세요.`;
      ocrConfirmBtn.disabled = true;
    }
  } catch (e) {
    console.error("OCR error", e);
    ocrCandidateEl.textContent = "OCR 처리 중 오류가 발생했습니다: " + (e.message || String(e));
    ocrConfirmBtn.disabled = true;
  }
});

ocrConfirmBtn.addEventListener("click", () => {
  const weightKgText = ocrConfirmBtn.dataset.weightKgText;
  if (!weightKgText) return;
  // OCR 결과는 실제 "바코드 result" 객체가 없으므로, 로그 형식을 맞추기 위한 최소 형태로 구성
  const fakeResult = { text: ocrConfirmBtn.dataset.rawText || "", format: "OCR", symbologyIdentifier: "", contentType: "OCR", error: "" };
  const fakeParsed = { ok: true, weightKgText, hasGsSeparator: false, weightAi: null, rawWeightDigits: null };
  ocrPanel.classList.remove("show");
  commitSuccess(fakeResult, fakeParsed, "OCR");
});

ocrCancelBtn.addEventListener("click", () => {
  ocrPanel.classList.remove("show");
  resetForNextScan(false);
});

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const mod = await import("./vendor/tesseract/tesseract.esm.min.js");
      const Tesseract = mod.default;
      const worker = await Tesseract.createWorker("eng", 1 /* OEM.LSTM_ONLY */, {
        workerPath: "./vendor/tesseract/worker.min.js",
        corePath: "./vendor/tesseract/tesseract-core-simd-lstm.wasm.js",
        langPath: "./vendor/tesseract/lang-eng",
        gzip: true,
        logger: () => {},
      });
      return worker;
    })();
  }
  return ocrWorkerPromise;
}
