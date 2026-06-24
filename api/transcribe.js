const DEFAULT_MODEL = "gemini-2.5-flash";

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function cleanBase64(value = "") {
  return String(value).replace(/^data:[^;]+;base64,/, "");
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: { message: "Method not allowed" } });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    sendJson(response, 500, { error: { message: "Missing GEMINI_API_KEY on the server." } });
    return;
  }

  try {
    const { audioBase64, mimeType = "audio/webm", language = "auto", model = DEFAULT_MODEL } = request.body || {};
    const audioData = cleanBase64(audioBase64);
    if (!audioData) {
      sendJson(response, 400, { error: { message: "Missing audio." } });
      return;
    }

    const prompt = [
      "Transcribe this meeting audio accurately.",
      language && language !== "auto" ? `Expected language or locale: ${language}.` : "Detect the language automatically.",
      "Preserve names, numbers, dates, company names, and action-item wording.",
      "Return only the transcript text. Do not summarize.",
    ].join("\n");

    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: audioData } },
          ],
        }],
        generationConfig: { maxOutputTokens: 4096, temperature: 0.05 },
      }),
    });

    const payload = await geminiResponse.json().catch(() => null);
    if (!geminiResponse.ok) {
      sendJson(response, geminiResponse.status, payload || { error: { message: "Audio transcription failed." } });
      return;
    }

    const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim() || "";
    sendJson(response, 200, { text });
  } catch (error) {
    sendJson(response, 500, { error: { message: error?.message || "Audio transcription failed." } });
  }
}
