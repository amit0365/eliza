import axios from "axios";
import { elizaLogger } from "@elizaos/core";

// Suppose we have these imports from your tools directory:
import { ToolCollection } from "./tools/collection";
import { ComputerTool20250124 } from "./tools/computer";
import { BashTool20250124 } from "./tools/bash";
import { EditTool20250124 } from "./tools/edit";
import { ComputerTool20241022 } from "./tools/computer";
import { BashTool20241022 } from "./tools/bash";
import { EditTool20241022 } from "./tools/edit";
import { _injectPromptCaching, _maybeFilterToNMostRecentImages } from "./services";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string; // if content is blocks, we'll store them as a JSON string
}

/**
 * multiTurnComputerUse: A multi-turn loop calling the standard endpoint `/v1/messages`
 * with a top-level system prompt, user messages, and "tools" referencing your 
 * existing "computer", "bash", or "edit" tool classes. If the model requests
 * a "tool_use", we run the tool via `toolCollection.run(name, input)` and produce
 * a "tool_result" block. This repeats until no more tool usage is requested.
 *
 * Note: We do NOT inject any Eliza text here; the user only sees the final
 * 'assistant' messages from the model. 
 */
export async function multiTurnComputerUse(args: {
  apiKey: string;
  model?: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  ephemeralPromptCaching?: boolean; 
  tokenEfficientTools?: boolean; 
}): Promise<ChatMessage[]> {
  const {
    apiKey,
    model = "claude-3-7-sonnet-20250219",
    systemPrompt = "You can use the 'computer' or 'bash' tools to open websites, run commands, etc.",
    messages,
    ephemeralPromptCaching = false,
    tokenEfficientTools = false,
  } = args;

  const url = "https://api.anthropic.com/v1/messages";

  // Build a "toolCollection" for each version
  const toolCollectionV2 = new ToolCollection(
    new ComputerTool20250124(),
    new BashTool20250124(),
    new EditTool20250124()
  );
  const toolCollectionV1 = new ToolCollection(
    new ComputerTool20241022(),
    new BashTool20241022(),
    new EditTool20241022()
  );

  // Decide which set of tools to use based on model version
  let chosenToolCollection = toolCollectionV1;
  let useV2 = false;
  if (model.includes("2025")) {
    useV2 = true;
    chosenToolCollection = toolCollectionV2;
  }

  // Build Beta flags
  const betaFlags: string[] = [];
  if (useV2) {
    betaFlags.push("computer-use-2025-01-24");
  } else {
    betaFlags.push("computer-use-2024-10-22");
  }
  if (ephemeralPromptCaching) {
    betaFlags.push("prompt-caching-2024-07-31");
  }
  if (tokenEfficientTools) {
    betaFlags.push("token-efficient-tools-2025-02-19");
  }
  const anthropicBetaHeader = betaFlags.join(",");

  const headers = {
    "x-api-key": apiKey,
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": anthropicBetaHeader,
  };

  // We'll define the tools array for the standard endpoint
  const tools = chosenToolCollection.toParams();

  while (true) {
    elizaLogger.info("[multiTurnComputerUse] Starting iteration...");

    // (A) Before each request, parse string -> blocks if needed
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        const trimmed = msg.content.trim();
        if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
          try {
            msg.content = JSON.parse(trimmed);
          } catch {
            // just leave it as string if parse fails
          }
        }
      }
    }

    // If ephemeral caching => mark ephemeral blocks in last ~3 user messages
    if (ephemeralPromptCaching) {
      _injectPromptCaching(messages as any);
    }

    // Filter older images so we keep only 2
    _maybeFilterToNMostRecentImages(messages as any, 2, 1);

    // 5) Construct request body
    const body = {
      model,
      max_tokens: 4096,
      stream: false,
      system: systemPrompt,
      messages,
      tools,
    };

    // 6) Call Anthropic
    let response;
    try {
      response = await axios.post(url, body, { headers });
      elizaLogger.info("[multiTurnComputerUse] Response =>", response.data);
    } catch (err: any) {
      elizaLogger.error("[multiTurnComputerUse] Request error:", err.response?.data || err.message);
      // Return the messages so the caller can handle or debug
      return messages;
    }

    const data = response.data;
    elizaLogger.debug("[multiTurnComputerUse] Received =>", JSON.stringify(data, null, 2));

    // The model's content is an array of blocks
    const blocks = data.content || [];

    // 7) Append an assistant message with these blocks
    messages.push({
      role: "assistant",
      content: JSON.stringify(blocks),
    });

    // 8) See if there's any "tool_use" request
    const toolUseBlocks = blocks.filter((b: any) => b.type === "tool_use");
    if (toolUseBlocks.length === 0) {
      elizaLogger.info("[multiTurnComputerUse] No more tool_use => finishing");
      return messages;
    }

    // 9) For each tool request, run the local tool => produce "tool_result"
    const toolResultBlocks: any[] = [];
    for (const tublock of toolUseBlocks) {
      const { name, input, id } = tublock;
      try {
        elizaLogger.info(`Running tool '${name}' with input:`, input);
        const result = await chosenToolCollection.run(name, input || {});

        // Must format tool_result content either as a string or array of blocks
        if (result.error) {
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: id,
            is_error: true,
            content: `Error: ${result.error}`, 
          });
        } else {
          const subBlocks: any[] = [];
          if (result.output) {
            subBlocks.push({
              type: "text",
              text: result.output,
            });
          }
          if (result.base64_image) {
            subBlocks.push({
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: result.base64_image,
              },
            });
          }
          if (subBlocks.length === 0) {
            subBlocks.push({ type: "text", text: "No output." });
          }
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: id,
            is_error: false,
            content: subBlocks,
          });
        }
      } catch (toolErr: any) {
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: id,
          is_error: true,
          content: `Tool invocation error: ${String(toolErr.message || toolErr)}`,
        });
      }
    }

    // 10) Add a user message with these tool_result blocks => triggers next iteration
    messages.push({
      role: "user",
      content: JSON.stringify(toolResultBlocks),
    });
  }
}
