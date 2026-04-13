// types.ts

// Session information shared between broker and clients
export interface SessionInfo {
  id: string;              // Unique session identifier (assigned by broker)
  name?: string;           // User-assigned name (/name command)
  cwd: string;             // Working directory
  model: string;           // Current model (e.g., "claude-sonnet-4")
  pid: number;             // Process ID
  startedAt: number;       // Unix timestamp
  lastActivity: number;    // Unix timestamp
  status?: string;         // Custom status (e.g., "researching", "executing")
}

// Message content
export interface Message {
  id: string;              // UUID
  timestamp: number;       // Unix timestamp
  replyTo?: string;        // Message ID for threading
  content: {
    text: string;
    attachments?: Attachment[];
  };
}

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;         // File content or snippet text
  language?: string;       // For syntax highlighting
}

// Client → Broker messages
export type ClientMessage =
  | { type: "register"; session: Omit<SessionInfo, "id"> }
  | { type: "unregister" }
  | { type: "list"; requestId: string }
  | { type: "send"; to: string; message: Message }
  | { type: "presence"; name?: string; status?: string; model?: string };

// Broker → Client messages
export type BrokerMessage =
  | { type: "registered"; sessionId: string }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "message"; from: SessionInfo; message: Message }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "error"; error: string }
  | { type: "delivered"; messageId: string }
  | { type: "delivery_failed"; messageId: string; reason: string };
