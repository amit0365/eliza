import {
  elizaLogger,
  Action,
  ActionExample,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import { validateAnthropicConfig } from "../environment";
import { getComputerUseExamples } from "../examples";
import { multiTurnComputerUse } from "../loop"; 
import { BetaMessageParam } from "../types";  // or your own message types

/**
 * Suppose we have your memory creation logic, etc.
 */
function createComputerUseMemory({
  roomId,
  runtime,
  conversation,
}: {
  roomId: UUID;
  runtime: IAgentRuntime;
  conversation: any[];
}): Memory {
  return {
    id: roomId,
    agentId: runtime.agentId,
    userId: runtime.agentId,
    roomId,
    content: {
      source: "anthropic-computer-use",
      text: "Computer use conversation",
      conversation,
    },
    embedding: [],
  };
}

/**
 * Convert blocks => a single text string for partial display
 */
function convertBlocksToText(content: any[]): string {
  return content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      } else if (block.type === "tool_use") {
        return `[tool request: ${block.name}]`;
      } else if (block.type === "tool_result") {
        if (typeof block.content === "string") {
          return block.content;
        } else if (Array.isArray(block.content)) {
          return block.content
            .map((c) => (c.type === "text" ? c.text : "[image omitted]"))
            .join("\n");
        }
        return "[tool result]";
      }
      return "";
    })
    .join("\n");
}

/**
 * This action calls `multiTurnComputerUse` but now sends 
 * each partial assistant message to the front-end via `callback({text:...})`.
 */
export const computerUseAction: Action = {
  name: "ANTHROPIC_COMPUTER_USE",
  similes: ["ANTHROPIC","COMPUTER","BASH","TOOL","BROWSE","SEARCH","OPEN","WEBSITE"],
  description: "Use Anthropic's multi-turn loop with partial updates",
  validate: async (runtime: IAgentRuntime) => {
    await validateAnthropicConfig(runtime);
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: { [key: string]: unknown },
    callback: HandlerCallback
  ) => {
    try {
      // 1) Prepare memory
      const roomId = ("anthropic_computeruse_" + runtime.agentId) as UUID;
      let existingMemory = await runtime.messageManager.getMemoryById(roomId);
      if (!existingMemory) {
        existingMemory = createComputerUseMemory({ roomId, runtime, conversation: [] });
        await runtime.messageManager.createMemory(existingMemory);
      }
      const conversation = (existingMemory.content.conversation as any[]) || [];

      // 2) Append user’s new message
      const userText = message.content?.text || "No user text";
      conversation.push({ role: "user", content: userText });

      // 3) Validate config
      const config = await validateAnthropicConfig(runtime);

      // 4) Call multiTurnComputerUse with an onIntermediate callback
      elizaLogger.info("[computerUseAction] Starting multi-turn with partial updates...");
      const finalMessages = await multiTurnComputerUse({
        apiKey: config.ANTHROPIC_API_KEY,
        messages: conversation,
        ephemeralPromptCaching: false,
        tokenEfficientTools: false,
        // here's the key part:
        onIntermediate: async (assistantBlocks) => {
          // Convert blocks => text
          const partialText = convertBlocksToText(assistantBlocks);
          // Send to the user
          if (callback) {
            await callback({ text: partialText, type: "partial" });
          }
        }
      });

      // 5) Now that the loop is done, store final conversation
      existingMemory.content.conversation = finalMessages;
      // Overwrite memory
      await runtime.messageManager.removeMemory(roomId);
      await runtime.messageManager.createMemory(existingMemory);

      // 6) The last message is the final assistant message
      const lastMsg = finalMessages[finalMessages.length - 1];
      if (!lastMsg || lastMsg.role !== "assistant") {
        if (callback) callback({ text: "No final assistant response found." });
        return true;
      }

      let finalText = "";
      try {
        const blocks = JSON.parse(lastMsg.content);
        finalText = convertBlocksToText(blocks);
      } catch {
        finalText = lastMsg.content; // fallback
      }

      // 7) Send that final text too, if you want it distinct from partial
      if (callback) {
        await callback({ text: finalText, type: "final" });
      }
      return true;

    } catch (error: any) {
      elizaLogger.error("[computerUseAction] error:", error);
      if (callback) {
        callback({ text: `Error: ${error.message}`, type: "error" });
      }
      return false;
    }
  },
  examples: getComputerUseExamples as ActionExample[][],
};
