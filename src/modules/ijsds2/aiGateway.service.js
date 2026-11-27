import crypto from "crypto";
import prisma from "../../config/prisma.js";
import { getActiveAiRouting } from "./aiRouting.config.js";

/**
 * Direct-API Multi-Provider AI Gateway (OpenAI, Anthropic, Google Gemini Paid Tiers).
 *
 * Design guarantees (PRD v2.4.2-PROD):
 *  - Commercial paid API keys only (env vars OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY).
 *  - Never attaches web-browsing tools or exposes unpublished text to consumer tiers.
 *  - Strict JSON schema enforcement + cross-provider fallback on outage/schema failure.
 *  - Per-manuscript USD cost cap enforcement and append-only metering in `ai_task_runs`.
 */

// Conservative reference USD rates per 1M tokens for real-time budget metering.
// Actual billed amounts reconcile against provider invoices.
const MODEL_RATES_PER_MTOK = Object.freeze({
  "gpt-5": { input: 1.25, output: 10.0 },
  "gpt-5-mini": { input: 0.25, output: 2.0 },
  "gpt-6.1-sol": { input: 2.0, output: 10.0 },
  "claude-sonnet-5-5": { input: 2.0, output: 10.0 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
});

export const estimateCostUsd = (model, inputTokens = 0, outputTokens = 0, cachedTokens = 0) => {
  const rate = MODEL_RATES_PER_MTOK[model] ?? { input: 2.0, output: 10.0 };
  const billableInput = Math.max(0, inputTokens - cachedTokens);
  const cachedCost = (cachedTokens / 1_000_000) * (rate.input * 0.1);
  const inputCost = (billableInput / 1_000_000) * rate.input;
  const outputCost = (outputTokens / 1_000_000) * rate.output;
  return Number((inputCost + cachedCost + outputCost).toFixed(6));
};

export const getProviderApiKey = (provider, env = process.env) => {
  if (provider === "openai") return env.OPENAI_API_KEY || null;
  if (provider === "anthropic") return env.ANTHROPIC_API_KEY || null;
  if (provider === "google") return env.GEMINI_API_KEY || env.GOOGLE_API_KEY || null;
  return null;
};

const stripCodeFence = (raw) => {
  const s = String(raw ?? "").trim();
  const match = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : s;
};

const parseStrictJson = (raw) => {
  const cleaned = stripCodeFence(raw);
  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Model did not return a JSON object");
  }
  return parsed;
};

const callOpenAI = async ({ apiKey, model, systemPrompt, userPrompt, jsonSchema, images = [], fetchImpl }) => {
  const userContent = images.length
    ? [
        { type: "text", text: userPrompt },
        ...images.map((img) => ({
          type: "image_url",
          image_url: { url: `data:${img.mimeType || "image/png"};base64,${img.base64}`, detail: "high" },
        })),
      ]
    : userPrompt;

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    response_format: jsonSchema
      ? { type: "json_schema", json_schema: { name: "ijsds_structured_output", strict: true, schema: jsonSchema } }
      : { type: "json_object" },
  };

  const res = await fetchImpl("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI returned empty completion");
  return {
    output: parseStrictJson(text),
    inputTokens: data?.usage?.prompt_tokens ?? 0,
    outputTokens: data?.usage?.completion_tokens ?? 0,
    cachedTokens: data?.usage?.prompt_tokens_details?.cached_tokens ?? 0,
  };
};

const callAnthropic = async ({ apiKey, model, systemPrompt, userPrompt, jsonSchema, images = [], fetchImpl }) => {
  const userParts = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mimeType || "image/png", data: img.base64 },
  }));
  userParts.push({ type: "text", text: userPrompt });

  const body = {
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userParts }],
    ...(jsonSchema
      ? {
          tools: [
            {
              name: "emit_structured_output",
              description: "Return the structured JSON result strictly matching the schema.",
              input_schema: jsonSchema,
            },
          ],
          tool_choice: { type: "tool", name: "emit_structured_output" },
        }
      : {}),
  };

  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Anthropic HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const toolBlock = (data?.content ?? []).find((b) => b.type === "tool_use" && b.input);
  const textBlock = (data?.content ?? []).find((b) => b.type === "text" && b.text);
  const output = toolBlock ? toolBlock.input : parseStrictJson(textBlock?.text);
  return {
    output,
    inputTokens: data?.usage?.input_tokens ?? 0,
    outputTokens: data?.usage?.output_tokens ?? 0,
    cachedTokens: data?.usage?.cache_read_input_tokens ?? 0,
  };
};

const callGemini = async ({ apiKey, model, systemPrompt, userPrompt, jsonSchema, images = [], fetchImpl }) => {
  const parts = [
    ...images.map((img) => ({
      inlineData: { mimeType: img.mimeType || "image/png", data: img.base64 },
    })),
    { text: userPrompt },
  ];

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
      ...(jsonSchema ? { responseSchema: jsonSchema } : {}),
    },
  };

  // Pass API key in header (never query string) so keys never leak in HTTP/proxy logs.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("\n");
  if (!text) throw new Error("Gemini returned empty response");
  return {
    output: parseStrictJson(text),
    inputTokens: data?.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data?.usageMetadata?.candidatesTokenCount ?? 0,
    cachedTokens: data?.usageMetadata?.cachedContentTokenCount ?? 0,
  };
};

const invokeSingleProvider = async ({ provider, model, systemPrompt, userPrompt, jsonSchema, images, fetchImpl, env }) => {
  const apiKey = getProviderApiKey(provider, env);
  if (!apiKey) {
    throw new Error(`Missing paid API key for provider "${provider}"`);
  }
  if (provider === "openai") return callOpenAI({ apiKey, model, systemPrompt, userPrompt, jsonSchema, images, fetchImpl });
  if (provider === "anthropic") return callAnthropic({ apiKey, model, systemPrompt, userPrompt, jsonSchema, images, fetchImpl });
  if (provider === "google") return callGemini({ apiKey, model, systemPrompt, userPrompt, jsonSchema, images, fetchImpl });
  throw new Error(`Unsupported LLM provider "${provider}"`);
};

/**
 * Executes a bounded, metered structured AI task with automatic cross-provider fallback,
 * budget-cap guard, and append-only audit logging to `ai_task_runs`.
 */
export const invokeStructuredTask = async (
  {
    manuscriptId = null,
    articleId = null,
    stage,
    task,
    systemPrompt,
    userPrompt,
    jsonSchema = null,
    images = [],
    policyVersion = "v2.4.2-PROD",
    idempotencyKey = null,
    validateOutput = null,
  },
  deps = {},
) => {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const routing = deps.routing ?? (await getActiveAiRouting());
  const db = "db" in deps ? deps.db : prisma;
  const route = routing.routes?.[task];

  if (!route) throw new Error(`Unknown AI workflow task "${task}"`);
  if (!route.enabled) {
    return { skipped: true, reason: "TASK_DISABLED", provider: route.provider, model: route.model };
  }

  // Per-manuscript USD cap check before spending tokens
  if (manuscriptId && db?.aiTaskRun) {
    const spentAgg = await db.aiTaskRun.aggregate({
      where: { manuscript_id: manuscriptId, status: "COMPLETED" },
      _sum: { cost_usd: true },
    });
    const spentUsd = Number(spentAgg?._sum?.cost_usd ?? 0);
    if (spentUsd >= routing.perManuscriptCapUsd) {
      return {
        skipped: true,
        reason: "BUDGET_CAP_EXCEEDED",
        spentUsd,
        capUsd: routing.perManuscriptCapUsd,
      };
    }
  }

  const attempts = [{ provider: route.provider, model: route.model }];
  if (route.fallbackProvider && route.fallbackModel) {
    attempts.push({ provider: route.fallbackProvider, model: route.fallbackModel });
  }

  const errors = [];
  for (let i = 0; i < attempts.length; i++) {
    const { provider, model } = attempts[i];
    const started = Date.now();
    const runKey = `${idempotencyKey ?? crypto.randomUUID()}:attempt-${i + 1}:${provider}`;

    try {
      const result = await invokeSingleProvider({
        provider,
        model,
        systemPrompt,
        userPrompt,
        jsonSchema,
        images,
        fetchImpl,
        env,
      });
      if (validateOutput) validateOutput(result.output);

      const latencyMs = Date.now() - started;
      const costUsd = estimateCostUsd(model, result.inputTokens, result.outputTokens, result.cachedTokens);

      let runId = null;
      if (db?.aiTaskRun) {
        const saved = await db.aiTaskRun.create({
          data: {
            manuscript_id: manuscriptId,
            article_id: articleId,
            stage,
            task,
            attempt: i + 1,
            idempotency_key: runKey,
            status: "COMPLETED",
            provider,
            model,
            prompt_version: route.promptVersion,
            policy_version: policyVersion,
            input_tokens: result.inputTokens,
            output_tokens: result.outputTokens,
            cached_tokens: result.cachedTokens,
            cost_usd: costUsd,
            latency_ms: latencyMs,
            completed_at: new Date(),
          },
        });
        runId = saved.id;
      }

      return {
        skipped: false,
        runId,
        provider,
        model,
        promptVersion: route.promptVersion,
        output: result.output,
        usage: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cachedTokens: result.cachedTokens,
          costUsd,
          latencyMs,
        },
      };
    } catch (err) {
      const latencyMs = Date.now() - started;
      errors.push(`${provider}/${model}: ${err.message}`);
      if (db?.aiTaskRun) {
        await db.aiTaskRun
          .create({
            data: {
              manuscript_id: manuscriptId,
              article_id: articleId,
              stage,
              task,
              attempt: i + 1,
              idempotency_key: runKey,
              status: "FAILED",
              provider,
              model,
              prompt_version: route.promptVersion,
              policy_version: policyVersion,
              latency_ms: latencyMs,
              error_code: String(err.message).slice(0, 240),
              completed_at: new Date(),
            },
          })
          .catch(() => {});
      }
    }
  }

  const failure = new Error(`All configured AI providers failed for ${task}: ${errors.join(" | ")}`);
  failure.status = 502;
  throw failure;
};
