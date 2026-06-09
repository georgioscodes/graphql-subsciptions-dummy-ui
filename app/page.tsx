"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "graphql-ws";

const GQL_HTTP = process.env.NEXT_PUBLIC_GQL_HTTP ?? "https://api.dev.adpower.com/graphql";
const GQL_WS = process.env.NEXT_PUBLIC_GQL_WS ?? "wss://api.dev.adpower.com/subscriptions";

const CREATE_SESSION = `
  mutation CreateSession($input: CreateAiPlannerSessionInput) {
    createAiPlannerSession(input: $input) {
      sessionId
      flow
    }
  }
`;

const AI_PLANNER_SUBSCRIPTION = `
  subscription AiPlanner($input: AiPlannerInput!) {
    aiPlanner(input: $input) {
      textDelta
      done
      planReady
      suggestions
      brief {
        goal brand budgetGbp geography audience channels formats
        dates { start end }
      }
      plan {
        budgetGbp rationale
        locations { frameId label format lat lng impacts costGbp }
        broadcastRegions { brand buyingAreaId duration impacts costGbp }
      }
    }
  }
`;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface FrameLog {
  ts: string;
  frame: Record<string, unknown>;
}

function generateTurnId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function Home() {
  const [gigyaToken, setGigyaToken] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [frames, setFrames] = useState<FrameLog[]>([]);
  const [error, setError] = useState<string | null>(null);

  const chatBottomRef = useRef<HTMLDivElement>(null);
  const framesBottomRef = useRef<HTMLDivElement>(null);
  const wsClientRef = useRef<ReturnType<typeof createClient> | null>(null);

  // Reveal queue: the orchestrator sends all textDelta frames in a sub-100ms burst, so appending
  // them directly renders the whole reply at once. Instead we queue each delta and drain one per
  // tick, so words visibly appear in the chat as they stream.
  const deltaQueueRef = useRef<string[]>([]);
  const drainTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const doneReceivingRef = useRef(false);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    framesBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [frames]);

  // Clear the drain timer if the component unmounts mid-stream.
  useEffect(() => {
    return () => {
      if (drainTimerRef.current) clearInterval(drainTimerRef.current);
    };
  }, []);

  // Reveal one queued delta per tick (~40ms). When the queue is empty and the server has finished
  // sending, stop the timer and clear the streaming flag.
  function startDraining() {
    if (drainTimerRef.current) return;
    drainTimerRef.current = setInterval(() => {
      const next = deltaQueueRef.current.shift();
      if (next !== undefined) {
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          updated[updated.length - 1] = { role: "assistant", content: last.content + next };
          return updated;
        });
      } else if (doneReceivingRef.current) {
        if (drainTimerRef.current) clearInterval(drainTimerRef.current);
        drainTimerRef.current = null;
        setStreaming(false);
      }
    }, 40);
  }

  function getWsClient() {
    if (wsClientRef.current) wsClientRef.current.dispose();
    const client = createClient({
      url: GQL_WS,
      connectionParams: { Authorization: `Bearer ${gigyaToken}` },
    });
    wsClientRef.current = client;
    return client;
  }

  async function createSession() {
    const res = await fetch(GQL_HTTP, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${gigyaToken}`,
      },
      body: JSON.stringify({ query: CREATE_SESSION, variables: { input: {} } }),
    });
    const data = await res.json();
    if (data.errors) throw new Error(data.errors[0].message);
    return data.data.createAiPlannerSession.sessionId as string;
  }

  async function sendMessage() {
    if (!input.trim() || streaming || !gigyaToken) return;
    setError(null);
    const userMessage = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);

    let sid = sessionId;
    try {
      if (!sid) {
        sid = await createSession();
        setSessionId(sid);
      }
    } catch (e) {
      setError(`Session creation failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    const turnId = generateTurnId();
    setStreaming(true);

    deltaQueueRef.current = [];
    doneReceivingRef.current = false;
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    const client = getWsClient();

    const unsub = client.subscribe(
      {
        query: AI_PLANNER_SUBSCRIPTION,
        variables: { input: { sessionId: sid, message: userMessage, turnId } },
      },
      {
        next(data) {
          const frame = (data.data as { aiPlanner: Record<string, unknown> }).aiPlanner;
          setFrames((prev) => [
            ...prev,
            { ts: new Date().toISOString(), frame },
          ]);

          if (frame.textDelta) {
            deltaQueueRef.current.push(frame.textDelta as string);
            startDraining();
          }

          if (frame.done) {
            // Let the drainer finish revealing any queued deltas, then it clears `streaming`.
            doneReceivingRef.current = true;
            startDraining();
            unsub();
          }
        },
        error(err) {
          let msg: string;
          if (Array.isArray(err)) {
            // graphql-ws delivers a GraphQL subscription error as an array of
            // GraphQLError objects (the server's `error` message payload).
            msg = err
              .map((e) => {
                const m = (e as { message?: string }).message ?? JSON.stringify(e);
                const cls = (e as { extensions?: { classification?: string } })
                  .extensions?.classification;
                return cls ? `${m} [${cls}]` : m;
              })
              .join("; ");
          } else if (err instanceof Error) {
            msg = err.message;
          } else if (err && typeof err === "object" && "code" in err) {
            const e = err as { code: number; reason?: string };
            msg = `WebSocket closed — code ${e.code}${e.reason ? `: ${e.reason}` : " (no reason given)"}`;
          } else {
            msg = `WebSocket connection failed — check the server is running and reachable at ${GQL_WS}`;
          }
          setError(`Stream error: ${msg}`);
          if (drainTimerRef.current) clearInterval(drainTimerRef.current);
          drainTimerRef.current = null;
          deltaQueueRef.current = [];
          setStreaming(false);
        },
        complete() {
          // Drain whatever is queued, then stop.
          doneReceivingRef.current = true;
          startDraining();
        },
      }
    );
  }

  function resetSession() {
    wsClientRef.current?.dispose();
    wsClientRef.current = null;
    if (drainTimerRef.current) clearInterval(drainTimerRef.current);
    drainTimerRef.current = null;
    deltaQueueRef.current = [];
    doneReceivingRef.current = false;
    setSessionId(null);
    setMessages([]);
    setFrames([]);
    setError(null);
    setStreaming(false);
  }

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-gray-100 font-mono text-sm">
      {/* Header */}
      <div className="flex items-center gap-3 p-3 border-b border-gray-700 bg-gray-800">
        <span className="text-gray-400 whitespace-nowrap text-xs">Gigya token</span>
        <input
          className="flex-1 bg-gray-700 rounded px-3 py-1.5 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="Paste Gigya token..."
          value={gigyaToken}
          onChange={(e) => setGigyaToken(e.target.value)}
        />
        {sessionId && (
          <span className="text-xs text-green-400 whitespace-nowrap">
            session: {sessionId.slice(0, 8)}…
          </span>
        )}
        <button
          onClick={resetSession}
          className="text-xs px-3 py-1.5 bg-gray-700 rounded hover:bg-gray-600"
        >
          Reset
        </button>
      </div>

      {error && (
        <div className="bg-red-900 text-red-300 text-xs px-4 py-2 border-b border-red-700">
          {error}
        </div>
      )}

      {/* Body: split panels */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Chat */}
        <div className="flex flex-col w-1/2 border-r border-gray-700">
          <div className="px-3 py-2 text-xs text-gray-400 border-b border-gray-700 bg-gray-800">
            Chat
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] rounded px-3 py-2 whitespace-pre-wrap break-words ${
                    m.role === "user"
                      ? "bg-blue-700 text-white"
                      : "bg-gray-700 text-gray-100"
                  }`}
                >
                  {m.content || <span className="animate-pulse text-gray-400">▋</span>}
                </div>
              </div>
            ))}
            <div ref={chatBottomRef} />
          </div>
          <div className="flex gap-2 p-3 border-t border-gray-700 bg-gray-800">
            <input
              className="flex-1 bg-gray-700 rounded px-3 py-2 outline-none focus:ring-1 focus:ring-blue-500"
              placeholder={gigyaToken ? "Type a message…" : "Paste a Gigya token first"}
              value={input}
              disabled={!gigyaToken || streaming}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
            />
            <button
              onClick={sendMessage}
              disabled={!gigyaToken || !input.trim() || streaming}
              className="px-4 py-2 bg-blue-600 rounded hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {streaming ? "…" : "Send"}
            </button>
          </div>
        </div>

        {/* Right: Frame stream log */}
        <div className="flex flex-col w-1/2">
          <div className="flex items-center justify-between px-3 py-2 text-xs text-gray-400 border-b border-gray-700 bg-gray-800">
            <span>Frame stream</span>
            <button
              onClick={() => setFrames([])}
              className="hover:text-gray-200"
            >
              clear
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {frames.length === 0 && (
              <div className="text-gray-600 text-xs pt-4 text-center">
                Frames will appear here when streaming starts
              </div>
            )}
            {frames.map((f, i) => (
              <div key={i} className="bg-gray-800 rounded p-2 text-xs">
                <div className="text-gray-500 mb-1">{f.ts}</div>
                <pre className="text-green-400 whitespace-pre-wrap break-all">
                  {JSON.stringify(f.frame, null, 2)}
                </pre>
              </div>
            ))}
            <div ref={framesBottomRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
