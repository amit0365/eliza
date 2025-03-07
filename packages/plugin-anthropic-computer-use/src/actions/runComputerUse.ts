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
import { multiTurnComputerUse } from "../loop"; // Our final-only multiTurnComputerUse

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
 * Convert an array of blocks into a plain text string. 
 * We omit any comedic or older assistant lines. 
 */
function blocksToText(blocks: any[]): string {
  if (!Array.isArray(blocks)) {
    if (typeof blocks === "string") return blocks;
    return JSON.stringify(blocks);
  }
  return blocks
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text;
        case "image":
          return "[image omitted]";
        case "tool_result":
          // We can omit or show a note
          return "[tool_result omitted]";
        case "thinking":
          return "";
        default:
          return "";
      }
    })
    .join("\n");
}

/**
 * An Action that calls multiTurnComputerUse to run local "computer" usage with Anthropic,
 * returning ONLY the final assistant message from Anthropic. 
 * 
 * We remove any older "assistant" lines from memory to avoid comedic Eliza text. 
 * No partial or intermediate output.
 */
export const computerUseAction: Action = {
  name: "ANTHROPIC_COMPUTER_USE",
  similes: ["ANTHROPIC", "COMPUTER", "BASH", "TOOL", "BROWSE", "SEARCH", "OPEN", "WEBSITE"],
  description:
    "Runs the multi-turn loop with Anthropic to use local computer tools, returning only the final AI message. No comedic or partial lines.",
  
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
      // 1) Identify the memory record
      const roomId = ("anthropic_computeruse_" + runtime.agentId) as UUID;
      let existingMemory = await runtime.messageManager.getMemoryById(roomId);

      // 2) If not found, create
      if (!existingMemory) {
        existingMemory = createComputerUseMemory({
          roomId,
          runtime,
          conversation: [],
        });
        await runtime.messageManager.createMemory(existingMemory);
      }

      // 3) Retrieve conversation array
      const conversation = (existingMemory.content.conversation as any[]) || [];

      // 4) Remove any existing "assistant" messages from memory 
      //    that might contain comedic lines from an older "Eliza" flow.
      const filtered = conversation.filter((m) => m.role !== "assistant");

      // 5) Append the new user message
      const userText = message.content?.text || "Hello from user";
      filtered.push({ role: "user", content: userText });

      // 6) Validate config
      const config = await validateAnthropicConfig(runtime);

      // 7) Call multiTurnComputerUse => final-only approach
      elizaLogger.info("[computerUseAction] Starting multi-turn computer use for final only.");
      const finalMessages = await multiTurnComputerUse({
        apiKey: config.ANTHROPIC_API_KEY,
        messages: filtered,
        ephemeralPromptCaching: false, // or true if you want ephemeral caching
        tokenEfficientTools: false,
      });

      // 8) Save final conversation to memory
      existingMemory.content.conversation = finalMessages;
      await runtime.messageManager.removeMemory(roomId);
      await runtime.messageManager.createMemory(existingMemory);

      // 9) The last message should be from Anthropic's assistant
      const lastMsg = finalMessages[finalMessages.length - 1];
      if (!lastMsg || lastMsg.role !== "assistant") {
        if (callback) {
          callback({ text: "No final assistant response found" });
        }
        return true;
      }

      // Possibly parse the final blocks
      let finalText = lastMsg.content;
      try {
        const blocks = JSON.parse(finalText);
        finalText = blocksToText(blocks);
      } catch {
        // fallback
      }

      // 10) Return only that final text
      elizaLogger.success("[computerUseAction] Final text => " + finalText);
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
