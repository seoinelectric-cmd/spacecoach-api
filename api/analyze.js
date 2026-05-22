export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  // CORS 헤더
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { imageBase64, mediaType, spaceType } = req.body;

    if (!imageBase64 || !mediaType) {
      return res.status(400).json({ error: "이미지 데이터가 없습니다." });
    }

    if ((imageBase64.length * 3) / 4 > 5 * 1024 * 1024) {
      return res.status(413).json({ error: "이미지 크기가 5MB를 초과합니다." });
    }

    // Claude Vision 호출
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1200,
        system: buildSystemPrompt(spaceType),
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
            { type: "text", text: "analyze this room. purpose: " + (spaceType || "general") }
          ]
        }]
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json().catch(() => ({}));
      console.error("Claude API error:", claudeRes.status, JSON.stringify(err));
      return res.status(502).json({ error: err.error?.message || "AI 분석 오류", status: claudeRes.status, detail: err });
    }

    const claudeData = await claudeRes.json();
    const text = claudeData.content.filter(b => b.type === "text").map(b => b.text).join("");
    const clean = text.replace(/```json|```/g, "").trim();
    const vars = JSON.parse(clean);

    // 점수 계산
    const scores = calcScores(vars);
    const mbti = calcMBTI(vars);

    // 결과 빌드
    const purposeScore = scores[spaceType] ?? scores["공부"];
    const result = buildResult(vars, scores, mbti, spaceType, purposeScore);

    return res.status(200).json({ ok: true, result });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "서버 오류가 발생했습니다.", detail: err.message });
  }
}

function buildSystemPrompt(spaceType) {
  return `당신은 인테리어 공간 분석 전문가입니다.
사진을 보고 아래 17개 변수를 판단하여 반드시 순수 JSON만 출력하세요 (백틱·설명 없이).

변수 설명:
- desk: 책상 존재 (0=없음, 1=있음)
- chair: 작업용 의자 존재 (0=없음, 1=있음)
- monitor: 모니터/노트북 존재 (0=없음, 1=있음)
- bed_visible: 책상/주 시야에 침대 노출 (0=안보임, 1=보임)
- storage: 수납 구조 존재 (0=없음, 1=있음)
- door_visible: 앉은 자리에서 문이 보임 (0=안보임, 1=보임)
- door_behind: 앉은 자리에서 문을 등짐 (0=아님, 1=맞음)
- window_front: 창문이 정면에 위치 (0=아님, 1=맞음)
- window_side: 창문이 측면에 위치 (0=아님, 1=맞음)
- brightness: 전체 밝기 (0=어두움, 1=보통, 2=밝음)
- task_light: 작업등/스탠드 존재 (0=없음, 1=있음)
- color_temp: 색온도 (0=따뜻함, 1=중립, 2=차가움)
- clutter: 정리 상태 (0=어수선, 1=보통, 2=정돈)
- layout_order: 가구 정렬감 (0=자유로움, 1=보통, 2=정렬됨)
- shadow_on_desk: 작업면 그림자 발생 (0=없음, 1=있음)
- annotations: 사진 위 표시할 영역 (최대 3개)

annotations 작성 규칙 (매우 중요):
- type은 반드시 "rect" 사용
- 해당 물체(침대, 책상, 창문 등)를 정확히 감싸는 박스 좌표
- x, y: 물체의 좌상단 모서리 위치 (이미지 가로/세로 대비 %, 0~100)
- w: 물체의 가로 너비 (이미지 가로 대비 %)
- h: 물체의 세로 높이 (이미지 세로 대비 %)
- 예시: 침대가 이미지 왼쪽 중앙에 있고 가로 40%, 세로 35% 크기라면
  → {"type":"rect", "x":5, "y":30, "w":40, "h":35, "color":"warn", "label":"침대 시야 차단 필요"}
- 물체의 실제 위치와 크기를 정확히 측정해서 입력

출력 형식 (이것만 출력):
{
  "desk": 1,
  "chair": 1,
  "monitor": 0,
  "bed_visible": 1,
  "storage": 1,
  "door_visible": 1,
  "door_behind": 0,
  "window_front": 0,
  "window_side": 1,
  "brightness": 2,
  "task_light": 1,
  "color_temp": 1,
  "clutter": 2,
  "layout_order": 2,
  "shadow_on_desk": 0,
  "annotations": [
    {"type":"rect", "x":5, "y":25, "w":45, "h":50, "color":"warn", "label":"침대 시야 차단 필요"},
    {"type":"rect", "x":70, "y":10, "w":25, "h":30, "color":"ok", "label":"측면 자연광 우수"}
  ]
}`;
}

function calcScores(v) {
  const raw = { 공부: 0, 업무: 0, 휴식: 0, 창의: 0 };

  if (v.desk)          { raw.공부+=10; raw.업무+=8; }
  if (v.clutter===2)   { raw.공부+=5;  raw.업무+=5;  raw.휴식+=3; }
  if (v.bed_visible)   { raw.공부-=8;  raw.업무-=6;  raw.휴식+=10; }
  if (v.window_front)  { raw.공부-=3; }
  if (v.shadow_on_desk){ raw.공부-=5;  raw.업무-=5; }

  if (v.brightness===2){ raw.공부+=10; raw.업무+=8; }
  if (v.brightness===1){ raw.공부+=5;  raw.업무+=4;  raw.휴식+=2;  raw.창의+=2; }
  if (v.brightness===0){ raw.휴식+=5; }
  if (v.task_light)    { raw.공부+=8;  raw.업무+=10; raw.창의+=3; }
  if (v.color_temp===2){ raw.공부+=5;  raw.업무+=5; }
  if (v.color_temp===1){ raw.업무+=5;  raw.휴식+=5;  raw.창의+=3; }
  if (v.color_temp===0){ raw.공부-=2;  raw.휴식+=10; raw.창의+=2; }

  if (v.door_visible)  { raw.공부+=3;  raw.업무+=2; }
  if (v.door_behind)   { raw.공부-=3; }
  if (v.window_side)   { raw.공부+=3;  raw.업무+=3;  raw.휴식+=5;  raw.창의+=8; }

  if (v.monitor)       { raw.공부+=5;  raw.업무+=10; raw.창의+=2; }
  if (v.chair)         { raw.업무+=5; }
  if (v.storage)       { raw.공부+=5; }
  if (v.layout_order===0){ raw.휴식+=5; raw.창의+=5; }

  let f공 = 1, f업 = 1;
  if (v.bed_visible)    { f공*=0.85; f업*=0.9; }
  if (v.shadow_on_desk) { f공*=0.8;  f업*=0.85; }
  if (v.color_temp===0) { f공*=0.85; f업*=0.9; }
  if (v.brightness===0) { f공*=0.8;  f업*=0.85; }

  raw.공부 *= f공;
  raw.업무 *= f업;

  const maxScores = { 공부: 57, 업무: 62, 휴식: 40, 창의: 25 };
  const result = {};
  for (const key of ["공부","업무","휴식","창의"]) {
    result[key] = Math.min(100, Math.max(0, Math.round((raw[key] / maxScores[key]) * 100)));
  }
  return result;
}

function calcMBTI(v) {
  let focus = 2*v.desk + (v.clutter===2?1:0) + (v.bed_visible?-1:0) + (v.shadow_on_desk?-1:0) + (v.window_side?1:0);
  let open = (v.window_front||v.window_side?1:0) + (v.brightness>0?1:0) + (v.clutter===0?-1:0);
  let energy = v.color_temp + v.brightness + v.desk - v.bed_visible;
  let structure = v.layout_order + v.storage - (v.clutter===0?1:0);

  return (focus>=2?"F":"D") + (open>=2?"O":"C") + (energy>=2?"A":"R") + (structure>=2?"S":"L");
}

function buildResult(vars, scores, mbti, spaceType, purposeScore) {
  const purpose = spaceType || "공부";
  const score = (purposeScore / 10).toFixed(1);
  const grade = purposeScore>=85?"EXCELLENT":purposeScore>=70?"GOOD":purposeScore>=50?"FAIR":"NEEDS WORK";

  const sub = [
    { name:"조명 환경", icon:"💡", score: calcLightScore(vars) },
    { name:"공간 배치", icon:"📐", score: calcLayoutScore(vars) },
    { name:"집중 셋업", icon:"🖥", score: calcSetupScore(vars) },
  ];

  const comment = buildComment(vars, scores, mbti, purpose, purposeScore);
  const improvements = buildImprovements(vars, purpose);
  const annotations = vars.annotations || [];

  return { score: parseFloat(score), grade, sub, comment, annotations, improvements, mbti, scores, purposeScore };
}

function calcLightScore(v) {
  let s = v.brightness*3 + (v.task_light?2:0) + (v.color_temp===1?1:0) + (v.shadow_on_desk?-2:0);
  return Math.min(10, Math.max(0, parseFloat((s/1.0).toFixed(1))));
}

function calcLayoutScore(v) {
  let s = v.layout_order*2 + (v.door_visible?1:0) + (v.window_side?2:0) + (v.door_behind?-1:0) + (v.window_front?-1:0);
  return Math.min(10, Math.max(0, parseFloat((s/1.0).toFixed(1))));
}

function calcSetupScore(v) {
  let s = (v.desk?3:0) + (v.monitor?2:0) + (v.chair?2:0) + (v.storage?1:0) + (v.clutter)*1;
  return Math.min(10, Math.max(0, parseFloat((s/1.0).toFixed(1))));
}

function buildComment(vars, scores, mbti, purpose, purposeScore) {
  const grade = purposeScore>=85?"매우 우수한":purposeScore>=70?"좋은":purposeScore>=50?"보통 수준의":"개선이 필요한";
  const mbtiDesc = {
    F:"집중형", D:"분산형", O:"개방형", C:"폐쇄형",
    A:"각성형", R:"이완형", S:"구조형", L:"유동형"
  };
  const m1 = mbtiDesc[mbti[0]], m2 = mbtiDesc[mbti[2]];
  let extra = "";
  if (vars.shadow_on_desk) extra += " 작업면 그림자가 발생하고 있어 피로감이 높아질 수 있습니다.";
  if (vars.bed_visible && (purpose==="공부"||purpose==="업무")) extra += " 시야에 침대가 노출되어 집중력에 영향을 줄 수 있어요.";
  if (vars.brightness===0) extra += " 전체적인 조도가 부족합니다.";
  return `공간 MBTI <strong>${mbti}</strong> — <strong>${m1}·${m2}</strong> 성향의 방입니다. <strong>${purpose}</strong> 목적으로는 ${grade} 환경입니다.${extra}`;
}

function buildImprovements(vars, purpose) {
  const list = [];
  if (!vars.desk && (purpose==="공부"||purpose==="업무"))
    list.push({icon:"🪑", ok:false, title:"책상 배치 추천", desc:"전용 작업 공간을 만들면 집중도가 크게 올라갑니다."});
  if (vars.shadow_on_desk)
    list.push({icon:"💡", ok:false, title:"작업면 조명 개선", desc:"책상 왼쪽에 스탠드를 추가해 그림자를 없애보세요."});
  if (vars.brightness===0)
    list.push({icon:"🔆", ok:false, title:"전체 조도 보강", desc:"천장등 또는 보조등을 추가해 밝기를 높이세요."});
  if (vars.bed_visible && (purpose==="공부"||purpose==="업무"))
    list.push({icon:"🛏", ok:false, title:"침대 시야 차단", desc:"책상 방향을 바꾸거나 가벽/커튼으로 침대를 가려보세요."});
  if (!vars.task_light && (purpose==="공부"||purpose==="업무"))
    list.push({icon:"🔦", ok:false, title:"작업등 추가", desc:"스탠드 조명이 없으면 눈의 피로가 빠르게 옵니다."});
  if (vars.clutter===0)
    list.push({icon:"📦", ok:false, title:"정리 정돈 필요", desc:"물건을 정리하면 심리적 여유와 집중력 모두 향상됩니다."});
  if (vars.window_side)
    list.push({icon:"🪟", ok:true, title:"측면 자연광 우수", desc:"자연광이 측면에서 들어와 눈의 피로가 적은 최적의 배치입니다."});
  if (vars.clutter===2)
    list.push({icon:"✨", ok:true, title:"깔끔한 정돈 상태", desc:"잘 정돈된 공간이 집중력 유지에 도움이 됩니다."});
  if (vars.desk && vars.monitor)
    list.push({icon:"🖥", ok:true, title:"작업 셋업 완비", desc:"책상과 모니터가 갖춰진 효율적인 작업 환경입니다."});
  return list.slice(0, 4);
}
