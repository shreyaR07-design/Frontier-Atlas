import { useCallback, useEffect, useState } from "react";
import type { User } from "firebase/auth";
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  Inbox,
  LogOut,
  Mail,
  RefreshCw,
  Search,
  Send,
  Trash2,
  X,
} from "lucide-react";
import {
  clearGoogleAccessToken,
  getGoogleAccessToken,
  googleSignIn,
  googleSignOut,
  initGoogleAuth,
} from "../lib/googleWorkspaceAuth";
import type { AtlasStatusResponse } from "../types/atlas";

interface GmailPanelProps {
  status: AtlasStatusResponse | null;
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailMessagePart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
}

interface GmailMessageFull {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: {
    mimeType?: string;
    headers?: GmailHeader[];
    body?: { data?: string; size?: number };
    parts?: GmailMessagePart[];
  };
}

interface GmailMessageItem {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  unread: boolean;
  bodyText: string;
}

type ConfirmAction =
  | {
      type: "send";
      to: string;
      subject: string;
      body: string;
    }
  | {
      type: "trash";
      message: GmailMessageItem;
    };

function decodeBase64UrlUtf8(encoded?: string): string {
  if (!encoded) return "";
  try {
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}

function encodeBase64UrlUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function stripHtmlTagsToText(html: string): string {
  if (!html) return "";
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return (doc.body?.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}

function extractBodyText(payload?: GmailMessageFull["payload"]): string {
  if (!payload) return "";

  const findPart = (
    part: GmailMessagePart | undefined,
    targetMime: string
  ): string | null => {
    if (!part) return null;
    if (part.mimeType === targetMime && part.body?.data) {
      return decodeBase64UrlUtf8(part.body.data);
    }
    if (Array.isArray(part.parts)) {
      for (const child of part.parts) {
        const found = findPart(child, targetMime);
        if (found !== null) return found;
      }
    }
    return null;
  };

  const plain = findPart(payload, "text/plain");
  if (plain !== null && plain.trim()) return plain.trim();

  const html = findPart(payload, "text/html");
  if (html !== null && html.trim()) return stripHtmlTagsToText(html);

  if (payload.body?.data) {
    const decoded = decodeBase64UrlUtf8(payload.body.data);
    return payload.mimeType === "text/html" ? stripHtmlTagsToText(decoded) : decoded.trim();
  }
  return "";
}

function getHeaderValue(headers: GmailHeader[] | undefined, name: string): string {
  if (!headers) return "";
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value ?? "";
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function encodeSubjectHeader(subject: string): string {
  const clean = sanitizeHeaderValue(subject);
  if (/^[\x20-\x7E]*$/.test(clean)) {
    return clean;
  }
  const bytes = new TextEncoder().encode(clean);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

export function GmailPanel({ status }: GmailPanelProps) {
  const [user, setUser] = useState<User | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [labelFilter, setLabelFilter] = useState<"INBOX" | "SENT" | "ALL">("INBOX");
  const [searchQuery, setSearchQuery] = useState("");
  const [messages, setMessages] = useState<GmailMessageItem[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);

  const [composeTo, setComposeTo] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [sending, setSending] = useState(false);
  const [trashingId, setTrashingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ success: boolean; message: string } | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  useEffect(() => {
    const unsub = initGoogleAuth(
      (authedUser, tokenReady) => {
        setUser(authedUser);
        setHasToken(tokenReady);
      },
      () => {
        setUser(null);
        setHasToken(false);
        setMessages([]);
        setSelectedMessageId(null);
      }
    );
    return unsub;
  }, []);

  const handleAuthFailure = useCallback((errMsg: string) => {
    clearGoogleAccessToken();
    setHasToken(false);
    setAuthError(errMsg);
  }, []);

  const fetchMessages = useCallback(async () => {
    const token = getGoogleAccessToken();
    if (!token) {
      setHasToken(false);
      return;
    }

    setMessagesLoading(true);
    setMessagesError(null);
    try {
      const params = new URLSearchParams({ maxResults: "15" });
      if (labelFilter !== "ALL") {
        params.set("labelIds", labelFilter);
      }
      if (searchQuery.trim()) {
        params.set("q", searchQuery.trim());
      }

      const listResp = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (listResp.status === 401 || listResp.status === 403) {
        const errBody = await listResp.json().catch(() => ({}));
        const msg =
          (errBody as { error?: { message?: string } })?.error?.message ||
          `Gmail session expired or missing permission (HTTP ${listResp.status}). Sign in again with Google.`;
        handleAuthFailure(msg);
        return;
      }

      const listJson = (await listResp.json()) as {
        messages?: Array<{ id: string; threadId: string }>;
        error?: { message?: string };
      };
      if (!listResp.ok) {
        throw new Error(listJson.error?.message || `Failed to list Gmail messages (HTTP ${listResp.status}).`);
      }

      const refs = listJson.messages ?? [];
      if (refs.length === 0) {
        setMessages([]);
        setSelectedMessageId(null);
        return;
      }

      const detailed = await Promise.all(
        refs.map(async (ref) => {
          const msgResp = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(ref.id)}?format=full`,
            {
              headers: { Authorization: `Bearer ${token}` },
            }
          );
          if (!msgResp.ok) {
            return null;
          }
          const full = (await msgResp.json()) as GmailMessageFull;
          const headers = full.payload?.headers;
          const labelIds = full.labelIds ?? [];
          return {
            id: full.id,
            threadId: full.threadId || ref.threadId,
            subject: getHeaderValue(headers, "Subject") || "(No subject)",
            from: getHeaderValue(headers, "From") || "Unknown sender",
            to: getHeaderValue(headers, "To") || "",
            date: getHeaderValue(headers, "Date") || "",
            snippet: full.snippet || "",
            unread: labelIds.includes("UNREAD"),
            bodyText: extractBodyText(full.payload) || full.snippet || "",
          } satisfies GmailMessageItem;
        })
      );

      const cleanList = detailed.filter((m): m is GmailMessageItem => m !== null);
      setMessages(cleanList);
      setSelectedMessageId((prev) =>
        prev && cleanList.some((m) => m.id === prev) ? prev : cleanList[0]?.id ?? null
      );
    } catch (err) {
      setMessagesError(err instanceof Error ? err.message : String(err));
    } finally {
      setMessagesLoading(false);
    }
  }, [handleAuthFailure, labelFilter, searchQuery]);

  useEffect(() => {
    if (hasToken) {
      void fetchMessages();
    }
  }, [hasToken, fetchMessages]);

  const handleGoogleSignIn = async () => {
    setAuthLoading(true);
    setAuthError(null);
    setFeedback(null);
    try {
      const res = await googleSignIn({ selectAccount: !user });
      setUser(res.user);
      setHasToken(true);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
      setHasToken(false);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleGoogleSignOut = async () => {
    setAuthLoading(true);
    setAuthError(null);
    setFeedback(null);
    try {
      await googleSignOut();
      setUser(null);
      setHasToken(false);
      setMessages([]);
      setSelectedMessageId(null);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleInsertAtlasDigest = () => {
    const counts = status?.counts;
    const sheetUrl = status?.sheetsStatus?.spreadsheetUrl;
    const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;

    setComposeSubject(
      `FrontierAtlas Intelligence Digest (${new Date().toISOString().slice(0, 10)})`
    );
    const lines = [
      "FrontierAtlas Live Pipeline Summary",
      "==================================",
      `Total Verified & Archive Records: ${total.toLocaleString()}`,
      counts
        ? [
            `- Startups: ${counts.startups.toLocaleString()}`,
            `- Products: ${counts.products.toLocaleString()}`,
            `- Research Papers: ${counts.research_papers.toLocaleString()}`,
            `- Jobs: ${counts.jobs.toLocaleString()}`,
            `- News: ${counts.news.toLocaleString()}`,
            `- Entity Mapping Log: ${counts.entity_mapping_log.toLocaleString()}`,
          ].join("\n")
        : "",
      sheetUrl ? `\nPublic Google Sheet:\n${sheetUrl}` : "",
      status?.lastSuccessfulRunAt
        ? `\nLast Successful Collection: ${new Date(status.lastSuccessfulRunAt).toLocaleString()}`
        : "",
    ].filter(Boolean);

    setComposeBody(lines.join("\n"));
  };

  const handleRequestSend = (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    const to = sanitizeHeaderValue(composeTo);
    const subject = sanitizeHeaderValue(composeSubject);
    if (!to || !to.includes("@")) {
      setFeedback({ success: false, message: "Enter a valid recipient email address." });
      return;
    }
    if (!subject) {
      setFeedback({ success: false, message: "Enter an email subject." });
      return;
    }
    setConfirmAction({
      type: "send",
      to,
      subject,
      body: composeBody,
    });
  };

  const executeConfirmedAction = async () => {
    if (!confirmAction) return;
    const action = confirmAction;
    setConfirmAction(null);

    const token = getGoogleAccessToken();
    if (!token) {
      handleAuthFailure("Google session expired. Sign in with Google again to continue.");
      return;
    }

    if (action.type === "send") {
      setSending(true);
      setFeedback(null);
      try {
        const mimeLines = [
          `To: ${sanitizeHeaderValue(action.to)}`,
          `Subject: ${encodeSubjectHeader(action.subject)}`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=UTF-8",
          "",
          action.body,
        ];
        const raw = encodeBase64UrlUtf8(mimeLines.join("\r\n"));
        const resp = await fetch(
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ raw }),
          }
        );
        if (resp.status === 401 || resp.status === 403) {
          const errJson = await resp.json().catch(() => ({}));
          handleAuthFailure(
            (errJson as { error?: { message?: string } })?.error?.message ||
              `Gmail send rejected (HTTP ${resp.status}). Sign in again with Google.`
          );
          return;
        }
        const data = (await resp.json().catch(() => ({}))) as {
          id?: string;
          error?: { message?: string };
        };
        if (!resp.ok) {
          throw new Error(data.error?.message || `Failed to send email (HTTP ${resp.status}).`);
        }
        setComposeTo("");
        setComposeSubject("");
        setComposeBody("");
        setFeedback({
          success: true,
          message: `Email sent to ${action.to} via Gmail (message ID ${data.id || "confirmed"}).`,
        });
        void fetchMessages();
      } catch (err) {
        setFeedback({
          success: false,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setSending(false);
      }
      return;
    }

    if (action.type === "trash") {
      setTrashingId(action.message.id);
      setFeedback(null);
      try {
        const resp = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(
            action.message.id
          )}/trash`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        if (resp.status === 401 || resp.status === 403) {
          const errJson = await resp.json().catch(() => ({}));
          handleAuthFailure(
            (errJson as { error?: { message?: string } })?.error?.message ||
              `Gmail modify rejected (HTTP ${resp.status}). Sign in again with Google.`
          );
          return;
        }
        if (!resp.ok) {
          const errJson = await resp.json().catch(() => ({}));
          throw new Error(
            (errJson as { error?: { message?: string } })?.error?.message ||
              `Failed to move message to Trash (HTTP ${resp.status}).`
          );
        }
        setMessages((prev) => prev.filter((m) => m.id !== action.message.id));
        if (selectedMessageId === action.message.id) {
          setSelectedMessageId(null);
        }
        setFeedback({
          success: true,
          message: `Moved "${action.message.subject}" to Gmail Trash.`,
        });
      } catch (err) {
        setFeedback({
          success: false,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setTrashingId(null);
      }
    }
  };

  const selectedMessage = messages.find((m) => m.id === selectedMessageId) ?? null;

  return (
    <div className="space-y-6">
      <section className="rounded-xl bg-[#0E172B] border border-slate-800/80 p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Mail className="w-5 h-5 text-sky-400 shrink-0" />
              <h1 className="font-display text-xl font-semibold text-slate-100">
                Gmail Workspace Integration
              </h1>
            </div>
            <p className="text-sm text-slate-400">
              Read, search, and send Gmail messages directly using Google OAuth, or share a live FrontierAtlas dataset digest.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            {hasToken ? (
              <>
                <div className="text-xs text-right">
                  <div className="text-emerald-300 font-medium flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Connected: {user?.email || "Google Account"}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void fetchMessages()}
                  disabled={messagesLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-slate-200 text-xs font-medium transition-colors"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${messagesLoading ? "animate-spin" : ""}`} />
                  <span>Refresh Mail</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleGoogleSignOut()}
                  disabled={authLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-slate-300 text-xs font-medium transition-colors"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Sign Out</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void handleGoogleSignIn()}
                disabled={authLoading}
                className="inline-flex items-center gap-3 h-10 px-4 rounded-full bg-white hover:bg-slate-100 disabled:opacity-60 text-[#1f1f1f] border border-[#747775] text-sm font-medium transition-colors shadow-xs cursor-pointer"
              >
                <svg className="w-4.5 h-4.5 shrink-0" viewBox="0 0 48 48" aria-hidden="true">
                  <path
                    fill="#EA4335"
                    d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                  />
                  <path
                    fill="#4285F4"
                    d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                  />
                  <path
                    fill="#34A853"
                    d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                  />
                </svg>
                <span>{authLoading ? "Connecting..." : "Sign in with Google"}</span>
              </button>
            )}
          </div>
        </div>

        {authError && (
          <div className="mt-4 rounded-lg bg-rose-950/30 border border-rose-800/60 p-3 text-xs text-rose-200 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <span>{authError}</span>
          </div>
        )}

        {feedback && (
          <div
            className={`mt-4 rounded-lg border p-3 text-xs flex items-center justify-between gap-2 ${
              feedback.success
                ? "bg-emerald-950/30 border-emerald-800/60 text-emerald-200"
                : "bg-rose-950/30 border-rose-800/60 text-rose-200"
            }`}
          >
            <span>{feedback.message}</span>
            <button
              type="button"
              onClick={() => setFeedback(null)}
              className="p-1 rounded hover:bg-slate-800/60 text-slate-400 hover:text-slate-200"
              aria-label="Dismiss feedback"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </section>

      {!hasToken ? (
        <section className="rounded-xl bg-[#0E172B] border border-slate-800/80 p-8 text-center space-y-3">
          <Inbox className="w-8 h-8 text-sky-400 mx-auto" />
          <h2 className="font-display text-base font-semibold text-slate-100">
            Connect your Google Account to view and send Gmail messages
          </h2>
          <p className="text-xs text-slate-400 max-w-md mx-auto leading-relaxed">
            OAuth access tokens stay strictly in browser memory for your current session and are never persisted to disk or local storage.
          </p>
        </section>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* Inbox & Message Reader */}
          <section className="xl:col-span-7 rounded-xl bg-[#0E172B] border border-slate-800/80 p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-1.5">
                {(["INBOX", "SENT", "ALL"] as const).map((lbl) => (
                  <button
                    key={lbl}
                    type="button"
                    onClick={() => setLabelFilter(lbl)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                      labelFilter === lbl
                        ? "bg-sky-600 text-white"
                        : "bg-slate-800/80 hover:bg-slate-700 text-slate-300"
                    }`}
                  >
                    {lbl === "INBOX" ? "Inbox" : lbl === "SENT" ? "Sent" : "All Mail"}
                  </button>
                ))}
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void fetchMessages();
                }}
                className="flex items-center gap-2"
              >
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search Gmail..."
                    className="pl-8 pr-3 py-1.5 rounded-lg bg-[#070D1A] border border-slate-800 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-500"
                  />
                </div>
                <button
                  type="submit"
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition-colors"
                >
                  Search
                </button>
              </form>
            </div>

            {messagesError && (
              <div className="rounded-lg bg-rose-950/30 border border-rose-800/60 p-3 text-xs text-rose-200">
                {messagesError}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
                {messagesLoading && messages.length === 0 ? (
                  <div className="p-4 text-xs text-slate-400">Loading Gmail messages...</div>
                ) : messages.length === 0 ? (
                  <div className="p-4 text-xs text-slate-400 rounded-lg bg-[#070D1A] border border-slate-800">
                    No messages matched this filter.
                  </div>
                ) : (
                  messages.map((msg) => {
                    const isSelected = msg.id === selectedMessageId;
                    return (
                      <button
                        key={msg.id}
                        type="button"
                        onClick={() => setSelectedMessageId(msg.id)}
                        className={`w-full text-left rounded-lg border p-3 transition-colors space-y-1 ${
                          isSelected
                            ? "bg-sky-500/10 border-sky-500/60"
                            : "bg-[#070D1A] border-slate-800/80 hover:border-slate-700"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={`text-xs truncate ${
                              msg.unread ? "font-semibold text-slate-100" : "font-medium text-slate-300"
                            }`}
                          >
                            {msg.from}
                          </span>
                          {msg.unread && (
                            <span className="text-[10px] font-mono text-sky-400 shrink-0">NEW</span>
                          )}
                        </div>
                        <div className="text-xs font-medium text-slate-200 truncate">
                          {msg.subject}
                        </div>
                        <div className="text-[11px] text-slate-400 line-clamp-2">{msg.snippet}</div>
                      </button>
                    );
                  })
                )}
              </div>

              <div className="rounded-lg bg-[#070D1A] border border-slate-800 p-4 flex flex-col justify-between min-h-[260px] max-h-[420px]">
                {selectedMessage ? (
                  <>
                    <div className="space-y-3 overflow-y-auto pr-1">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-sm font-semibold text-slate-100 leading-snug">
                          {selectedMessage.subject}
                        </h3>
                        <button
                          type="button"
                          onClick={() =>
                            setConfirmAction({ type: "trash", message: selectedMessage })
                          }
                          disabled={trashingId === selectedMessage.id}
                          className="p-1.5 rounded-md bg-rose-950/50 hover:bg-rose-900/60 border border-rose-800/60 text-rose-300 shrink-0 transition-colors"
                          title="Move message to Trash"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="text-[11px] text-slate-400 space-y-0.5 border-b border-slate-800/80 pb-2">
                        <div className="truncate">
                          <span className="text-slate-500">From:</span> {selectedMessage.from}
                        </div>
                        {selectedMessage.to && (
                          <div className="truncate">
                            <span className="text-slate-500">To:</span> {selectedMessage.to}
                          </div>
                        )}
                        {selectedMessage.date && (
                          <div className="font-mono text-slate-500">{selectedMessage.date}</div>
                        )}
                      </div>
                      <pre className="text-xs text-slate-300 whitespace-pre-wrap font-sans leading-relaxed">
                        {selectedMessage.bodyText}
                      </pre>
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-slate-500 m-auto">
                    Select a message to inspect its contents.
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Compose & Send */}
          <section className="xl:col-span-5 rounded-xl bg-[#0E172B] border border-slate-800/80 p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Send className="w-4 h-4 text-sky-400" />
                <h2 className="font-display text-base font-semibold text-slate-100">
                  Compose Email
                </h2>
              </div>
              <button
                type="button"
                onClick={handleInsertAtlasDigest}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-sky-300 text-xs font-medium transition-colors"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                <span>Insert FrontierAtlas Digest</span>
              </button>
            </div>

            <form onSubmit={handleRequestSend} className="space-y-3">
              <div className="space-y-1">
                <label htmlFor="gmail-to" className="text-xs text-slate-400 block">
                  To
                </label>
                <input
                  id="gmail-to"
                  type="email"
                  required
                  value={composeTo}
                  onChange={(e) => setComposeTo(e.target.value)}
                  placeholder="recipient@example.com"
                  className="w-full px-3 py-2 rounded-lg bg-[#070D1A] border border-slate-800 text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-sky-500"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="gmail-subject" className="text-xs text-slate-400 block">
                  Subject
                </label>
                <input
                  id="gmail-subject"
                  type="text"
                  required
                  value={composeSubject}
                  onChange={(e) => setComposeSubject(e.target.value)}
                  placeholder="FrontierAtlas Update"
                  className="w-full px-3 py-2 rounded-lg bg-[#070D1A] border border-slate-800 text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-sky-500"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="gmail-body" className="text-xs text-slate-400 block">
                  Message
                </label>
                <textarea
                  id="gmail-body"
                  rows={8}
                  required
                  value={composeBody}
                  onChange={(e) => setComposeBody(e.target.value)}
                  placeholder="Write your email or click 'Insert FrontierAtlas Digest' above..."
                  className="w-full px-3 py-2 rounded-lg bg-[#070D1A] border border-slate-800 text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-sky-500"
                />
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={sending}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-60 text-white text-xs font-medium transition-colors"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>{sending ? "Sending..." : "Review & Send"}</span>
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {/* Explicit Confirmation Modal for Gmail mutations */}
      {confirmAction && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs"
          onClick={() => setConfirmAction(null)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-[#0E172B] border border-slate-800 p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-display text-base font-semibold text-slate-100">
                {confirmAction.type === "send"
                  ? "Confirm Gmail Send"
                  : "Confirm Move to Gmail Trash"}
              </h3>
              <button
                type="button"
                onClick={() => setConfirmAction(null)}
                className="p-1 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800"
                aria-label="Close confirmation"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {confirmAction.type === "send" ? (
              <div className="space-y-2 text-xs text-slate-300">
                <div>
                  <span className="text-slate-400">To:</span>{" "}
                  <span className="font-mono text-slate-100">{confirmAction.to}</span>
                </div>
                <div>
                  <span className="text-slate-400">Subject:</span>{" "}
                  <span className="text-slate-100 font-medium">{confirmAction.subject}</span>
                </div>
                <pre className="max-h-40 overflow-y-auto rounded-lg bg-[#070D1A] border border-slate-800 p-3 text-[11px] whitespace-pre-wrap font-sans text-slate-300">
                  {confirmAction.body}
                </pre>
              </div>
            ) : (
              <div className="space-y-2 text-xs text-slate-300">
                <p>Are you sure you want to move this email to Trash?</p>
                <div className="rounded-lg bg-[#070D1A] border border-slate-800 p-3 space-y-1">
                  <div className="font-medium text-slate-100">{confirmAction.message.subject}</div>
                  <div className="text-slate-400 truncate">From: {confirmAction.message.from}</div>
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setConfirmAction(null)}
                className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void executeConfirmedAction()}
                className={`px-3.5 py-2 rounded-lg text-white text-xs font-medium transition-colors ${
                  confirmAction.type === "trash"
                    ? "bg-rose-600 hover:bg-rose-500"
                    : "bg-sky-600 hover:bg-sky-500"
                }`}
              >
                {confirmAction.type === "send" ? "Confirm & Send Email" : "Confirm Move to Trash"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
