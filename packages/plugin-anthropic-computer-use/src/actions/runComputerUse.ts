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

/**
 * Builds a Memory record for storing the entire computer-use conversation.
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
 * Convert an array of Anthropic blocks into a plain string.
 * We show only final text, ignoring partial or tool blocks if you like.
 */
function convertBlocksToText(blocks: any[]): string {
  if (!Array.isArray(blocks)) {
    // If it's a single object or string, convert to array for uniformity
    return typeof blocks === "string" ? blocks : JSON.stringify(blocks);
  }

  return blocks
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text;
        case "image":
          return "[image omitted]";
        case "tool_result":
          // If you want to omit tool results from final text entirely, do empty string
          // or show a simple note:
          return "[tool_result omitted]";
        case "thinking":
          // Hide thinking
          return "";
        default:
          return "";
      }
    })
    .join("\n");
}

/**
 * The Action that triggers the multi-turn loop:
 *  - No intermediate partial callbacks
 *  - Only the final assistant message from Anthropic is returned
 *  - No comedic Eliza text
 */
export const computerUseAction: Action = {
  name: "ANTHROPIC_COMPUTER_USE",
  similes: ["ANTHROPIC", "COMPUTER", "BASH", "TOOL", "BROWSE", "SEARCH", "OPEN", "WEBSITE"],
  description:
    "Use Anthropic's multi-turn loop to run local computer-use tools, returning only the final response. No partial or Eliza messages.",

  validate: async (runtime: IAgentRuntime) => {
    // Ensure we have an Anthropic key
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
      // 1) Memory record ID
      const roomId = ("anthropic_computeruse_" + runtime.agentId) as UUID;

      // 2) Load or create memory
      let existingMemory = await runtime.messageManager.getMemoryById(roomId);
      if (!existingMemory) {
        existingMemory = createComputerUseMemory({
          roomId,
          runtime,
          conversation: [],
        });
        await runtime.messageManager.createMemory(existingMemory);
      }

      // 3) Retrieve conversation
      const conversation = (existingMemory.content.conversation as any[]) || [];

      // 4) Append the user's new message
      const userText = message.content?.text || "Hello from user";
      conversation.push({ role: "user", content: userText });

      // 5) Validate config (Anthropic key, etc.)
      const config = await validateAnthropicConfig(runtime);
      const anthropicKey = config.ANTHROPIC_API_KEY;

      // 6) Call multiTurnComputerUse for final-only results
      elizaLogger.info("[computerUseAction] Starting multi-turn computer use (final-only).");
      const finalMessages = await multiTurnComputerUse({
        apiKey: anthropicKey,
        messages: conversation,
        ephemeralPromptCaching: false,
        tokenEfficientTools: false,
      });

      // 7) Save final conversation
      existingMemory.content.conversation = finalMessages;
      await runtime.messageManager.removeMemory(roomId);
      await runtime.messageManager.createMemory(existingMemory);

      // 8) The last message is the final assistant text
      const lastMsg = finalMessages[finalMessages.length - 1];
      if (!lastMsg || lastMsg.role !== "assistant") {
        if (callback) {
          callback({ text: "No final assistant response found." });
        }
        return true;
      }

      // Possibly parse JSON blocks
      let finalText = lastMsg.content;
      try {
        const blocks = JSON.parse(finalText);
        finalText = convertBlocksToText(blocks);
      } catch {
        // fallback
      }

      // 9) Return the final text (only from Anthropic).
      elizaLogger.success(`[computerUseAction] Final text => ${finalText}`);
      if (callback) {
        callback({ text: finalText });
      }
      return true;
    } catch (error: any) {
      elizaLogger.error("[computerUseAction] error:", error);
      if (callback) {
        callback({
          text: `Error: ${error.message}`,
          content: { error: error.message },
        });
      }
      return false;
    }
  },

  examples: getComputerUseExamples as ActionExample[][],
};
