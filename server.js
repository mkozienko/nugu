const http = require("http");

const PORT = Number(process.env.AI_SERVER_PORT || 8787);
const MODEL = process.env.OPENAI_MODEL || "gpt-5.5";

function getApiKey() {
  return (process.env.OPENAI_API_KEY || "").replace(/\s/g, "");
}

function rawApiKeyHadWhitespace() {
  return /\s/.test(process.env.OPENAI_API_KEY || "");
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 25 * 1024 * 1024) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "http://localhost:3000",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(payload));
}

function extractResponseText(response) {
  if (response.output_text) return response.output_text;

  return (response.output || [])
    .flatMap((item) => item.content || [])
    .filter((content) => content.type === "output_text")
    .map((content) => content.text || "")
    .join("\n");
}

function getDeveloperPrompt() {
  return `
You are an expert medical educator creating high-quality Anki-style cards from an entire PDF lecture/file.
Return JSON only.

Rules:
- Analyze the file as a coherent lesson, not as isolated pages.
- Use page images as the source of truth for layout. Respect columns, tables, boxes, arrows, and visual grouping.
- Do not skip images automatically. Use images when they carry independent testable meaning.
- Skip pages or regions that are decorative, citation-only, URL-only, title-only, or only support another concept without adding a testable fact.
- Skip introductory, overview, agenda, learning-objective, motivation, and general explanatory material unless it contains a key criterion needed later.
- Skip example photos when they only illustrate a previously explained fact and do not add a new diagnostic criterion, mechanism, classification, treatment rule, or comparison.
- Skip images that merely explain or decorate the previous page unless the image itself adds a new independently testable concept.
- Keep images/diagrams/tables when they teach a visual diagnostic criterion, staging/classification, mechanism, anatomy/pathophysiology link, algorithm, treatment decision, or comparison.
- Do not make cards from image credits, URLs, page numbers, decorative labels, or isolated figure titles.
- Create atomic cards: one card tests one meaningful idea.
- If a page is a comparison table or category contrast, compress related bullets into category-level cards. Usually create one comparison card or one card per category, not one card per bullet.
- For two-column comparisons like Type A vs Type B, prefer 2 cards that define each category, or 1 card asking for the key differences, unless a bullet is independently high-yield.
- Prefer clinical reasoning, mechanism, contrast, consequence, diagnostic recognition, and treatment tradeoff questions.
- Avoid obvious, shallow prompts such as "What is the key testable idea...".
- Avoid "Explain everything" questions.
- Do not copy the whole page into a question or answer.
- If comments include important/exam/high yield/важно/экзамен, mark relevant cards high priority.
- If highlights are provided, create cloze cards with blanks for each highlighted concept and do not duplicate them with concept cards.
- If two or more highlighted phrases appear on the same page, create separate cloze cards or one multi-blank cloze only when the phrases belong to one sentence/idea.
- Good cloze questions preserve the surrounding sentence/context and replace highlighted text with _____.
- If a highlighted phrase is visible only in the page image, infer the surrounding context from the image.

JSON shape:
{
  "cards": [
    {
      "question": "short question",
      "answer": "short answer",
      "cardType": "ai" | "cloze",
      "priority": "normal" | "high",
      "pageNumber": 12,
      "sourceText": "short source quote or bullet",
      "reason": "why this card is useful"
    }
  ]
}
`;
}

async function generateCards(payload) {
  const apiKey = getApiKey();

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const content = [
    {
      type: "input_text",
      text: JSON.stringify(
        {
          fileName: payload.fileName,
          task:
            payload.task ||
            "Analyze the supplied PDF material and generate high-quality Anki cards.",
          pageNumber: payload.pageNumber,
          pageText: payload.pageText,
          comments: payload.comments || [],
          highlights: payload.highlights || [],
          pages: payload.pages || [],
        },
        null,
        2
      ),
    },
  ];

  if (payload.pages?.length) {
    payload.pages.forEach((page) => {
      if (page.imageDataUrl) {
        content.push({
          type: "input_image",
          image_url: page.imageDataUrl,
          detail: "high",
        });
      }
    });
  }

  if (payload.imageDataUrl) {
    content.push({
      type: "input_image",
      image_url: payload.imageDataUrl,
      detail: "high",
    });
  }

  const apiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      instructions: getDeveloperPrompt(),
      reasoning: { effort: "medium" },
      input: [
        {
          role: "user",
          content,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "anki_cards",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              cards: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    question: { type: "string" },
                    answer: { type: "string" },
                    cardType: { type: "string", enum: ["ai", "cloze"] },
                    priority: { type: "string", enum: ["normal", "high"] },
                    pageNumber: { type: "number" },
                    sourceText: { type: "string" },
                    reason: { type: "string" },
                  },
                  required: [
                    "question",
                    "answer",
                    "cardType",
                    "priority",
                    "pageNumber",
                    "sourceText",
                    "reason",
                  ],
                },
              },
            },
            required: ["cards"],
          },
        },
      },
      max_output_tokens: 5000,
    }),
  });

  const responseJson = await apiResponse.json();

  if (!apiResponse.ok) {
    throw new Error(
      responseJson.error?.message || `OpenAI request failed: ${apiResponse.status}`
    );
  }

  const text = extractResponseText(responseJson);
  return JSON.parse(text);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 204, {});
  }

  if (req.method === "GET" && req.url === "/api/health") {
    const apiKey = getApiKey();
    return sendJson(res, 200, {
      ok: true,
      model: MODEL,
      hasApiKey: Boolean(apiKey),
      keyLooksLikeOpenAIKey: apiKey.startsWith("sk-"),
      keyLength: apiKey.length,
      keyHadWhitespace: rawApiKeyHadWhitespace(),
    });
  }

  if (req.method === "POST" && req.url === "/api/generate-cards") {
    try {
      const payload = await readJsonBody(req);
      const generated = await generateCards(payload);
      return sendJson(res, 200, generated);
    } catch (error) {
      return sendJson(res, 500, { error: error.message });
    }
  }

  return sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`AI card server listening on http://localhost:${PORT}`);
  console.log(`Using model: ${MODEL}`);
});
