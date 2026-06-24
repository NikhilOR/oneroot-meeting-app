import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  deleteMeetingFromDb,
  fetchCurrentProfile,
  fetchMeetingsFromDb,
  fetchProfilesFromDb,
  getCurrentSession,
  hasSupabaseConfig,
  onAuthChanged,
  signInWithEmail,
  signOut,
  supabaseConfigError,
  upsertMeetingToDb,
} from "./supabaseMeetings";

const CUSTOM_TAGS_KEY = "or_custom_tags";
const CUSTOM_COLORS_KEY = "or_custom_tag_colors";
const GEMINI_API_KEY_KEY = "or_gemini_api_key";
const GEMINI_COOLDOWN_KEY = "or_gemini_cooldown_until";
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_PROXY_URL = "/api/gemini";
const TRANSCRIBE_PROXY_URL = "/api/transcribe";
const GOOGLE_SPEECH_WS_URL = import.meta.env.VITE_GOOGLE_SPEECH_WS_URL || "ws://localhost:8787/speech";

const VOICE_LANGUAGES = [
  ["en-IN", "English"],
  ["hi-IN", "Hindi"],
  ["te-IN", "Telugu"],
  ["ta-IN", "Tamil"],
  ["kn-IN", "Kannada"],
  ["ml-IN", "Malayalam"],
  ["mr-IN", "Marathi"],
  ["gu-IN", "Gujarati"],
  ["bn-IN", "Bengali"],
  ["ur-IN", "Urdu"],
];

const DEFAULT_TAGS = [
  "Vietnam",
  "Finance",
  "Hiring",
  "Strategy",
  "Ops",
  "Export",
  "Cashew",
  "Spices",
  "Retail",
  "Inputs",
  "Bio",
  "Contract Farming",
  "General",
];

const BASE_TAG_COLORS = {
  Vietnam: ["#dbeafe", "#1e40af"],
  Finance: ["#fef3c7", "#92400e"],
  Hiring: ["#fce7f3", "#9d174d"],
  Strategy: ["#ede9fe", "#5b21b6"],
  Ops: ["#e5e7eb", "#374151"],
  Export: ["#dcfce7", "#166534"],
  Cashew: ["#f5e8d3", "#7c3f16"],
  Spices: ["#fee2e2", "#991b1b"],
  Retail: ["#cffafe", "#155e75"],
  Inputs: ["#e0f2fe", "#0369a1"],
  Bio: ["#ccfbf1", "#134e4a"],
  "Contract Farming": ["#fef9c3", "#713f12"],
  General: ["#f3f4f6", "#374151"],
};

const COLOR_PALETTE = [
  ["#fce7f3", "#9d174d"],
  ["#ede9fe", "#5b21b6"],
  ["#dbeafe", "#1e40af"],
  ["#dcfce7", "#166534"],
  ["#fef3c7", "#92400e"],
  ["#fee2e2", "#991b1b"],
  ["#ccfbf1", "#134e4a"],
  ["#fef9c3", "#713f12"],
  ["#e0f2fe", "#0369a1"],
  ["#fff7ed", "#9a3412"],
];

const STATUS_MAP = {
  open: { label: "Open", bg: "#f0fdf4", color: "#166534", border: "#bbf7d0" },
  completed: { label: "Completed", bg: "#d1fae5", color: "#065f46", border: "#6ee7b7" },
  closed: { label: "Closed", bg: "#f1f5f9", color: "#475569", border: "#cbd5e1" },
  postponed: { label: "Postponed", bg: "#fef3c7", color: "#92400e", border: "#fde68a" },
};

const pageStyle = {
  minHeight: "100vh",
  background: "#f7f7f5",
  color: "#222",
  fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
};
const wrapStyle = { maxWidth: 880, margin: "0 auto", padding: "22px 16px 34px" };
const cardStyle = { background: "#fff", border: "1px solid #e9e9e4", borderRadius: 8, padding: 18, boxShadow: "0 8px 26px rgba(20,24,20,0.06)" };
const inputStyle = { width: "100%", boxSizing: "border-box", border: "1px solid #deded8", borderRadius: 8, padding: "10px 12px", fontSize: 14, outline: "none", background: "#fff" };
const labelStyle = { display: "block", fontSize: 12, color: "#666", fontWeight: 750, marginBottom: 6 };
const smallMuted = { fontSize: 12, color: "#8a8a82" };

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function useResponsive() {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return { width, isMobile: width < 640, isTablet: width >= 640 && width < 960 };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function fmtDate(value) {
  if (!value) return "";
  return new Date(value + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function namesFromAttendees(value) {
  return (value || "").split(",").map((name) => name.trim()).filter(Boolean);
}

function initials(name) {
  return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function normalize(value) {
  return (value || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function actionTokens(value) {
  const stopwords = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "including", "into", "is", "of", "on", "or", "should", "the", "their", "them", "then", "to", "with"]);
  return normalize(value)
    .split(" ")
    .map((token) => token.replace(/(ing|ed|es|s)$/i, ""))
    .filter((token) => token.length > 2 && !stopwords.has(token));
}

function actionSimilarity(a, b) {
  const aTokens = new Set(actionTokens(a));
  const bTokens = new Set(actionTokens(b));
  if (!aTokens.size || !bTokens.size) return 0;
  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  return intersection / union;
}

function actionCoreKey(value) {
  return actionTokens(value)
    .filter((token) => !["other", "additional", "also", "need", "needed", "responsible"].includes(token))
    .sort()
    .join(" ");
}

function isSimilarAction(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length > 18 && right.length > 18 && (left.includes(right) || right.includes(left))) return true;
  const leftKey = actionCoreKey(left);
  const rightKey = actionCoreKey(right);
  if (leftKey && rightKey && (leftKey.includes(rightKey) || rightKey.includes(leftKey))) return true;
  return actionSimilarity(left, right) >= 0.34;
}

function actionInfoScore(action) {
  return [
    action.assignee,
    action.delegate,
    action.remarks,
    action.postponeDate,
    action.status && action.status !== "open" ? action.status : "",
  ].filter(Boolean).length;
}

function mergeDuplicateActions(primary, duplicate) {
  const primaryText = primary.text || "";
  const duplicateText = duplicate.text || "";
  const keepDuplicateText = duplicateText.length > primaryText.length + 12;
  return {
    ...primary,
    text: keepDuplicateText ? duplicateText : primaryText,
    assignee: primary.assignee || duplicate.assignee || "",
    delegate: primary.delegate || duplicate.delegate || "",
    category: primary.category || duplicate.category || "General",
    status: primary.status && primary.status !== "open" ? primary.status : (duplicate.status || primary.status || "open"),
    postponeDate: primary.postponeDate || duplicate.postponeDate || "",
    remarks: primary.remarks || duplicate.remarks || "",
  };
}

function dedupeActions(actions = []) {
  const cleaned = [];
  for (const action of actions) {
    const text = (action.text || "").trim();
    if (!text) continue;
    const normalizedAction = { ...action, text };
    const matchIndex = cleaned.findIndex((existing) => isSimilarAction(existing.text, text));
    if (matchIndex === -1) {
      cleaned.push(normalizedAction);
      continue;
    }
    const existing = cleaned[matchIndex];
    const existingScore = actionInfoScore(existing);
    const newScore = actionInfoScore(normalizedAction);
    const base = newScore > existingScore ? normalizedAction : existing;
    const extra = newScore > existingScore ? existing : normalizedAction;
    cleaned[matchIndex] = mergeDuplicateActions(base, extra);
  }
  return cleaned;
}

function cleanMeetingActions(meeting) {
  return { ...meeting, actions: dedupeActions(meeting.actions || []) };
}

function waitLabel(ms) {
  const seconds = Math.ceil(ms / 1000);
  if (seconds <= 60) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function getGeminiCooldown() {
  const until = Number(localStorage.getItem(GEMINI_COOLDOWN_KEY) || 0);
  return Number.isFinite(until) ? until : 0;
}

function setGeminiCooldown(ms) {
  localStorage.setItem(GEMINI_COOLDOWN_KEY, String(Date.now() + ms));
}

function parseRetryDelay(value) {
  if (!value) return 60_000;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.max(1, numeric) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1_000, date - Date.now()) : 60_000;
}

function extractErrorMessage(payload, fallback) {
  if (!payload) return fallback;
  if (typeof payload === "string") return payload;
  return payload.error?.message || payload.message || fallback;
}

function textMentionsName(text, name) {
  if (!name) return false;
  const note = normalize(text);
  const person = normalize(name);
  if (!person) return false;
  return note.split(" ").includes(person) || note.includes(person);
}

function mergeExtractedAction(existing, extracted, correctedNotes) {
  return {
    ...existing,
    text: existing.text || extracted.text || "",
    category: existing.category || extracted.category || "General",
    assignee: existing.assignee || extracted.assignee || "",
    delegate: existing.delegate || extracted.delegate || "",
    status: existing.status || "open",
    postponeDate: existing.postponeDate || "",
    remarks: existing.remarks || "",
  };
}

function syncActionsToNotes(existingActions = [], extractedActions = [], correctedNotes = "") {
  const synced = existingActions.map((action) => ({ ...blankAction(), ...action }));
  for (const extracted of extractedActions) {
    const cleanText = (extracted.text || "").trim();
    if (!cleanText) continue;
    const normalizedExtracted = { ...blankAction(), ...extracted, text: cleanText };
    const existingIndex = synced.findIndex((action) => isSimilarAction(action.text, cleanText));
    if (existingIndex === -1) {
      synced.push(normalizedExtracted);
      continue;
    }
    synced[existingIndex] = mergeExtractedAction(synced[existingIndex], normalizedExtracted, correctedNotes);
  }
  return synced;
}

function blankAction() {
  return { id: genId(), text: "", assignee: "", delegate: "", category: "General", status: "open", postponeDate: "", remarks: "" };
}

function appendNotes(existing, nextText) {
  const cleanText = (nextText || "").trim();
  if (!cleanText) return existing || "";
  return existing ? existing.trimEnd() + "\n" + cleanText : cleanText;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function tagColor(tag, customColors = {}) {
  return BASE_TAG_COLORS[tag] || customColors[tag] || ["#f3f4f6", "#374151"];
}

function actionCardStyle(category, customColors = {}) {
  const [bg, color] = tagColor(category || "General", customColors);
  return {
    background: bg,
    color,
    border: "1px solid " + color + "22",
    borderLeft: "4px solid " + color,
    borderRadius: 8,
  };
}

function ActionNumber({ number, category, customColors }) {
  const [, color] = tagColor(category || "General", customColors);
  return (
    <span style={{ minWidth: 28, height: 28, borderRadius: 999, background: color, color: "#fff", display: "inline-grid", placeItems: "center", fontSize: 12, fontWeight: 900, flexShrink: 0 }}>
      {number}
    </span>
  );
}

function TagChip({ tag, selected, onClick, customColors, onDelete }) {
  const [bg, color] = selected ? ["#1D9E75", "#fff"] : tagColor(tag, customColors);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <button type="button" onClick={onClick} style={{ border: "1px solid " + (selected ? "#1D9E75" : "transparent"), background: bg, color, borderRadius: 999, padding: "5px 10px", fontSize: 12, fontWeight: 750, cursor: onClick ? "pointer" : "default" }}>
        {tag}
      </button>
      {onDelete && (
        <button type="button" onClick={onDelete} title="Delete custom tag" style={{ border: 0, background: "transparent", color: "#999", cursor: "pointer", fontWeight: 800, padding: 0 }}>
          x
        </button>
      )}
    </span>
  );
}

function Button({ children, tone, style, ...props }) {
  const tones = {
    primary: { background: "#1D9E75", color: "#fff", border: "#1D9E75" },
    purple: { background: "#7c3aed", color: "#fff", border: "#7c3aed" },
    danger: { background: "#fff", color: "#dc2626", border: "#fecaca" },
    plain: { background: "#fff", color: "#333", border: "#d8d8d2" },
  };
  const t = tones[tone || "plain"];
  return (
    <button {...props} style={{ border: "1px solid " + t.border, background: t.background, color: t.color, borderRadius: 8, padding: "9px 13px", fontSize: 13, fontWeight: 750, cursor: props.disabled ? "not-allowed" : "pointer", opacity: props.disabled ? 0.6 : 1, ...style }}>
      {children}
    </button>
  );
}

function LoginScreen({ status }) {
  const screen = useResponsive();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState(status || "");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (!email.trim() || !password) {
      setMessage("Enter your email and password.");
      return;
    }
    setBusy(true);
    setMessage("Signing in...");
    try {
      await signInWithEmail(email.trim(), password);
      setMessage("Signed in.");
    } catch (error) {
      setMessage(error?.message || "Sign in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={pageStyle}>
      <div style={{ ...wrapStyle, maxWidth: 420, paddingTop: screen.isMobile ? 36 : 80 }}>
        <form onSubmit={submit} style={cardStyle}>
          <div style={{ fontSize: 24, fontWeight: 900, marginBottom: 4 }}><span style={{ color: "#1D9E75" }}>OneRoot</span> Meetings</div>
          <div style={{ ...smallMuted, marginBottom: 18 }}>Sign in to view your meetings</div>
          <div>
            <label style={labelStyle}>Email</label>
            <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" style={inputStyle} />
          </div>
          <div style={{ marginTop: 12 }}>
            <label style={labelStyle}>Password</label>
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" style={inputStyle} />
          </div>
          <Button type="submit" tone="primary" disabled={busy || !hasSupabaseConfig} style={{ width: "100%", marginTop: 16 }}>{busy ? "Signing in..." : "Sign In"}</Button>
          {message && <div style={{ ...smallMuted, marginTop: 12, color: message.includes("failed") || message.includes("Missing") ? "#b45309" : "#777" }}>{message}</div>}
        </form>
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  const st = STATUS_MAP[status || "open"];
  return <span style={{ background: st.bg, color: st.color, border: "1px solid " + st.border, borderRadius: 999, padding: "3px 9px", fontSize: 11, fontWeight: 750 }}>{st.label}</span>;
}

async function geminiMessage(prompt, maxTokens = 1200, responseMimeType = "text/plain") {
  const cooldownUntil = getGeminiCooldown();
  if (cooldownUntil > Date.now()) {
    throw new Error(`Gemini quota limit reached. Try again in ${waitLabel(cooldownUntil - Date.now())}.`);
  }

  const payload = {
    model: GEMINI_MODEL,
    prompt,
    maxTokens,
    responseMimeType,
  };

  const proxied = await fetch(GEMINI_PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (proxied.ok) {
    const data = await proxied.json();
    return data.text || "";
  }

  if (proxied.status !== 404) {
    let errorPayload = null;
    try {
      errorPayload = await proxied.json();
    } catch {
      errorPayload = null;
    }
    if (proxied.status === 429) {
      const retryMs = parseRetryDelay(proxied.headers.get("Retry-After") || errorPayload?.retryAfter);
      setGeminiCooldown(retryMs);
      throw new Error(`Gemini quota limit reached. Try again in ${waitLabel(retryMs)}.`);
    }
    throw new Error(extractErrorMessage(errorPayload, "AI extraction unavailable. Check Gemini server key and deployment logs."));
  }

  let key = import.meta.env.VITE_GEMINI_API_KEY || localStorage.getItem(GEMINI_API_KEY_KEY) || "";
  if (!key) {
    key = window.prompt("Enter your Gemini API key to use OneRoot Meetings AI features locally:") || "";
    if (key.trim()) localStorage.setItem(GEMINI_API_KEY_KEY, key.trim());
  }
  if (!key.trim()) throw new Error("Missing Gemini API key");

  const direct = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key.trim())}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.15, responseMimeType, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  let data = null;
  try {
    data = await direct.json();
  } catch {
    data = null;
  }
  if (!direct.ok) {
    if (direct.status === 429) {
      const retryMs = parseRetryDelay(direct.headers.get("Retry-After"));
      setGeminiCooldown(retryMs);
      throw new Error(`Gemini quota limit reached. Try again in ${waitLabel(retryMs)}.`);
    }
    throw new Error(extractErrorMessage(data, "AI request failed."));
  }
  if (data?.candidates?.[0]?.finishReason === "MAX_TOKENS") throw new Error("AI response was cut off. Try shorter notes or run extraction again.");
  return data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
}

async function spellFix(text) {
  const prompt = "Fix spelling, grammar, and punctuation in these meeting notes for OneRoot, an Indian agritech company. Preserve meaning, names, dates, bullets, and line breaks. Return only the corrected notes.\n\n" + text;
  return (await geminiMessage(prompt, 900)).trim() || text;
}

async function fixAndExtract(text, tags, existingActions = []) {
  const prompt = [
    "You are a meeting assistant for OneRoot, an Indian agritech company.",
    "Correct the notes and extract action items.",
    "Return concise action items, not long explanations.",
    "Do not return duplicate actions. Treat wording variants as duplicates if the same work is required.",
    "Use only these categories: " + tags.join(", "),
    "If a sentence says something like 'Bharath to send MOU', infer assignee as Bharath.",
    existingActions.length ? "Existing actions already added, do not repeat these: " + existingActions.map((action) => action.text).join(" | ") : "No existing actions yet.",
    "Return only valid JSON with this shape:",
    '{"corrected":"corrected notes","actions":[{"text":"action item","assignee":"name if known","delegate":"delegate if known","category":"one category"}]}',
    "",
    "Notes:",
    text,
  ].join("\n");
  const raw = await geminiMessage(prompt, 4096, "application/json");
  const clean = raw.replace(/```json|```/g, "").trim();
  const jsonText = clean.startsWith("{") ? clean : clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1);
  const json = JSON.parse(jsonText);
  return { corrected: json.corrected || text, actions: Array.isArray(json.actions) ? json.actions : [] };
}

async function transcribeAudio(audioBase64, mimeType, language) {
  const response = await fetch(TRANSCRIBE_PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audioBase64, mimeType, language }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, "Audio transcription failed."));
  }
  return payload?.text || "";
}

function localFixAndExtract(text, tags, attendees = "", existingActions = []) {
  const people = namesFromAttendees(attendees);
  const actionWords = /\b(will|to|contact|meet|send|share|follow up|arrange|prepare|visit|call|check|confirm|collect|update)\b/i;
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const actions = [];

  for (const line of lines) {
    if (!actionWords.test(line)) continue;
    const assignee = people.find((name) => textMentionsName(line, name)) || "";
    const normalizedLine = line.replace(/^[-*0-9.)\s]+/, "").trim();
    if (!normalizedLine || existingActions.some((action) => isSimilarAction(action.text, normalizedLine)) || actions.some((action) => isSimilarAction(action.text, normalizedLine))) continue;
    const category = tags.find((tag) => tag !== "General" && normalize(line).includes(normalize(tag))) || "General";
    actions.push({ text: normalizedLine, assignee, delegate: "", category });
  }

  return { corrected: text, actions };
}

function PersonPicker({ label, value, onChange, options, exclude = [], onAdd }) {
  const [mode, setMode] = useState("");
  const [draft, setDraft] = useState("");
  const filtered = options.filter((name) => name && !exclude.includes(name));
  function confirm() {
    const name = draft.trim();
    if (!name) return;
    onAdd(name);
    onChange(name);
    setDraft("");
    setMode("");
  }
  return (
    <div style={{ minWidth: 180, flex: 1 }}>
      <div style={labelStyle}>{label}</div>
      <select value={mode || value || ""} onChange={(e) => {
        if (e.target.value === "__add") {
          setMode("__add");
          onChange("");
        } else {
          setMode("");
          onChange(e.target.value);
        }
      }} style={inputStyle}>
        <option value="">Select person</option>
        {filtered.map((name) => <option key={name} value={name}>{name}</option>)}
        <option value="__add">Add someone else</option>
      </select>
      {mode === "__add" && (
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && confirm()} autoFocus placeholder="Type name" style={inputStyle} />
          <Button type="button" tone="primary" onClick={confirm}>Add</Button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [meetings, setMeetings] = useState([]);
  const [syncStatus, setSyncStatus] = useState(hasSupabaseConfig ? "Checking session..." : supabaseConfigError);
  const [authReady, setAuthReady] = useState(false);
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [screen, setScreen] = useState("list");
  const [active, setActive] = useState(null);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [customTags, setCustomTags] = useState(() => readJson(CUSTOM_TAGS_KEY, []));
  const [customColors, setCustomColors] = useState(() => readJson(CUSTOM_COLORS_KEY, {}));

  const allTags = useMemo(() => [...DEFAULT_TAGS, ...customTags.filter((tag) => !DEFAULT_TAGS.includes(tag))], [customTags]);
  const isAdmin = profile?.role === "admin";
  const currentUserId = profile?.id || session?.user?.id || "";

  useEffect(() => {
    let cancelled = false;
    async function initAuth() {
      if (!hasSupabaseConfig) {
        setSyncStatus(supabaseConfigError);
        setAuthReady(true);
        return;
      }
      try {
        const currentSession = await getCurrentSession();
        if (!cancelled) {
          setSession(currentSession);
          setAuthReady(true);
          setSyncStatus(currentSession ? "Connecting to Supabase..." : "Sign in required.");
        }
      } catch (error) {
        if (!cancelled) {
          setAuthReady(true);
          setSyncStatus(error?.message || "Could not check Supabase session.");
        }
      }
    }
    initAuth();
    const unsubscribe = onAuthChanged((nextSession) => {
      setSession(nextSession);
      setProfile(null);
      setMeetings([]);
      setScreen("list");
      setSyncStatus(nextSession ? "Connecting to Supabase..." : "Sign in required.");
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadWorkspace() {
      if (!hasSupabaseConfig || !session) return;
      try {
        setSyncStatus("Loading profile...");
        const currentProfile = await fetchCurrentProfile();
        const [dbMeetings, dbProfiles] = await Promise.all([
          fetchMeetingsFromDb(),
          fetchProfilesFromDb(),
        ]);
        if (cancelled) return;
        setProfile(currentProfile);
        setProfiles(dbProfiles || []);
        const cleanedMeetings = (dbMeetings || []).map(cleanMeetingActions);
        setMeetings(cleanedMeetings);
        const dirtyMeetings = cleanedMeetings.filter((meeting, index) => (meeting.actions || []).length !== ((dbMeetings || [])[index]?.actions || []).length);
        if (currentProfile?.role === "admin" && dirtyMeetings.length) {
          await Promise.all(dirtyMeetings.map((meeting) => upsertMeetingToDb(meeting)));
        }
        setSyncStatus((dbMeetings || []).length ? "Synced with Supabase" : "Supabase connected. No saved meetings yet.");
      } catch (error) {
        if (!cancelled) setSyncStatus(error?.message || "Supabase unavailable. Check URL, anon key, table, and RLS policies.");
      }
    }
    loadWorkspace();
    return () => {
      cancelled = true;
    };
  }, [session]);

  function addCustomTag(name) {
    const tag = name.trim();
    if (!tag || allTags.includes(tag)) return;
    const nextTags = [...customTags, tag];
    const nextColors = { ...customColors, [tag]: COLOR_PALETTE[nextTags.length % COLOR_PALETTE.length] };
    setCustomTags(nextTags);
    setCustomColors(nextColors);
    writeJson(CUSTOM_TAGS_KEY, nextTags);
    writeJson(CUSTOM_COLORS_KEY, nextColors);
  }

  async function deleteCustomTag(tag) {
    const nextTags = customTags.filter((item) => item !== tag);
    const nextMeetings = meetings.map((meeting) => ({ ...meeting, tags: (meeting.tags || []).filter((item) => item !== tag), actions: (meeting.actions || []).map((action) => action.category === tag ? { ...action, category: "General" } : action) }));
    setCustomTags(nextTags);
    writeJson(CUSTOM_TAGS_KEY, nextTags);
    setMeetings(nextMeetings);
    if (hasSupabaseConfig) {
      try {
        await Promise.all(nextMeetings.map((meeting) => upsertMeetingToDb(meeting)));
        setSyncStatus("Synced with Supabase");
      } catch {
        setSyncStatus("Could not update meetings after deleting tag.");
      }
    }
  }

  async function saveMeeting(meeting) {
      if (!hasSupabaseConfig) {
      setSyncStatus(supabaseConfigError);
      return;
    }
    const clean = cleanMeetingActions({ ...meeting, title: meeting.title.trim(), attendees: meeting.attendees.trim(), body: meeting.body.trim() });
    const record = clean.id ? clean : { ...clean, id: genId(), visibility: "restricted", memberIds: [...new Set([currentUserId, ...(clean.memberIds || [])].filter(Boolean))] };
    setSyncStatus("Saving to Supabase...");
    try {
      const saved = await upsertMeetingToDb(record);
      const finalRecord = cleanMeetingActions(saved || record);
      setMeetings((current) => clean.id ? current.map((item) => item.id === finalRecord.id ? finalRecord : item) : [finalRecord, ...current]);
      setSyncStatus("Synced with Supabase");
      setScreen("list");
    } catch {
      setSyncStatus("Save failed. Check Supabase connection, table, and RLS policies.");
    }
  }

  async function updateActive(next) {
    if (!hasSupabaseConfig) {
      setSyncStatus(supabaseConfigError);
      return;
    }
    const cleanedNext = cleanMeetingActions(next);
    setActive(cleanedNext);
    setSyncStatus("Saving to Supabase...");
    try {
      const saved = await upsertMeetingToDb(cleanedNext);
      const finalRecord = cleanMeetingActions(saved || cleanedNext);
      setActive(finalRecord);
      setMeetings((current) => current.map((meeting) => meeting.id === finalRecord.id ? finalRecord : meeting));
      setSyncStatus("Synced with Supabase");
    } catch {
      setSyncStatus("Save failed. Check Supabase connection, table, and RLS policies.");
    }
  }

  async function deleteMeeting(id) {
    if (!window.confirm("Delete this meeting?")) return;
    if (!hasSupabaseConfig) {
      setSyncStatus(supabaseConfigError);
      return;
    }
    setSyncStatus("Deleting from Supabase...");
    try {
      await deleteMeetingFromDb(id);
      setMeetings((current) => current.filter((meeting) => meeting.id !== id));
      setSyncStatus("Synced with Supabase");
    } catch {
      setSyncStatus("Delete failed. Check Supabase connection, table, and RLS policies.");
    }
  }

  async function logout() {
    setSyncStatus("Signing out...");
    try {
      await signOut();
    } catch (error) {
      setSyncStatus(error?.message || "Sign out failed.");
    }
  }

  if (!authReady) {
    return <LoginScreen status={syncStatus} />;
  }

  if (!session) {
    return <LoginScreen status={syncStatus} />;
  }

  if (screen === "form") {
    return <MeetingForm data={active} allTags={allTags} customTags={customTags} customColors={customColors} profiles={profiles} currentUserId={currentUserId} isAdmin={isAdmin} onAddTag={addCustomTag} onDeleteTag={deleteCustomTag} onSave={saveMeeting} onBack={() => setScreen("list")} />;
  }
  if (screen === "detail") {
    return <MeetingDetail note={active} customColors={customColors} canEdit={isAdmin} onBack={() => setScreen("list")} onEdit={() => setScreen("form")} onUpdate={updateActive} />;
  }
  return <MeetingList meetings={meetings} syncStatus={syncStatus} profile={profile} isAdmin={isAdmin} search={search} setSearch={setSearch} tagFilter={tagFilter} setTagFilter={setTagFilter} customColors={customColors} onSignOut={logout} onNew={() => { setActive({ id: "", title: "", date: today(), attendees: "", tags: [], body: "", actions: [], visibility: "restricted", memberIds: currentUserId ? [currentUserId] : [] }); setScreen("form"); }} onView={(meeting) => { setActive(cleanMeetingActions(meeting)); setScreen("detail"); }} onEdit={(meeting) => { setActive(cleanMeetingActions(meeting)); setScreen("form"); }} onDelete={deleteMeeting} />;
}

function MeetingList({ meetings, syncStatus, profile, isAdmin, search, setSearch, tagFilter, setTagFilter, customColors, onSignOut, onNew, onView, onEdit, onDelete }) {
  const screen = useResponsive();
  const now = new Date();
  const usedTags = [...new Set(meetings.flatMap((meeting) => meeting.tags || []))];
  const filtered = meetings.filter((meeting) => {
    const haystack = [meeting.title, meeting.attendees, meeting.body, ...(meeting.tags || [])].join(" ").toLowerCase();
    return (!search || haystack.includes(search.toLowerCase())) && (!tagFilter || (meeting.tags || []).includes(tagFilter));
  }).sort((a, b) => new Date(b.date) - new Date(a.date));
  const thisMonth = meetings.filter((meeting) => {
    const date = new Date(meeting.date + "T00:00:00");
    return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
  }).length;
  const openActions = meetings.reduce((sum, meeting) => sum + (meeting.actions || []).filter((action) => (action.status || "open") === "open").length, 0);

  return (
    <div style={pageStyle}>
      <div style={{ ...wrapStyle, padding: screen.isMobile ? "14px 10px 26px" : wrapStyle.padding }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: screen.isMobile ? "stretch" : "center", flexDirection: screen.isMobile ? "column" : "row", gap: 12, marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: screen.isMobile ? 22 : 26, fontWeight: 900 }}><span style={{ color: "#1D9E75" }}>OneRoot</span> Meetings</div>
            <div style={smallMuted}>Meeting notes, decisions, and action follow-through</div>
            <div style={{ ...smallMuted, color: syncStatus.includes("Supabase") && !syncStatus.includes("failed") && !syncStatus.includes("unavailable") ? "#1D9E75" : "#8a8a82", marginTop: 3 }}>{syncStatus}</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: screen.isMobile ? "stretch" : "center", flexDirection: screen.isMobile ? "column" : "row" }}>
            <div style={{ ...smallMuted, textAlign: screen.isMobile ? "left" : "right" }}>
              {profile?.full_name || profile?.email || "Signed in"}
              {profile?.role && <span style={{ marginLeft: 6, color: isAdmin ? "#1D9E75" : "#777", fontWeight: 800 }}>{profile.role}</span>}
            </div>
            {isAdmin && <Button tone="primary" onClick={onNew} style={screen.isMobile ? { width: "100%" } : null}>+ New Meeting</Button>}
            <Button onClick={onSignOut} style={screen.isMobile ? { width: "100%" } : null}>Sign Out</Button>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: screen.isMobile ? "1fr" : "repeat(3, minmax(0, 1fr))", gap: 10, marginBottom: 14 }}>
          {[["Total", meetings.length], ["This month", thisMonth], ["Open actions", openActions]].map(([label, value]) => (
            <div key={label} style={cardStyle}>
              <div style={{ ...smallMuted, textTransform: "uppercase", fontWeight: 800 }}>{label}</div>
              <div style={{ fontSize: 28, fontWeight: 900 }}>{value}</div>
            </div>
          ))}
        </div>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search meetings" style={{ ...inputStyle, marginBottom: 10 }} />
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 16 }}>
          <Button style={{ padding: "6px 11px", borderRadius: 999 }} tone={!tagFilter ? "primary" : "plain"} onClick={() => setTagFilter("")}>All</Button>
          {usedTags.map((tag) => <TagChip key={tag} tag={tag} selected={tagFilter === tag} onClick={() => setTagFilter(tagFilter === tag ? "" : tag)} customColors={customColors} />)}
        </div>
        {filtered.length === 0 ? (
          <div style={{ ...cardStyle, textAlign: "center", padding: 44, color: "#888" }}>No meetings found.</div>
        ) : filtered.map((meeting) => {
          const open = (meeting.actions || []).filter((action) => (action.status || "open") === "open").length;
          return (
            <div key={meeting.id} style={{ ...cardStyle, marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                <div>
                  <div style={{ fontSize: 17, fontWeight: 850 }}>{meeting.title}</div>
                  <div style={{ ...smallMuted, marginTop: 3 }}>{fmtDate(meeting.date)}{meeting.attendees ? " · " + meeting.attendees : ""}</div>
                </div>
                {open > 0 && <span style={{ background: "#fef3c7", color: "#92400e", borderRadius: 999, padding: "4px 9px", fontSize: 11, fontWeight: 850 }}>{open} open</span>}
              </div>
              {(meeting.tags || []).length > 0 && <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>{meeting.tags.map((tag) => <TagChip key={tag} tag={tag} customColors={customColors} />)}</div>}
              {meeting.body && <div style={{ marginTop: 9, color: "#666", fontSize: 13, lineHeight: 1.55, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{meeting.body}</div>}
              <div style={{ display: "flex", gap: 7, borderTop: "1px solid #f0f0ec", marginTop: 13, paddingTop: 13, flexWrap: "wrap" }}>
                <Button onClick={() => onView(meeting)} style={screen.isMobile ? { flex: "1 1 30%" } : null}>View</Button>
                {isAdmin && <Button onClick={() => onEdit(meeting)} style={screen.isMobile ? { flex: "1 1 30%" } : null}>Edit</Button>}
                {isAdmin && <Button tone="danger" onClick={() => onDelete(meeting.id)} style={screen.isMobile ? { flex: "1 1 30%" } : null}>Delete</Button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MeetingForm({ data, allTags, customTags, customColors, profiles, currentUserId, isAdmin, onAddTag, onDeleteTag, onSave, onBack }) {
  const screen = useResponsive();
  const [form, setForm] = useState(() => cleanMeetingActions({ ...data, actions: data.actions || [] }));
  const [titleError, setTitleError] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [manualPeople, setManualPeople] = useState([]);
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [interim, setInterim] = useState("");
  const [voiceMode, setVoiceMode] = useState("server");
  const [voiceLang, setVoiceLang] = useState("en-IN");
  const speechRef = useRef(null);
  const speechSocketRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const audioChunksRef = useRef([]);
  const notesRef = useRef(null);
  const actionsRef = useRef(form.actions || []);

  const people = [...new Set([...namesFromAttendees(form.attendees), ...manualPeople, ...(form.actions || []).flatMap((action) => [action.assignee, action.delegate]).filter(Boolean)])];
  const actionCategories = [...new Set((form.actions || []).map((action) => action.category || "General"))];
  const memberIds = [...new Set([...(form.memberIds || []), currentUserId].filter(Boolean))];
  const selectedMembers = profiles.filter((person) => memberIds.includes(person.id));

  useEffect(() => {
    actionsRef.current = form.actions || [];
  }, [form.actions]);

  useEffect(() => {
    return () => {
      speechRef.current?.stop();
      mediaRecorderRef.current?.stop();
      speechSocketRef.current?.close();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  function setField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function updateAction(id, patch) {
    setForm((prev) => {
      const nextActions = prev.actions.map((action) => action.id === id ? { ...action, ...patch } : action);
      actionsRef.current = nextActions;
      return { ...prev, actions: actionsRef.current };
    });
  }

  function addManualPerson(name) {
    setManualPeople((prev) => prev.includes(name) ? prev : [...prev, name]);
  }

  function toggleMember(id) {
    if (!id || id === currentUserId) return;
    setForm((prev) => {
      const current = new Set([...(prev.memberIds || []), currentUserId].filter(Boolean));
      if (current.has(id)) current.delete(id);
      else current.add(id);
      return { ...prev, memberIds: [...current], visibility: "restricted" };
    });
  }

  async function processNotesWithAi({ manual = false } = {}) {
    const sourceText = form.body.trim();
    if (!sourceText) {
      setHint("Add meeting notes first.");
      return;
    }
    if (manual) setBusy(true);
    setHint("Fixing and extracting actions...");
    try {
      const existingActions = actionsRef.current || [];
      const result = await fixAndExtract(sourceText, allTags, existingActions);
      const corrected = result.corrected || sourceText;
      const extracted = [];
      const inferredPeople = [];
      for (const item of result.actions) {
        const text = (item.text || "").trim();
        if (!text || extracted.some((action) => isSimilarAction(action.text, text))) continue;
        if (item.assignee) inferredPeople.push(item.assignee.trim());
        if (item.delegate) inferredPeople.push(item.delegate.trim());
        extracted.push({ ...blankAction(), text, assignee: item.assignee || "", delegate: item.delegate || "", category: allTags.includes(item.category) ? item.category : "General" });
      }
      setManualPeople((prev) => [...new Set([...prev, ...inferredPeople.filter(Boolean)])]);
      setForm((prev) => {
        actionsRef.current = syncActionsToNotes(prev.actions || [], extracted, corrected);
        return { ...prev, body: corrected, actions: actionsRef.current };
      });
      setHint(actionsRef.current.length ? `Actions synced with latest notes (${actionsRef.current.length})` : "Notes checked. No actions found.");
    } catch (error) {
      const fallback = localFixAndExtract(sourceText, allTags, form.attendees, actionsRef.current || []);
      setForm((prev) => {
        actionsRef.current = syncActionsToNotes(prev.actions || [], fallback.actions, fallback.corrected);
        return { ...prev, actions: actionsRef.current };
      });
      setHint(`${error?.message || "AI extraction unavailable."} Local action extraction ran instead.`);
    } finally {
      if (manual) setBusy(false);
    }
  }

  async function extractActions() {
    await processNotesWithAi({ manual: true });
  }

  function startVoice() {
    if (voiceMode === "server") {
      startServerVoice();
      return;
    }
    startBrowserVoice();
  }

  function stopVoice() {
    if (voiceMode === "server") {
      stopServerVoice();
      return;
    }
    stopBrowserVoice();
  }

  async function startServerVoice() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setHint("Server voice needs microphone recording support in this browser.");
      return;
    }
    try {
      notesRef.current?.focus();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      const socket = new WebSocket(GOOGLE_SPEECH_WS_URL);
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      speechSocketRef.current = socket;
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: "start", language: voiceLang }));
        recorder.start(250);
      };
      socket.onmessage = (event) => {
        const payload = JSON.parse(event.data || "{}");
        if (payload.type === "ready") {
          setRecording(true);
          setHint("Streaming to Google Speech...");
          return;
        }
        if (payload.type === "interim") {
          setInterim(payload.text || "");
          return;
        }
        if (payload.type === "final") {
          setInterim("");
          setForm((prev) => ({ ...prev, body: appendNotes(prev.body, payload.text) }));
          window.setTimeout(() => {
            notesRef.current?.focus();
            notesRef.current?.setSelectionRange(notesRef.current.value.length, notesRef.current.value.length);
          }, 0);
          return;
        }
        if (payload.type === "error") {
          setHint(payload.message || "Google Speech streaming failed.");
        }
      };
      socket.onerror = () => {
        setRecording(false);
        setHint("Could not connect to Google Speech server.");
      };
      socket.onclose = () => {
        setRecording(false);
        setInterim("");
        speechSocketRef.current = null;
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
      };
      recorder.ondataavailable = (event) => {
        if (event.data?.size && socket.readyState === WebSocket.OPEN) {
          socket.send(event.data);
        }
      };
      recorder.onerror = () => {
        setRecording(false);
        setHint("Voice recording stopped.");
      };
      recorder.onstop = () => {
        setRecording(false);
        setInterim("");
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "stop" }));
          window.setTimeout(() => socket.close(), 150);
        }
        mediaRecorderRef.current = null;
        setHint("Google Speech streaming stopped.");
      };
      setHint("Connecting to Google Speech server...");
    } catch (error) {
      setRecording(false);
      setHint(error?.message || "Microphone permission denied.");
    }
  }

  function stopServerVoice() {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
      return;
    }
    speechSocketRef.current?.close();
  }

  function startBrowserVoice() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setHint("Voice input needs Chrome or Edge.");
      return;
    }
    notesRef.current?.focus();
    const recognition = new SpeechRecognition();
    recognition.lang = voiceLang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onstart = () => {
      setRecording(true);
      setHint("Listening in " + (VOICE_LANGUAGES.find(([code]) => code === voiceLang)?.[1] || "selected language") + "...");
    };
    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += text + " ";
        else interimText += text;
      }
      if (finalText.trim()) {
        setForm((prev) => ({ ...prev, body: appendNotes(prev.body, finalText) }));
        window.setTimeout(() => {
          notesRef.current?.focus();
          notesRef.current?.setSelectionRange(notesRef.current.value.length, notesRef.current.value.length);
        }, 0);
      }
      setInterim(interimText);
    };
    recognition.onerror = () => {
      setRecording(false);
      setInterim("");
      setHint("Voice input stopped.");
    };
    recognition.onend = () => {
      setRecording(false);
      setInterim("");
      setHint("Recording stopped.");
    };
    speechRef.current = recognition;
    recognition.start();
  }

  function stopBrowserVoice() {
    speechRef.current?.stop();
    speechRef.current = null;
    setRecording(false);
  }

  function save() {
    if (!form.title.trim()) {
      setTitleError(true);
      return;
    }
    onSave({ ...form, actions: dedupeActions(form.actions || []) });
  }

  return (
    <div style={pageStyle}>
      <div style={{ ...wrapStyle, maxWidth: 820, padding: screen.isMobile ? "12px 10px 26px" : wrapStyle.padding }}>
        <Button onClick={onBack}>Back</Button>
        <div style={{ ...cardStyle, marginTop: 14, padding: screen.isMobile ? 12 : cardStyle.padding }}>
          <div style={{ fontSize: screen.isMobile ? 19 : 22, fontWeight: 900, marginBottom: 16 }}>{form.id ? "Edit Meeting" : "New Meeting"}</div>
          <div style={{ display: "grid", gridTemplateColumns: screen.isMobile ? "1fr" : "minmax(0, 1.4fr) 180px", gap: 12 }}>
            <div>
              <label style={labelStyle}>Title *</label>
              <input value={form.title} onChange={(e) => { setField("title", e.target.value); setTitleError(false); }} placeholder="Vietnam supplier review" style={{ ...inputStyle, borderColor: titleError ? "#ef4444" : "#deded8" }} />
              {titleError && <div style={{ color: "#dc2626", fontSize: 12, marginTop: 4 }}>Title is required.</div>}
            </div>
            <div>
              <label style={labelStyle}>Date</label>
              <input type="date" value={form.date} onChange={(e) => setField("date", e.target.value)} style={inputStyle} />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <label style={labelStyle}>Attendees</label>
            <input value={form.attendees} onChange={(e) => setField("attendees", e.target.value)} placeholder="Bharath, Dileep, Teja" style={inputStyle} />
          </div>
          {isAdmin && (
            <div style={{ marginTop: 12 }}>
              <label style={labelStyle}>Meeting Access</label>
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                {profiles.map((person) => {
                  const selected = memberIds.includes(person.id);
                  const isSelf = person.id === currentUserId;
                  return (
                    <button
                      key={person.id}
                      type="button"
                      onClick={() => toggleMember(person.id)}
                      disabled={isSelf}
                      title={person.email}
                      style={{
                        border: "1px solid " + (selected ? "#1D9E75" : "#deded8"),
                        background: selected ? "#d1fae5" : "#fff",
                        color: selected ? "#065f46" : "#444",
                        borderRadius: 999,
                        padding: "6px 10px",
                        fontSize: 12,
                        fontWeight: 800,
                        cursor: isSelf ? "not-allowed" : "pointer",
                        opacity: isSelf ? 0.7 : 1,
                      }}
                    >
                      {person.full_name || person.email}{person.role === "admin" ? " · admin" : ""}
                    </button>
                  );
                })}
              </div>
              <div style={{ ...smallMuted, marginTop: 6 }}>
                {selectedMembers.length ? `Visible to ${selectedMembers.map((person) => person.full_name || person.email).join(", ")}` : "Only admins can currently access this meeting."}
              </div>
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <label style={labelStyle}>Tags</label>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
              {allTags.map((tag) => <TagChip key={tag} tag={tag} selected={(form.tags || []).includes(tag)} customColors={customColors} onClick={() => setField("tags", (form.tags || []).includes(tag) ? form.tags.filter((item) => item !== tag) : [...(form.tags || []), tag])} onDelete={customTags.includes(tag) ? () => onDeleteTag(tag) : null} />)}
              {isAddingTag ? (
                <span style={{ display: "inline-flex", gap: 6 }}>
                  <input autoFocus value={newTag} onChange={(e) => setNewTag(e.target.value)} onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      onAddTag(newTag);
                      setNewTag("");
                      setIsAddingTag(false);
                    }
                    if (e.key === "Escape") setIsAddingTag(false);
                  }} placeholder="New tag" style={{ ...inputStyle, width: 130, padding: "6px 10px", borderRadius: 999 }} />
                  <Button type="button" tone="primary" style={{ padding: "6px 10px", borderRadius: 999 }} onClick={() => { onAddTag(newTag); setNewTag(""); setIsAddingTag(false); }}>Add</Button>
                </span>
              ) : <Button type="button" style={{ padding: "6px 11px", borderRadius: 999 }} onClick={() => setIsAddingTag(true)}>+ Tag</Button>}
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: screen.isMobile ? "stretch" : "center", flexDirection: screen.isMobile ? "column" : "row", marginBottom: 6 }}>
              <label style={{ ...labelStyle, margin: 0 }}>Notes</label>
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                <select value={voiceMode} disabled={recording || busy} onChange={(e) => setVoiceMode(e.target.value)} title="Voice transcription mode" style={{ ...inputStyle, width: 128, padding: "8px 10px" }}>
                  <option value="server">Server AI</option>
                  <option value="browser">Browser live</option>
                </select>
                <select value={voiceLang} disabled={recording} onChange={(e) => setVoiceLang(e.target.value)} title="Dictation language" style={{ ...inputStyle, width: 132, padding: "8px 10px" }}>
                  {VOICE_LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                </select>
                <Button type="button" tone={recording ? "danger" : "plain"} disabled={busy && !recording} onClick={recording ? stopVoice : startVoice}>{recording ? "Stop" : "Voice"}</Button>
                <Button type="button" tone="purple" disabled={busy} onClick={extractActions}>{busy ? "Processing..." : "Fix & Extract Actions"}</Button>
              </div>
            </div>
            <textarea ref={notesRef} value={form.body} onChange={(e) => { setField("body", e.target.value); setHint(""); }} placeholder="Type or dictate meeting notes..." rows={8} style={{ ...inputStyle, lineHeight: 1.7, resize: "vertical" }} />
            <div style={{ ...smallMuted, minHeight: 20, marginTop: 5, color: hint.includes("unavailable") ? "#b45309" : "#777" }}>{interim || hint || "Auto-fix and action extraction runs 5 seconds after typing stops."}</div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 850 }}>Action items</div>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <Button type="button" onClick={() => {
                setForm((prev) => {
                  const cleaned = dedupeActions(prev.actions || []).map((action) => ({
                    ...action,
                    assignee: textMentionsName(prev.body, action.assignee) ? action.assignee : "",
                    delegate: textMentionsName(prev.body, action.delegate) ? action.delegate : "",
                  }));
                  actionsRef.current = cleaned;
                  setHint(cleaned.length === (prev.actions || []).length ? "No duplicate actions found." : "Duplicate actions cleaned.");
                  return { ...prev, actions: cleaned };
                });
              }}>Clean duplicates</Button>
              <Button type="button" onClick={() => setForm((prev) => ({ ...prev, actions: [...prev.actions, blankAction()] }))}>+ Add</Button>
            </div>
          </div>
          {(form.actions || []).length === 0 ? (
            <div style={{ border: "1px dashed #d8d8d2", borderRadius: 8, padding: 18, textAlign: "center", color: "#888", marginTop: 10 }}>No action items yet.</div>
          ) : actionCategories.map((category) => (
            <div key={category} style={{ marginTop: 14 }}>
              <TagChip tag={category} customColors={customColors} />
              {(form.actions || []).filter((action) => (action.category || "General") === category).map((action) => {
                const actionNumber = (form.actions || []).findIndex((item) => item.id === action.id) + 1;
                return (
                <div key={action.id} style={{ ...actionCardStyle(action.category || category, customColors), padding: 12, marginTop: 8 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 10 }}>
                    <ActionNumber number={actionNumber} category={action.category || category} customColors={customColors} />
                    <textarea value={action.text} onChange={(e) => updateAction(action.id, { text: e.target.value })} placeholder="Action item" rows={2} style={{ ...inputStyle, resize: "vertical", lineHeight: 1.55, color: "#111", background: "rgba(255,255,255,0.86)" }} />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: screen.isMobile ? "1fr" : screen.isTablet ? "repeat(2, minmax(0, 1fr))" : "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                    <PersonPicker label="Assignee" value={action.assignee || ""} options={people} onAdd={addManualPerson} onChange={(name) => updateAction(action.id, { assignee: name, delegate: action.delegate === name ? "" : action.delegate })} />
                    <PersonPicker label="Delegate" value={action.delegate || ""} options={people} exclude={[action.assignee]} onAdd={addManualPerson} onChange={(name) => updateAction(action.id, { delegate: name })} />
                    <div>
                      <label style={labelStyle}>Category</label>
                      <select value={action.category || "General"} onChange={(e) => updateAction(action.id, { category: e.target.value })} style={inputStyle}>{allTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}</select>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
                    {Object.entries(STATUS_MAP).map(([key, status]) => <button key={key} type="button" onClick={() => updateAction(action.id, { status: key })} style={{ border: "1px solid " + ((action.status || "open") === key ? status.border : "#deded8"), background: (action.status || "open") === key ? status.bg : "#fff", color: (action.status || "open") === key ? status.color : "#777", borderRadius: 999, padding: "5px 10px", fontSize: 12, fontWeight: 750, cursor: "pointer" }}>{status.label}</button>)}
                    {(action.status || "open") === "postponed" && <input type="date" value={action.postponeDate || ""} onChange={(e) => updateAction(action.id, { postponeDate: e.target.value })} style={{ ...inputStyle, width: 155, padding: "6px 9px" }} />}
                    <Button type="button" tone="danger" style={{ marginLeft: screen.isMobile ? 0 : "auto" }} onClick={() => setForm((prev) => ({ ...prev, actions: prev.actions.filter((item) => item.id !== action.id) }))}>Delete</Button>
                  </div>
                  <textarea value={action.remarks || ""} onChange={(e) => updateAction(action.id, { remarks: e.target.value })} placeholder="Remarks" rows={2} style={{ ...inputStyle, marginTop: 10, resize: "vertical" }} />
                </div>
              );
              })}
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, borderTop: "1px solid #f0f0ec", marginTop: 16, paddingTop: 14, flexDirection: screen.isMobile ? "column-reverse" : "row" }}>
            <Button onClick={onBack} style={screen.isMobile ? { width: "100%" } : null}>Cancel</Button>
            <Button tone="primary" onClick={save} style={screen.isMobile ? { width: "100%" } : null}>Save Meeting</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MeetingDetail({ note, customColors, canEdit, onBack, onEdit, onUpdate }) {
  const screen = useResponsive();
  const [editingId, setEditingId] = useState("");
  const [draft, setDraft] = useState("");
  const actions = note.actions || [];
  const categories = [...new Set(actions.map((action) => action.category || "General"))];
  const completed = actions.filter((action) => action.status === "completed").length;
  const pct = actions.length ? Math.round((completed / actions.length) * 100) : 0;

  function patchAction(id, patch) {
    onUpdate({ ...note, actions: actions.map((action) => action.id === id ? { ...action, ...patch } : action) });
  }

  return (
    <div style={pageStyle}>
      <div style={{ ...wrapStyle, padding: screen.isMobile ? "12px 10px 26px" : wrapStyle.padding }}>
        <Button onClick={onBack}>Back</Button>
        <div style={{ ...cardStyle, marginTop: 14, padding: screen.isMobile ? 12 : cardStyle.padding }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: screen.isMobile ? "stretch" : "flex-start", flexDirection: screen.isMobile ? "column" : "row" }}>
            <div>
              <div style={{ fontSize: screen.isMobile ? 21 : 25, fontWeight: 900 }}>{note.title}</div>
              <div style={{ ...smallMuted, marginTop: 4 }}>{fmtDate(note.date)}</div>
            </div>
            {canEdit && <Button onClick={onEdit} style={screen.isMobile ? { width: "100%" } : null}>Edit</Button>}
          </div>
          {namesFromAttendees(note.attendees).length > 0 && <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 14 }}>{namesFromAttendees(note.attendees).map((name) => <div key={name} title={name} style={{ width: 34, height: 34, borderRadius: "50%", background: "#d1fae5", color: "#065f46", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 900 }}>{initials(name)}</div>)}</div>}
          {(note.tags || []).length > 0 && <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>{note.tags.map((tag) => <TagChip key={tag} tag={tag} customColors={customColors} />)}</div>}
          {note.body && <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.8, borderTop: "1px solid #f0f0ec", marginTop: 16, paddingTop: 14, fontSize: 14 }}>{note.body}</div>}
          <div style={{ borderTop: "1px solid #f0f0ec", marginTop: 16, paddingTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: screen.isMobile ? "stretch" : "center", flexDirection: screen.isMobile ? "column" : "row", gap: 8, marginBottom: 14 }}>
              <div style={{ fontSize: 16, fontWeight: 900 }}>Action items</div>
              <div style={{ display: "flex", alignItems: "center", gap: 9, ...smallMuted }}>
                {completed}/{actions.length} completed
                <div style={{ width: 120, height: 8, background: "#ecece6", borderRadius: 999, overflow: "hidden" }}><div style={{ width: pct + "%", height: "100%", background: "#1D9E75" }} /></div>
              </div>
            </div>
            {actions.length === 0 ? <div style={{ color: "#888" }}>No action items recorded.</div> : categories.map((category) => (
              <div key={category} style={{ marginBottom: 18 }}>
                <div style={{ marginBottom: 8 }}><TagChip tag={category} customColors={customColors} /></div>
                {actions.filter((action) => (action.category || "General") === category).map((action) => {
                  const actionNumber = actions.findIndex((item) => item.id === action.id) + 1;
                  return (
                  <div key={action.id} style={{ ...actionCardStyle(action.category || category, customColors), padding: 13, marginBottom: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
                      {editingId === action.id ? (
                        <div style={{ flex: 1, display: "flex", gap: 10, alignItems: "flex-start" }}>
                          <ActionNumber number={actionNumber} category={action.category || category} customColors={customColors} />
                          <div style={{ flex: 1 }}>
                          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} style={{ ...inputStyle, resize: "vertical" }} />
                          <div style={{ display: "flex", gap: 7, marginTop: 7 }}>
                            <Button tone="primary" onClick={() => { patchAction(action.id, { text: draft }); setEditingId(""); }}>Save</Button>
                            <Button onClick={() => setEditingId("")}>Cancel</Button>
                          </div>
                          </div>
                        </div>
                      ) : (
                        <div style={{ flex: 1, display: "flex", gap: 10, alignItems: "flex-start" }}>
                          <ActionNumber number={actionNumber} category={action.category || category} customColors={customColors} />
                          <div style={{ flex: 1, lineHeight: 1.6, color: ["completed", "closed"].includes(action.status) ? "#777" : "#111", textDecoration: ["completed", "closed"].includes(action.status) ? "line-through" : "none" }}>{action.text}</div>
                        </div>
                      )}
                      {editingId !== action.id && <StatusPill status={action.status || "open"} />}
                    </div>
                    {canEdit && editingId !== action.id && <Button style={{ padding: "5px 9px", marginTop: 8 }} onClick={() => { setEditingId(action.id); setDraft(action.text); }}>Edit text</Button>}
                    {(action.assignee || action.delegate) && (
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                        {action.assignee && <span style={{ background: "#d1fae5", color: "#065f46", borderRadius: 999, padding: "4px 10px", fontSize: 12, fontWeight: 850 }}>Assignee: {action.assignee}</span>}
                        {action.delegate && <span style={{ background: "#ede9fe", color: "#5b21b6", borderRadius: 999, padding: "4px 10px", fontSize: 12, fontWeight: 850 }}>Delegate: {action.delegate}</span>}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
                      {Object.entries(STATUS_MAP).map(([key, status]) => <button key={key} disabled={!canEdit} onClick={() => patchAction(action.id, { status: key })} style={{ border: "1px solid " + ((action.status || "open") === key ? status.border : "#deded8"), background: (action.status || "open") === key ? status.bg : "#fff", color: (action.status || "open") === key ? status.color : "#777", borderRadius: 999, padding: "5px 10px", fontSize: 12, fontWeight: 750, cursor: canEdit ? "pointer" : "default", opacity: canEdit ? 1 : 0.8 }}>{status.label}</button>)}
                      {(action.status || "open") === "postponed" && <input type="date" disabled={!canEdit} value={action.postponeDate || ""} onChange={(e) => patchAction(action.id, { postponeDate: e.target.value })} style={{ ...inputStyle, width: 155, padding: "6px 9px" }} />}
                    </div>
                    {action.status === "postponed" && action.postponeDate && <div style={{ color: "#92400e", fontSize: 12, marginTop: 8 }}>Postponed to {fmtDate(action.postponeDate)}</div>}
                    <textarea disabled={!canEdit} value={action.remarks || ""} onChange={(e) => patchAction(action.id, { remarks: e.target.value })} placeholder="Remarks" rows={2} style={{ ...inputStyle, marginTop: 10, resize: "vertical", background: "#f9f9f7" }} />
                  </div>
                );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
