import { parseNetWeightKg } from "./gs1-parser.js";

const GS = String.fromCharCode(29);

// 아래 세 문자열은 추측이 아니라, zxing-wasm writer로 실제 GS1-128 바코드를 생성한 뒤
// zxing-wasm reader로 다시 디코딩해서 "실제로 반환된" text 값을 그대로 옮긴 것이다.
// (생성/디코딩 로그: gentest.mjs, gentest2.mjs 참고, 이 저장소 밖 임시 검증 스크립트)
const realDecoderOutputs = [
  { label: "중량 단독 (실제 리더 출력)", raw: "3102001420" },
  { label: "GTIN+중량, 둘 다 고정길이 (실제 리더 출력)", raw: "01000123456789053102001420" },
  { label: "로트+중량, 가변+고정 (실제 리더 출력, 진짜 GS 문자 포함)", raw: "10LOT01" + GS + "3102001420" },
];

for (const { label, raw } of realDecoderOutputs) {
  const r = parseNetWeightKg(raw);
  console.log(`${label}\n  입력(raw): ${JSON.stringify(raw)}\n  결과: ${r.ok ? r.weightKgText : "FAIL: " + r.reason}\n`);
}
