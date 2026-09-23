import fs from "node:fs/promises";
import { retryWithBackoff } from "./retry.js";

function ollamaBaseUrl(settings) {
  return String(settings.ollamaBaseUrl || "http://localhost:11434").replace(
    /\/+$/,
    "",
  );
}

async function ollamaFetch(settings, path, init = {}) {
  const base = ollamaBaseUrl(settings);
  const url = `${base}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Ollama request failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    );
  }
  return response.json();
}

async function chat(settings, systemPrompt, userPrompt, options = {}) {
  const model = options.model || settings.ollamaSummaryModel || "gemma3:4b";
  const data = await retryWithBackoff(
    async () => {
      return ollamaFetch(settings, "/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model,
          temperature: options.temperature ?? 0.4,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });
    },
    { attempts: 3 },
  );
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("AI returned empty response");
  }
  return content.trim();
}

export async function checkOllamaStatus(settings) {
  const base = ollamaBaseUrl(settings);
  try {
    const response = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      return { online: false, error: `HTTP ${response.status}` };
    const data = await response.json();
    const models = (data.models || []).map((m) => m.name);
    return { online: true, models, url: base };
  } catch (error) {
    return { online: false, error: error.message, url: base };
  }
}

export async function transcribeAudio(settings, { filePath, buffer }) {
  const model = settings.ollamaTranscriptionModel || "whisper";
  if (buffer) {
    const base64 = buffer.toString("base64");
    const data = await retryWithBackoff(
      async () => {
        return ollamaFetch(settings, "/api/transcribe", {
          method: "POST",
          body: JSON.stringify({ model, images: [base64] }),
        });
      },
      { attempts: 3 },
    );
    return String(data.text || "").trim();
  }
  const fileBuffer = await fs.readFile(filePath);
  const base64 = fileBuffer.toString("base64");
  const data = await retryWithBackoff(
    async () => {
      return ollamaFetch(settings, "/api/transcribe", {
        method: "POST",
        body: JSON.stringify({ model, images: [base64] }),
      });
    },
    { attempts: 3 },
  );
  return String(data.text || "").trim();
}

export async function summarizeTranscript(
  settings,
  { transcript, title, contact },
) {
  return chat(
    settings,
    "You write concise, accurate CRM call summaries.",
    `Summarize this sales call transcript for a CRM workspace.

Title: ${title || "Untitled"}
Contact: ${contact || "Unknown"}

Transcript:
${String(transcript || "").slice(0, 60000)}

Return the summary as plain text with these sections:
- Key points (short bullet list)
- Customer signals (pain points, budget, timeline, decision makers)
- Next steps
- Suggested follow-up message`,
  );
}

export async function suggestReplies(
  settings,
  { subject, body, to, contact, history },
) {
  return chat(
    settings,
    "You are a sales email assistant. Generate 3 reply suggestions for the user to choose from.",
    `Generate 3 reply suggestions for this email.

From: ${to || "Unknown"}
Contact: ${contact || "Unknown"}
Subject: ${subject || "(no subject)"}
Message:
${String(body || "").slice(0, 8000)}
${history ? `\nPrevious conversation:\n${String(history).slice(0, 4000)}` : ""}

Return ONLY valid JSON array with 3 objects, each having "tone" (Formal/Short/Friendly) and "text" (the reply body). No markdown, no explanation.`,
    { temperature: 0.6 },
  );
}

export async function scoreLead(
  settings,
  {
    name,
    email,
    company,
    source,
    status,
    phone,
    role,
    notes,
    activityCount,
    dealValue,
    daysSinceContact,
  },
) {
  const facts = [
    name && `Name: ${name}`,
    email && `Email: ${email}`,
    company && `Company: ${company}`,
    source && `Source: ${source}`,
    status && `Status: ${status}`,
    phone && `Has phone: yes`,
    role && `Role: ${role}`,
    notes && `Notes: ${String(notes).slice(0, 500)}`,
    activityCount !== undefined && `Total activities: ${activityCount}`,
    dealValue !== undefined && `Deal value: $${dealValue}`,
    daysSinceContact !== undefined &&
      `Days since last contact: ${daysSinceContact}`,
  ]
    .filter(Boolean)
    .join("\n");

  const result = await chat(
    settings,
    "You are a lead scoring engine for a CRM. Score leads based on available data.",
    `Score this lead from 1 (cold) to 10 (hot) based on the data below. Consider: engagement level, data completeness, recency, deal value.

Lead data:
${facts}

Return ONLY valid JSON: {"score": <1-10>, "label": "Hot/Warm/Cold", "reason": "<one sentence>"}`,
    { temperature: 0.2 },
  );
  try {
    return JSON.parse(
      result
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim(),
    );
  } catch {
    return {
      score: 5,
      label: "Warm",
      reason: "Insufficient data for precise scoring",
    };
  }
}

export async function generateMeetingBrief(
  settings,
  { contact, deals, activities, notes },
) {
  return chat(
    settings,
    "You are a sales prep assistant. Generate a concise meeting brief.",
    `Generate a meeting preparation brief for this contact.

Contact: ${JSON.stringify(contact || {})}
${deals?.length ? `Active deals:\n${JSON.stringify(deals, null, 2)}` : "No active deals"}
${activities?.length ? `Recent activities:\n${JSON.stringify(activities.slice(0, 10), null, 2)}` : "No recent activities"}
${notes?.length ? `Notes:\n${JSON.stringify(notes.slice(0, 5), null, 2)}` : "No notes"}

Return a brief with:
1. Who they are (1-2 sentences)
2. Relationship summary (interactions, deals)
3. Key topics to discuss
4. Suggested talking points (3-5 bullets)
5. Potential next steps`,
    { temperature: 0.3 },
  );
}

export async function generateCallScript(
  settings,
  { contact, type, product, stage },
) {
  return chat(
    settings,
    "You are a sales call script writer. Create natural, conversational scripts.",
    `Write a call script for a ${type || "prospecting"} call.

Contact: ${contact?.name || "Unknown"}${contact?.company ? ` at ${contact.company}` : ""}
Product/Service: ${product || "our solution"}
Pipeline stage: ${stage || "Early stage"}

Return a script with:
1. Opening (friendly, professional)
2. Discovery questions (3-5 relevant questions)
3. Value proposition (tailored to likely pain points)
4. Objection handling (2-3 common objections)
5. Closing / next steps`,
    { temperature: 0.5 },
  );
}

export async function generatePipelineInsights(
  settings,
  { deals, activities, contacts },
) {
  return chat(
    settings,
    "You are a sales analytics AI. Analyze pipeline health and provide actionable insights.",
    `Analyze this CRM pipeline data and provide weekly insights.

Active deals (${deals?.length || 0}):
${JSON.stringify(deals?.slice(0, 30) || [], null, 2)}

Recent activities (${activities?.length || 0}):
${JSON.stringify(activities?.slice(0, 20) || [], null, 2)}

Contacts: ${contacts?.length || 0} total

Provide:
1. Pipeline health summary (1-2 sentences)
2. At-risk deals (specific deals with reasons)
3. Deals with strong momentum
4. Stalled deals needing attention
5. Recommended actions (top 5 priorities)
6. Week-over-week trend assessment`,
    { temperature: 0.3 },
  );
}

export async function enrichContact(
  settings,
  { name, email, company, domain },
) {
  return chat(
    settings,
    "You are a contact enrichment engine. Suggest likely data for incomplete contacts based on patterns.",
    `Enrich this contact record with likely data. Mark suggestions as "suggested" (not confirmed).

Known data:
Name: ${name || "Unknown"}
Email: ${email || "Unknown"}
Company: ${company || "Unknown"}
${domain ? `Domain: ${domain}` : ""}

Return ONLY valid JSON: {
  "suggested_role": "...",
  "suggested_industry": "...",
  "company_size": "likely range",
  "conversation_starters": ["topic1", "topic2", "topic3"],
  "enrichment_notes": "brief assessment"
}`,
    { temperature: 0.4 },
  );
}

export async function writeSequence(
  settings,
  { contact, product, goal, steps },
) {
  return chat(
    settings,
    "You are an email sequence writer for sales outreach. Write natural, personalized sequences.",
    `Write a ${steps || 3}-step email sequence for this outreach goal.

Contact: ${contact?.name || "Target contact"}${contact?.company ? ` at ${contact.company}` : ""}
Product/Service: ${product || "our solution"}
Goal: ${goal || "Book a demo meeting"}

For each step provide:
1. Subject line
2. Email body (2-4 short paragraphs)
3. Delay from previous (e.g., "2 days", "1 week")
4. Purpose of this email

Make each email progressively more specific and value-driven. No spammy language.`,
    { temperature: 0.5 },
  );
}

export async function autoLogActivity(settings, { text, contact, context }) {
  return chat(
    settings,
    "You are an activity logger. Extract structured activities from unstructured text.",
    `Extract structured activities from this text. Return each activity as an object.

Text: ${String(text || "").slice(0, 4000)}
Contact: ${contact || "Unknown"}
Context: ${context || "CRM activity"}

Return ONLY valid JSON array with objects: [{"type": "Note|Meeting|Email|Call|Task", "title": "short title", "notes": "details", "date": "YYYY-MM-DD or empty", "suggested_action": "optional follow-up"}]`,
    { temperature: 0.2 },
  );
}

export async function smartSearch(settings, { query, resources }) {
  return chat(
    settings,
    "You are a CRM search interpreter. Convert natural language queries into structured search filters.",
    `Convert this natural language search into structured filters for the CRM.

User query: "${query}"
Available resources: ${resources?.join(", ") || "leads, contacts, companies, deals, activities, tasks"}

Return ONLY valid JSON: {
  "intent": "brief description of what user wants",
  "filters": [{"resource": "...", "field": "...", "operator": "eq|contains|gt|lt|between", "value": "..."}],
  "sort": {"field": "...", "direction": "asc|desc"},
  "limit": 20
}`,
    { temperature: 0.1 },
  );
}

export async function calculateWinProbability(
  settings,
  { deal, activities, contacts, historicalDeals },
) {
  return chat(
    settings,
    "You are a deal prediction engine. Calculate win probability based on deal characteristics and patterns.",
    `Calculate the win probability for this deal.

Deal: ${JSON.stringify(deal || {}, null, 2)}
Recent activities on this deal: ${activities?.length || 0}
Associated contacts: ${contacts?.length || 0}
${historicalDeals?.length ? `Historical closed deals:\n${JSON.stringify(historicalDeals.slice(0, 10), null, 2)}` : ""}

Return ONLY valid JSON: {
  "probability": <0-100>,
  "confidence": "high|medium|low",
  "factors": [{"factor": "...", "impact": "positive|negative|neutral", "weight": "..."}],
  "recommendation": "one actionable suggestion to improve odds"
}`,
    { temperature: 0.2 },
  );
}
