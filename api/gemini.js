const DEFAULT_MODEL = "gemini-2.5-flash";

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function parseRetryAfter(value) {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return String(Math.max(1, Math.ceil(numeric)));
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return String(Math.max(1, Math.ceil((date - Date.now()) / 1000)));
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
    const { model = DEFAULT_MODEL, prompt, maxTokens = 1200, responseMimeType = "text/plain" } = request.body || {};
    if (!prompt || typeof prompt !== "string") {
      sendJson(response, 400, { error: { message: "Missing prompt." } });
      return;
    }

    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.15, responseMimeType, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });

    const retryAfter = parseRetryAfter(geminiResponse.headers.get("Retry-After"));
    const payload = await geminiResponse.json().catch(() => null);

    if (!geminiResponse.ok) {
      sendJson(
        response,
        geminiResponse.status,
        payload || { error: { message: "Gemini request failed." } },
        retryAfter ? { "Retry-After": retryAfter } : {},
      );
      return;
    }

    if (payload?.candidates?.[0]?.finishReason === "MAX_TOKENS") {
      sendJson(response, 422, { error: { message: "AI response was cut off. Try shorter notes or run extraction again." } });
      return;
    }

    const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
    sendJson(response, 200, { text });
  } catch (error) {
    sendJson(response, 500, { error: { message: error?.message || "Gemini server request failed." } });
  }
}
