import axios from "axios";
import { elizaLogger } from "@elizaos/core";

// Your local code
import { ToolCollection } from "./tools/collection";
import { ComputerTool20250124, ComputerTool20241022 } from "./tools/computer";
import { BashTool20250124, BashTool20241022 } from "./tools/bash";
import { EditTool20250124, EditTool20241022 } from "./tools/edit";
import { _injectPromptCaching, _maybeFilterToNMostRecentImages } from "./services";

/**
 * Minimal shape for user or assistant messages
 */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * multiTurnComputerUse: 
 * - Calls Anthropic’s /v1/messages repeatedly (non-streaming)
 * - Runs local tools if requested
 * - Finally returns when no more tool usage is requested
 * - Does NOT produce any intermediate/partial outputs.
 * - The final 'assistant' message from Anthropic is in the returned messages array.
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
    model = "claude-3-5-sonnet-20241022",
    systemPrompt = "You can use the 'computer' or 'bash' tools to open websites, run commands, etc.",
    messages,
    ephemeralPromptCaching = false,
    tokenEfficientTools = false,
  } = args;

  const url = "https://api.anthropic.com/v1/messages";

  // Build two sets of tools
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

  // Decide which tool set to use
  const chosenToolSet = model.includes("2025") ? toolCollectionV2 : toolCollectionV1;

  // Build the "anthropic-beta" header
  const betaFlags: string[] = [];
  if (model.includes("2025")) {
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

  const headers = {
    "x-api-key": apiKey,
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": betaFlags.join(","),
  };

  const tools = chosenToolSet.toParams();

  while (true) {
    elizaLogger.info("[multiTurnComputerUse] Starting iteration...");

    // Parse JSON content if needed
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        const trimmed = msg.content.trim();
        if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
          try {
            msg.content = JSON.parse(trimmed);
          } catch {
            // if parse fails, keep it as a string
          }
        }
      }
    }

    // ephemeral caching & image filtering
    if (ephemeralPromptCaching) {
      _injectPromptCaching(messages as any);
    }
    _maybeFilterToNMostRecentImages(messages as any, 2, 1);

    // Build request body
    const body = {
      model,
      max_tokens: 1024,
      stream: false, // no streaming => final only
      system: systemPrompt,
      messages,
      tools,
    };

    // POST to Anthropic once this iteration
    let response;
    try {
      response = await axios.post(url, body, { headers });
      elizaLogger.info("[multiTurnComputerUse] =>", response.data);
    } catch (err: any) {
      elizaLogger.error("[multiTurnComputerUse] Request error:", err.response?.data || err.message);
      // Return whatever messages we have so far
      return messages;
    }

    // The model returns an array of blocks
    const blocks = response.data.content || [];

    // Add an assistant message with these blocks
    messages.push({
      role: "assistant",
      content: JSON.stringify(blocks),
    });

    // Check if any "tool_use" blocks
    const toolUseBlocks = blocks.filter((b: any) => b.type === "tool_use");
    if (toolUseBlocks.length === 0) {
      // No more usage => done
      elizaLogger.info("[multiTurnComputerUse] no more tool_use => finishing");
      return messages;
    }

    // For each tool request, run it => produce tool_result
    const toolResultBlocks: any[] = [];
    for (const tublock of toolUseBlocks) {
      const { name, input, id } = tublock;
      try {
        elizaLogger.info(`[multiTurnComputerUse] Running tool '${name}' with input:`, input);
        const result = await chosenToolSet.run(name, input || {});
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
            subBlocks.push({ type: "text", text: result.output });
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
          content: `Tool error: ${String(toolErr.message || toolErr)}`,
        });
      }
    }

    // Add a user message with these tool_result blocks => triggers next iteration
    messages.push({
      role: "user",
      content: JSON.stringify(toolResultBlocks),
    });
  }
}
