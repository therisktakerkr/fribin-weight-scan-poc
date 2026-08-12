import { extractNetWeightFromOcrText } from "./ocr-weight-parser.js";

const cases = [
  { name: "요청하신 실제 라벨 문구 (콤마 소수점)", input: "Net weight: 14,20 Kg", expectOk: true, expectText: "14.20kg" },
  { name: "마침표 소수점 + 대문자", input: "NET WEIGHT: 14.20 KG", expectOk: true, expectText: "14.20kg" },
  { name: "줄바꿈/여백이 섞인 OCR 특유의 지저분한 출력", input: "FRIBIN\nNet   weight:\n14,20\nKg\nLOT 51215293", expectOk: true, expectText: "14.20kg" },
  { name: "약어 표기 N.W.", input: "N.W. 14,20Kg", expectOk: true, expectText: "14.20kg" },
  { name: "중량 문구 자체가 없는 경우 → 매칭 실패", input: "FRIBIN GTIN 98420945631698", expectOk: false, expectReason: "NO_MATCH" },
  { name: "빈 문자열(OCR이 아무것도 못 읽음) → 실패", input: "", expectOk: false, expectReason: "EMPTY_TEXT" },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const r = extractNetWeightFromOcrText(c.input);
  const ok = c.expectOk ? (r.ok && r.weightKgText === c.expectText) : (!r.ok && r.reason === c.expectReason);
  pass += ok ? 1 : 0;
  fail += ok ? 0 : 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${c.name}`);
  console.log(`  입력: ${JSON.stringify(c.input)}`);
  console.log(`  결과: ${JSON.stringify(r)}`);
  console.log("");
}
console.log(`결과 요약: ${pass}건 통과 / ${fail}건 실패 (총 ${cases.length}건)`);
process.exit(fail === 0 ? 0 : 1);
