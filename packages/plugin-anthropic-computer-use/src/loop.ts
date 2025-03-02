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

/**
 * Minimal shape for each user or assistant message.
 */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string; // if content is blocks, we'll store them as a JSON string
}

/**
 * multiTurnComputerUse: A multi-turn loop calling the standard endpoint `/v1/messages`
 * with a top-level system prompt, user messages, and "tools" referencing your 
 * existing "computer", "bash", or "edit" tool classes. If the model requests a 
 * "tool_use", we run the tool via `toolCollection.run(name, input)` and produce 
 * a "tool_result" block. This repeats until no more tool usage is requested.
 */
export async function multiTurnComputerUse(args: {
  apiKey: string;
  model?: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  ephemeralPromptCaching?: boolean; // if you want "prompt-caching-2024-07-31" in the header
  tokenEfficientTools?: boolean; // if you want "token-efficient-tools-2025-02-19" in the header
}): Promise<ChatMessage[]> {
  const {
    apiKey,
    model = "claude-3-5-sonnet-20241022",
    systemPrompt = "You can use the 'computer' or 'bash' tools to open websites, run commands, etc.",
    messages,
    ephemeralPromptCaching = false,
    tokenEfficientTools = false,
  } = args;

  elizaLogger.info("model", model);
  // 1) Prepare the standard endpoint
  const url = "https://api.anthropic.com/v1/messages";

  // 2) Build a "toolCollection" with your existing tool classes
  // e.g. we have "ComputerTool20250124", "BashTool20250124", "EditTool20250124"
  // If you only need "computer", just remove the others
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

  // 3) Build Beta flags for the "anthropic-beta" header
  // Include appropriate beta flag based on model version
  const betaFlags: string[] = [];
  
  // Add the appropriate computer-use beta flag based on model version
  if (model.includes("20250124")) {
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

  // 4) Build the standard endpoint request headers
  const headers = {
    "x-api-key": apiKey,
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    // Beta flags
    "anthropic-beta": anthropicBetaHeader,
  };

  // We'll define the tools array for the standard endpoint
  // We rely on each tool's `toParams()` to get name, type, and display info, etc.
  const tools = model.includes("20250124") ? toolCollectionV2.toParams() : toolCollectionV1.toParams();

  while (true) {
    elizaLogger.info("[multiTurnComputerUse] Starting iteration...");

    // 5) Construct the request body with a top-level system, no "betas" field
    // (the standard endpoint forbids "betas" in body).
    const body = {
      model,
      max_tokens: 1024,
      stream: true,
      system: systemPrompt,
      messages,
      tools,
    };

    // 6) POST to the standard endpoint
    let response;
    try {
      response = await axios.post(url, body, { headers });
    } catch (err: any) {
      elizaLogger.error("[multiTurnComputerUse] Request error:", err.response?.data || err.message);
      // Return the messages so far
      return messages;
    }

    const data = response.data;
    elizaLogger.debug("[multiTurnComputerUse] Response =>", JSON.stringify(data, null, 2));

    // The model's content is an array of blocks, e.g. {type:"text",text:"..."}, {type:"tool_use",...}
    const blocks = data.content || [];

    // 7) Append an assistant message with these blocks in JSON form
    messages.push({
      role: "assistant",
      content: JSON.stringify(blocks),
    });

    // 8) Check if any "tool_use" blocks appear
    const toolUseBlocks = blocks.filter((b: any) => b.type === "tool_use");
    if (toolUseBlocks.length === 0) {
      // no more usage => done
      elizaLogger.info("[multiTurnComputerUse] no more tool_use => finishing");
      return messages;
    }

    // 9) For each tool_use block, run the local tool
    // We produce "tool_result" blocks. We'll store them in a single user message next iteration
    const toolResultBlocks: any[] = [];
    for (const tublock of toolUseBlocks) {
      const { name, input, id } = tublock;
      try {
        // Call your local tool
        elizaLogger.info(`[multiTurnComputerUse] Running tool '${name}' with input:`, input);
        const toolCollection = model.includes("20250124") ? toolCollectionV2 : toolCollectionV1;
        const result = await toolCollection.run(name, input || {});
        // Convert result => {type:"tool_result", tool_use_id, content}
        const toolResultBlock = {
          type: "tool_result",
          tool_use_id: id,
          content: {},
        };

        if (result.error) {
          toolResultBlock.content = { error: result.error };
          toolResultBlock["is_error"] = true;
        } else {
          const { output, base64_image } = result;
          const contentObj: Record<string, any> = {};
          if (output) contentObj.output = output;
          if (base64_image) contentObj.base64_image = base64_image;
          toolResultBlock.content = contentObj;
        }

        toolResultBlocks.push(toolResultBlock);
      } catch (err: any) {
        // If the local tool threw an error
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: id,
          is_error: true,
          content: { error: String(err.message || err) },
        });
      }
    }

    // 10) Add a "user" message with these tool_result blocks
    messages.push({
      role: "user",
      content: JSON.stringify(toolResultBlocks),
    });
  }
}
