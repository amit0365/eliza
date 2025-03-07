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
 * If the final message is an array of blocks, flatten them to text.
 */
function blocksToText(content: any): string {
  if (!content) return "";
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        switch (block.type) {
          case "text":
            return block.text;
          case "tool_result":
            // Could flatten further. We'll skip for brevity.
            return "[tool_result omitted]";
          default:
            return "";
        }
      })
      .join("\n");
  }
  return String(content);
}

/**
 * Action: no intermediate Eliza, final AI message only.
 */
export const computerUseAction: Action = {
  name: "ANTHROPIC_COMPUTER_USE",
  similes: ["ANTHROPIC", "COMPUTER", "BASH", "TOOL", "BROWSE", "SEARCH", "OPEN", "WEBSITE"],
  description:
    "Use Anthropic's multi-turn loop, returning only the final message from Anthropic. No Eliza messages or partial output.",
  
  validate: async (runtime: IAgentRuntime) => {
    // Ensure we have an Anthropic API key
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
      // 1) Memory record
      const roomId = ("anthropic_computeruse_" + runtime.agentId) as UUID;
      let existingMemory = await runtime.messageManager.getMemoryById(roomId);

      if (!existingMemory) {
        existingMemory = createComputerUseMemory({
          roomId,
          runtime,
          conversation: [],
        });
        await runtime.messageManager.createMemory(existingMemory);
      }

      // 2) Retrieve conversation array
      const conversation = (existingMemory.content.conversation as any[]) || [];

      // 3) Append the user's new message
      const userText = message.content?.text || "";
      conversation.push({ role: "user", content: userText });

      // 4) Validate config
      const config = await validateAnthropicConfig(runtime);
      const anthropicKey = config.ANTHROPIC_API_KEY;

      // 5) Call the multi-turn loop (no SSE, no partial messages)
      elizaLogger.info("[computerUseAction] Starting multi-turn computer use with final only...");
      const finalMessages = await multiTurnComputerUse({
        apiKey: anthropicKey,
        messages: conversation,
        // If you want ephemeral caching or not
        ephemeralPromptCaching: false,
        tokenEfficientTools: false,
      });

      // 6) Save final conversation
      existingMemory.content.conversation = finalMessages;
      await runtime.messageManager.removeMemory(roomId);
      await runtime.messageManager.createMemory(existingMemory);

      // 7) The last message is the final assistant text
      const lastMsg = finalMessages[finalMessages.length - 1];
      if (!lastMsg || lastMsg.role !== "assistant") {
        if (callback) {
          callback({ text: "No final assistant response found" });
        }
        return true;
      }

      // Possibly parse JSON blocks
      let finalText = lastMsg.content;
      try {
        const blocks = JSON.parse(finalText);
        finalText = blocksToText(blocks);
      } catch {
        // fallback
      }

      // 8) Return the final text (Anthropic only, no Eliza)
      if (callback) {
        callback({ text: finalText });
      }
      return true;

    } catch (err: any) {
      elizaLogger.error("[computerUseAction] error:", err);
      if (callback) {
        callback({
          text: `Error: ${err.message}`,
          content: { error: err.message },
        });
      }
      return false;
    }
  },

  examples: getComputerUseExamples as ActionExample[][],
};
