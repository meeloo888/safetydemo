// ─────────────────────────────────────────────────────────────
//  Vercel 서버리스 함수: /api/analyze
//  역할: 프론트엔드에서 받은 이미지를 Gemini API로 분석.
//        API 키는 Vercel 환경변수(GEMINI_API_KEY)에 숨겨져 있어
//        브라우저(청중)에게 절대 노출되지 않습니다.
// ─────────────────────────────────────────────────────────────

const LANG_NAMES = {
  ko: "Korean",
  vi: "Vietnamese",
  th: "Thai",
  zh: "Chinese",
  en: "English",
};

export default async function handler(req, res) {
  // CORS (같은 도메인에서 호출하므로 사실상 불필요하지만 안전하게)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST만 허용됩니다." });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: "서버에 GEMINI_API_KEY가 설정되지 않았습니다. Vercel 환경변수를 확인하세요.",
    });
    return;
  }

  try {
    const { imageBase64, lang } = req.body || {};
    if (!imageBase64) {
      res.status(400).json({ error: "이미지 데이터가 없습니다." });
      return;
    }

    const targetLang = LANG_NAMES[lang] || "Korean";

    const prompt = `You are an AI construction-site safety inspector for a Korean accident-prevention system. Analyze the construction site image for safety hazards.

Focus on: missing hard hats (안전모), missing safety harnesses / fall protection (안전벨트), missing safety boots (안전화), fall-from-height risk, dangerous postures, proximity to heavy machinery, unstable scaffolding, and other visible hazards.

Respond with ONLY a valid JSON object (no markdown, no backticks, no preamble) in this exact schema:
{
  "riskScore": <integer 0-100, higher = more dangerous>,
  "summary_ko": "<one-sentence overall assessment in Korean>",
  "hazards": [
    {
      "label_ko": "<hazard name in Korean>",
      "severity": "high" | "medium" | "low",
      "detail_ko": "<short explanation in Korean>",
      "box": { "x": <0-1 left>, "y": <0-1 top>, "w": <0-1 width>, "h": <0-1 height> }
    }
  ],
  "voiceAlert": "<the most urgent single safety warning, written in ${targetLang}, as if spoken to the worker through a smart helmet>"
}
Each of x, y, w, h MUST be a single decimal number (e.g. 0.42), never a range. If you cannot localize a hazard, estimate its position. Always return at least riskScore, summary_ko and voiceAlert even if no hazards are found (empty hazards array).
CRITICAL: Output strictly valid JSON only. No trailing commas. No comments. No text before or after the JSON object.`;

    const geminiBody = {
      contents: [
        {
          parts: [
            { inline_data: { mime_type: "image/jpeg", data: imageBase64 } },
            { text: prompt },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
      },
    };

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

    const geminiRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(geminiBody),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      let msg = errText;
      try {
        msg = JSON.parse(errText)?.error?.message || errText;
      } catch (_) {}
      res.status(geminiRes.status).json({
        error: `Gemini API 오류 (${geminiRes.status}): ${msg}`,
      });
      return;
    }

    const data = await geminiRes.json();
    const text =
      data?.candidates?.[0]?.content?.parts
        ?.filter((p) => p.text)
        ?.map((p) => p.text)
        ?.join("\n") || "";

    if (!text) {
      res.status(502).json({ error: "Gemini 응답이 비어 있습니다." });
      return;
    }

    // 견고한 JSON 파싱 (혹시 모를 형식 오류 자동 정리)
    const parsed = extractJson(text);
    res.status(200).json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "서버 내부 오류" });
  }
}

function extractJson(text) {
  let t = String(text).replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    t = t.slice(start, end + 1);
  }
  try {
    return JSON.parse(t);
  } catch (_) {
    const fixed = t
      .replace(/,(\s*[}\]])/g, "$1")
      .replace(/:\s*(-?\d+(?:\.\d+)?)\s*-\s*-?\d+(?:\.\d+)?/g, ": $1")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'");
    return JSON.parse(fixed);
  }
}
