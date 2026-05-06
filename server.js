import http from "http";
import { randomUUID } from "crypto";
import https from "https";

const GROQ_API_KEY = process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY;
const GROQ_RESEARCH_API_KEY = process.env.GROQ_RESEARCH_API_KEY || process.env.VITE_GROQ_RESEARCH_API_KEY;

async function callGroq(messages, model = "llama-3.3-70b-versatile", apiKey = GROQ_API_KEY, jsonMode = false) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages,
      temperature: 0.7,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    });

    const options = {
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message || "Groq API error"));
          resolve(parsed.choices?.[0]?.message?.content || "");
        } catch (e) {
          reject(new Error("Failed to parse Groq response"));
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Groq API request timed out"));
    });
    req.write(body);
    req.end();
  });
}

const PORT = Number(process.env.PORT || 4000);
const FRONTEND_ORIGIN = "http://localhost:8080";

// NOTE: Remove seeded admin for security. Use proper authentication with password hashing.
// For development, users can sign up via the API.
const users = [];

const sessions = new Map();
const accessTokens = new Map();

const profiles = [];

const forms = [
  {
    id: "form-1",
    title: "Aqora Demo Form",
    description: "This is a locally generated form for development.",
    questions: [
      {
        id: "q-1",
        type: "short_text",
        title: "Tell us your name",
        required: true,
      },
      {
        id: "q-2",
        type: "email",
        title: "What is your email?",
        required: true,
      },
      {
        id: "q-3",
        type: "single_choice",
        title: "How did you find this demo?",
        required: false,
        options: [
          { id: "o-1", label: "Search engine" },
          { id: "o-2", label: "Friend or colleague" },
          { id: "o-3", label: "Social media" },
        ],
      },
    ],
    theme: "clean_light",
    layout: "single_page",
    style: {
      fontFamily: "sans",
      fontSize: "medium",
      backgroundColor: "#ffffff",
      customAccentColor: "#2563eb",
    },
    isAnonymous: true,
    acceptingResponses: true,
    confirmationMessage: "Thanks for submitting!",
    views: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

const responses = [];
const complaints = [];

function allowCors(res) {
  res.setHeader("Access-Control-Allow-Origin", FRONTEND_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function sendJson(res, status, body) {
  allowCors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function parseJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function getAuthUser(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  return accessTokens.get(token)?.userId ?? null;
}

function createSession(userId) {
  const accessToken = randomUUID();
  const refreshToken = randomUUID();
  accessTokens.set(accessToken, { userId, refreshToken });
  sessions.set(refreshToken, { userId, accessToken });
  return { accessToken, refreshToken };
}

function revokeSession(refreshToken) {
  const session = sessions.get(refreshToken);
  if (session?.accessToken) {
    accessTokens.delete(session.accessToken);
  }
  sessions.delete(refreshToken);
}

function isOwnedByUser(item, userId) {
  return item.userId === userId || item.user_id === userId;
}

function isPublicForm(form) {
  return !!form && (form.isAnonymous === true || form.userId == null || form.user_id == null);
}

function filterBySince(items, since) {
  if (!since) return items;
  const date = new Date(since);
  if (Number.isNaN(date.getTime())) return items;
  return items.filter((item) => new Date(item.createdAt || item.created_at || item.submittedAt || item.submitted_at || item.updatedAt || item.updated_at) >= date);
}

function filterByFormIds(items, formIds) {
  if (!formIds) return items;
  const ids = formIds.split(",").map((id) => id.trim()).filter(Boolean);
  if (!ids.length) return items;
  return items.filter((item) => ids.includes(item.formId || item.form_id));
}

const server = http.createServer(async (req, res) => {
  allowCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = url.pathname;
  const search = url.searchParams;
  const method = req.method;

  if (pathname.startsWith("/api/functions/") && method === "POST") {
    const functionName = pathname.replace("/api/functions/", "");
    pathname = `/api/ai/${functionName}`;
  }

  if (pathname === "/api/auth/signup" && method === "POST") {
    const body = await parseJson(req);
    const existing = users.find((user) => user.email === body.email);
    if (existing) {
      return sendJson(res, 400, { message: "Email already registered" });
    }
    const user = {
      id: randomUUID(),
      email: body.email,
      password: body.password,
      username: body.username || body.email.split("@")[0],
      avatar_url: body.avatar_url || `https://api.dicebear.com/6.x/initials/svg?seed=${encodeURIComponent(body.email)}`,
      role: "user",
      created_at: new Date().toISOString(),
    };
    users.push(user);
    profiles.push({ id: user.id, email: user.email, username: user.username, avatar_url: user.avatar_url, created_at: user.created_at });
    const tokens = createSession(user.id);
    return sendJson(res, 200, { user, tokens });
  }

  if (pathname === "/api/auth/login" && method === "POST") {
    const body = await parseJson(req);
    const user = users.find((item) => item.email === body.email && item.password === body.password);
    if (!user) {
      return sendJson(res, 401, { message: "Invalid credentials" });
    }
    const tokens = createSession(user.id);
    return sendJson(res, 200, { user, tokens });
  }

  if (pathname === "/api/auth/logout" && method === "POST") {
    const body = await parseJson(req);
    if (body.refreshToken) {
      revokeSession(body.refreshToken);
    }
    return sendJson(res, 200, { message: "Logged out" });
  }

  if (pathname === "/api/auth/refresh" && method === "POST") {
    const body = await parseJson(req);
    const existingSession = sessions.get(body.refreshToken);
    if (!existingSession) {
      return sendJson(res, 401, { message: "Invalid refresh token" });
    }
    revokeSession(body.refreshToken);
    const tokens = createSession(existingSession.userId);
    return sendJson(res, 200, { user: users.find((item) => item.id === existingSession.userId), tokens });
  }

  const userId = getAuthUser(req);
  const isFormDetailRead = pathname.startsWith("/api/forms/") && method === "GET";
  const isFormViewIncrement = pathname.startsWith("/api/forms/") && pathname.endsWith("/increment-views") && method === "POST";
  const isPublicResponseSubmit = pathname === "/api/responses" && method === "POST";
  const isPublicResponseCount = pathname === "/api/responses" && method === "GET" && search.get("countOnly") === "true" && !!search.get("formId");
  const requiresAuth =
    pathname === "/api/forms/count" ||
    (pathname === "/api/forms" && method !== "GET") ||
    (pathname === "/api/forms" && method === "GET") ||
    (pathname.startsWith("/api/forms/") && !isFormDetailRead && !isFormViewIncrement) ||
    (pathname.startsWith("/api/responses") && !isPublicResponseSubmit && !isPublicResponseCount) ||
    pathname.startsWith("/api/profiles") ||
    (pathname.startsWith("/api/complaints") && method !== "POST");

  if (requiresAuth && !userId) {
    return sendJson(res, 401, { message: "Unauthorized" });
  }

  if (pathname === "/api/forms/count" && method === "GET") {
    const countUserId = search.get("userId");
    const since = search.get("since");
    if (countUserId && countUserId !== userId) {
      return sendJson(res, 403, { message: "Forbidden" });
    }
    let items = forms.filter((form) => isOwnedByUser(form, userId));
    items = filterBySince(items, since);
    return sendJson(res, 200, { count: items.length });
  }

  if (pathname === "/api/forms" && method === "GET") {
    let items = forms.filter((form) => isOwnedByUser(form, userId));
    const filterUserId = search.get("userId");
    const limit = Number(search.get("limit"));
    if (filterUserId && filterUserId !== userId) {
      return sendJson(res, 403, { message: "Forbidden" });
    }
    if (!Number.isNaN(limit) && limit > 0) items = items.slice(0, limit);
    return sendJson(res, 200, items);
  }

  if (pathname.startsWith("/api/forms/") && method === "GET") {
    const id = pathname.replace("/api/forms/", "");
    const form = forms.find((item) => item.id === id);
    if (!form) return sendJson(res, 404, { message: "Form not found" });
    if (!isPublicForm(form) && !isOwnedByUser(form, userId)) {
      return sendJson(res, 403, { message: "Forbidden" });
    }
    return sendJson(res, 200, form);
  }

  if (pathname === "/api/forms" && method === "POST") {
    const body = await parseJson(req);
    const form = {
      ...body,
      id: body.id || randomUUID(),
      views: body.views ?? 0,
      createdAt: body.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userId,
    };
    forms.push(form);
    return sendJson(res, 200, form);
  }

  if (pathname === "/api/forms/upsert" && method === "POST") {
    const body = await parseJson(req);
    const index = forms.findIndex((item) => item.id === body.id);
    if (index >= 0) {
      if (!isOwnedByUser(forms[index], userId)) {
        return sendJson(res, 403, { message: "Forbidden" });
      }
      forms[index] = { ...forms[index], ...body, updatedAt: new Date().toISOString() };
      return sendJson(res, 200, forms[index]);
    }
    const form = {
      ...body,
      id: body.id || randomUUID(),
      views: body.views ?? 0,
      createdAt: body.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userId,
    };
    forms.push(form);
    return sendJson(res, 200, form);
  }

  if (pathname.startsWith("/api/forms/") && pathname.endsWith("/increment-views") && method === "POST") {
    const id = pathname.replace("/api/forms/", "").replace("/increment-views", "");
    const form = forms.find((item) => item.id === id.replace(/\/$/, ""));
    if (!form) return sendJson(res, 404, { message: "Form not found" });
    form.views = (form.views ?? 0) + 1;
    return sendJson(res, 200, form);
  }

  if (pathname.startsWith("/api/forms/") && method === "PATCH") {
    const id = pathname.replace("/api/forms/", "");
    const body = await parseJson(req);
    const form = forms.find((item) => item.id === id);
    if (!form) return sendJson(res, 404, { message: "Form not found" });
    // Ownership check
    if (!isOwnedByUser(form, userId)) {
      return sendJson(res, 403, { message: "Forbidden" });
    }
    Object.assign(form, body, { updatedAt: new Date().toISOString() });
    return sendJson(res, 200, form);
  }

  if (pathname.startsWith("/api/forms/") && method === "DELETE") {
    const id = pathname.replace("/api/forms/", "");
    const form = forms.find((item) => item.id === id);
    if (!form) return sendJson(res, 404, { message: "Form not found" });
    // Ownership check
    if (!isOwnedByUser(form, userId)) {
      return sendJson(res, 403, { message: "Forbidden" });
    }
    const index = forms.findIndex((item) => item.id === id);
    if (index >= 0) forms.splice(index, 1);
    return sendJson(res, 204, {});
  }

  if (pathname === "/api/responses" && method === "GET") {
    let items = responses;
    const formId = search.get("formId");
    const formIds = search.get("formIds");
    const since = search.get("since");
    const countOnly = search.get("countOnly") === "true";
    const limit = Number(search.get("limit"));
    if (!userId) {
      const form = forms.find((item) => item.id === formId);
      if (!countOnly || !isPublicForm(form)) {
        return sendJson(res, 401, { message: "Unauthorized" });
      }
    } else {
      const ownedFormIds = new Set(forms.filter((form) => isOwnedByUser(form, userId)).map((form) => form.id));
      items = items.filter((item) => ownedFormIds.has(item.formId || item.form_id));
    }
    if (formId) items = items.filter((item) => (item.formId || item.form_id) === formId);
    if (formIds) items = filterByFormIds(items, formIds);
    items = filterBySince(items, since);
    if (!Number.isNaN(limit) && limit > 0) items = items.slice(0, limit);
    if (countOnly) return sendJson(res, 200, { count: items.length });
    return sendJson(res, 200, items);
  }

  if (pathname.startsWith("/api/responses/") && method === "GET") {
    const id = pathname.replace("/api/responses/", "");
    const responseItem = responses.find((item) => item.id === id);
    if (!responseItem) return sendJson(res, 404, { message: "Response not found" });
    // Ownership check via form ownership
    const form = forms.find((f) => f.id === (responseItem.formId || responseItem.form_id));
    if (!form || !isOwnedByUser(form, userId)) {
      return sendJson(res, 403, { message: "Forbidden" });
    }
    return sendJson(res, 200, responseItem);
  }

  if (pathname === "/api/responses" && method === "POST") {
    const body = await parseJson(req);
    const responseItem = {
      ...body,
      id: body.id || randomUUID(),
      submittedAt: body.submittedAt || new Date().toISOString(),
    };
    responses.push(responseItem);
    return sendJson(res, 200, responseItem);
  }

  if (pathname.startsWith("/api/responses/") && method === "DELETE") {
    const id = pathname.replace("/api/responses/", "");
    const responseItem = responses.find((item) => item.id === id);
    if (!responseItem) return sendJson(res, 404, { message: "Response not found" });
    // Ownership check via form ownership
    const form = forms.find((f) => f.id === (responseItem.formId || responseItem.form_id));
    if (!form || !isOwnedByUser(form, userId)) {
      return sendJson(res, 403, { message: "Forbidden" });
    }
    const index = responses.findIndex((item) => item.id === id);
    if (index >= 0) responses.splice(index, 1);
    return sendJson(res, 204, {});
  }

  if (pathname.startsWith("/api/profiles/") && method === "GET") {
    const id = pathname.replace("/api/profiles/", "");
    const profile = profiles.find((item) => item.id === id);
    if (!profile) return sendJson(res, 404, { message: "Profile not found" });
    // Ownership check
    if (id !== userId) {
      return sendJson(res, 403, { message: "Forbidden" });
    }
    return sendJson(res, 200, profile);
  }

  if (pathname.startsWith("/api/profiles/") && method === "PATCH") {
    const id = pathname.replace("/api/profiles/", "");
    const body = await parseJson(req);
    const profile = profiles.find((item) => item.id === id);
    if (!profile) return sendJson(res, 404, { message: "Profile not found" });
    // Ownership check
    if (id !== userId) {
      return sendJson(res, 403, { message: "Forbidden" });
    }
    Object.assign(profile, body);
    return sendJson(res, 200, profile);
  }

  if (pathname === "/api/profiles/upsert" && method === "POST") {
    const body = await parseJson(req);
    const existing = profiles.find((item) => item.id === body.id);
    if (existing) {
      Object.assign(existing, body);
      return sendJson(res, 200, existing);
    }
    const profile = { ...body, id: body.id || randomUUID(), created_at: new Date().toISOString() };
    profiles.push(profile);
    return sendJson(res, 200, profile);
  }

  if (pathname === "/api/complaints" && method === "GET") {
    let items = complaints;
    const status = search.get("status");
    const type = search.get("type");
    const since = search.get("since");
    const countOnly = search.get("countOnly") === "true";
    if (status) items = items.filter((item) => item.status === status);
    if (type) items = items.filter((item) => item.type === type);
    items = filterBySince(items, since);
    if (countOnly) return sendJson(res, 200, { count: items.length });
    return sendJson(res, 200, items);
  }

  if (pathname === "/api/complaints" && method === "POST") {
    const body = await parseJson(req);
    const complaint = { ...body, id: randomUUID(), created_at: new Date().toISOString() };
    complaints.push(complaint);
    return sendJson(res, 200, complaint);
  }

  if (pathname.startsWith("/api/complaints/") && method === "PATCH") {
    const id = pathname.replace("/api/complaints/", "");
    const body = await parseJson(req);
    const complaint = complaints.find((item) => item.id === id);
    if (!complaint) return sendJson(res, 404, { message: "Complaint not found" });
    Object.assign(complaint, body);
    return sendJson(res, 200, complaint);
  }

  // ─── AI: GENERATE FORM ───────────────────────────────────────────────────
  if (pathname === "/api/ai/generate-form" && method === "POST") {
    const body = await parseJson(req);
    const prompt = body.prompt || body.title || body.intent;
    if (!prompt) return sendJson(res, 400, { message: "Missing prompt" });

    const systemPrompt = `You are an expert form designer. Generate a professional form schema from the user's prompt.
Return ONLY a JSON object:
{
  "title": "Form title",
  "description": "Short form description",
  "questions": [
    {
      "id": "uuid",
      "title": "Question text",
      "type": "short_text|long_text|email|number|phone|single_choice|multiple_choice|dropdown|date|time|rating|linear_scale|yes_no",
      "required": true|false,
      "description": "Optional helper text",
      "options": [{"id": "uuid", "label": "Option label"}]
    }
  ]
}
Rules:
- Use logical ordering
- Include required fields where appropriate
- Choose the best question type for each question
- Keep questions clear and non-ambiguous`;

    try {
      const content = await callGroq([
        { role: "system", content: systemPrompt },
        { role: "user", content: `Generate a form for: ${prompt}` },
      ], "llama-3.3-70b-versatile", GROQ_API_KEY, true);

      const parsed = JSON.parse(content);
      if (parsed.questions) {
        parsed.questions = parsed.questions.map((question) => ({
          ...question,
          id: question.id || randomUUID(),
          options: question.options?.map((option) => ({ ...option, id: option.id || randomUUID() })),
        }));
      }
      return sendJson(res, 200, parsed);
    } catch (err) {
      console.error("generate-form error:", err);
      return sendJson(res, 500, { message: err.message || "AI form generation failed" });
    }
  }

  // ─── AI: ANALYZE RESPONSES ───────────────────────────────────────────────
  if (pathname === "/api/ai/analyze-responses" && method === "POST") {
    const body = await parseJson(req);
    const { form, responses: formResponses } = body;
    if (!form || !Array.isArray(formResponses)) {
      return sendJson(res, 400, { message: "Missing form or responses" });
    }

    const systemPrompt = `You are a research analyst. Summarize form responses, detect patterns, and highlight key insights.
Return ONLY a JSON object:
{
  "content": "Concise markdown analysis with summary, patterns, and key insights"
}`;

    try {
      const content = await callGroq([
        { role: "system", content: systemPrompt },
        { role: "user", content: `Form:\n${JSON.stringify({ title: form.title, questions: form.questions }, null, 2)}\n\nResponses:\n${JSON.stringify(formResponses, null, 2)}` },
      ], "llama-3.3-70b-versatile", GROQ_API_KEY, true);

      return sendJson(res, 200, JSON.parse(content));
    } catch (err) {
      console.error("analyze-responses error:", err);
      return sendJson(res, 500, { message: err.message || "AI response analysis failed" });
    }
  }

  // ─── AI: SUGGEST NEXT QUESTION ───────────────────────────────────────────
  if (pathname === "/api/ai/suggest-question" && method === "POST") {
    const body = await parseJson(req);
    const { formSchema } = body;
    if (!formSchema) return sendJson(res, 400, { message: "Missing formSchema" });

    const systemPrompt = `You are an expert form designer. Given the current form schema, suggest the next 3 most relevant questions to add.
Rules:
- Avoid repetition with existing questions
- Focus on improving data quality
- Ensure logical flow
- Each suggestion must include a "why" explanation

Return ONLY a JSON object with this structure:
{
  "suggestions": [
    {
      "title": "Question text here",
      "type": "short_text|long_text|email|number|phone|single_choice|multiple_choice|dropdown|date|time|rating|linear_scale|yes_no",
      "required": true|false,
      "description": "Optional helper text",
      "options": [{"id": "uuid", "label": "Option label"}],
      "why": "Brief explanation of why this question is valuable"
    }
  ]
}`;

    try {
      const content = await callGroq([
        { role: "system", content: systemPrompt },
        { role: "user", content: `Current form schema:\n${JSON.stringify(formSchema, null, 2)}\n\nSuggest the next 3 best questions.` },
      ], "llama-3.3-70b-versatile", GROQ_API_KEY, true);

      const parsed = JSON.parse(content);
      // Inject UUIDs into options if missing
      if (parsed.suggestions) {
        parsed.suggestions = parsed.suggestions.map(s => ({
          ...s,
          id: randomUUID(),
          options: s.options?.map(o => ({ ...o, id: o.id || randomUUID() })),
        }));
      }
      return sendJson(res, 200, parsed);
    } catch (err) {
      console.error("suggest-question error:", err);
      return sendJson(res, 500, { message: err.message || "AI suggestion failed" });
    }
  }

  // ─── AI: REFINE QUESTION ─────────────────────────────────────────────────
  if (pathname === "/api/ai/refine-question" && method === "POST") {
    const body = await parseJson(req);
    const { question } = body;
    if (!question) return sendJson(res, 400, { message: "Missing question" });

    const systemPrompt = `You are an expert form designer. Improve the given question to make it more clear, engaging, and precise.

Return ONLY a JSON object:
{
  "refined": "The improved question text",
  "type": "suggested question type (same or better)",
  "description": "Optional helper text for the respondent",
  "improvements": ["List of what was improved"]
}`;

    try {
      const content = await callGroq([
        { role: "system", content: systemPrompt },
        { role: "user", content: `Improve this question: "${question}"` },
      ], "llama-3.3-70b-versatile", GROQ_API_KEY, true);

      return sendJson(res, 200, JSON.parse(content));
    } catch (err) {
      console.error("refine-question error:", err);
      return sendJson(res, 500, { message: err.message || "AI refinement failed" });
    }
  }

  // ─── AI: INTERVIEW FLOW ──────────────────────────────────────────────────
  if (pathname === "/api/ai/interview-flow" && method === "POST") {
    const body = await parseJson(req);
    const { title, previousAnswers } = body;
    if (!title) return sendJson(res, 400, { message: "Missing title" });

    const systemPrompt = `You are a professional interviewer conducting a dynamic interview.
Based on the interview title and the candidate's previous answers, generate the next adaptive question.
Keep it natural, conversational, and progressively deeper.

Return ONLY a JSON object:
{
  "question": "The next interview question",
  "type": "short_text|long_text|single_choice|multiple_choice|rating|yes_no",
  "options": [{"id": "uuid", "label": "Option"}],
  "hint": "Optional hint or context for the respondent",
  "isFollowUp": true|false
}`;

    const answersText = previousAnswers?.length
      ? previousAnswers.map((a, i) => `Q${i + 1}: ${a.question}\nA${i + 1}: ${a.answer}`).join("\n\n")
      : "No previous answers yet — this is the first dynamic question.";

    try {
      const content = await callGroq([
        { role: "system", content: systemPrompt },
        { role: "user", content: `Interview Title: "${title}"\n\nPrevious Q&A:\n${answersText}\n\nGenerate the next question.` },
      ], "llama-3.3-70b-versatile", GROQ_API_KEY, true);

      const parsed = JSON.parse(content);
      if (parsed.options) {
        parsed.options = parsed.options.map(o => ({ ...o, id: o.id || randomUUID() }));
      }
      return sendJson(res, 200, parsed);
    } catch (err) {
      console.error("interview-flow error:", err);
      return sendJson(res, 500, { message: err.message || "AI interview flow failed" });
    }
  }

  // ─── AI: RESEARCH ENHANCE ────────────────────────────────────────────────
  if (pathname === "/api/ai/research-enhance" && method === "POST") {
    const body = await parseJson(req);
    const { topic, targetAudience, researchGoal } = body;
    if (!topic) return sendJson(res, 400, { message: "Missing topic" });

    const systemPrompt = `You are an expert research designer. Generate a comprehensive, structured research form.

Return ONLY a JSON object:
{
  "title": "Research form title",
  "description": "Brief description of the research",
  "sections": [
    {
      "name": "Section name (e.g. Demographics, Opinions, Behavior)",
      "tag": "demographics|opinions|behavior|experience|other",
      "questions": [
        {
          "id": "uuid",
          "title": "Question text",
          "type": "short_text|long_text|single_choice|multiple_choice|rating|linear_scale|yes_no|number",
          "required": true|false,
          "description": "Optional helper text",
          "options": [{"id": "uuid", "label": "Option label"}]
        }
      ]
    }
  ],
  "insights": ["Key insight this research will uncover"],
  "suggestedAnalytics": ["Suggested analysis methods"]
}`;

    try {
      const content = await callGroq([
        { role: "system", content: systemPrompt },
        { role: "user", content: `Topic: ${topic}\nTarget Audience: ${targetAudience || "General public"}\nResearch Goal: ${researchGoal || "Understand opinions and behaviors"}` },
      ], "llama-3.3-70b-versatile", GROQ_RESEARCH_API_KEY, true);

      const parsed = JSON.parse(content);
      // Inject UUIDs
      if (parsed.sections) {
        parsed.sections = parsed.sections.map(section => ({
          ...section,
          questions: section.questions?.map(q => ({
            ...q,
            id: q.id || randomUUID(),
            options: q.options?.map(o => ({ ...o, id: o.id || randomUUID() })),
          })),
        }));
      }
      return sendJson(res, 200, parsed);
    } catch (err) {
      console.error("research-enhance error:", err);
      return sendJson(res, 500, { message: err.message || "AI research generation failed" });
    }
  }

  // ─── AI: OPTIMIZE FORM ───────────────────────────────────────────────────
  if (pathname === "/api/ai/optimize-form" && method === "POST") {
    const body = await parseJson(req);
    const { form } = body;
    if (!form) return sendJson(res, 400, { message: "Missing form" });

    const systemPrompt = `You are an expert form optimizer. Analyze the given form and return an improved version.
- Remove redundant or duplicate questions
- Improve question clarity and phrasing
- Reorder questions for better logical flow
- Suggest better question types where appropriate

Return ONLY a JSON object:
{
  "questions": [ /* improved questions array, same structure as input */ ],
  "changes": ["Description of each change made"],
  "removedCount": 0,
  "improvedCount": 0
}`;

    try {
      const content = await callGroq([
        { role: "system", content: systemPrompt },
        { role: "user", content: `Optimize this form:\nTitle: ${form.title}\nQuestions:\n${JSON.stringify(form.questions, null, 2)}` },
      ], "llama-3.3-70b-versatile", GROQ_API_KEY, true);

      const parsed = JSON.parse(content);
      if (parsed.questions) {
        parsed.questions = parsed.questions.map(q => ({
          ...q,
          id: q.id || randomUUID(),
          options: q.options?.map(o => ({ ...o, id: o.id || randomUUID() })),
        }));
      }
      return sendJson(res, 200, parsed);
    } catch (err) {
      console.error("optimize-form error:", err);
      return sendJson(res, 500, { message: err.message || "AI optimization failed" });
    }
  }

  // ─── AI: REFINE SINGLE QUESTION ──────────────────────────────────────────
  // (already handled above as /api/ai/refine-question)

  // ─── AI: AUTO CATEGORISE ─────────────────────────────────────────────────
  if (pathname === "/api/ai/auto-categorise" && method === "POST") {
    const body = await parseJson(req);
    const { questions, formTitle } = body;
    if (!questions) return sendJson(res, 400, { message: "Missing questions" });

    const systemPrompt = `You are an expert form designer. Group the given questions into logical sections.
Each section should have a clear name and contain related questions.

Return ONLY a JSON object:
{
  "sections": [
    {
      "name": "Section name",
      "description": "Brief description of this section",
      "questionIds": ["id1", "id2"]
    }
  ],
  "reasoning": "Brief explanation of the grouping logic"
}`;

    try {
      const content = await callGroq([
        { role: "system", content: systemPrompt },
        { role: "user", content: `Form: "${formTitle}"\nQuestions:\n${JSON.stringify(questions.map(q => ({ id: q.id, title: q.title, type: q.type })), null, 2)}\n\nGroup these into logical sections.` },
      ], "llama-3.3-70b-versatile", GROQ_API_KEY, true);

      return sendJson(res, 200, JSON.parse(content));
    } catch (err) {
      console.error("auto-categorise error:", err);
      return sendJson(res, 500, { message: err.message || "Auto categorisation failed" });
    }
  }

  // ─── AI: SMART VALIDATION ────────────────────────────────────────────────
  if (pathname === "/api/ai/smart-validation" && method === "POST") {
    const body = await parseJson(req);
    const { question } = body;
    if (!question) return sendJson(res, 400, { message: "Missing question" });

    const systemPrompt = `You are an expert form validator. Suggest the best validation rules for the given question.

Return ONLY a JSON object:
{
  "required": true|false,
  "suggestions": [
    {
      "rule": "Rule name (e.g. email_format, min_length, max_length, numeric_only, phone_format)",
      "description": "Human-readable description",
      "value": "Optional value (e.g. 10 for min_length)"
    }
  ],
  "reasoning": "Why these validations improve data quality"
}`;

    try {
      const content = await callGroq([
        { role: "system", content: systemPrompt },
        { role: "user", content: `Question: "${question.title}"\nType: ${question.type}\nSuggest validation rules.` },
      ], "llama-3.3-70b-versatile", GROQ_API_KEY, true);

      return sendJson(res, 200, JSON.parse(content));
    } catch (err) {
      console.error("smart-validation error:", err);
      return sendJson(res, 500, { message: err.message || "Smart validation failed" });
    }
  }

  // ─── AI: TONE CONTROL ────────────────────────────────────────────────────
  if (pathname === "/api/ai/tone-control" && method === "POST") {
    const body = await parseJson(req);
    const { questions, tone, formTitle } = body;
    if (!questions || !tone) return sendJson(res, 400, { message: "Missing questions or tone" });

    const toneDescriptions = {
      formal: "professional, corporate, precise language",
      casual: "relaxed, conversational, friendly but not overly informal",
      friendly: "warm, encouraging, approachable, uses simple words"
    };

    const systemPrompt = `You are an expert copywriter. Rewrite the given form questions in a ${tone} tone (${toneDescriptions[tone] || tone}).
Keep the meaning identical, only change the wording style.

Return ONLY a JSON object:
{
  "questions": [
    {
      "id": "original id",
      "title": "rewritten question",
      "description": "rewritten description if present"
    }
  ]
}`;

    try {
      const content = await callGroq([
        { role: "system", content: systemPrompt },
        { role: "user", content: `Form: "${formTitle}"\nTone: ${tone}\nRewrite these questions:\n${JSON.stringify(questions.map(q => ({ id: q.id, title: q.title, description: q.description, type: q.type })), null, 2)}` },
      ], "llama-3.3-70b-versatile", GROQ_API_KEY, true);

      return sendJson(res, 200, JSON.parse(content));
    } catch (err) {
      console.error("tone-control error:", err);
      return sendJson(res, 500, { message: err.message || "Tone control failed" });
    }
  }

  // ─── AI: MULTILINGUAL TRANSLATE ──────────────────────────────────────────
  if (pathname === "/api/ai/translate" && method === "POST") {
    const body = await parseJson(req);
    const { questions, targetLanguage, formTitle, formDescription } = body;
    if (!questions || !targetLanguage) return sendJson(res, 400, { message: "Missing questions or targetLanguage" });

    const systemPrompt = `You are an expert translator. Translate the given form content into ${targetLanguage}.
Preserve the tone and meaning. Localize naturally — don't translate word-for-word.

Return ONLY a JSON object:
{
  "title": "translated form title",
  "description": "translated form description",
  "questions": [
    {
      "id": "original id",
      "title": "translated question",
      "description": "translated description if present",
      "options": [{"id": "original id", "label": "translated label"}]
    }
  ]
}`;

    try {
      const content = await callGroq([
        { role: "system", content: systemPrompt },
        { role: "user", content: `Translate to: ${targetLanguage}\nForm title: "${formTitle}"\nDescription: "${formDescription || ''}"\nQuestions:\n${JSON.stringify(questions.map(q => ({ id: q.id, title: q.title, description: q.description, type: q.type, options: q.options })), null, 2)}` },
      ], "llama-3.3-70b-versatile", GROQ_RESEARCH_API_KEY, true);

      return sendJson(res, 200, JSON.parse(content));
    } catch (err) {
      console.error("translate error:", err);
      return sendJson(res, 500, { message: err.message || "Translation failed" });
    }
  }
  return sendJson(res, 404, { message: "Endpoint not found" });
});

server.listen(PORT, () => {
  console.log(`Local API server running on http://localhost:${PORT}`);
});
