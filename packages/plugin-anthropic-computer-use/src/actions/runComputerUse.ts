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
// IMPORTANT: ensure "multiTurnComputerUse" is exported from "../loop"

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
  conversation: any[]; // typed or untyped array of conversation steps
}): Memory {
  return {
    id: roomId,
    agentId: runtime.agentId,
    userId: runtime.agentId,
    roomId,
    content: {
      source: "anthropic-computer-use",
      text: "Computer use conversation",
      conversation, // store conversation array
    },
    embedding: [],
  };
}

/**
 * Optionally parse the final assistant content from blocks => text.
 * If the final message is a JSON array of blocks (like {type: "text"}),
 * we flatten them into a single string.
 */
function convertBlocksToText(content: any): string {
  if (!content) return "";
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        switch (block.type) {
          case "text":
            return block.text;
          case "tool_result":
            if (Array.isArray(block.content)) {
              // might be sub-blocks
              return block.content
                .map((c) => (c.type === "text" ? c.text : "[image omitted]"))
                .join("\n");
            }
            return JSON.stringify(block.content);
          case "thinking":
            return "[thinking hidden]";
          default:
            return "";
        }
      })
      .join("\n");
  }
  return String(content);
}

/**
 * The Action that triggers a multi-turn "computer use" loop with the standard endpoint,
 * saving conversation to memory. Because we do NOT have "updateMemory," we do a 
 * deleteMemory + createMemory approach to overwrite the old record.
 */
export const computerUseAction: Action = {
  name: "ANTHROPIC_COMPUTER_USE",
  similes: ["ANTHROPIC", "COMPUTER", "BASH", "TOOL", "BROWSE", "SEARCH", "OPEN", "WEBSITE"],
  description:
    "Use Anthropic's agentic multi-turn loop to run local computer-use tools, browse websites, etc. and store conversation in memory without updateMemory.",
  validate: async (runtime: IAgentRuntime) => {
    // Ensure we have an Anthropic key or relevant config
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
      // 1) Identify the memory record ID
      const roomId = ("anthropic_computeruse_" + runtime.agentId) as UUID;

      // 2) Attempt to load existing memory
      let existingMemory = await runtime.messageManager.getMemoryById(roomId);

      if (!existingMemory) {
        // If not found, create a new empty conversation
        existingMemory = createComputerUseMemory({
          roomId,
          runtime,
          conversation: [],
        });
        // store it
        await runtime.messageManager.createMemory(existingMemory);
      }

      // 3) Retrieve conversation array
      const conversation = (existingMemory.content.conversation as any[]) || [];

      // 4) Append the user's new message
      const userText = message.content?.text || "Hello from user";
      conversation.push({ role: "user", content: userText });

      // 5) Validate config (Anthropic key, etc.)
      const config = await validateAnthropicConfig(runtime);
      const anthropicKey = config.ANTHROPIC_API_KEY;

      // 6) Call the multi-turn loop
      //    This function repeatedly calls https://api.anthropic.com/v1/messages 
      //    until no more "tool_use" is requested.
      elizaLogger.info("[computerUseAction] Starting multi-turn computer use...");

      const finalMessages = await multiTurnComputerUse({
        apiKey: config.ANTHROPIC_API_KEY,
        messages: conversation,
        ephemeralPromptCaching: true,
      });

      // 7) finalMessages is updated conversation with assistant responses + tool results
      existingMemory.content.conversation = finalMessages;

      // Because we do NOT have "updateMemory", we can do this:
      //  - delete the old memory
      //  - re-create with the same ID
      await runtime.messageManager.removeMemory(roomId);
      await runtime.messageManager.createMemory(existingMemory);

      // 8) parse the final messages for the last assistant text
      const lastMsg = finalMessages[finalMessages.length - 1];
      if (!lastMsg || lastMsg.role !== "assistant") {
        if (callback) {
          callback({ text: "No final assistant response found." });
        }
        return true;
      }

      let finalText = lastMsg.content;
      // Possibly parse if it's a JSON array
      try {
        const blocks = JSON.parse(finalText);
        finalText = convertBlocksToText(blocks);
      } catch (err) {
        // fallback
      }

      // 9) callback to Eliza
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
