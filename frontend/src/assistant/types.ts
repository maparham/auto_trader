// The Messages API shapes the assistant exchanges with our own proxy
// (/api/assistant/messages). Blocks the loop does not inspect (thinking) pass
// through as plain ContentBlock and are echoed back unchanged.
export type CacheControl = { type: "ephemeral" };
export interface ContentBlock { type: string; [key: string]: unknown }
export interface TextBlock extends ContentBlock { type: "text"; text: string }
export interface ToolUseBlock extends ContentBlock {
  type: "tool_use"; id: string; name: string; input: Record<string, unknown>;
}
export interface ToolResultBlock extends ContentBlock {
  type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean;
}
export interface MessageParam { role: "user" | "assistant"; content: ContentBlock[] }
export interface ToolDef {
  name: string; description: string; input_schema: Record<string, unknown>; cache_control?: CacheControl;
}
export interface AssistantMessage {
  id: string; role: "assistant"; content: ContentBlock[]; stop_reason: string | null;
}
export interface RequestBody {
  system: Array<TextBlock & { cache_control?: CacheControl }>;
  messages: MessageParam[];
  tools: ToolDef[];
}
export const isText = (b: ContentBlock): b is TextBlock => b.type === "text";
export const isToolUse = (b: ContentBlock): b is ToolUseBlock => b.type === "tool_use";
export const isToolResult = (b: ContentBlock): b is ToolResultBlock => b.type === "tool_result";
