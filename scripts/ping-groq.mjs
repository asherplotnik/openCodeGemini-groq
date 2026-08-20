const apiKey = process.env.GROQ_API_KEY;
const model = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";
const baseURL = process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1";

if (!apiKey) {
  console.error("GROQ_API_KEY is required.");
  process.exit(1);
}

const response = await fetch(`${baseURL}/chat/completions`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`
  },
  body: JSON.stringify({
    model,
    messages: [
      {
        role: "user",
        content: "Reply with exactly: groq harness ok"
      }
    ],
    temperature: 0.2,
    max_completion_tokens: 32
  })
});

const body = await response.json().catch(() => null);

if (!response.ok) {
  console.error(`Groq request failed: ${response.status} ${response.statusText}`);
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

console.log(body?.choices?.[0]?.message?.content?.trim() ?? JSON.stringify(body, null, 2));
