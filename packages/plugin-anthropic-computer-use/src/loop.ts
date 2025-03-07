import axios from "axios";
import { elizaLogger } from "@elizaos/core";
import { ToolCollection } from "./tools/collection";
import { ComputerTool20250124, ComputerTool20241022 } from "./tools/computer";
import { BashTool20250124, BashTool20241022 } from "./tools/bash";
import { EditTool20250124, EditTool20241022 } from "./tools/edit";
import { _injectPromptCaching, _maybeFilterToNMostRecentImages } from "./services";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string; // could be JSON string or plain
}

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
    model = "claude-3-5-20250124",
    systemPrompt = "You can use the 'computer' or 'bash' tools...",
    messages,
    ephemeralPromptCaching = false,
    tokenEfficientTools = false,
  } = args;

  const url = "https://api.anthropic.com/v1/messages";

  // Prepare two sets of tools
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
  const chosenToolSet = model.includes("2025") ? toolCollectionV2 : toolCollectionV1;

  // Beta flags
  const betaFlags: string[] = [];
  if (model.includes("2025")) betaFlags.push("computer-use-2025-01-24");
  else betaFlags.push("computer-use-2024-10-22");
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

  while (true) {
    elizaLogger.info("[multiTurnComputerUse] Starting iteration...");

    // parse JSON if needed
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        const trimmed = msg.content.trim();
        if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
          try {
            msg.content = JSON.parse(trimmed);
          } catch {}
        }
      }
    }

    if (ephemeralPromptCaching) {
      _injectPromptCaching(messages as any);
    }
    _maybeFilterToNMostRecentImages(messages as any, 2, 1);

    // Send to Anthropic once
    const body = {
      model,
      max_tokens: 1024,
      stream: false,
      system: systemPrompt,
      messages,
      tools: chosenToolSet.toParams(),
    };

    let resp;
    try {
      resp = await axios.post(url, body, { headers });
      elizaLogger.info("[multiTurnComputerUse] =>", resp.data);
    } catch (err: any) {
      elizaLogger.error("[multiTurnComputerUse] Request error:", err.response?.data || err.message);
      return messages;
    }

    const blocks = resp.data.content || [];
    // Add an assistant message
    messages.push({
      role: "assistant",
      content: JSON.stringify(blocks),
    });

    // Check tool_use
    const toolUseBlocks = blocks.filter((b: any) => b.type === "tool_use");
    if (toolUseBlocks.length === 0) {
      elizaLogger.info("[multiTurnComputerUse] No more tool_use => done.");
      return messages;
    }

    // For each tool request, run tool => produce tool_result
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

    // Add user message with tool_result => triggers next iteration
    messages.push({
      role: "user",
      content: JSON.stringify(toolResultBlocks),
    });
  }
}
