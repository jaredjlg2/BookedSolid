import readline from "readline";
import { google } from "googleapis";

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is missing`);
  }
  return value;
}

async function main() {
  const clientId = requireEnv(process.env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID");
  const clientSecret = requireEnv(process.env.GOOGLE_CLIENT_SECRET, "GOOGLE_CLIENT_SECRET");
  const redirectUri = requireEnv(process.env.GOOGLE_REDIRECT_URI, "GOOGLE_REDIRECT_URI");

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const scopes = ["https://www.googleapis.com/auth/calendar"];
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
    prompt: "consent",
  });

  console.log("Open this URL in your browser to authorize:");
  console.log(authUrl);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const code = await new Promise<string>((resolve) => {
    rl.question("Paste the authorization code here: ", (answer) => resolve(answer.trim()));
  });

  rl.close();
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    console.log("No refresh token returned. Ensure you used prompt=consent and a fresh authorization.");
    return;
  }

  console.log("\n✅ Refresh token:");
  console.log(tokens.refresh_token);
  console.log("\nStore this in GOOGLE_REFRESH_TOKEN.");
}

main().catch((error) => {
  console.error("Failed to generate refresh token:", error);
  process.exit(1);
});
