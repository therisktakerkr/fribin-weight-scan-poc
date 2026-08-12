/**
 * gs1-parser.test.js
 *
 * 카메라 테스트 전 "파서 사전검증" — 대표님이 지정하신 6개 케이스를 그대로 확인한다.
 * 실행: node gs1-parser.test.js
 *
 * 주의: 괄호가 있는 입력, 예) "(3102)001420" 은 사람이 읽는 HRI 표기이며,
 * 실제 카메라 디코더가 반환하는 원문과 다를 수 있다는 점을 이 파일도 그대로 구분해서 표시한다.
 * (실제 디코더 원문은 app.js 를 통한 실기 스캔에서만 확인 가능 — 이 테스트는 파싱 로직 자체의
 * 정확성만 검증하는 것이며, "카메라가 실제로 이 문자열을 반환한다"는 것을 증명하지 않는다.)
 */
import { parseNetWeightKg } from "./gs1-parser.js";

const cases = [
  {
    name: "1) (3102)001420 → 14.20kg  [HRI 표기 입력]",
    input: "(3102)001420",
    expectOk: true,
    expectText: "14.20kg",
  },
  {
    name: "2) 3102001420 → 14.20kg  [괄호 없는 연속 원문 입력]",
    input: "3102001420",
    expectOk: true,
    expectText: "14.20kg",
  },
  {
    name: "3) (3103)014200 → 14.200kg  [HRI 표기 입력]",
    input: "(3103)014200",
    expectOk: true,
    expectText: "14.200kg",
  },
  {
    name: "4) 3103001420 → 1.420kg  [괄호 없는 연속 원문 입력]",
    input: "3103001420",
    expectOk: true,
    expectText: "1.420kg",
  },
  {
    name: "5) 중량 AI 없는 문자열(GTIN만 있음) → 중량 없음",
    input: "(01)00012345678905",
    expectOk: false,
    expectReason: "NO_WEIGHT_AI",
  },
  {
    name: "6) 숫자 길이가 잘못된 문자열(6자리가 아닌 4자리) → 파싱 실패",
    input: "(3102)0014",
    expectOk: false,
    expectReason: "INVALID_LENGTH",
  },
  // 아래는 요구된 6개 케이스에 더한 추가 안전장치 확인용 케이스(참고용)
  {
    name: "7) [추가] 숫자가 아닌 문자가 섞인 경우 → 파싱 실패",
    input: "(3102)00X420",
    expectOk: false,
    expectReason: "INVALID_DIGITS",
    note: "6자리는 채워지지만 숫자가 아닌 문자가 섞여 있어 자릿수 검증에서 거부됨",
  },
  {
    name: "8) [추가] GTIN(01) 뒤에 중량(3102)이 이어지는 복합 문자열, 괄호 없음",
    input: "0100012345678905" + "3102001420",
    expectOk: true,
    expectText: "14.20kg",
    note: "AI 01은 고정 14자리이므로 정확히 건너뛰고 이어지는 3102를 인식해야 함",
  },
  {
    name: "9) [추가] 가변길이 AI(10, 로트번호) 뒤에 GS 구분자로 중량(3102)이 이어지는 원문(괄호 없는 실제 디코더 형태를 가정)",
    input: "10LOT01" + String.fromCharCode(29) + "3102001420",
    expectOk: true,
    expectText: "14.20kg",
    note: "실제 카메라 디코더는 괄호(HRI)가 아니라 이런 GS(0x1D) 구분자 형태로 반환할 가능성이 높음 — 이번 최초 시도에서는 파서가 '전체가 HRI 괄호형이거나 전체가 원문형'이라고 가정해 혼합 케이스를 놓치는 버그를 발견해 수정했다",
  },
];

let pass = 0;
let fail = 0;
const lines = [];

for (const c of cases) {
  const result = parseNetWeightKg(c.input);
  let ok;
  if (c.expectOk) {
    ok = result.ok === true && result.weightKgText === c.expectText;
  } else {
    ok = result.ok === false && (!c.expectReason || result.reason === c.expectReason);
  }
  pass += ok ? 1 : 0;
  fail += ok ? 0 : 1;
  const line =
    `[${ok ? "PASS" : "FAIL"}] ${c.name}\n` +
    `    입력: ${JSON.stringify(c.input)}\n` +
    `    결과: ok=${result.ok} ` +
    (result.ok
      ? `weightKgText=${result.weightKgText} (AI=${result.weightAi}, decimals=${result.decimals})`
      : `reason=${result.reason}`) +
    (c.note ? `\n    참고: ${c.note}` : "");
  lines.push(line);
  console.log(line);
  console.log("");
}

const summary = `\n결과 요약: ${pass}건 통과 / ${fail}건 실패 (총 ${cases.length}건)`;
console.log(summary);
lines.push(summary);

// 결과를 파일로도 저장 (보고서 제출용 원본 로그)
import { writeFileSync } from "node:fs";
writeFileSync(
  new URL("./parser-selftest-result.txt", import.meta.url),
  lines.join("\n") + "\n",
  "utf-8"
);

process.exit(fail === 0 ? 0 : 1);
