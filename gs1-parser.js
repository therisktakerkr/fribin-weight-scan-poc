/**
 * gs1-parser.js
 *
 * FRIBIN 중량 스캔 POC 전용 최소 GS1 엘리먼트 스트링 파서.
 *
 * 목적: 바코드 디코더(zxing-wasm)가 반환한 "원본에 가까운" 문자열에서
 * GS1 Application Identifier(AI)를 분리하고, 그 중 순중량(kg) 계열 AI인
 * 310n (n = 소수점 이하 자릿수)을 찾아 kg 값으로 변환한다.
 *
 * 이 파서는 정솔푸드 전체 시스템용 "완전한 GS1 범용 파서"가 아니라
 * 이번 POC의 목표(FRIBIN 라벨의 3102/3103 중량 값 확인)에 맞춘 축소판이다.
 * 다른 AI(GTIN, 로트번호, 유통기한 등)는 "건너뛰기만" 하고 해석하지 않는다.
 *
 * 참고한 공식 자료(POC 범위에서 실제로 쓰인 규칙만):
 * - GS1 General Specifications (Release 26.0) — AI 길이·구분자 규칙
 *   https://ref.gs1.org/standards/genspecs/
 * - GS1 AI 레퍼런스 테이블 — https://ref.gs1.org/ai/
 * - GS1 UK, 변동중량 상품 바코드 계산법(310n 소수점 규칙 예시)
 *   https://www.gs1uk.org/sites/default/files/How_to_calculate_variable_measure_items_0.pdf
 *
 * 감정 없이 사실만: 정솔푸드가 실제로 취급하는 다른 브랜드 라벨이 이 구조를
 * 따르는지는 이 POC로 확인되지 않는다. 오직 FRIBIN 라벨만 검증 대상이다.
 */

// GS1 Group Separator (필드 구분자), ASCII 29
export const GS_CHAR = String.fromCharCode(29);

// zxing-wasm의 textMode:"Escaped"가 제어문자를 이렇게 표기한다 (README/타입 정의 기준 확인)
const ESCAPED_GS_TOKEN = "<GS>";
const ESCAPED_FNC1_TOKENS = ["<FNC1>", "<GS1>"]; // 라이브러리가 FNC1을 별도 토큰으로 표기하는 경우를 대비 (실측 필요, 가정)

// 고정 길이 AI(2자리 코드) — data 부분의 "자릿수"만 기록 (AI 코드 자체는 제외)
// 이번 POC에서 실제로 쓰는 것은 없지만, "중량 AI가 없는 문자열"(예: GTIN만 있는 라벨)을
// 올바르게 건너뛰고 "중량 없음"으로 판정하기 위해 최소한으로 포함한다.
const FIXED_LENGTH_AI_2 = {
  "00": 18,
  "01": 14,
  "02": 14,
  "11": 6,
  "12": 6,
  "13": 6,
  "15": 6,
  "16": 6,
  "17": 6,
  "20": 2,
};

// GS1의 "3xxn 계측값 계열"(순중량/치수 등, 마지막 자리가 소수점 이하 자릿수) 판정.
// 공식 문서 기준으로 310~337 범위가 이 규칙(코드 4자리 + 데이터 6자리 고정)을 따른다.
// 이번 POC는 그중 310n(순중량, kg)만 실제로 해석하고, 나머지 3xxn은 "계측값이지만
// 중량이 아님"으로 구분해 건너뛴다 — 무게 아닌 값을 중량으로 오인하지 않기 위함이다.
function isMeasureFamilyAiCode(ai4) {
  return /^3[0-3][0-9]\d$/.test(ai4);
}
function isNetWeightKgAiCode(ai4) {
  return /^310\d$/.test(ai4); // 3100~3109, 실제로는 3100~3103 정도가 흔히 쓰임
}

/**
 * 원본 문자열을 정규화한다.
 * - textMode:"Escaped"로 받은 "<GS>" 토큰을 실제 GS(0x1D) 문자로 치환
 * - 심볼로지 식별자(예: "]C1")가 앞에 붙어 있으면 제거
 */
export function normalizeRawInput(raw) {
  if (typeof raw !== "string") return "";
  let s = raw;
  for (const tok of ESCAPED_FNC1_TOKENS) s = s.split(tok).join("");
  s = s.split(ESCAPED_GS_TOKEN).join(GS_CHAR);
  // 심볼로지 식별자: "]" + 코드문자 1개 + 모디파이어 1개 (예: "]C1")
  if (/^\][ -~]{2}/.test(s)) {
    s = s.slice(3);
  }
  return s;
}

/**
 * "(AI)data(AI)data..." 형태(HRI 표기)인지 확인한다.
 * 주의: 이 형태는 사람이 읽기 쉽게 만든 표기이며, 실제 카메라 디코더가 그대로
 * 반환한다는 보장은 없다 — 이번 POC의 화면에는 실제 디코더 원문을 별도로 표시해
 * 이 가정이 맞는지 눈으로 검증할 수 있게 한다.
 */
function looksLikeHri(s) {
  return /^\(\d{2,4}\)/.test(s);
}

/**
 * GS1 엘리먼트 스트링을 AI/데이터 쌍의 배열로 분해한다.
 * 실패하면 ok:false와 사유를 반환한다(예외를 던지지 않음 — 카메라 루프에서
 * 매 프레임 호출되므로 예외로 흐름을 끊지 않기 위함).
 */
export function tokenizeElementString(input) {
  const fields = [];
  let s = input;
  let pos = 0;
  const hri = looksLikeHri(s);

  while (pos < s.length) {
    let ai;
    if (hri) {
      const m = /^\((\d{2,4})\)/.exec(s.slice(pos));
      if (!m) return { ok: false, reason: "HRI_PAREN_MISMATCH", fields };
      ai = m[1];
      pos += m[0].length;
    } else {
      // 괄호가 없는 원문: 4자리 계측값 계열 AI 먼저 시도, 아니면 2자리 AI로 시도
      const cand4 = s.slice(pos, pos + 4);
      if (/^\d{4}$/.test(cand4) && isMeasureFamilyAiCode(cand4)) {
        ai = cand4;
        pos += 4;
      } else {
        const cand2 = s.slice(pos, pos + 2);
        if (/^\d{2}$/.test(cand2)) {
          ai = cand2;
          pos += 2;
        } else {
          return { ok: false, reason: "UNRECOGNIZED_AI", fields };
        }
      }
    }

    // 데이터 길이 결정
    let dataLen;
    if (isMeasureFamilyAiCode(ai)) {
      dataLen = 6; // 계측값 계열은 항상 6자리 고정
    } else if (FIXED_LENGTH_AI_2[ai] != null) {
      dataLen = FIXED_LENGTH_AI_2[ai];
    } else {
      dataLen = null; // 가변 길이 — GS 구분자 또는 문자열 끝까지
    }

    let data;
    if (dataLen != null) {
      data = s.slice(pos, pos + dataLen);
      if (data.length < dataLen) {
        return { ok: false, reason: "INVALID_LENGTH", ai, expectedLen: dataLen, gotLen: data.length, fields };
      }
      pos += dataLen;
      // 고정 길이 필드 뒤에 우연히 GS가 붙어 있으면 관대하게 건너뜀
      if (s[pos] === GS_CHAR) pos += 1;
    } else {
      const gsIdx = s.indexOf(GS_CHAR, pos);
      const parenIdx = hri ? s.indexOf("(", pos) : -1;
      let end = s.length;
      if (gsIdx !== -1) end = Math.min(end, gsIdx);
      if (parenIdx !== -1) end = Math.min(end, parenIdx);
      data = s.slice(pos, end);
      pos = end;
      if (s[pos] === GS_CHAR) pos += 1;
    }

    fields.push({ ai, data });
  }

  return { ok: true, fields };
}

/**
 * 메인 함수: 원본 바코드 문자열 → { ok, weightKg, ... }
 */
export function parseNetWeightKg(rawInput) {
  const normalized = normalizeRawInput(rawInput);
  const tok = tokenizeElementString(normalized);

  const base = {
    rawInput,
    normalizedInput: normalized,
    hasGsSeparator: normalized.includes(GS_CHAR),
    fields: tok.fields || [],
  };

  if (!tok.ok) {
    return { ...base, ok: false, reason: tok.reason, weightAi: null, weightKg: null };
  }

  const weightField = tok.fields.find((f) => isNetWeightKgAiCode(f.ai));
  if (!weightField) {
    return { ...base, ok: false, reason: "NO_WEIGHT_AI", weightAi: null, weightKg: null };
  }

  if (!/^\d{6}$/.test(weightField.data)) {
    return {
      ...base,
      ok: false,
      reason: "INVALID_DIGITS",
      weightAi: weightField.ai,
      rawWeightDigits: weightField.data,
      weightKg: null,
    };
  }

  const decimals = Number(weightField.ai[3]); // 310n 의 n
  const intValue = Number(weightField.data);
  const value = intValue / Math.pow(10, decimals);

  return {
    ...base,
    ok: true,
    weightAi: weightField.ai,
    rawWeightDigits: weightField.data,
    decimals,
    weightKg: value,
    weightKgText: `${value.toFixed(decimals)}kg`,
  };
}

// Node.js(테스트)와 브라우저(ESM import) 양쪽에서 쓸 수 있도록 default export도 제공
export default { parseNetWeightKg, tokenizeElementString, normalizeRawInput, GS_CHAR };
