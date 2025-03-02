import axios from "axios";
import { elizaLogger } from "@elizaos/core";
import { ToolCollection } from "./tools/collection";
import {
  ComputerTool20250124,
  ComputerTool20241022
} from "./tools/computer";
import {
  BashTool20250124,
  BashTool20241022
} from "./tools/bash";
import {
  EditTool20250124,
  EditTool20241022
} from "./tools/edit";
import {
  _injectPromptCaching,
  _maybeFilterToNMostRecentImages
} from "./services";

// same shape as before
export interface ChatMessage {
  role: "user" | "assistant";
  content: string; 
}

/**
 * multiTurnComputerUse now supports an optional `onIntermediate` callback,
 * which is invoked *after* each new assistant message arrives from Anthropic.
 */
export async function multiTurnComputerUse(args: {
  apiKey: string;
  model?: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  ephemeralPromptCaching?: boolean;
  tokenEfficientTools?: boolean;

  /** 
   * This callback is called each time we get a new assistant response from Anthropic 
   * (i.e. after each iteration in the while loop). 
   * You can display partial responses here. 
   */
  onIntermediate?: (assistantBlocks: any[]) => Promise<void> | void;
}): Promise<ChatMessage[]> {
  const {
    apiKey,
    model = "claude-3-5-sonnet-20241022",
    systemPrompt = "You can use the 'computer' or 'bash' tools...",
    messages,
    ephemeralPromptCaching = false,
    tokenEfficientTools = false,
    onIntermediate,
  } = args;

  const url = "https://api.anthropic.com/v1/messages";

  // Set up two sets of tools
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

  // Decide which set
  const chosenToolSet = model.includes("20250124") ? toolCollectionV2 : toolCollectionV1;

  // Build "anthropic-beta" header
  const betaFlags: string[] = [];
  if (model.includes("20250124")) betaFlags.push("computer-use-2025-01-24");
  else betaFlags.push("computer-use-2024-10-22");
  if (ephemeralPromptCaching) betaFlags.push("prompt-caching-2024-07-31");
  if (tokenEfficientTools) betaFlags.push("token-efficient-tools-2025-02-19");
  const anthropicBetaHeader = betaFlags.join(",");

  const headers = {
    "x-api-key": apiKey,
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": anthropicBetaHeader,
  };

  const tools = chosenToolSet.toParams();

  while (true) {
    elizaLogger.info("[multiTurnComputerUse] Starting iteration...");

    // 1) Possibly parse existing messages from JSON string => array
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        const trimmed = msg.content.trim();
        if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
          try {
            msg.content = JSON.parse(trimmed);
          } catch {
            // fallback: keep as string
          }
        }
      }
    }

    // 2) ephemeral & image filtering
    if (ephemeralPromptCaching) {
      _injectPromptCaching(messages as any);
    }
    _maybeFilterToNMostRecentImages(messages as any, 2, 1);

    // 3) Build request
    const body = {
      model,
      max_tokens: 1024,
      stream: false,
      system: systemPrompt,
      messages,
      tools,
    };

    // 4) Call Anthropic
    let response;
    try {
      response = await axios.post(url, body, { headers });
      elizaLogger.info("[multiTurnComputerUse] =>", response.data);
    } catch (err: any) {
      elizaLogger.error("[multiTurnComputerUse] Request error:", err.response?.data || err.message);
      return messages;
    }

    const data = response.data;
    const blocks = data.content || [];

    // 5) Append an assistant message with these blocks
    messages.push({
      role: "assistant",
      content: JSON.stringify(blocks),
    });

    // **** IMPORTANT: Call onIntermediate if provided ****
    if (onIntermediate) {
      // onIntermediate can be synchronous or async
      await onIntermediate(blocks);
    }

    // 6) Check for tool usage
    const toolUseBlocks = blocks.filter((b: any) => b.type === "tool_use");
    if (toolUseBlocks.length === 0) {
      elizaLogger.info("[multiTurnComputerUse] no more tool_use => done");
      return messages;
    }

    // 7) For each tool, run it => produce tool_result
    const toolResultBlocks: any[] = [];
    for (const tublock of toolUseBlocks) {
      const { name, input, id } = tublock;
      try {
        elizaLogger.info(`Running tool '${name}' =>`, input);
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
              }
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

    // 8) Add these tool results as a user message => triggers next iteration
    messages.push({
      role: "user",
      content: JSON.stringify(toolResultBlocks),
    });
  }
}
