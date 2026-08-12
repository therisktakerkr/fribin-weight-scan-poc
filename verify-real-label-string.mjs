import { parseNetWeightKg } from "./gs1-parser.js";

// 대표님이 알려주신 실제 FRIBIN 라벨 값으로, zxing-wasm writer/reader를 왕복시켜 얻은
// "실제 디코더 반환값"이다(추측이 아님. gen_real_label.mjs 실행 로그 참고).
//   원래 라벨 표기(HRI): (01)98420945631698(15)271215(3102)001420(10)51215293
//   실제 디코더 반환값 : 01984209456316981527121531020014201051215293  (구분자 전혀 없음)
// 구분자가 하나도 없는 이유: AI 01(고정14)·15(고정6)·3102(고정6)는 원래 구분자가 필요 없고,
// 마지막 AI 10(가변길이, 로트번호)은 "문자열의 맨 끝"이라 GS1 규칙상 구분자가 필요 없다.
const realBottomBarcodeText = "01984209456316981527121531020014201051215293";
const r = parseNetWeightKg(realBottomBarcodeText);
console.log("입력(실제 GS1-128 디코더 반환값):", realBottomBarcodeText);
console.log("결과:", JSON.stringify(r, null, 2));
console.log("");
console.log(r.ok && r.weightKgText === "14.20kg" ? "[PASS] 14.20kg 정확히 산출됨" : "[FAIL] 기대값과 다름");

// 위쪽 일반 Code128("25789003")도 흘려보내 NO_WEIGHT_AI로 안전하게 분류되는지 확인
const topText = "25789003";
const rTop = parseNetWeightKg(topText);
console.log("\n입력(위쪽 일반 Code128):", topText);
console.log("결과:", JSON.stringify(rTop, null, 2));
console.log(!rTop.ok && rTop.reason === "NO_WEIGHT_AI" ? "[PASS] NO_WEIGHT_AI로 정확히 분류됨(참고 로그 대상)" : "[FAIL] 기대와 다름");
