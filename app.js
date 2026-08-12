/**
 * app.js — FRIBIN 중량 스캔 POC 메인 로직
 *
 * 사용 라이브러리: zxing-wasm 3.1.2 — vendor/zxing-wasm/ 에 로컬로 복사해 CDN 없이 동작.
 * 이 파일은 카메라 프레임을 오프스크린 캔버스에 "일시적으로" 그려서 픽셀만 읽고,
 * 그 캔버스 내용을 저장하거나 어디로도 전송하지 않는다. 매 시도마다 같은 캔버스를 덮어쓴다.
 *
 * V2 수정(이번 배포 전 수정사항): 바코드 자체가 계속 인식되지 않는 경우(디코더가 아예
 * 아무 결과도 반환하지 못하는 경우)를 별도로 감지해 "실패"로 집계한다. 기존에는 바코드가
 * 인식됐지만 GS1 중량 파싱에 실패한 경우만 실패로 잡았고, 바코드 자체가 전혀 안 잡히는
 * 경우는 실패 횟수에 반영되지 않는 사각지대가 있었다 — 아래 "5초 무인식 타임아웃" 로직으로 보완.
 */

// ── 1. 라이브러리 로드 (정확한 버전 고정) ────────────────────────────────
// zxing-wasm 3.1.2 (npm registry에서 실제로 내려받아 버전 확인함, 2026-08-11).
// 주의: zxing-wasm의 기본 동작은 .wasm 바이너리를 jsDelivr(fastly.jsdelivr.net) CDN에서
// 매번 내려받는 것이다. 이번 POC는 창고 등 네트워크가 불안정한 환경에서 쓰일 가능성과,
// 외부 CDN 의존성 자체를 줄이기 위해 라이브러리 파일(JS + wasm)을 이 폴더 안에
// 그대로 복사해(vendoring) 로컬에서 제공한다 — 아래 prepareZXingModule 로 그 경로를 지정한다.
const ZXING_WASM_VERSION = "3.1.2";
import { readBarcodes, prepareZXingModule } from "./vendor/zxing-wasm/reader/index.js";
import { parseNetWeightKg, GS_CHAR } from "./gs1-parser.js";

prepareZXingModule({
  overrides: {
    locateFile: (fileName) => `./vendor/zxing-wasm/reader/${fileName}`,
  },
});

// ── 2. DOM 참조 ──────────────────────────────────────────────────────────
const video = document.getElementById("video");
const canvas = document.getElementById("workCanvas"); // 화면에 보이지 않음 (CSS로 숨김), 저장/전송 없음
const ctx = canvas.getContext("2d", { willReadFrequently: true });

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

// ── 3. 상태값 ────────────────────────────────────────────────────────────
let successCount = 0;
let failCount = 0;
let scanStartTs = 0;
let frozen = false; // 성공/실패로 한 번 멈춘 상태 — "다시 스캔"을 눌러야 재개 (중복 등록 방지 설계와 동일한 원칙)
let decodeInFlight = false;
let intervalHandle = null;
let noBarcodeTimeoutHandle = null; // 5초 무인식 타임아웃 타이머 (V2 신규)
let audioCtx = null;
const sessionLog = []; // 세션 동안의 시도 기록 (메모리에만 존재, 새로고침하면 사라짐. 서버 전송/저장 없음)

const DECODE_INTERVAL_MS = 220; // 튜닝 가능한 POC 파라미터. 너무 짧으면 저사양 폰에서 버벅일 수 있음.
const NO_BARCODE_TIMEOUT_MS = 5000; // 스캔 시작/다시 스캔 후 이 시간 동안 바코드가 전혀 안 잡히면 실패로 기록

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
  // 아이폰 Safari는 Vibration API(navigator.vibrate)를 지원하지 않는 것으로 알려져 있음(2026-08 기준 실기 확인 필요).
  // 지원하지 않는 기기에서는 조용히 무시되며, 화면 색상 강조로 대체한다.
  if (navigator.vibrate) navigator.vibrate(200);
}
function failFeedback() {
  beep(220, 220);
  if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
}

// ── 5. 카메라 시작 ───────────────────────────────────────────────────────
async function startCamera() {
  unlockAudio();
  cameraErrorEl.textContent = "";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    startBtn.hidden = true;
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

// ── 6. 스캔 루프 ─────────────────────────────────────────────────────────
function startLoop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(tick, DECODE_INTERVAL_MS);
}

async function tick() {
  if (frozen || decodeInFlight) return;
  if (video.readyState < 2) return; // 아직 프레임 준비 안 됨
  decodeInFlight = true;
  try {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;

    // 디코딩 속도를 위해 긴 변을 최대 960px로 다운스케일 (조정 가능한 POC 파라미터)
    const maxSide = 960;
    const scale = Math.min(1, maxSide / Math.max(vw, vh));
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // ↑ 이 imageData는 함수 안에서만 쓰이고 어디에도 저장/전송되지 않음. 다음 tick에서 canvas 내용은 덮어써짐.

    const results = await readBarcodes(imageData, {
      formats: ["Code128"], // 요청하신 대로 Code128(=GS1-128 포함)로 제한해 속도 확보
      tryHarder: true,
      textMode: "Escaped", // GS/FNC1 등 제어문자를 <GS> 형태로 보여줘 원문 구조를 눈으로 확인 가능하게 함
      returnErrors: false,
    });

    if (results && results.length > 0) {
      handleDecodeResult(results[0]);
    }
  } catch (e) {
    // 디코딩 자체의 예외(예: WASM 초기화 지연)는 화면에 조용히 로그만 남기고 루프는 계속
    console.error("decode tick error", e);
  } finally {
    decodeInFlight = false;
  }
}

// ── 7. 디코드 결과 처리 ──────────────────────────────────────────────────
function handleDecodeResult(result) {
  // 바코드가 (파싱 성공 여부와 무관하게) 실제로 잡혔으므로, 대기 중이던 "5초 무인식" 타이머는 취소한다.
  if (noBarcodeTimeoutHandle) {
    clearTimeout(noBarcodeTimeoutHandle);
    noBarcodeTimeoutHandle = null;
  }
  const elapsedMs = Math.round(performance.now() - scanStartTs);
  const parsed = parseNetWeightKg(result.text);

  // 개발자 정보 패널 — 요청하신 8개 항목을 그대로 채움
  devFormat.textContent = result.format ?? "-";
  devSymbology.textContent = result.symbology ?? "-";
  devSymbologyId.textContent = result.symbologyIdentifier || "(빈 값 — 실기 확인 필요)";
  devGsFlag.textContent = parsed.hasGsSeparator ? "포함됨 (GS 구분자 감지)" : "없음";
  devAi.textContent = parsed.weightAi ?? "(감지 안 됨)";
  devRawDigits.textContent = parsed.rawWeightDigits ?? "-";
  devFinalKg.textContent = parsed.ok ? parsed.weightKgText : "-";
  devElapsed.textContent = elapsedMs + " ms";
  devContentType.textContent = result.contentType ?? "-";
  devError.textContent = result.error || "(없음)";

  rawTextEl.textContent = result.text || "(빈 문자열)";
  elapsedEl.textContent = (elapsedMs / 1000).toFixed(2) + "초";

  const logEntry = {
    ts: new Date().toISOString(),
    rawText: result.text,
    format: result.format,
    symbologyIdentifier: result.symbologyIdentifier,
    hasGs: parsed.hasGsSeparator,
    ok: parsed.ok,
    ai: parsed.weightAi,
    rawDigits: parsed.rawWeightDigits,
    weightKgText: parsed.ok ? parsed.weightKgText : null,
    reason: parsed.ok ? null : parsed.reason,
    elapsedMs,
  };
  sessionLog.push(logEntry);
  renderLogRow(logEntry);

  if (parsed.ok) {
    successCount += 1;
    successCountEl.textContent = String(successCount);
    weightBigEl.textContent = parsed.weightKgText;
    weightBigEl.classList.remove("fail");
    weightBigEl.classList.add("ok");
    setStatus("성공");
    successFeedback();
  } else {
    failCount += 1;
    failCountEl.textContent = String(failCount);
    weightBigEl.textContent = "인식 실패";
    weightBigEl.classList.remove("ok");
    weightBigEl.classList.add("fail");
    setStatus("실패 (" + parsed.reason + ")");
    failFeedback();
  }
  frozen = true; // 같은 프레임/같은 라벨이 계속 잡혀도 다시 스캔 누르기 전까지 재등록하지 않음
  rescanBtn.hidden = false;
}

// ── 7-b. 5초 무인식 타임아웃 (V2 신규) ─────────────────────────────────────
// 요구사항: 스캔 시작/다시 스캔 후 5초 동안 바코드 자체가 전혀 인식되지 않으면
// "실패 — 5초 내 인식 안 됨"으로 1회만 기록한다. 바코드가 인식됐지만 GS1 중량
// 파싱만 실패한 경우(handleDecodeResult 쪽)와는 다른, 별도의 실패 사유(TIMEOUT_NO_BARCODE)다.
function handleNoBarcodeTimeout() {
  noBarcodeTimeoutHandle = null;
  if (frozen) return; // 이미 다른 경로(정상 디코드)로 처리된 경우 안전하게 무시 — 중복 기록 방지

  const elapsedMs = Math.round(performance.now() - scanStartTs);

  devFormat.textContent = "-";
  devSymbology.textContent = "-";
  devSymbologyId.textContent = "-";
  devGsFlag.textContent = "-";
  devAi.textContent = "-";
  devRawDigits.textContent = "-";
  devFinalKg.textContent = "-";
  devElapsed.textContent = elapsedMs + " ms";
  devContentType.textContent = "-";
  devError.textContent = "TIMEOUT_NO_BARCODE";

  rawTextEl.textContent = "(바코드 인식 안 됨)";
  elapsedEl.textContent = (elapsedMs / 1000).toFixed(2) + "초";

  const logEntry = {
    ts: new Date().toISOString(),
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
  setStatus("실패 — 5초 내 인식 안 됨");
  failFeedback();

  frozen = true; // "다시 스캔"을 눌러야 다음 5초 타이머가 새로 시작됨 — 반복 집계 방지
  rescanBtn.hidden = false;
}

function renderLogRow(entry) {
  const li = document.createElement("li");
  li.textContent =
    `${entry.ts.slice(11, 19)} | ${entry.ok ? "성공" : "실패"} | ` +
    `${entry.weightKgText ?? entry.reason ?? "-"} | ${entry.elapsedMs}ms | raw="${entry.rawText}"`;
  li.className = entry.ok ? "log-ok" : "log-fail";
  logListEl.prepend(li);
}

// ── 8. 다시 스캔 ─────────────────────────────────────────────────────────
function resetForNextScan(isFirst = false) {
  frozen = false;
  scanStartTs = performance.now();
  rescanBtn.hidden = true;
  weightBigEl.textContent = "-- kg";
  weightBigEl.classList.remove("ok", "fail");
  rawTextEl.textContent = isFirst ? "(아직 스캔 안 됨)" : "-";
  elapsedEl.textContent = "-";
  setStatus(isFirst ? "대기" : "인식 중");
  [devFormat, devSymbology, devSymbologyId, devGsFlag, devAi, devRawDigits, devFinalKg, devElapsed, devContentType, devError]
    .forEach((el) => (el.textContent = "-"));

  // 5초 무인식 타임아웃 재시작 (V2 신규) — 스캔을 시작하거나 "다시 스캔"을 누를 때마다 새로 잰다.
  if (noBarcodeTimeoutHandle) clearTimeout(noBarcodeTimeoutHandle);
  noBarcodeTimeoutHandle = setTimeout(handleNoBarcodeTimeout, NO_BARCODE_TIMEOUT_MS);
}
rescanBtn.addEventListener("click", () => resetForNextScan(false));

function setStatus(text) {
  statusEl.textContent = text;
  statusEl.dataset.state = text;
}

// ── 9. 테스트 로그 복사 (요구사항 외 편의 기능 — 10회 반복 테스트 결과를 정리할 때 참고용) ──
copyLogBtn.addEventListener("click", async () => {
  const text = sessionLog
    .map(
      (e, i) =>
        `${i + 1}\t${e.ts}\t${e.ok ? "성공" : "실패"}\t${e.weightKgText ?? e.reason ?? ""}\t${e.elapsedMs}ms\t${e.format}\t${e.symbologyIdentifier}\t${e.hasGs}\t${e.rawText}`
    )
    .join("\n");
  const header = "번호\t시각\t결과\t중량/실패사유\t소요시간\t포맷\t심볼로지ID\tGS포함\t원본문자열\n";
  try {
    await navigator.clipboard.writeText(header + text);
    copyLogBtn.textContent = "복사됨 ✓ (붙여넣기 해서 사용하세요)";
    setTimeout(() => (copyLogBtn.textContent = "테스트 로그 복사"), 2500);
  } catch (e) {
    alert("클립보드 복사에 실패했습니다. 화면 하단 로그 목록을 직접 참고해 주세요.");
  }
});
