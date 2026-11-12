import { fault } from "./state.mjs";

export function validateIdentity(data) {
  if (
    !data ||
    data.email_verified !== true ||
    typeof data.email !== "string" ||
    data.email.length > 254 ||
    !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(
      data.email,
    ) ||
    typeof data.sub !== "string" ||
    !/^[A-Za-z0-9_-]{1,255}$/.test(data.sub)
  )
    throw fault("GOOGLE_VERIFIED_EMAIL_REQUIRED", 502);
  return { email: data.email, subject: data.sub };
}

// Fixed Google endpoint; never follow redirects or disclose response bodies.
export async function identifyGoogleAccount(
  tokens,
  { fetchImpl = fetch, timeoutMs = 8000 } = {},
) {
  if (
    typeof tokens?.accessToken !== "string" ||
    !tokens.accessToken ||
    /[\r\n]/.test(tokens.accessToken)
  )
    throw fault("GOOGLE_IDENTITY_UNAVAILABLE", 502);
  try {
    const response = await fetchImpl(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw fault("GOOGLE_IDENTITY_UNAVAILABLE", 502);
    }
    const reader = response.body?.getReader();
    if (!reader) throw fault("GOOGLE_IDENTITY_UNAVAILABLE", 502);
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 32768) {
          await reader.cancel();
          throw fault("GOOGLE_IDENTITY_UNAVAILABLE", 502);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return validateIdentity(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (error) {
    if (error.code === "GOOGLE_VERIFIED_EMAIL_REQUIRED") throw error;
    throw fault("GOOGLE_IDENTITY_UNAVAILABLE", 502);
  }
}
