import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const README_FILE = process.env.README_FILE || "README.md";
const OPENAPI_FILE = process.env.OPENAPI_FILE || "";
const OPENAPI_URL =
  process.env.OPENAPI_URL?.trim() || "https://api.justoneapi.com/v3/api-docs/public-api";
const FETCH_TIMEOUT_MS = Number.parseInt(process.env.OPENAPI_FETCH_TIMEOUT_MS || "30000", 10);
const CACHE_FILE = process.env.I18N_CACHE_FILE || "i18n-cache.json";
const GLOSSARY_FILE = process.env.GLOSSARY_FILE || "glossary.json";
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const API_LIST_START = "<!-- API_LIST_START -->";
const API_LIST_END = "<!-- API_LIST_END -->";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return readJson(filePath);
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

async function fetchOpenApi() {
  const username = requireEnv("OPENAPI_BASIC_AUTH_USER");
  const password = requireEnv("OPENAPI_BASIC_AUTH_PASS");
  const auth = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(OPENAPI_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${auth}`,
      },
      redirect: "follow",
      signal: controller.signal,
    });
    const body = await response.text();

    if (!response.ok) {
      const compactBody = body.replace(/\s+/g, " ").trim().slice(0, 200);
      throw new Error(
        `Failed to fetch OpenAPI: HTTP ${response.status} ${response.statusText}${
          compactBody ? ` - ${compactBody}` : ""
        }`,
      );
    }

    return JSON.parse(body);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`OpenAPI fetch timed out after ${FETCH_TIMEOUT_MS}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadOpenApi() {
  if (OPENAPI_FILE) {
    console.log(`Reading OpenAPI from ${OPENAPI_FILE}`);
    return readJson(OPENAPI_FILE);
  }

  console.log(`Fetching OpenAPI from ${OPENAPI_URL}`);
  return fetchOpenApi();
}

function normalizeReadmeLanguage(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["zh", "zh-cn", "cn", "chinese"].includes(normalized)) return "zh";
  if (["en", "en-us", "english"].includes(normalized)) return "en";
  return null;
}

function inferReadmeLanguage(readme) {
  return readme.includes("## 服务概览") ? "zh" : "en";
}

function getNumericOrder(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number.parseInt(String(value), 10);
  return Number.isFinite(numeric) ? numeric : null;
}

function compareOrder(aOrder, bOrder, aIndex, bIndex) {
  const a = aOrder ?? Number.MAX_SAFE_INTEGER;
  const b = bOrder ?? Number.MAX_SAFE_INTEGER;
  if (a !== b) return a - b;
  return aIndex - bIndex;
}

function normalizeVersion(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;

  const exact = text.match(/^v?(\d+)$/i);
  if (exact) return `V${exact[1]}`;

  const wrapped = text.match(/\bV(\d+)\b/i);
  return wrapped ? `V${wrapped[1]}` : null;
}

function extractPathVersion(pathKey) {
  const segments = String(pathKey).split("/").filter(Boolean);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const version = normalizeVersion(segments[index]);
    if (version) return version;
  }
  return null;
}

function getOperationVersion(op, pathKey) {
  const candidates = [op["x-api-version"], op["x-version"], op.apiVersion, op.api_version, op.version];
  for (const candidate of candidates) {
    const version = normalizeVersion(candidate);
    if (version) return version;
  }

  const pathVersion = extractPathVersion(pathKey);
  if (pathVersion) return pathVersion;

  const operationIdMatch = op.operationId?.match(/V(\d+)$/i);
  if (operationIdMatch) return `V${operationIdMatch[1]}`;

  const summaryMatch = op.summary?.match(/\((V\d+)\)/i);
  return summaryMatch ? summaryMatch[1].toUpperCase() : null;
}

function stripTrailingVersion(text) {
  return String(text || "")
    .replace(/\s*\((V\d+)\)\s*$/i, "")
    .replace(/\s+V(\d+)\s*$/i, "")
    .replace(/V(\d+)$/i, "")
    .replace(/\s*\[(Deprecated|已弃用|已废弃)\]\s*$/gi, "")
    .trim();
}

function getOperationBaseTitle(op, pathKey) {
  return stripTrailingVersion(op.summary || op.operationId || pathKey) || pathKey;
}

function collectApiGroups(api) {
  const groups = new Map();
  let operationIndex = 0;

  for (const [pathKey, methods] of Object.entries(api.paths || {})) {
    for (const [method, op] of Object.entries(methods || {})) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;

      const tagName = op.tags?.[0] || "Default";
      if (!groups.has(tagName)) {
        groups.set(tagName, {
          tagName,
          index: groups.size,
          operations: [],
        });
      }

      groups.get(tagName).operations.push({
        pathKey,
        method: method.toUpperCase(),
        baseTitle: getOperationBaseTitle(op, pathKey),
        version: getOperationVersion(op, pathKey),
        deprecated: Boolean(op.deprecated),
        order: getNumericOrder(op["x-order"]),
        index: operationIndex,
      });
      operationIndex += 1;
    }
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      operations: group.operations.sort((a, b) => compareOrder(a.order, b.order, a.index, b.index)),
    }))
    .sort((a, b) =>
      compareOrder(a.operations[0]?.order ?? null, b.operations[0]?.order ?? null, a.index, b.index),
    );
}

function getHash(text) {
  return crypto.createHash("md5").update(text).digest("hex");
}

class Translator {
  constructor(language) {
    this.language = language;
    this.glossary = {};
    this.terminology = {};
    this.translationOverrides = {};
    this.cache = {};
    this.cacheChanged = false;

    if (language === "zh") {
      this.glossary = readJsonIfExists(GLOSSARY_FILE, {});
      this.terminology = this.glossary.terminology || {};
      this.translationOverrides = this.glossary.translation_overrides || {};
      this.cache = readJsonIfExists(CACHE_FILE, {});
    }
  }

  applyTranslationOverrides(text) {
    if (!text || typeof text !== "string") return text;

    let normalized = text;
    for (const [from, to] of Object.entries(this.translationOverrides)) {
      normalized = normalized.replaceAll(from, to);
    }
    return normalized;
  }

  getGlossaryTranslation(text) {
    return this.terminology[text] || null;
  }

  translateFromCache(text) {
    if (this.language !== "zh") return text;
    const glossaryTranslation = this.getGlossaryTranslation(text);
    if (glossaryTranslation) return this.applyTranslationOverrides(glossaryTranslation);

    const cached = this.cache[getHash(text)];
    return cached ? this.applyTranslationOverrides(cached) : null;
  }

  async ensureTranslations(texts) {
    if (this.language !== "zh") return;

    const uniqueTexts = Array.from(new Set(texts.filter((text) => text && String(text).trim())));
    const missing = uniqueTexts.filter((text) => !this.translateFromCache(text));
    if (missing.length === 0) {
      console.log("All Chinese README list strings are already translated in cache.");
      return;
    }

    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) {
      throw new Error(
        `DEEPSEEK_API_KEY is required to translate ${missing.length} new README API list string(s).`,
      );
    }

    console.log(`Translating ${missing.length} README API list string(s) with DeepSeek.`);
    const batchSize = 20;
    for (let index = 0; index < missing.length; index += batchSize) {
      const batch = missing.slice(index, index + batchSize);
      const translations = await this.translateBatch(batch, apiKey);
      batch.forEach((text, batchIndex) => {
        const glossaryTranslation = this.getGlossaryTranslation(text);
        const translated = glossaryTranslation || this.applyTranslationOverrides(translations[batchIndex]);
        this.cache[getHash(text)] = translated;
        this.cacheChanged = true;
      });
      this.saveCache();
    }
  }

  async translateBatch(batch, apiKey) {
    const systemPrompt = `You are a professional technical translator specializing in API documentation.
Translate the provided strings from English to Simplified Chinese (zh-CN).

Rules:
1. Keep technical terms accurate and concise for a README endpoint list.
2. Do not translate technical identifiers, parameter names, enum values, or API paths.
3. Keep product names such as TikTok, YouTube, Reddit, Amazon, Facebook, Twitter, IMDb, Temu, Lazada, SHEIN, and Shopee unchanged unless the glossary says otherwise.
4. Follow the glossary exactly when provided.
5. Return JSON in this exact shape: {"translations":["..."]}.

Glossary:
${JSON.stringify(this.terminology, null, 2)}
`;

    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(batch) },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      }),
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`DeepSeek translation failed: HTTP ${response.status} ${response.statusText} - ${body}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`DeepSeek response was not valid JSON: ${error.message}`);
    }

    const content = parsed.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("DeepSeek response did not include message content.");
    }

    let result;
    try {
      result = JSON.parse(content);
    } catch (error) {
      throw new Error(`DeepSeek message content was not valid JSON: ${error.message}`);
    }

    const translations = Array.isArray(result) ? result : result.translations;
    if (!Array.isArray(translations) || translations.length !== batch.length) {
      throw new Error("DeepSeek translation count did not match input count.");
    }

    return translations.map((translation) => String(translation || "").trim());
  }

  saveCache() {
    if (this.language !== "zh" || !this.cacheChanged) return;
    fs.writeFileSync(CACHE_FILE, `${JSON.stringify(this.cache, null, 2)}\n`);
  }

  translate(text) {
    if (this.language !== "zh") return text;
    return this.translateFromCache(text) || text;
  }
}

function buildDisplayTitle(operation, language, translator) {
  const baseTitle = translator.translate(operation.baseTitle);
  const titleWithVersion = operation.version ? `${baseTitle} (${operation.version})` : baseTitle;

  if (!operation.deprecated) return titleWithVersion;
  return language === "zh" ? `${titleWithVersion}（已弃用）` : `${titleWithVersion} (Deprecated)`;
}

function renderApiList(groups, language, translator) {
  return groups
    .map((group) => {
      const tagName = translator.translate(group.tagName);
      const lines = [`### ${tagName}`, ""];
      for (const operation of group.operations) {
        lines.push(`- ${buildDisplayTitle(operation, language, translator)}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function buildReadmeSection(apiList, language) {
  if (language === "zh") {
    return `## 服务概览

以下接口列表由 OpenAPI 自动生成，展示当前公开 API 的分类、接口名称和版本。完整请求参数和响应说明请以在线接口文档为准。

${API_LIST_START}

${apiList}

${API_LIST_END}
`;
  }

  return `## Service Overview

The API list below is generated from OpenAPI and shows the current public API categories, endpoint names, and versions. See the online API documentation for full request and response details.

${API_LIST_START}

${apiList}

${API_LIST_END}
`;
}

function replaceApiListSection(readme, section, language) {
  const headingRegex =
    language === "zh" ? /^##\s+服务概览\s*$/m : /^##\s+Service\s+Overv(?:iew)?\s*$/m;
  const headingMatch = readme.match(headingRegex);

  if (headingMatch && headingMatch.index !== undefined) {
    const start = headingMatch.index;
    const afterHeading = start + headingMatch[0].length;
    const rest = readme.slice(afterHeading);
    const nextHeadingOffset = rest.search(/\n##\s+/);
    const end = nextHeadingOffset === -1 ? readme.length : afterHeading + nextHeadingOffset;
    return `${readme.slice(0, start)}${section}${readme.slice(end)}`;
  }

  const startMarkerIndex = readme.indexOf(API_LIST_START);
  const endMarkerIndex = readme.indexOf(API_LIST_END);
  if (startMarkerIndex !== -1 && endMarkerIndex !== -1 && endMarkerIndex > startMarkerIndex) {
    const end = endMarkerIndex + API_LIST_END.length;
    return `${readme.slice(0, startMarkerIndex)}${section}${readme.slice(end)}`;
  }

  throw new Error(`Could not find the README API list section in ${README_FILE}.`);
}

async function main() {
  const readmePath = path.resolve(README_FILE);
  const readme = fs.readFileSync(readmePath, "utf8");
  const language = normalizeReadmeLanguage(process.env.README_LANG) || inferReadmeLanguage(readme);
  const api = await loadOpenApi();
  const groups = collectApiGroups(api);
  const translator = new Translator(language);

  const textsToTranslate =
    language === "zh"
      ? groups.flatMap((group) => [group.tagName, ...group.operations.map((operation) => operation.baseTitle)])
      : [];
  await translator.ensureTranslations(textsToTranslate);

  const apiList = renderApiList(groups, language, translator);
  const section = buildReadmeSection(apiList, language);
  const updatedReadme = replaceApiListSection(readme, section, language);

  if (updatedReadme === readme) {
    console.log(`${README_FILE} is already up to date.`);
    return;
  }

  fs.writeFileSync(readmePath, updatedReadme);
  console.log(`Updated ${README_FILE} with ${groups.length} API group(s).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
