import { extractSingleValueFromPassText, combineOcrPasses, findFallbackNumericCandidatesForDevLogOnly } from "./ocr-weight-parser.js";

let pass = 0, fail = 0;
function check(name, ok, detail) {
  pass += ok ? 1 : 0;
  fail += ok ? 0 : 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  if (detail) console.log(`  ${detail}`);
}

console.log("=== 1. extractSingleValueFromPassText (패스 1개 단위 추출) ===\n");

{
  const r = extractSingleValueFromPassText("9.4kg");
  check("단순 '9.4kg' → 9.4", r.value === 9.4, JSON.stringify(r));
}
{
  const r = extractSingleValueFromPassText("중량 9.4 kg");
  check("'중량 9.4 kg' → 9.4 (문맥 단어는 무시하고 숫자만)", r.value === 9.4, JSON.stringify(r));
}
{
  const r = extractSingleValueFromPassText("제품중량 24.7 Kg");
  check("'제품중량 24.7 Kg' → 24.7", r.value === 24.7, JSON.stringify(r));
}
{
  const r = extractSingleValueFromPassText("중량 9,4 kg");
  check("쉼표 소수점 '9,4kg' → 9.4 (요청사항 8: 쉼표→소수점 정규화)", r.value === 9.4, JSON.stringify(r));
}
{
  const r = extractSingleValueFromPassText("19.4kg");
  check("'19.4kg' 단독 → 19.4 (한 패스만으로는 오독 여부를 알 수 없음, 그대로 반환하는 게 정상)", r.value === 19.4, JSON.stringify(r));
}
{
  const r = extractSingleValueFromPassText("1.15-1.50kg");
  check("범위 표현 '1.15-1.50kg' → null(포기)", r.value === null && r.reason === "RANGE_LIKE", JSON.stringify(r));
}
{
  const r = extractSingleValueFromPassText("2026.04.09 24.7");
  check("날짜+숫자가 섞이면 서로 다른 두 숫자로 보고 포기(AMBIGUOUS)", r.value === null && r.reason === "AMBIGUOUS_MULTIPLE_NUMBERS", JSON.stringify(r));
}
{
  const r = extractSingleValueFromPassText("");
  check("빈 문자열 → null", r.value === null, JSON.stringify(r));
}
{
  const r = extractSingleValueFromPassText("150.0kg");
  check("100kg 초과 → null(범위 밖)", r.value === null, JSON.stringify(r));
}
{
  // 실제 사진2 테스트에서 반복 관찰된 실패 패턴: OCR이 소수점을 완전히 놓쳐 "24.7kg"이
  // "247kg"으로 나옴 — kg 단위 바로 앞 숫자에서 마지막 자리 앞에 점을 넣어보는 보조 규칙
  const r = extractSingleValueFromPassText("247 Kg");
  check(
    "소수점 누락 보조 규칙: '247 Kg' → 24.7 (kg 단위 앞 숫자에서 소수점 유추, reason=OK_INFERRED_MISSING_DECIMAL)",
    r.value === 24.7 && r.reason === "OK_INFERRED_MISSING_DECIMAL",
    JSON.stringify(r)
  );
}
{
  // 이 보조 규칙은 kg 단위와 붙어있지 않은 숫자에는 적용하지 않는다(과도한 추측 방지)
  const r = extractSingleValueFromPassText("이력번호 126040870");
  check("kg 단위 없는 긴 숫자는 소수점 유추 대상이 아님 → null", r.value === null, JSON.stringify(r));
}
{
  // 실제 사진2 테스트에서 "Kg"가 "Ka"로 오인식된 사례 — g/a 글자 혼동까지만 관대하게 허용
  const r = extractSingleValueFromPassText("247 Ka");
  check(
    "'Kg'가 'Ka'로 오인식되어도 소수점 유추 규칙이 동작함 → 24.7",
    r.value === 24.7 && r.reason === "OK_INFERRED_MISSING_DECIMAL",
    JSON.stringify(r)
  );
}
{
  // 소수점이 이미 정상적으로 있으면 이 보조 규칙은 개입하지 않는다(우선순위: 정상 매칭 우선)
  const r = extractSingleValueFromPassText("9.4 kg");
  check("정상 소수점이 있으면 보조 규칙 미적용, reason=OK", r.value === 9.4 && r.reason === "OK", JSON.stringify(r));
}

console.log("\n=== 2. combineOcrPasses (여러 패스 합의 로직, 요청사항 10~12) ===\n");

{
  const r = combineOcrPasses([
    { passName: "원본", text: "9.4kg" },
    { passName: "그레이스케일", text: "9.4kg" },
    { passName: "대비강화", text: "19.4kg" },
    { passName: "이진화", text: "" },
    { passName: "숫자전용", text: "9.4kg" },
  ]);
  check(
    "3표(9.4) vs 1표(19.4) → 9.4가 권장, 19.4는 후보로만 표시(권장 아님)",
    r.recommended && r.recommended.weightKg === 9.4 &&
      r.candidates.find((c) => c.weightKg === 19.4 && !c.recommended),
    JSON.stringify(r.candidates)
  );
}
{
  // 요청사항의 핵심 우려사항: "19.4"가 권장으로 뜨면 절대 안 됨
  const r = combineOcrPasses([
    { passName: "원본", text: "19.4kg" },
    { passName: "그레이스케일", text: "9.4kg" },
    { passName: "대비강화", text: "9.4kg" },
    { passName: "이진화", text: "9.4kg" },
  ]);
  const wrongIsRecommended = r.recommended && r.recommended.weightKg === 19.4;
  check("정답(9.4)이 다수일 때 오답(19.4)이 권장으로 뜨지 않음", !wrongIsRecommended && r.recommended.weightKg === 9.4);
}
{
  // 동점 상황(2 vs 2) — 아무것도 권장하지 않고 불확실 처리
  const r = combineOcrPasses([
    { passName: "원본", text: "9.4kg" },
    { passName: "그레이스케일", text: "9.4kg" },
    { passName: "대비강화", text: "19.4kg" },
    { passName: "이진화", text: "19.4kg" },
  ]);
  check(
    "2표 vs 2표 동점 → 권장 없음, '불확실' 상태",
    r.recommended === null && r.uncertain === true && r.candidates.length === 2
  );
}
{
  // 단 1개 패스만 값을 찾은 경우 — 권장 아님(2표 미만)
  const r = combineOcrPasses([
    { passName: "원본", text: "9.4kg" },
    { passName: "그레이스케일", text: "" },
    { passName: "대비강화", text: "" },
    { passName: "이진화", text: "" },
  ]);
  check("1표뿐이면 권장하지 않음(최소 2표 필요, 요청사항 11)", r.recommended === null && r.uncertain === true && r.candidates.length === 1);
}
{
  // 전원 일치
  const r = combineOcrPasses([
    { passName: "원본", text: "24.7kg" },
    { passName: "그레이스케일", text: "24.7kg" },
    { passName: "대비강화", text: "24.7kg" },
    { passName: "이진화", text: "24.7kg" },
    { passName: "숫자전용", text: "24.7kg" },
  ]);
  check("5개 패스 전원 일치(24.7) → 권장, 5표", r.recommended && r.recommended.weightKg === 24.7 && r.candidates[0].votes === 5);
}
{
  // 아무 패스도 숫자를 못 찾음
  const r = combineOcrPasses([
    { passName: "원본", text: "" },
    { passName: "그레이스케일", text: "..." },
  ]);
  check("전부 실패 → 후보 0개, uncertain=false(후보 자체가 없는 상태)", r.candidates.length === 0 && r.uncertain === false);
}
{
  // 긴 이력번호(소수점 없는 정수)는 정규식 모양 자체가 달라 애초에 후보에 안 잡힌다 —
  // 그래서 이 패스도 "24.7" 하나만 정상적으로 찾아내야 한다(오탐 없음).
  const r = combineOcrPasses([
    { passName: "원본", text: "이력번호 12604087053150 중량 24.7" },
    { passName: "그레이스케일", text: "24.7kg" },
  ]);
  check(
    "긴 이력번호(소수점 없음)는 애초에 숫자 후보 모양이 아니라서 무시되고, '24.7'만 정상 검출",
    r.passDetails[0].value === 24.7 && r.passDetails[1].value === 24.7 && r.recommended.weightKg === 24.7
  );
}

console.log("\n=== 3. 개발자 로그 전용 화면 전체 안전망 (요청사항: 사용자 후보로 노출 금지) ===\n");
{
  const words = [{ text: "24.7" }, { text: "2026" }, { text: "9.4" }];
  const r = findFallbackNumericCandidatesForDevLogOnly(words);
  check(
    "화면 전체 단어에서 소수점 있는 값만 뽑아 dev 로그용으로 반환(24.7, 9.4) — 이 함수의 반환값은 app.js에서 후보 UI로 넘기지 않고 콘솔/개발자패널에만 출력해야 함",
    r.length === 2 && r.some((c) => c.weightKg === 24.7) && r.some((c) => c.weightKg === 9.4)
  );
}

console.log(`\n결과 요약: ${pass}건 통과 / ${fail}건 실패 (총 ${pass + fail}건)`);
process.exit(fail === 0 ? 0 : 1);
