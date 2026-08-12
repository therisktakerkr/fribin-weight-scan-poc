/**
 * app.js — 박스 중량 스캔 POC 메인 로직 (V6 — "중량 영역 전용" OCR + 다중 전처리 합의)
 *
 * 사용 라이브러리: zxing-wasm 3.1.2(바코드), tesseract.js 7.0.0(OCR, 영어+한국어) — 전부
 * vendor/ 폴더에 로컬로 복사해 CDN 없이 동작. 카메라/OCR 캡처 화면은 인식 처리에만 일시적으로
 * 쓰이고 저장·전송되지 않는다.
 *
 * V6 핵심 변경점(이번 요청 반영):
 *  - 기존 GS1 파서(gs1-parser.js)와 FRIBIN 바코드 인식 로직은 전혀 건드리지 않았다.
 *  - "화면 전체 OCR + 문맥 판정" 방식을 중단하고, 화면 중앙의 작고 가로로 긴 사각형
 *    ("중량 X kg" 한 줄만 들어오도록)만 인식하는 방식으로 전면 교체했다.
 *  - 그 좁은 사각형 내부를 원본(업스케일)/그레이스케일/대비강화/이진화(Otsu)/숫자전용
 *    5가지 방식으로 각각 OCR하고, 서로 다른 결과 중 최소 2개 이상이 일치해야만 "권장"
 *    후보로 표시한다(ocr-weight-parser.js의 combineOcrPasses). 합의가 없으면 "불확실"로
 *    표시하고 무엇도 자동 선택하지 않는다.
 *  - "화면 전체에서 아무 소수나 찾는" 안전망은 사용자 후보 목록에서 완전히 제거했다 —
 *    이제 OCR 자체가 사각형 밖은 애초에 캡처하지 않는다. 사각형 내부 단어 중 소수점
 *    있는 것만 참고용으로 개발자 패널/콘솔에만 남긴다(findFallbackNumericCandidatesForDevLogOnly).
 *  - 사각형(guide element)의 실제 화면 위치/크기를 getBoundingClientRect()로 읽어 카메라
 *    원본 해상도 좌표로 정확히 환산한다(object-fit:cover로 인한 크롭까지 고려) — 사각형
 *    밖의 픽셀은 크롭 단계에서부터 아예 포함되지 않는다.
 *  - "직접 입력"(0~100kg, 소수점 가능) 버튼을 추가했다 — 인식이 불확실하거나 실패해도
 *    직원이 라벨 실물을 보고 직접 입력할 수 있다.
 *  - 어떤 경로로도 자동 확정은 없다 — 항상 "이 중량으로 확정"을 직접 눌러야 한다.
 */

const ZXING_WASM_VERSION = "3.1.2";
const TESSERACT_JS_VERSION = "7.0.0";
import { readBarcodes, prepareZXingModule } from "./vendor/zxing-wasm/reader/index.js";
import { parseNetWeightKg } from "./gs1-parser.js";
import { combineOcrPasses, findFallbackNumericCandidatesForDevLogOnly } from "./ocr-weight-parser.js";

prepareZXingModule({
  overrides: { locateFile: (fileName) => `./vendor/zxing-wasm/reader/${fileName}` },
});

// ── DOM 참조 ─────────────────────────────────────────────────────────────
const video = document.getElementById("video");
const canvas = document.getElementById("workCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const ocrCanvas = document.getElementById("ocrCanvas"); // 미리보기용(숨김) — 실제 크롭은 별도 캔버스에서 처리

const statusEl = document.getElementById("status");
const weightIdleEl = document.getElementById("weightIdle");
const candidateListEl = document.getElementById("candidateList");
const uncertainBannerEl = document.getElementById("uncertainBanner");
const rawTextEl = document.getElementById("rawText");
const elapsedEl = document.getElementById("elapsed");
const ocrLoadTimeEl = document.getElementById("ocrLoadTime");
const ocrRecognizeTimeEl = document.getElementById("ocrRecognizeTime");
const successCountEl = document.getElementById("successCount");
const failCountEl = document.getElementById("failCount");
const confirmBtn = document.getElementById("confirmBtn");
const retryBtn = document.getElementById("retryBtn");
const barcodeModeBtn = document.getElementById("barcodeModeBtn");
const ocrBtn = document.getElementById("ocrBtn");
const startBtn = document.getElementById("startBtn");
const logListEl = document.getElementById("logList");
const copyLogBtn = document.getElementById("copyLogBtn");
const cameraErrorEl = document.getElementById("cameraError");

const manualEntryBtn = document.getElementById("manualEntryBtn");
const manualEntryPanelEl = document.getElementById("manualEntryPanel");
const manualWeightInputEl = document.getElementById("manualWeightInput");
const manualConfirmBtn = document.getElementById("manualConfirmBtn");
const manualCancelBtn = document.getElementById("manualCancelBtn");

const devFormat = document.getElementById("devFormat");
const devSymbology = document.getElementById("devSymbology");
const devSymbologyId = document.getElementById("devSymbologyId");
const devGsFlag = document.getElementById("devGsFlag");
const devAi = document.getElementById("devAi");
const devRawDigits = document.getElementById("devRawDigits");
const devFinalKg = document.getElementById("devFinalKg");
const devContentType = document.getElementById("devContentType");
const devError = document.getElementById("devError");
const devResultCount = document.getElementById("devResultCount");
const devCameraCaps = document.getElementById("devCameraCaps");
const devOcrFallbackEl = document.getElementById("devOcrFallback");

const torchBtn = document.getElementById("torchBtn");
const zoomWrap = document.getElementById("zoomWrap");
const zoomRange = document.getElementById("zoomRange");
const scanGuideEl = document.getElementById("scanGuide");
const scanGuideHintEl = document.getElementById("scanGuideHint");
const ocrGuideEl = document.getElementById("ocrGuide");
const ocrGuideHintEl = document.getElementById("ocrGuideHint");

// ── 상태값 ───────────────────────────────────────────────────────────────
let successCount = 0;
let failCount = 0;
let scanStartTs = 0;
let frozen = false; // 후보를 찾아 검토 중이거나, 확정 직후 상태 — "다시 인식/다시 촬영"을 눌러야 재개
let decodeInFlight = false;
let intervalHandle = null;
let noBarcodeTimeoutHandle = null;
let audioCtx = null;
let videoTrack = null;
let torchOn = false;
let streamStarted = false;
let ocrWorkerPromise = null;
let ocrEngineReady = false; // 최초 로딩 완료 여부(로딩시간 vs 인식시간 구분용)
let currentMode = "BARCODE"; // "BARCODE" | "OCR" — 가이드 UI와 "다시 촬영" 버튼 동작을 결정
const sessionLog = []; // 세션 동안의 시도 기록 — 메모리에만 존재, 서버 전송/저장 없음

const DECODE_INTERVAL_MS = 250;
const NO_BARCODE_TIMEOUT_MS = 15000;
const MAX_DECODE_SIDE_PX = 1600;
const OCR_UPSCALE_FACTOR = 4; // 요청사항 4: 크롭한 사각형을 2~4배 확대 후 OCR

let currentCandidates = []; // 화면에 표시 중인 후보 목록
let selectedCandidateIdx = -1;
let pendingLogMeta = null; // 확정 시 로그에 남길 부가정보(원본문자열, AI 등)

let lastRefKey = null;
let lastRefLoggedAt = 0;
const REF_LOG_DEDUP_MS = 1500;

// ── 사운드/진동 피드백 ────────────────────────────────────────────────────
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
function foundFeedback() { beep(1046, 110); if (navigator.vibrate) navigator.vibrate(150); }
function confirmFeedback() { beep(1318, 140); if (navigator.vibrate) navigator.vibrate(200); }
function failFeedback() { beep(220, 220); if (navigator.vibrate) navigator.vibrate([80, 60, 80]); }

// ── 카메라 시작 ──────────────────────────────────────────────────────────
async function startCamera() {
  unlockAudio();
  cameraErrorEl.textContent = "";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920, min: 1280 },
        height: { ideal: 1080, min: 720 },
        advanced: [{ focusMode: "continuous" }],
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    videoTrack = stream.getVideoTracks()[0];
    streamStarted = true;
    startBtn.hidden = true;
    ocrBtn.hidden = false;
    barcodeModeBtn.hidden = false;
    manualEntryBtn.hidden = false;
    await applyCameraCapabilities();
    enterBarcodeMode(true);
  } catch (err) {
    cameraErrorEl.textContent =
      "카메라를 시작할 수 없습니다: " + (err && err.message ? err.message : String(err)) +
      " (브라우저의 카메라 권한 설정을 확인해 주세요. 반드시 HTTPS 주소로 접속해야 합니다.)";
    setStatus("실패");
  }
}
startBtn.addEventListener("click", startCamera);

async function applyCameraCapabilities() {
  if (!videoTrack || typeof videoTrack.getCapabilities !== "function") {
    devCameraCaps.textContent = "getCapabilities() 미지원(아이폰 Safari에서 흔함) — 줌/손전등 UI 숨김";
    return;
  }
  let caps;
  try { caps = videoTrack.getCapabilities(); } catch (e) {
    devCameraCaps.textContent = "getCapabilities() 호출 실패: " + e.message;
    return;
  }
  const settings = typeof videoTrack.getSettings === "function" ? videoTrack.getSettings() : {};
  const summary = [`해상도 ${settings.width || "?"}x${settings.height || "?"}`];

  if (Array.isArray(caps.focusMode) && caps.focusMode.includes("continuous")) {
    try { await videoTrack.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); summary.push("연속AF:지원"); }
    catch (e) { summary.push("연속AF:적용실패"); }
  } else summary.push("연속AF:미지원");

  if (caps.zoom && typeof caps.zoom.min === "number" && typeof caps.zoom.max === "number" && caps.zoom.max > caps.zoom.min) {
    zoomRange.min = caps.zoom.min; zoomRange.max = caps.zoom.max; zoomRange.step = caps.zoom.step || 0.1;
    zoomRange.value = settings.zoom || caps.zoom.min;
    zoomWrap.style.display = "block";
    summary.push(`줌:지원(${caps.zoom.min}~${caps.zoom.max})`);
  } else { zoomWrap.style.display = "none"; summary.push("줌:미지원"); }

  if (caps.torch === true) { torchBtn.hidden = false; summary.push("손전등:지원"); }
  else { torchBtn.hidden = true; summary.push("손전등:미지원"); }

  devCameraCaps.textContent = summary.join(" · ");
}

zoomRange.addEventListener("input", async () => {
  if (!videoTrack) return;
  try { await videoTrack.applyConstraints({ advanced: [{ zoom: Number(zoomRange.value) }] }); }
  catch (e) { console.error("zoom apply failed", e); }
});
torchBtn.addEventListener("click", async () => {
  if (!videoTrack) return;
  torchOn = !torchOn;
  try {
    await videoTrack.applyConstraints({ advanced: [{ torch: torchOn }] });
    torchBtn.textContent = torchOn ? "🔦 손전등 끄기" : "🔦 손전등";
  } catch (e) { console.error("torch apply failed", e); torchOn = !torchOn; }
});

// ── 가이드 UI 전환 (바코드: 넓은 사각형 / OCR: 작은 가로 사각형) ───────────
function enterBarcodeGuideUi() {
  currentMode = "BARCODE";
  ocrGuideEl.hidden = true;
  ocrGuideHintEl.hidden = true;
  scanGuideEl.style.display = "";
  scanGuideHintEl.style.display = "";
  retryBtn.textContent = "다시 인식";
}
function enterOcrGuideUi() {
  currentMode = "OCR";
  scanGuideEl.style.display = "none";
  scanGuideHintEl.style.display = "none";
  ocrGuideEl.hidden = false;
  ocrGuideHintEl.hidden = false;
  retryBtn.textContent = "다시 촬영";
}

// ── 바코드 모드 (1순위: GS1) ────────────────────────────────────────────
function enterBarcodeMode(isFirst = false) {
  frozen = false;
  enterBarcodeGuideUi();
  scanStartTs = performance.now();
  clearCandidatePanel();
  hideUncertainBanner();
  manualEntryPanelEl.style.display = "none";
  rawTextEl.textContent = isFirst ? "(아직 스캔 안 됨)" : "-";
  elapsedEl.textContent = "-";
  ocrLoadTimeEl.textContent = ocrEngineReady ? "로딩됨" : "-";
  ocrRecognizeTimeEl.textContent = "-";
  setStatus(streamStarted ? "인식 중" : "대기");
  [devFormat, devSymbology, devSymbologyId, devGsFlag, devAi, devRawDigits, devFinalKg, devContentType, devError, devResultCount]
    .forEach((el) => (el.textContent = "-"));
  lastRefKey = null;

  if (noBarcodeTimeoutHandle) clearTimeout(noBarcodeTimeoutHandle);
  noBarcodeTimeoutHandle = setTimeout(handleNoBarcodeTimeout, NO_BARCODE_TIMEOUT_MS);
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(tick, DECODE_INTERVAL_MS);
}
barcodeModeBtn.addEventListener("click", () => enterBarcodeMode(false));

retryBtn.addEventListener("click", () => {
  hideUncertainBanner();
  manualEntryPanelEl.style.display = "none";
  if (currentMode === "OCR") {
    // 요청사항: OCR "다시 촬영"은 바코드 모드로 전환하지 않고, 사각형을 다시 맞출 수 있게
    // 후보/배너만 초기화한다. 실제 재촬영은 "🔤 글자로 중량 찾기" 버튼을 다시 눌러 수행한다.
    frozen = false;
    clearCandidatePanel();
    rawTextEl.textContent = "-";
    elapsedEl.textContent = "-";
    ocrRecognizeTimeEl.textContent = "-";
    setStatus(streamStarted ? "대기 (사각형을 맞추고 다시 촬영하세요)" : "대기");
  } else {
    enterBarcodeMode(false);
  }
});

async function tick() {
  if (frozen || decodeInFlight) return;
  if (video.readyState < 2) return;
  decodeInFlight = true;
  try {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.min(1, MAX_DECODE_SIDE_PX / Math.max(vw, vh));
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // ↑ 이 imageData는 함수 안에서만 쓰이고 저장·전송되지 않음. 다음 tick에서 canvas는 덮어써짐.

    const results = await readBarcodes(imageData, {
      formats: ["Code128"], // GS1-128 포함
      tryHarder: true,
      textMode: "Escaped",
      returnErrors: false,
      maxNumberOfSymbols: 0,
    });
    if (results && results.length > 0) handleBarcodeResults(results);
  } catch (e) {
    console.error("decode tick error", e);
  } finally {
    decodeInFlight = false;
  }
}

function handleBarcodeResults(results) {
  devResultCount.textContent = String(results.length);
  let successPick = null;
  const referencePicks = [];

  for (const r of results) {
    const parsed = parseNetWeightKg(r.text);
    if (parsed.ok) { successPick = { result: r, parsed }; break; }
    referencePicks.push({ result: r, parsed });
  }

  if (successPick) {
    const { result, parsed } = successPick;
    if (noBarcodeTimeoutHandle) { clearTimeout(noBarcodeTimeoutHandle); noBarcodeTimeoutHandle = null; }
    const elapsedMs = Math.round(performance.now() - scanStartTs);

    updateDevPanelLive(result, parsed, elapsedMs);
    rawTextEl.textContent = result.text || "(빈 문자열)";
    elapsedEl.textContent = (elapsedMs / 1000).toFixed(2) + "초";

    const candidate = {
      weightKg: parsed.weightKg,
      weightKgText: parsed.weightKgText,
      classification: "NET",
      recommended: true,
      reasonLabel: `GS1 바코드 (AI ${parsed.weightAi})`,
      matchedText: result.text,
      source: "BARCODE",
    };
    pendingLogMeta = {
      format: result.format, symbologyIdentifier: result.symbologyIdentifier,
      hasGs: parsed.hasGsSeparator, rawText: result.text, elapsedMs,
    };
    frozen = true; // 후보를 찾았으니 자동 검색은 멈추고 사람 확인을 기다림
    foundFeedback();
    presentCandidates([candidate], "BARCODE");
    return;
  }

  for (const pick of referencePicks) logReferenceOnly(pick.result, pick.parsed);
  if (referencePicks.length > 0) {
    const last = referencePicks[referencePicks.length - 1];
    updateDevPanelLive(last.result, last.parsed);
    rawTextEl.textContent = last.result.text || "(빈 문자열)";
  }
}

function logReferenceOnly(result, parsed) {
  const key = `${result.format}|${result.text}|${parsed.reason}`;
  const now = performance.now();
  if (key === lastRefKey && now - lastRefLoggedAt < REF_LOG_DEDUP_MS) return;
  lastRefKey = key; lastRefLoggedAt = now;
  const elapsedMs = Math.round(performance.now() - scanStartTs);
  const entry = {
    ts: new Date().toISOString(), source: "BARCODE", rawText: result.text,
    format: result.format ?? null, symbologyIdentifier: result.symbologyIdentifier ?? null,
    hasGs: parsed.hasGsSeparator ?? null, ok: false, ref: true,
    ai: parsed.weightAi ?? null, rawDigits: parsed.rawWeightDigits ?? null,
    weightKgText: null, reason: parsed.reason, elapsedMs,
  };
  sessionLog.push(entry);
  renderLogRow(entry);
}

function handleNoBarcodeTimeout() {
  noBarcodeTimeoutHandle = null;
  if (frozen) return;
  const elapsedMs = Math.round(performance.now() - scanStartTs);
  devError.textContent = "TIMEOUT_NO_BARCODE";
  elapsedEl.textContent = (elapsedMs / 1000).toFixed(2) + "초";

  const entry = {
    ts: new Date().toISOString(), source: "BARCODE", rawText: null, format: null,
    symbologyIdentifier: null, hasGs: null, ok: false, ai: null, rawDigits: null,
    weightKgText: null, reason: "TIMEOUT_NO_BARCODE", elapsedMs,
  };
  sessionLog.push(entry);
  renderLogRow(entry);

  failCount += 1;
  failCountEl.textContent = String(failCount);
  setStatus(`실패 — ${NO_BARCODE_TIMEOUT_MS / 1000}초 내 중량 인식 안 됨`);
  failFeedback();
  frozen = true;
  weightIdleEl.style.display = "block";
  weightIdleEl.textContent = "인식 실패";
  candidateListEl.style.display = "none";
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
  devContentType.textContent = result.contentType ?? "-";
  devError.textContent = result.error || (parsed.ok ? "(없음)" : parsed.reason);
}

// ── 후보 표시 / 선택 / 확정 (어떤 경로든 사람 확인 필수, 자동 확정 없음) ────
function presentCandidates(candidates, source) {
  currentCandidates = candidates;
  // 요청사항: 서로 다른 전처리 결과가 합의(권장)에 이르지 못했으면, 아무것도 자동으로
  // 선택하지 않는다 — 직원이 후보 중 하나를 직접 눌러야 "확정" 버튼이 활성화된다.
  const recIdx = candidates.findIndex((c) => c.recommended);
  selectedCandidateIdx = recIdx;

  weightIdleEl.style.display = "none";
  candidateListEl.style.display = "flex";
  candidateListEl.innerHTML = "";

  if (candidates.length === 0) {
    weightIdleEl.style.display = "block";
    candidateListEl.style.display = "none";
    weightIdleEl.textContent = "후보 없음";
    confirmBtn.disabled = true;
    setStatus("실패 — 중량 후보 없음");
    return;
  }

  candidates.forEach((c, idx) => {
    const row = document.createElement("div");
    row.className = "candidate-row" + (idx === selectedCandidateIdx ? " selected" : "") +
      (c.recommended ? " recommended" : "");
    row.innerHTML = `<span class="radio"></span><span class="val">${c.weightKgText}</span><span class="reason">${c.reasonLabel}<br/><small>[${c.source}] ${c.matchedText ?? ""}</small></span>`;
    row.addEventListener("click", () => {
      selectedCandidateIdx = idx;
      Array.from(candidateListEl.children).forEach((el, i) => el.classList.toggle("selected", i === idx));
      confirmBtn.disabled = false;
    });
    candidateListEl.appendChild(row);
  });

  confirmBtn.disabled = selectedCandidateIdx < 0;
  setStatus(selectedCandidateIdx < 0 ? "확인 필요 (불확실)" : "확인 필요");
}

function clearCandidatePanel() {
  currentCandidates = [];
  selectedCandidateIdx = -1;
  candidateListEl.style.display = "none";
  candidateListEl.innerHTML = "";
  weightIdleEl.style.display = "block";
  weightIdleEl.textContent = "-- kg";
  confirmBtn.disabled = true;
}

function hideUncertainBanner() {
  uncertainBannerEl.style.display = "none";
  uncertainBannerEl.textContent = "";
}
function showUncertainBanner(text) {
  uncertainBannerEl.textContent = text;
  uncertainBannerEl.style.display = "block";
}

confirmBtn.addEventListener("click", () => {
  if (selectedCandidateIdx < 0 || !currentCandidates[selectedCandidateIdx]) return;
  const c = currentCandidates[selectedCandidateIdx];

  const entry = {
    ts: new Date().toISOString(),
    source: c.source,
    rawText: (pendingLogMeta && pendingLogMeta.rawText) || c.matchedText || null,
    format: (pendingLogMeta && pendingLogMeta.format) || (c.source === "OCR" ? "OCR" : c.source === "MANUAL" ? "MANUAL" : null),
    symbologyIdentifier: (pendingLogMeta && pendingLogMeta.symbologyIdentifier) || null,
    hasGs: (pendingLogMeta && pendingLogMeta.hasGs) || null,
    ok: true,
    reasonLabel: c.reasonLabel,
    ai: null,
    rawDigits: null,
    weightKgText: c.weightKgText,
    reason: null,
    elapsedMs: (pendingLogMeta && pendingLogMeta.elapsedMs) || 0,
  };
  sessionLog.push(entry);
  renderLogRow(entry);

  successCount += 1;
  successCountEl.textContent = String(successCount);
  weightIdleEl.style.display = "block";
  candidateListEl.style.display = "none";
  hideUncertainBanner();
  manualEntryPanelEl.style.display = "none";
  weightIdleEl.textContent = `확정: ${c.weightKgText}`;
  setStatus(`확정됨 (${c.source})`);
  confirmFeedback();
  confirmBtn.disabled = true;
  pendingLogMeta = null;
});

function renderLogRow(entry) {
  const li = document.createElement("li");
  const label = entry.ok ? "확정" : entry.ref ? "참고" : "실패";
  li.textContent =
    `${entry.ts.slice(11, 19)} | ${label} | [${entry.source}] ` +
    `${entry.weightKgText ?? entry.reason ?? "-"}${entry.reasonLabel ? " (" + entry.reasonLabel + ")" : ""} | ${entry.elapsedMs}ms | raw="${entry.rawText}"`;
  li.className = entry.ok ? "log-ok" : entry.ref ? "log-ref" : "log-fail";
  logListEl.prepend(li);
}

function setStatus(text) { statusEl.textContent = text; statusEl.dataset.state = text; }

copyLogBtn.addEventListener("click", async () => {
  const header = "번호\t시각\t결과\t경로\t중량/사유\t근거\t소요시간\t원본문자열\n";
  const text = sessionLog.map((e, i) => {
    const label = e.ok ? "확정" : e.ref ? "참고" : "실패";
    return `${i + 1}\t${e.ts}\t${label}\t${e.source}\t${e.weightKgText ?? e.reason ?? ""}\t${e.reasonLabel ?? ""}\t${e.elapsedMs}ms\t${e.rawText}`;
  }).join("\n");
  try {
    await navigator.clipboard.writeText(header + text);
    copyLogBtn.textContent = "복사됨 ✓ (붙여넣기 해서 사용하세요)";
    setTimeout(() => (copyLogBtn.textContent = "테스트 로그 복사"), 2500);
  } catch (e) {
    alert("클립보드 복사에 실패했습니다. 화면 하단 로그 목록을 직접 참고해 주세요.");
  }
});

// ── 직접 입력 (요청사항 15: 0~100kg, 소수점 가능) ──────────────────────
manualEntryBtn.addEventListener("click", () => {
  frozen = true;
  if (noBarcodeTimeoutHandle) { clearTimeout(noBarcodeTimeoutHandle); noBarcodeTimeoutHandle = null; }
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
  hideUncertainBanner();
  manualEntryPanelEl.style.display = "block";
  manualWeightInputEl.value = "";
  manualWeightInputEl.focus();
});
manualCancelBtn.addEventListener("click", () => {
  manualEntryPanelEl.style.display = "none";
});
manualConfirmBtn.addEventListener("click", () => {
  const raw = manualWeightInputEl.value;
  const v = Number(raw);
  if (!raw || !Number.isFinite(v) || v <= 0 || v > 100) {
    alert("0보다 크고 100 이하의 숫자를 kg 단위로 입력해 주세요 (예: 9.4)");
    return;
  }
  const c = {
    weightKg: v,
    weightKgText: `${v}kg`,
    classification: "MANUAL",
    recommended: false,
    reasonLabel: "직원 직접 입력 (인식 결과 아님)",
    matchedText: raw,
    source: "MANUAL",
  };
  pendingLogMeta = { rawText: `직접입력:${raw}`, elapsedMs: 0 };
  presentCandidates([c], "MANUAL");
  selectedCandidateIdx = 0;
  Array.from(candidateListEl.children).forEach((el, i) => el.classList.toggle("selected", i === 0));
  confirmBtn.disabled = false;
  manualEntryPanelEl.style.display = "none";
  hideUncertainBanner();
  setStatus("확인 필요 (직접 입력)");
});

// ── OCR 영역 계산: 화면에 보이는 작은 사각형(#ocrGuide)의 실제 위치/크기를
//    그대로 읽어 카메라 원본 해상도 좌표로 환산한다. video는 CSS object-fit:cover로
//    렌더링되므로, 비디오 원본 종횡비가 컨테이너와 다르면 위/아래 또는 좌/우가 잘려서
//    보인다 — 그 잘린 만큼을 보정해야 "사각형 안에 실제로 보이는 부분"과 "크롭되는
//    픽셀"이 정확히 일치한다(요청사항 3: 사각형 밖은 아예 처리하지 않음).
function getOcrRoiNative() {
  const videoRect = video.getBoundingClientRect();
  const guideRect = ocrGuideEl.getBoundingClientRect();
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh || videoRect.width === 0 || videoRect.height === 0) return null;

  const fracLeft = (guideRect.left - videoRect.left) / videoRect.width;
  const fracTop = (guideRect.top - videoRect.top) / videoRect.height;
  const fracW = guideRect.width / videoRect.width;
  const fracH = guideRect.height / videoRect.height;

  const containerAspect = videoRect.width / videoRect.height;
  const videoAspect = vw / vh;
  let visX, visY, visW, visH;
  if (videoAspect > containerAspect) {
    // 비디오가 컨테이너보다 가로로 넓다 → 좌우가 잘려서 보인다
    visH = vh; visW = vh * containerAspect; visX = (vw - visW) / 2; visY = 0;
  } else {
    // 비디오가 컨테이너보다 세로로 길다(또는 같다) → 위아래가 잘려서 보인다
    visW = vw; visH = vw / containerAspect; visX = 0; visY = (vh - visH) / 2;
  }

  const roiX = Math.round(visX + fracLeft * visW);
  const roiY = Math.round(visY + fracTop * visH);
  const roiW = Math.max(1, Math.round(fracW * visW));
  const roiH = Math.max(1, Math.round(fracH * visH));
  return { roiX, roiY, roiW, roiH };
}

// ── 이미지 전처리 (요청사항 4·5: 업스케일 + 원본/그레이스케일/대비강화/이진화) ──
function makeUpscaledCanvas(sourceCanvas, factor) {
  const w = Math.max(1, Math.round(sourceCanvas.width * factor));
  const h = Math.max(1, Math.round(sourceCanvas.height * factor));
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = "high";
  octx.drawImage(sourceCanvas, 0, 0, w, h);
  return out;
}

function toGrayscaleCanvas(sourceCanvas) {
  const w = sourceCanvas.width, h = sourceCanvas.height;
  const sctx = sourceCanvas.getContext("2d", { willReadFrequently: true });
  const imageData = sctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = gray;
  }
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  out.getContext("2d").putImageData(imageData, 0, 0);
  return out;
}

function toContrastEnhancedCanvas(grayCanvas, extraFactor = 1.6) {
  const w = grayCanvas.width, h = grayCanvas.height;
  const gctx = grayCanvas.getContext("2d", { willReadFrequently: true });
  const imageData = gctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4) { if (d[i] < min) min = d[i]; if (d[i] > max) max = d[i]; }
  const range = Math.max(1, max - min);
  for (let i = 0; i < d.length; i += 4) {
    let v = (d[i] - min) * (255 / range); // 히스토그램 스트레치
    v = 128 + (v - 128) * extraFactor; // 추가 대비 강화
    v = Math.max(0, Math.min(255, v));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  out.getContext("2d").putImageData(imageData, 0, 0);
  return out;
}

// Otsu's method — 그레이스케일 히스토그램에서 클래스 간 분산이 최대가 되는 임계값을 찾는다.
function otsuThreshold(grayImageData, w, h) {
  const d = grayImageData.data;
  const hist = new Array(256).fill(0);
  for (let i = 0; i < d.length; i += 4) hist[d[i]]++;
  const total = w * h;
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, maxVar = -1, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > maxVar) { maxVar = varBetween; threshold = t; }
  }
  return threshold;
}

function toBinarizedCanvas(grayCanvas) {
  const w = grayCanvas.width, h = grayCanvas.height;
  const gctx = grayCanvas.getContext("2d", { willReadFrequently: true });
  const imageData = gctx.getImageData(0, 0, w, h);
  const th = otsuThreshold(imageData, w, h);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] >= th ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  out.getContext("2d").putImageData(imageData, 0, 0);
  return out;
}

// ── OCR 모드 (2순위: 라벨 문자, 사각형 내부 전용 + 다중 전처리 합의) ───────
async function runOcrPass(worker, passCanvas, passName) {
  const t0 = performance.now();
  const { data } = await worker.recognize(passCanvas, {}, { text: true, blocks: true });
  const ms = Math.round(performance.now() - t0);
  const words = flattenTesseractWords(data.blocks);
  return { passName, text: data.text || "", words, ms };
}

function devOcrFallbackLog(devFallback, passResults) {
  console.log("[OCR dev] 사각형 내부 전처리별 원문:", passResults.map((p) => ({ pass: p.passName, text: p.text, ms: p.ms })));
  console.log("[OCR dev] 사각형 내부 소수 안전망(개발자 로그 전용 — 사용자 후보로 노출되지 않음):", devFallback);
  if (devOcrFallbackEl) {
    devOcrFallbackEl.textContent = devFallback.length
      ? devFallback.map((d) => d.weightKgText).join(", ") + " (참고용 — 사용자 후보 아님)"
      : "(없음)";
  }
}

ocrBtn.addEventListener("click", async () => {
  frozen = true;
  if (noBarcodeTimeoutHandle) { clearTimeout(noBarcodeTimeoutHandle); noBarcodeTimeoutHandle = null; }
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }

  enterOcrGuideUi();
  clearCandidatePanel();
  hideUncertainBanner();
  manualEntryPanelEl.style.display = "none";
  weightIdleEl.style.display = "block";
  weightIdleEl.textContent = "OCR 준비 중...";
  setStatus("인식 중");
  rawTextEl.textContent = "-";

  try {
    const loadStart = performance.now();
    const worker = await getOcrWorker();
    const loadMs = Math.round(performance.now() - loadStart);
    ocrLoadTimeEl.textContent = ocrEngineReady && loadMs < 50 ? "이미 로딩됨" : loadMs + "ms";
    ocrEngineReady = true;

    // 요청사항 3: 사각형(#ocrGuide) 내부만 원본 해상도로 크롭한다 — 그 밖은 처리하지 않는다.
    const roi = getOcrRoiNative();
    if (!roi) throw new Error("카메라 영상 크기를 아직 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.");

    const rawCropCanvas = document.createElement("canvas");
    rawCropCanvas.width = roi.roiW;
    rawCropCanvas.height = roi.roiH;
    rawCropCanvas.getContext("2d").drawImage(video, roi.roiX, roi.roiY, roi.roiW, roi.roiH, 0, 0, roi.roiW, roi.roiH);
    // ↑ 캡처한 사각형 내부 영역은 OCR 처리에만 쓰이고 저장·전송되지 않음. 다음 시도에서 캔버스는 덮어써짐.

    // 요청사항 4: 2~4배 확대(여기서는 3배) 후, 요청사항 5: 4가지 전처리 버전을 만든다.
    const baseCanvas = makeUpscaledCanvas(rawCropCanvas, OCR_UPSCALE_FACTOR);
    const grayCanvas = toGrayscaleCanvas(baseCanvas);
    const contrastCanvas = toContrastEnhancedCanvas(grayCanvas);
    const binarizedCanvas = toBinarizedCanvas(grayCanvas);

    // 미리보기 캔버스(숨김, 저장/전송 없음)에 대비강화본을 표시해 개발 확인용으로만 남긴다.
    ocrCanvas.width = contrastCanvas.width; ocrCanvas.height = contrastCanvas.height;
    ocrCanvas.getContext("2d").drawImage(contrastCanvas, 0, 0);

    const recognizeStart = performance.now();
    const passResults = [];

    weightIdleEl.textContent = "글자 인식 중 (원본, 1/5)...";
    passResults.push(await runOcrPass(worker, baseCanvas, "원본"));

    weightIdleEl.textContent = "글자 인식 중 (그레이스케일, 2/5)...";
    passResults.push(await runOcrPass(worker, grayCanvas, "그레이스케일"));

    weightIdleEl.textContent = "글자 인식 중 (대비강화, 3/5)...";
    passResults.push(await runOcrPass(worker, contrastCanvas, "대비강화"));

    weightIdleEl.textContent = "글자 인식 중 (이진화, 4/5)...";
    passResults.push(await runOcrPass(worker, binarizedCanvas, "이진화"));

    // 요청사항 7: 숫자/단위 위주 인식을 위한 화이트리스트 전용 패스(5번째).
    weightIdleEl.textContent = "글자 인식 중 (숫자전용, 5/5)...";
    try {
      await worker.setParameters({ tessedit_char_whitelist: "0123456789.,kgKG" });
      passResults.push(await runOcrPass(worker, contrastCanvas, "숫자전용"));
    } finally {
      await worker.setParameters({ tessedit_char_whitelist: "" });
    }

    const recognizeMs = Math.round(performance.now() - recognizeStart);
    ocrRecognizeTimeEl.textContent = recognizeMs + "ms (전처리 5개 합산)";

    rawTextEl.textContent = passResults
      .map((p) => `[${p.passName}] ${(p.text || "").replace(/\s+/g, " ").trim() || "(없음)"}`)
      .join("  ");

    // 요청사항 10·11: combineOcrPasses가 "최소 2개 이상 서로 다른 패스가 일치"할 때만 권장.
    const combined = combineOcrPasses(passResults.map((p) => ({ passName: p.passName, text: p.text })));

    // 요청사항: 화면 전체 안전망은 사용자 후보로 노출하지 않는다 — 사각형 내부 단어 중
    // 소수점 있는 것만 개발자 패널/콘솔 로그에만 참고용으로 남긴다.
    const allWords = passResults.flatMap((p) => p.words);
    const devFallback = findFallbackNumericCandidatesForDevLogOnly(allWords);
    devOcrFallbackLog(devFallback, passResults);

    pendingLogMeta = {
      rawText: passResults.map((p) => `${p.passName}:${p.text}`).join(" | "),
      elapsedMs: recognizeMs,
    };

    const candidates = combined.candidates.map((c) => ({
      weightKg: c.weightKg,
      weightKgText: c.weightKgText,
      classification: c.recommended ? "NET" : "UNCONFIRMED",
      recommended: c.recommended,
      reasonLabel: `${c.votes}/5 패스 일치 (${c.passNames.join(", ")})`,
      matchedText: c.weightKgText,
      source: "OCR",
    }));

    presentCandidates(candidates, "OCR");

    if (candidates.length === 0) {
      failCount += 1;
      failCountEl.textContent = String(failCount);
      failFeedback();
      showUncertainBanner("⚠ 사각형 안에서 숫자를 찾지 못했습니다 — 사각형을 '중량 X kg' 행에 맞추고 다시 촬영하거나, 아래 '직접 입력'을 사용해 주세요.");
    } else if (combined.uncertain) {
      // 요청사항 12: 합의가 없으면 "인식 결과가 불확실합니다" + 전체 후보 + 다시 촬영 + 직접 입력.
      showUncertainBanner("⚠ 인식 결과가 불확실합니다 — 전처리 결과들이 서로 다른 값을 보였습니다. 아래 후보를 라벨 실물과 비교해 직접 선택하거나, 다시 촬영하거나, 직접 입력해 주세요.");
    } else {
      hideUncertainBanner();
      foundFeedback();
    }
  } catch (e) {
    // 요청사항: OCR 오류가 발생해도 기존 바코드 스캔 기능은 계속 작동해야 한다.
    console.error("OCR error", e);
    weightIdleEl.style.display = "block";
    candidateListEl.style.display = "none";
    weightIdleEl.textContent = "OCR 오류 발생";
    rawTextEl.textContent = "OCR 처리 중 오류: " + (e.message || String(e)) + " — '바코드로 중량 찾기'를 눌러 계속 스캔하거나 '직접 입력'을 사용하세요.";
    setStatus("실패 — OCR 오류");
    confirmBtn.disabled = true;
    failFeedback();
  }
});

// tesseract.js v7의 recognize({blocks:true}) 결과는 blocks[].paragraphs[].lines[].words[]
// 계층 구조로 온다(과거 버전의 평평한 data.words 배열과 다름) — 평평하게 펼쳐서 쓴다.
function flattenTesseractWords(blocks) {
  const out = [];
  if (!Array.isArray(blocks)) return out;
  for (const b of blocks) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        for (const w of l.words || []) {
          out.push({ text: w.text, confidence: w.confidence, bbox: w.bbox });
        }
      }
    }
  }
  return out;
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const mod = await import("./vendor/tesseract/tesseract.esm.min.js");
      const Tesseract = mod.default;
      // 한국어(kor)와 영어(eng)를 함께 로드해 두 언어가 섞인 라벨을 지원한다. 언어 순서는
      // "kor"를 먼저 두었다 — 실측 결과 ["kor","eng"] 순서가 한글 숫자 인식과 영어 라벨
      // 인식 모두에서 더 나은 결과를 보였다(자세한 비교는 README 참고).
      const worker = await Tesseract.createWorker(["kor", "eng"], 1 /* OEM.LSTM_ONLY */, {
        workerPath: "./vendor/tesseract/worker.min.js",
        corePath: "./vendor/tesseract/tesseract-core-simd-lstm.wasm.js",
        langPath: "./vendor/tesseract/lang-data",
        gzip: true,
        logger: () => {},
      });
      // 페이지 분할 모드(PSM) 실험: 7(단일 줄) 고정은 오히려 소수점을 더 자주 놓쳤다
      // (기본값 3이 이 좁은 크롭에서 더 나은 결과를 보임) — 기본값을 유지한다.
      return worker;
    })();
  }
  return ocrWorkerPromise;
}
