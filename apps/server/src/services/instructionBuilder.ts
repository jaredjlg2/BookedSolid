import axios from "axios";
import { env } from "../config/env";

const DEFAULT_MODEL = "gpt-4o-mini";

export async function buildCallInstructions(prompt: string): Promise<string> {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: env.OPENAI_INSTRUCTION_MODEL ?? DEFAULT_MODEL,
      temperature: 0.2,
      max_tokens: 220,
      messages: [
        {
          role: "system",
          content:
            "You convert a short description of a desired phone call into concise receptionist instructions. " +
            "Write 3-6 bullet points, imperative voice. Avoid prefacing or explaining.",
        },
        { role: "user", content: prompt },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  const content = response.data?.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("No instructions returned from OpenAI");
  }

  return content;
}
