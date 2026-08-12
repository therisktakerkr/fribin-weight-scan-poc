/**
 * ocr-weight-parser.js (V6 — "중량 영역 전용" OCR, 여러 전처리 결과의 합의로만 권장)
 *
 * V4/V5까지는 화면(또는 큰 영역)에서 "중량/총중량/포장중량" 등 문맥을 스스로 구분해
 * 골라내려 했지만, 실제 사진 테스트에서 오인식(9.4→19.4) 위험이 있었다. 이번 버전은
 * 접근을 단순화한다 — 직원이 카메라의 작은 사각형을 라벨의 "중량 X kg" 행에 직접
 * 맞추므로, 이 모듈은 더 이상 "이게 순중량인지 총중량인지" 문맥을 판단하지 않는다.
 * 대신 그 좁은 영역을 여러 방식(원본/그레이스케일/대비강화/이진화/숫자전용)으로 각각
 * OCR한 뒤, 서로 다른 방식들이 "같은 숫자"에 동의하는지만 확인한다 — 최소 2개 이상의
 * 서로 다른 전처리 결과가 일치해야만 "권장 후보"로 표시한다(요청사항 10, 11).
 *
 * 중요: 이 모듈은 절대 스스로 값을 확정하지 않는다. app.js가 후보를 화면에 보여주고,
 * 직원이 실제 라벨과 비교해 "이 중량으로 확정"을 눌러야 반영된다.
 */

const MIN_WEIGHT_KG = 0; // "0보다 크고"
const MAX_WEIGHT_KG = 100; // "100kg 이하"

// 라벨이 실수로 다른 행(총중량 등)에 걸렸을 때 최소한의 경고를 주기 위한 참고용 키워드.
// 이번 버전에서는 "판단"에 쓰지 않고, 화면 안내(사각형을 옮겨보라는 힌트)에만 참고로 쓴다.
export const EXCLUDE_HINT_KEYWORDS = [
  "gross weight", "gross wt", "총중량", "총 중량",
  "tare weight", "tare wt", "포장중량", "포장 중량", "용기중량", "용기 중량", "규격",
];

/**
 * 하나의 OCR 패스(원문 텍스트 1개)에서 "이 좁은 영역에 있는 숫자는 이것 하나다"라고
 * 확신할 수 있을 때만 값을 반환한다. 범위 표현이거나, 서로 다른 숫자가 여러 개
 * 뒤섞여 있어 어떤 게 맞는지 이 패스 혼자서는 판단할 수 없으면 null을 반환한다
 * (억지로 하나를 고르지 않는다 — 그게 바로 9.4→19.4 같은 오독을 만드는 원인이었다).
 *
 * @param {string} rawText
 * @returns {{ value: number|null, valueText: string|null, reason: string }}
 */
export function extractSingleValueFromPassText(rawText) {
  const text = (rawText || "").replace(/\s+/g, " ").trim();
  if (!text) return { value: null, valueText: null, reason: "EMPTY" };

  // 범위 표현("1.15-1.50kg")이 있으면 이 패스는 포기한다 — 좁은 영역에 범위가
  // 나올 리 없으므로, 나온다면 그 자체가 다른 행까지 함께 잡혔다는 신호다.
  if (/\d\s*[-–~]\s*\d.{0,6}kg/i.test(text)) {
    return { value: null, valueText: null, reason: "RANGE_LIKE" };
  }

  // 소수점 있는 숫자를 전부 찾는다(쉼표/마침표 모두 허용 — 요청사항 8: 쉼표는 소수점으로 정규화).
  const re = /(\d{1,3})[.,](\d{1,2})/g;
  const found = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const value = Number(`${m[1]}.${m[2]}`);
    if (value > MIN_WEIGHT_KG && value <= MAX_WEIGHT_KG) {
      found.push({ value, decimals: m[2].length, text: m[0] });
    }
  }

  if (found.length === 0) {
    // 보조 규칙(실측 기반): OCR이 소수점 자체를 놓쳐 "24.7kg"이 "247kg"처럼 붙어버리는
    // 경우가 실제 라벨 테스트에서 반복 관찰됐다(전처리와 무관하게 특정 폰트에서 마침표가
    // 사라짐). 이 좁은 사각형 안에는 중량 숫자 외의 다른 숫자가 있을 수 없으므로, kg/Kg/KG
    // 단위 바로 앞에 붙은 2~3자리 정수만 대상으로 "마지막 자리 앞에 소수점이 빠졌다"고
    // 해석해보고, 그 결과가 0~100kg 범위에 들어올 때만 후보로 인정한다(다른 자리에 점을
    // 넣어보는 등의 임의 추측은 하지 않음 — 단 하나의 정해진 해석만 시도). 단위의 "g"는
    // 실측에서 OCR이 a/q/9 등으로 자주 오인식했으므로(글자 모양이 비슷함) 그 오인식까지만
    // 관대하게 허용한다 — 특정 브랜드·라벨 문구를 하드코딩하는 것이 아니라 일반적인 글자
    // 형태 혼동에 대한 보정이다.
    const noDecimalRe = /(\d{2,3})\s*[kK][gGaqQ9]s?\b/g;
    const inferred = [];
    let nm;
    while ((nm = noDecimalRe.exec(text)) !== null) {
      const digits = nm[1];
      const withDot = `${digits.slice(0, -1)}.${digits.slice(-1)}`;
      const value = Number(withDot);
      if (value > MIN_WEIGHT_KG && value <= MAX_WEIGHT_KG) {
        inferred.push({ value, decimals: 1, text: nm[0] });
      }
    }
    const distinctInferred = [...new Set(inferred.map((f) => f.value.toFixed(2)))];
    if (distinctInferred.length === 1) {
      const best = inferred[0];
      return {
        value: best.value,
        valueText: `${best.value.toFixed(1)}kg`,
        reason: "OK_INFERRED_MISSING_DECIMAL",
      };
    }
    return { value: null, valueText: null, reason: "NO_NUMBER" };
  }

  // 서로 다른 값이 여러 개 검출되면(예: 잡음으로 두 개의 다른 숫자가 나옴), 이 패스
  // 혼자서는 뭐가 맞는지 알 수 없으므로 포기한다 — 임의로 첫 번째 것을 고르지 않는다.
  const distinctValues = [...new Set(found.map((f) => f.value.toFixed(2)))];
  if (distinctValues.length > 1) {
    return { value: null, valueText: null, reason: "AMBIGUOUS_MULTIPLE_NUMBERS" };
  }

  const best = found[0];
  return { value: best.value, valueText: `${best.value.toFixed(Math.max(best.decimals, 1))}kg`, reason: "OK" };
}

/**
 * 여러 OCR 패스(전처리 원본/그레이스케일/대비강화/이진화/숫자전용 등)의 결과를 모아
 * "서로 다른 패스 중 최소 2개가 같은 값일 때만" 권장 후보로 표시한다(요청사항 11).
 *
 * @param {Array<{passName: string, text: string}>} passResults
 * @returns {{
 *   recommended: {weightKg:number, weightKgText:string}|null,
 *   candidates: Array<{weightKg:number, weightKgText:string, votes:number, passNames:string[], recommended:boolean}>,
 *   uncertain: boolean,
 *   passDetails: Array<{passName:string, text:string, value:number|null, reason:string}>
 * }}
 */
export function combineOcrPasses(passResults) {
  const passDetails = (passResults || []).map((p) => {
    const r = extractSingleValueFromPassText(p.text);
    return { passName: p.passName, text: p.text, value: r.value, valueText: r.valueText, reason: r.reason };
  });

  const byValue = new Map();
  for (const d of passDetails) {
    if (d.value == null) continue;
    const key = d.value.toFixed(2);
    if (!byValue.has(key)) byValue.set(key, { weightKg: d.value, weightKgText: d.valueText, votes: 0, passNames: [] });
    const entry = byValue.get(key);
    entry.votes += 1;
    entry.passNames.push(d.passName);
  }

  const groups = Array.from(byValue.values()).sort((a, b) => b.votes - a.votes);
  const topVotes = groups.length > 0 ? groups[0].votes : 0;
  // 요청사항 11: 최소 2개 이상의 "서로 다른" 패스가 일치해야만 권장. 동점(예: 2표짜리가
  // 두 개, 서로 다른 값)이면 무엇도 권장하지 않는다 — 안전한 쪽으로 결정을 미룬다.
  const topGroups = groups.filter((g) => g.votes === topVotes);
  const recommendedGroup = topVotes >= 2 && topGroups.length === 1 ? topGroups[0] : null;

  const candidates = groups.map((g) => ({
    weightKg: g.weightKg,
    weightKgText: g.weightKgText,
    votes: g.votes,
    passNames: g.passNames,
    recommended: recommendedGroup ? g.weightKg === recommendedGroup.weightKg : false,
  }));

  return {
    recommended: recommendedGroup ? { weightKg: recommendedGroup.weightKg, weightKgText: recommendedGroup.weightKgText } : null,
    candidates,
    uncertain: candidates.length > 0 && !recommendedGroup,
    passDetails,
  };
}

// ── 개발자 로그 전용(요청사항: 화면 전체에서 임의의 소수를 찾는 안전망은 사용자 후보로
// 보여주지 않는다 — 개발자 정보 패널/콘솔 로그로만 남긴다). V5의 "화면 전체 안전망"을
// 그대로 유지하되, presentCandidates()로는 절대 넘기지 않고 devOcrFallbackLog 로만 쓴다.
const DECIMAL_WORD_RE = /^(\d{1,3})[.,](\d{1,2})$/;
export function findFallbackNumericCandidatesForDevLogOnly(words) {
  const out = [];
  if (!Array.isArray(words)) return out;
  const seen = new Set();
  for (const w of words) {
    const m = DECIMAL_WORD_RE.exec((w.text || "").trim());
    if (!m) continue;
    const value = Number(`${m[1]}.${m[2]}`);
    if (!(value > MIN_WEIGHT_KG && value <= MAX_WEIGHT_KG)) continue;
    const key = value.toFixed(2);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ weightKg: value, weightKgText: `${value.toFixed(m[2].length)}kg`, matchedText: w.text });
  }
  return out;
}

export default {
  extractSingleValueFromPassText,
  combineOcrPasses,
  findFallbackNumericCandidatesForDevLogOnly,
  EXCLUDE_HINT_KEYWORDS,
};
