/**
 * ocr-weight-parser.js
 *
 * GS1-128 바코드 인식이 계속 실패할 때를 대비한 보조 수단.
 * 라벨에 인쇄된 "Net weight: 14,20 Kg" 같은 문구를 OCR로 읽은 뒤,
 * 그 텍스트에서 중량 숫자만 뽑아낸다.
 *
 * 중요: 이 결과는 절대 자동으로 저장/확정되지 않는다. app.js 쪽에서 이 함수의
 * 결과를 "후보값"으로만 화면에 보여주고, 직원이 확인 버튼을 눌러야 최종 확정된다.
 */

// 유럽식(콤마) 표기 "14,20"와 한국/영어식(마침표) 표기 "14.20"를 모두 허용.
// "Net weight", "Net Wt", "NET WT", "N.W." 등 표기 변형도 느슨하게 허용.
const NET_WEIGHT_PATTERNS = [
  /net\s*w(?:eigh)?t\.?\s*[:\-]?\s*(\d{1,3})[.,](\d{1,3})\s*kg/i,
  /n\.?\s*w\.?\s*[:\-]?\s*(\d{1,3})[.,](\d{1,3})\s*kg/i,
];

export function extractNetWeightFromOcrText(rawText) {
  const text = (rawText || "").replace(/\s+/g, " ").trim();
  for (const re of NET_WEIGHT_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const intPart = m[1];
      const fracPart = m[2];
      const weightKg = Number(`${intPart}.${fracPart}`);
      if (!Number.isFinite(weightKg)) continue;
      return {
        ok: true,
        weightKg,
        weightKgText: `${weightKg.toFixed(fracPart.length)}kg`,
        matchedText: m[0],
        rawText: text,
      };
    }
  }
  return { ok: false, reason: text ? "NO_MATCH" : "EMPTY_TEXT", rawText: text };
}

export default { extractNetWeightFromOcrText };
