import "./styles.css";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Fragment,
  type KeyboardEvent,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent
} from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName, type UIMessage } from "ai";
import {
  EMPTY_DIGEST,
  formatRelativeShelfLabel,
  formatTimestamp,
  groupBooks,
  INITIAL_BOOKWORM_STATE,
  normalizeAgentName,
  type BookEntry,
  type BookStatus,
  type BookWormState,
  type ExtensionSummary,
  type ReminderSummary
} from "./shared";

type ReaderIdentity = {
  displayName: string;
  agentName: string;
};

type ConnectionStatus = "connecting" | "connected" | "disconnected";

const THINK_DOCS_URL = "https://developers.cloudflare.com/agents/";
const REPO_URL = "https://github.com/craigsdennis/bookworm-think-agent";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReminderSummary(value: unknown): value is ReminderSummary {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.callback === "string" &&
    typeof value.kind === "string" &&
    typeof value.nextRunAt === "string" &&
    typeof value.note === "string" &&
    typeof value.cadence === "string"
  );
}

function readReminderList(output: unknown): ReminderSummary[] | null {
  if (!isRecord(output) || !Array.isArray(output.reminders)) {
    return null;
  }

  const reminders = output.reminders.filter(isReminderSummary);
  return reminders.length === output.reminders.length ? reminders : null;
}

function readSingleReminder(output: unknown): ReminderSummary | null {
  if (!isRecord(output) || !isReminderSummary(output.reminder)) {
    return null;
  }

  return output.reminder;
}

function isExtensionSummary(value: unknown): value is ExtensionSummary {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    Array.isArray(value.tools)
  );
}

function readExtensionList(output: unknown): ExtensionSummary[] | null {
  if (!isRecord(output) || !Array.isArray(output.extensions)) {
    return null;
  }

  const extensions = output.extensions.filter(isExtensionSummary);
  return extensions.length === output.extensions.length ? extensions : null;
}

function readInstalledExtension(output: unknown): ExtensionSummary | null {
  if (!isRecord(output) || typeof output.name !== "string" || typeof output.version !== "string") {
    return null;
  }

  return {
    name: output.name,
    version: output.version,
    description: typeof output.description === "string" ? output.description : undefined,
    tools: Array.isArray(output.tools) ? output.tools.filter((item): item is string => typeof item === "string") : [],
    permissions: isRecord(output.permissions)
      ? {
          workspace:
            output.permissions.workspace === "none" ||
            output.permissions.workspace === "read" ||
            output.permissions.workspace === "read-write"
              ? output.permissions.workspace
              : undefined,
          network: Array.isArray(output.permissions.network)
            ? output.permissions.network.filter((item): item is string => typeof item === "string")
            : undefined
        }
      : {}
  };
}

function upsertReminder(reminders: ReminderSummary[], reminder: ReminderSummary): ReminderSummary[] {
  const next = reminders.filter((entry) => entry.id !== reminder.id);
  next.push(reminder);
  return next.sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
}

function upsertExtension(
  extensions: ExtensionSummary[],
  extension: ExtensionSummary
): ExtensionSummary[] {
  const next = extensions.filter((entry) => entry.name !== extension.name);
  next.push(extension);
  return next.sort((a, b) => a.name.localeCompare(b.name));
}

function sameReminderList(left: ReminderSummary[], right: ReminderSummary[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((item, index) => {
    const other = right[index];
    return (
      item.id === other.id &&
      item.callback === other.callback &&
      item.kind === other.kind &&
      item.nextRunAt === other.nextRunAt &&
      item.note === other.note &&
      item.cadence === other.cadence
    );
  });
}

function sameExtensionList(left: ExtensionSummary[], right: ExtensionSummary[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((item, index) => {
    const other = right[index];
    return (
      item.name === other.name &&
      item.version === other.version &&
      item.description === other.description &&
      item.permissions.workspace === other.permissions.workspace &&
      JSON.stringify(item.permissions.network ?? []) ===
        JSON.stringify(other.permissions.network ?? []) &&
      JSON.stringify(item.tools) === JSON.stringify(other.tools)
    );
  });
}

const SUGGESTIONS = [
  "Add The Left Hand of Darkness to my to-read shelf.",
  "I'm halfway through Piranesi. Move it to reading.",
  "Save a 5-star review for Small Things Like These.",
  "Remind me tomorrow at 8pm to read for thirty minutes.",
  "Build me a notes extension that stores quote fragments in a writable context block."
];

function SiteFooter() {
  return (
    <footer className="site-footer">
      <p>
        Built with <span aria-hidden="true">🧡</span> using{" "}
        <a href={THINK_DOCS_URL} target="_blank" rel="noreferrer">
          Agents SDK - Think
        </a>
      </p>
      <p>
        <span aria-hidden="true">👀</span>{" "}
        <a href={REPO_URL} target="_blank" rel="noreferrer">
          the code
        </a>
      </p>
    </footer>
  );
}

function HomePage({
  defaultName,
  onStart
}: {
  defaultName: string;
  onStart(identity: ReaderIdentity): void;
}) {
  const [name, setName] = useState(defaultName);

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    onStart({
      displayName: trimmed,
      agentName: normalizeAgentName(trimmed)
    });
  }

  return (
    <main className="landing-shell">
      <section className="landing-card">
        <div className="landing-crest">BW</div>
        <p className="eyebrow">Cloudflare Think Demo</p>
        <h1>BookWorm</h1>
        <p className="lead">
          A long-running reading companion with a live bookshelf, durable workspace,
          reminder scheduling, and chat-installed extensions.
        </p>

        <form className="name-form" onSubmit={submit}>
          <label htmlFor="reader-name">Who is entering the library?</label>
          <div className="name-row">
            <input
              id="reader-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ada Lovelace"
              autoComplete="name"
            />
            <button type="submit">Open BookWorm</button>
          </div>
        </form>

        <ul className="promise-list">
          <li>Every entered name maps to its own Think agent.</li>
          <li>The bookshelf syncs in real time from durable agent state.</li>
          <li>Extensions install in chat and persist across hibernation.</li>
        </ul>
      </section>
    </main>
  );
}

function ShelfColumn({
  title,
  books,
  tone
}: {
  title: string;
  books: BookEntry[];
  tone: "gold" | "ink" | "pine";
}) {
  return (
    <section className={`shelf-column shelf-${tone}`}>
      <div className="shelf-header">
        <h3>{title}</h3>
        <span>{books.length}</span>
      </div>
      {books.length === 0 ? (
        <p className="empty-note">No books here yet.</p>
      ) : (
        <div className="book-stack">
          {books.map((book) => (
            <article key={book.id} className="book-card">
              <div className="book-card-layout">
                {book.coverImageUrl ? (
                  <img
                    className="book-cover"
                    src={book.coverImageUrl}
                    alt={`Cover of ${book.title}`}
                    loading="lazy"
                  />
                ) : (
                  <div className="book-cover book-cover-placeholder" aria-hidden="true">
                    {book.title.slice(0, 1)}
                  </div>
                )}
                <div className="book-copy">
                  {book.openLibraryUrl ? (
                    <a
                      className="book-title book-link"
                      href={book.openLibraryUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {book.title}
                    </a>
                  ) : (
                    <p className="book-title">{book.title}</p>
                  )}
                  <p className="book-author">{book.author}</p>
                  {book.rating ? <p className="book-rating">{Array.from({ length: book.rating }, () => "★").join("")}</p> : null}
                  {book.review ? <p className="book-review">“{book.review}”</p> : null}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function MessageBubble({
  message,
  isStreaming,
  onApprove,
  onReject
}: {
  message: UIMessage;
  isStreaming: boolean;
  onApprove(id: string): void;
  onReject(id: string): void;
}) {
  const isUser = message.role === "user";
  const textParts = message.parts.filter((part) => part.type === "text");

  return (
    <div className={`message-row ${isUser ? "user" : "assistant"}`}>
      <div className="message-bubble">
        {textParts.map((part, index) => (
          <div key={index} className="message-text">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
            {!isUser && isStreaming && index === textParts.length - 1 ? (
              <span className="cursor">|</span>
            ) : null}
          </div>
        ))}

        {message.parts.map((part, index) => {
          if (!isToolUIPart(part)) return null;

          const toolName = getToolName(part);

          if (part.state === "input-available" || part.state === "input-streaming") {
            return (
              <div className="tool-chip" key={`${toolName}-${index}`}>
                Running <strong>{toolName}</strong>
              </div>
            );
          }

          if (part.state === "output-available") {
            return (
              <details className="tool-result tool-disclosure" key={`${toolName}-${index}`}>
                <summary className="tool-summary">
                  <span className="tool-label">{toolName}</span>
                  <span className="tool-summary-hint">Click to view result</span>
                </summary>
                <pre>{JSON.stringify(part.output, null, 2)}</pre>
              </details>
            );
          }

          if (part.state === "output-denied") {
            return (
              <div className="tool-chip denied" key={`${toolName}-${index}`}>
                Denied <strong>{toolName}</strong>
              </div>
            );
          }

          if ("approval" in part && part.state === "approval-requested") {
            const approvalId = (part.approval as { id?: string })?.id;

            return (
              <div className="approval-card" key={`${toolName}-${index}`}>
                <p>
                  <strong>{toolName}</strong> wants approval.
                </p>
                <pre>{JSON.stringify(part.input, null, 2)}</pre>
                <div className="approval-actions">
                  <button
                    type="button"
                    onClick={() => approvalId && onApprove(approvalId)}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => approvalId && onReject(approvalId)}
                  >
                    Reject
                  </button>
                </div>
              </div>
            );
          }

          return null;
        })}
      </div>
    </div>
  );
}

function BookWormDesk({
  identity,
  onSwitchReader
}: {
  identity: ReaderIdentity;
  onSwitchReader(): void;
}) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [libraryState, setLibraryState] = useState<BookWormState>(INITIAL_BOOKWORM_STATE);
  const [reminders, setReminders] = useState<ReminderSummary[]>([]);
  const [extensions, setExtensions] = useState<ExtensionSummary[]>([]);
  const [input, setInput] = useState("");
  const lastToolSyncSignature = useRef("");
  const initializedReaderRef = useRef<string | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);

  const agent = useAgent<BookWormState>({
    agent: "BookWormAgent",
    name: identity.agentName,
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onStateUpdate: useCallback((nextState: BookWormState) => {
      setLibraryState(nextState);
    }, [])
  });

  const {
    messages,
    sendMessage,
    clearHistory,
    stop,
    isStreaming,
    error,
    clearError,
    addToolApprovalResponse
  } = useAgentChat({ agent });

  const grouped = useMemo(() => groupBooks(libraryState.books), [libraryState.books]);

  const refreshPanels = useCallback(async () => {
    try {
      const [nextReminders, nextExtensions] = await Promise.all([
        agent.call("getReminderSchedules", []),
        agent.call("listInstalledExtensions", [])
      ]);

      setReminders(nextReminders as ReminderSummary[]);
      setExtensions(nextExtensions as ExtensionSummary[]);
    } catch {
      // Ignore while the connection is still warming up.
    }
  }, [agent]);

  const scrollMessagesToBottom = useCallback(() => {
    const list = messageListRef.current;
    if (!list) {
      return;
    }

    list.scrollTop = list.scrollHeight;
  }, []);

  useEffect(() => {
    localStorage.setItem("bookworm:last-name", identity.displayName);

    if (initializedReaderRef.current === identity.agentName) {
      return;
    }

    initializedReaderRef.current = identity.agentName;

    void agent.call("initializeOwner", [identity.displayName]).then(() => {
      void refreshPanels();
    });
  }, [agent, identity.displayName, refreshPanels]);

  useEffect(() => {
    if (connectionStatus === "connected") {
      void refreshPanels();
    }
  }, [connectionStatus, refreshPanels]);

  useEffect(() => {
    if (messages.length > 0 && !isStreaming) {
      void refreshPanels();
    }
  }, [messages, isStreaming, refreshPanels]);

  useEffect(() => {
    if (!shouldStickToBottomRef.current) {
      return;
    }

    const animationFrame = requestAnimationFrame(() => {
      scrollMessagesToBottom();
    });

    return () => cancelAnimationFrame(animationFrame);
  }, [messages, isStreaming, scrollMessagesToBottom]);

  useEffect(() => {
    const reversedMessages = [...messages].reverse();
    let nextReminderList: ReminderSummary[] | null = null;
    let nextReminderSingle: ReminderSummary | null = null;
    let nextExtensionList: ExtensionSummary[] | null = null;
    let nextInstalledExtension: ExtensionSummary | null = null;

    for (const message of reversedMessages) {
      for (const part of message.parts) {
        if (!isToolUIPart(part) || part.state !== "output-available") {
          continue;
        }

        const toolName = getToolName(part);
        const reminderList = readReminderList(part.output);
        const singleReminder = readSingleReminder(part.output);
        const extensionList = readExtensionList(part.output);
        const installedExtension = readInstalledExtension(part.output);

        if (
          toolName === "list_scheduled_reminders" ||
          toolName === "cancel_scheduled_reminder"
        ) {
          if (reminderList && !nextReminderList) {
            nextReminderList = reminderList;
          }
        }

        if (toolName === "schedule_reading_reminder" && singleReminder && !nextReminderSingle) {
          nextReminderSingle = singleReminder;
        }

        if (toolName === "list_extensions" || toolName === "remove_extension") {
          if (extensionList && !nextExtensionList) {
            nextExtensionList = extensionList;
          }
        }

        if (toolName === "install_extension" && installedExtension && !nextInstalledExtension) {
          nextInstalledExtension = installedExtension;
        }
      }
    }

    const signature = JSON.stringify({
      nextReminderList,
      nextReminderSingle,
      nextExtensionList,
      nextInstalledExtension
    });

    if (signature === lastToolSyncSignature.current) {
      return;
    }

    lastToolSyncSignature.current = signature;

    if (nextReminderList) {
      setReminders((current) =>
        sameReminderList(current, nextReminderList!) ? current : nextReminderList!
      );
    } else if (nextReminderSingle) {
      setReminders((current) => {
        const next = upsertReminder(current, nextReminderSingle!);
        return sameReminderList(current, next) ? current : next;
      });
    }

    if (nextExtensionList) {
      setExtensions((current) =>
        sameExtensionList(current, nextExtensionList!) ? current : nextExtensionList!
      );
    } else if (nextInstalledExtension) {
      setExtensions((current) => {
        const next = upsertExtension(current, nextInstalledExtension!);
        return sameExtensionList(current, next) ? current : next;
      });
    }
  }, [messages]);

  const send = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed) return;
    shouldStickToBottomRef.current = true;
    setInput("");
    clearError();
    sendMessage({
      role: "user",
      parts: [{ type: "text", text: trimmed }]
    });
  }, [clearError, input, sendMessage]);

  const canSend = input.trim().length > 0 && connectionStatus === "connected";

  const handleComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
        return;
      }

      event.preventDefault();

      if (canSend) {
        send();
      }
    },
    [canSend, send]
  );

  const handleMessageListScroll = useCallback(() => {
    const list = messageListRef.current;
    if (!list) {
      return;
    }

    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom < 48;
  }, []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Think Agent Workspace</p>
          <h1>BookWorm for {libraryState.ownerName || identity.displayName}</h1>
        </div>
        <div className="topbar-actions">
          <span className={`connection-pill ${connectionStatus}`}>{connectionStatus}</span>
          <button type="button" className="ghost" onClick={onSwitchReader}>
            Switch reader
          </button>
        </div>
      </header>

      <section className="hero-band">
        <div>
          <p className="hero-label">Durable shelf</p>
          <p className="hero-value">{libraryState.books.length} books</p>
        </div>
        <div>
          <p className="hero-label">Extensions</p>
          <p className="hero-value">{libraryState.extensionCount}</p>
        </div>
        <div>
          <p className="hero-label">Digest</p>
          <p className="hero-value">{libraryState.lastDigest.status}</p>
        </div>
      </section>

      <section className="layout-grid">
        <aside className="sidebar">
          <div className="panel sidebar-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Bookshelf</p>
                <h2>Live state</h2>
              </div>
            </div>
            <div className="shelf-grid">
              <ShelfColumn title={formatRelativeShelfLabel("to-read")} books={grouped["to-read"]} tone="gold" />
              <ShelfColumn title={formatRelativeShelfLabel("reading")} books={grouped.reading} tone="pine" />
              <ShelfColumn title={formatRelativeShelfLabel("read")} books={grouped.read} tone="ink" />
            </div>
          </div>

          <div className="panel meta-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Reminders</p>
                <h2>Scheduled nudges</h2>
              </div>
              <button type="button" className="ghost" onClick={() => void refreshPanels()}>
                Refresh
              </button>
            </div>
            {reminders.length === 0 ? (
              <p className="empty-note">No scheduled reminders yet.</p>
            ) : (
              <div className="meta-list">
                {reminders.map((reminder) => (
                  <article key={reminder.id} className="meta-card">
                    <p className="meta-title">{reminder.note}</p>
                    <p>{reminder.cadence}</p>
                    <p>{formatTimestamp(reminder.nextRunAt)}</p>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        void agent.call("cancelReminder", [reminder.id]).then((result) => {
                          setReminders(result as ReminderSummary[]);
                        });
                      }}
                    >
                      Cancel
                    </button>
                  </article>
                ))}
              </div>
            )}
          </div>

          <div className="panel meta-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Extensions</p>
                <h2>Installed Extensions</h2>
                <p className="panel-caption">
                  Loaded dynamically through chat-approved Think extensions.
                </p>
              </div>
            </div>
            {extensions.length === 0 ? (
              <p className="empty-note">
                Ask BookWorm to create and install a custom extension. It can persist with
                workspace files or its own writable context blocks.
              </p>
            ) : (
              <div className="meta-list">
                {extensions.map((extension) => (
                  <article key={extension.name} className="meta-card extension-card">
                    <div className="extension-card-header">
                      <p className="meta-title extension-name">{extension.name}</p>
                      <span className="extension-version">v{extension.version}</span>
                    </div>
                    <p className="extension-description">
                      {extension.description || "No description provided."}
                    </p>
                    <div className="extension-badges">
                      <span className="extension-badge">
                        {extension.tools.length} tool{extension.tools.length === 1 ? "" : "s"}
                      </span>
                      <span className="extension-badge">
                        Workspace: {extension.permissions.workspace ?? "none"}
                      </span>
                      <span className="extension-badge">
                        Network: {extension.permissions.network?.length ? "enabled" : "off"}
                      </span>
                    </div>
                    <div className="extension-tools">
                      {extension.tools.map((tool) => (
                        <span key={tool} className="extension-tool-pill">
                          {tool}
                        </span>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>

          <div className="panel meta-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Background fiber</p>
                <h2>Reading digest</h2>
              </div>
            </div>
            <p className="meta-title">{libraryState.lastDigest.status}</p>
            <p>{libraryState.lastDigest.note || EMPTY_DIGEST.note}</p>
            <p>{libraryState.lastDigest.path || "No digest file yet."}</p>
            <p>{formatTimestamp(libraryState.lastDigest.generatedAt)}</p>
          </div>
        </aside>

        <section className="chat-panel panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Conversation</p>
              <h2>Talk to your agent</h2>
            </div>
            <div className="chat-actions">
              <button type="button" className="ghost" onClick={() => void refreshPanels()}>
                Sync panels
              </button>
              <button type="button" className="ghost" onClick={() => clearHistory()}>
                Clear chat
              </button>
            </div>
          </div>

          <div className="suggestion-row">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="suggestion-chip"
                onClick={() => setInput(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>

          <div className="message-list" ref={messageListRef} onScroll={handleMessageListScroll}>
            {messages.length === 0 ? (
              <div className="empty-chat">
                <p>BookWorm is ready.</p>
                <span>
                  Track books, schedule reminders, generate a digest, or ask for a custom
                  extension that saves its own data.
                </span>
              </div>
            ) : (
              messages.map((message) => (
                <Fragment key={message.id}>
                  <MessageBubble
                    message={message}
                    isStreaming={isStreaming && message.id === messages[messages.length - 1]?.id}
                    onApprove={(id) => addToolApprovalResponse({ id, approved: true })}
                    onReject={(id) => addToolApprovalResponse({ id, approved: false })}
                  />
                </Fragment>
              ))
            )}
          </div>

          {error ? <div className="error-banner">{error.message}</div> : null}

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <textarea
              rows={4}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder="Ask BookWorm to track a book, review one, schedule a reminder, or design a custom extension."
            />
            <div className="composer-actions">
              <button type="button" className="ghost" onClick={() => stop()} disabled={!isStreaming}>
                Stop
              </button>
              <button type="submit" disabled={!canSend}>
                Send to BookWorm
              </button>
            </div>
          </form>
        </section>
      </section>
    </main>
  );
}

function App() {
  const [activeIdentity, setActiveIdentity] = useState<ReaderIdentity | null>(null);

  const defaultName = useMemo(() => localStorage.getItem("bookworm:last-name") ?? "", []);

  return (
    <>
      {activeIdentity ? (
        <BookWormDesk identity={activeIdentity} onSwitchReader={() => setActiveIdentity(null)} />
      ) : (
        <HomePage defaultName={defaultName} onStart={setActiveIdentity} />
      )}
      <SiteFooter />
    </>
  );
}

const container = document.getElementById("root");

if (!container) {
  throw new Error("Root container was not found.");
}

type RootContainer = HTMLElement & {
  __bookwormRoot?: Root;
};

const rootContainer = container as RootContainer;
const root = rootContainer.__bookwormRoot ?? createRoot(rootContainer);
rootContainer.__bookwormRoot = root;

root.render(
  <Suspense fallback={null}>
    <App />
  </Suspense>
);
