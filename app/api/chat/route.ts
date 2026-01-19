import { UIMessage } from "ai";

export const maxDuration = 30;

const LANGFLOW_URL =
  "https://aws-us-east-2.langflow.datastax.com/lf/7f863bd2-9173-423d-afc5-a8e21f800d2d/api/v1/run/b47cabb8-5df8-49c3-b3d4-22e0c3b7d40e?stream=false";
const LANGFLOW_ORG_ID = "60441da7-0223-41da-9fb1-b6afef96ea7b";

interface LangflowResponse {
  session_id: string;
  outputs: Array<{
    inputs: {
      input_value: string;
    };
    outputs: Array<{
      results: {
        message: {
          text: string;
          sender: string;
          sender_name: string;
          session_id: string;
        };
      };
      artifacts: {
        message: string;
        sender: string;
        sender_name: string;
      };
    }>;
  }>;
}

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  // Get the latest user message
  const lastUserMessage = messages.filter((m) => m.role === "user").pop();
  if (!lastUserMessage) {
    return new Response("No user message found", { status: 400 });
  }

  // Extract text content from the message
  const inputValue =
    typeof lastUserMessage.content === "string"
      ? lastUserMessage.content
      : lastUserMessage.content
          .filter((part) => part.type === "text")
          .map((part) => (part as { type: "text"; text: string }).text)
          .join(" ");

  // Generate a session ID based on the conversation (using first message timestamp or random)
  const sessionId =
    messages.length > 0
      ? `session_${messages[0].id}`
      : `session_${Date.now()}`;

  try {
    const response = await fetch(LANGFLOW_URL, {
      method: "POST",
      headers: {
        "X-DataStax-Current-Org": LANGFLOW_ORG_ID,
        Authorization: `Bearer ${process.env.LANGFLOW_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        output_type: "chat",
        input_type: "chat",
        input_value: inputValue,
        session_id: sessionId,
      }),
      signal: req.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Langflow API error:", errorText);
      return new Response(`Langflow API error: ${response.status}`, {
        status: response.status,
      });
    }

    const data: LangflowResponse = await response.json();

    // Extract the message text from the Langflow response
    const messageText =
      data.outputs?.[0]?.outputs?.[0]?.results?.message?.text ||
      data.outputs?.[0]?.outputs?.[0]?.artifacts?.message ||
      "No response received";

    // Create a streaming response compatible with the AI SDK
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // Send the message ID
        const messageId = `msg_${Date.now()}`;
        controller.enqueue(encoder.encode(`f:{"messageId":"${messageId}"}\n`));

        // Send the text content
        controller.enqueue(encoder.encode(`0:${JSON.stringify(messageText)}\n`));

        // Send finish message
        controller.enqueue(
          encoder.encode(
            `e:{"finishReason":"stop","usage":{"promptTokens":0,"completionTokens":0}}\n`
          )
        );

        // Send done message
        controller.enqueue(encoder.encode(`d:{"finishReason":"stop"}\n`));

        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Vercel-AI-Data-Stream": "v1",
      },
    });
  } catch (error) {
    console.error("Error calling Langflow:", error);
    return new Response(
      `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      { status: 500 }
    );
  }
}
