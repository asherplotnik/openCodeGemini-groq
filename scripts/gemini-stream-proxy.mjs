import http from "node:http";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";

const port = Number.parseInt(process.env.GEMINI_PROXY_PORT ?? "8787", 10);
const connectorRoot = process.env.GEMINI_BASE_URL?.replace(/\/+$/, "");
const project = process.env.GEMINI_VERTEX_PROJECT;
const location = process.env.GEMINI_VERTEX_LOCATION;

if (!connectorRoot || !project || !location || !Number.isInteger(port)) {
  throw new Error("GEMINI_BASE_URL, GEMINI_VERTEX_PROJECT, GEMINI_VERTEX_LOCATION, and GEMINI_PROXY_PORT are required.");
}

const upstreamBase = `${connectorRoot}/v1/projects/${project}/locations/${location}/publishers/google`;
const vertexPrefix = `/v1/projects/${project}/locations/${location}/publishers/google`;
const hopByHopHeaders = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

function textParts(content) {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (part.type === "text" && typeof part.text === "string") return [{ text: part.text }];
    return [];
  });
}

function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return undefined;
  const converted = {};
  for (const key of ["type", "description", "format", "nullable", "minimum", "maximum", "minLength", "maxLength", "enum"]) {
    if (schema[key] !== undefined) converted[key] = schema[key];
  }
  if (schema.properties && typeof schema.properties === "object") {
    converted.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, value]) => [name, toGeminiSchema(value)])
    );
  }
  if (schema.items) converted.items = toGeminiSchema(schema.items);
  if (Array.isArray(schema.required)) converted.required = schema.required;
  return converted;
}

function callIdForSignature(signature) {
  return signature ? `call_sig_${Buffer.from(signature).toString("base64url")}` : `call_${randomUUID().replaceAll("-", "")}`;
}

function signatureFromCallId(callId) {
  if (!callId?.startsWith("call_sig_")) return undefined;
  try {
    return Buffer.from(callId.slice(9), "base64url").toString("utf8") || undefined;
  } catch {
    return undefined;
  }
}

function toGeminiRequest(payload) {
  const toolNames = new Map();
  for (const message of payload.messages ?? []) {
    for (const toolCall of message.tool_calls ?? []) {
      if (toolCall.id && toolCall.function?.name) toolNames.set(toolCall.id, toolCall.function.name);
    }
  }

  const systemParts = [];
  const contents = [];
  let pendingToolResponses = [];
  const flushToolResponses = () => {
    if (pendingToolResponses.length > 0) {
      contents.push({ role: "user", parts: pendingToolResponses });
      pendingToolResponses = [];
    }
  };
  for (const message of payload.messages ?? []) {
    if (message.role === "system" || message.role === "developer") {
      systemParts.push(...textParts(message.content));
      continue;
    }
    if (message.role === "tool") {
      const name = toolNames.get(message.tool_call_id) ?? "tool";
      pendingToolResponses.push({ functionResponse: { name, response: { content: message.content ?? "" } } });
      continue;
    }

    flushToolResponses();
    const parts = textParts(message.content);
    for (const toolCall of message.tool_calls ?? []) {
      if (toolCall.function?.name) {
        let args = {};
        try {
          args = JSON.parse(toolCall.function.arguments ?? "{}");
        } catch {
          args = {};
        }
        const functionCall = { name: toolCall.function.name, args };
        const thoughtSignature = signatureFromCallId(toolCall.id);
        parts.push(thoughtSignature ? { functionCall, thoughtSignature } : { functionCall });
      }
    }
    if (parts.length > 0) contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
  }
  flushToolResponses();

  const request = { contents };
  if (systemParts.length > 0) request.systemInstruction = { parts: systemParts };
  if (Array.isArray(payload.tools)) {
    const declarations = payload.tools
      .filter((tool) => tool.type === "function" && tool.function?.name)
      .map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: toGeminiSchema(tool.function.parameters)
      }));
    if (declarations.length > 0) request.tools = [{ functionDeclarations: declarations }];
  }
  const generationConfig = {};
  if (typeof payload.temperature === "number") generationConfig.temperature = payload.temperature;
  if (typeof payload.max_tokens === "number") generationConfig.maxOutputTokens = payload.max_tokens;
  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;
  return request;
}

function sendChunk(response, id, model, delta, finishReason = null) {
  response.write(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  })}\n\n`);
}

async function handleChatCompletions(request, response) {
  let payload = "";
  for await (const chunk of request) payload += chunk;

  let body;
  try {
    body = JSON.parse(payload);
  } catch {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Invalid chat completion request." } }));
    return;
  }

  const upstream = await fetch(`${upstreamBase}/models/${body.model}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY
    },
    body: JSON.stringify(toGeminiRequest(body))
  });
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text();
    response.writeHead(upstream.status, { "content-type": "application/json" });
    response.end(detail || JSON.stringify({ error: { message: "Gemini connector request failed." } }));
    return;
  }

  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream"
  });
  const id = `chatcmpl-${randomUUID()}`;
  let transcript = "";
  let sentRole = false;
  let toolIndex = 0;
  let usedTools = false;
  for await (const chunk of upstream.body) {
    transcript += Buffer.from(chunk).toString("utf8");
  }
  if (transcript.trimStart().startsWith('"')) {
    try {
      transcript = JSON.parse(transcript);
    } catch {
      throw new Error("Gemini connector returned an invalid streamed response.");
    }
  }
  for (const frame of transcript.split(/\r?\n\r?\n/)) {
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith("data: ")) continue;
      let event;
      try {
        event = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (process.env.GEMINI_PROXY_DEBUG === "1") {
        console.error(JSON.stringify(event));
      }
      for (const part of event.candidates?.[0]?.content?.parts ?? []) {
        if (typeof part.text === "string") {
          sendChunk(response, id, body.model, sentRole ? { content: part.text } : { role: "assistant", content: part.text });
          sentRole = true;
        }
        if (part.functionCall?.name) {
          const callId = callIdForSignature(part.thoughtSignature);
          sendChunk(response, id, body.model, {
            role: sentRole ? undefined : "assistant",
            tool_calls: [{
              index: toolIndex++,
              id: callId,
              type: "function",
              function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args ?? {})
              }
            }]
          });
          sentRole = true;
          usedTools = true;
        }
      }
    }
  }
  sendChunk(response, id, body.model, {}, usedTools ? "tool_calls" : "stop");
  response.end("data: [DONE]\n\n");
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }

  if (request.method === "POST" && request.url === "/chat/completions") {
    try {
      await handleChatCompletions(request, response);
    } catch {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Could not reach the Gemini connector." } }));
    }
    return;
  }

  const requestPath = request.url?.startsWith("/") ? request.url : `/${request.url ?? ""}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value && !hopByHopHeaders.has(name.toLowerCase())) {
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
  }

  try {
    const upstreamUrl = requestPath.startsWith(vertexPrefix)
      ? `${connectorRoot}${requestPath}`
      : `${upstreamBase}${requestPath}`;
    if (process.env.GEMINI_PROXY_DEBUG === "1") {
      console.error(`${request.method} ${requestPath}`);
    }
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : Readable.toWeb(request),
      duplex: "half"
    });
    const isStreaming = requestPath.includes(":streamGenerateContent");

    response.statusCode = upstream.status;
    for (const [name, value] of upstream.headers) {
      if (!hopByHopHeaders.has(name.toLowerCase()) && !(isStreaming && name.toLowerCase() === "content-type")) {
        response.setHeader(name, value);
      }
    }
    if (isStreaming) {
      response.setHeader("content-type", "text/event-stream");
    }

    if (!upstream.body) {
      response.end();
      return;
    }
    Readable.fromWeb(upstream.body).on("error", () => response.destroy()).pipe(response);
  } catch {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Could not reach the Gemini connector." } }));
  }
});

server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
