// Default public OAuth desktop client configuration and lightweight error helper.
export function fault(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

export const DEFAULT_OAUTH_PROFILE = Object.freeze({
  context: 2,
  enableFst: true,
  clientId: "839509190550-l232s7lupkp6f57818eshd7u4sl4920h.apps.googleusercontent.com",
  clientSecret: "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",
  scopes: Object.freeze(["openid","https://www.googleapis.com/auth/userinfo.email","https://www.googleapis.com/auth/userinfo.profile","https://www.googleapis.com/auth/assistant","https://www.googleapis.com/auth/client_channel","https://www.googleapis.com/auth/gemini","https://www.googleapis.com/auth/calendar","https://www.googleapis.com/auth/drive","https://www.googleapis.com/auth/photos.image.readonly","https://www.googleapis.com/auth/photospicker.mediaitems.readonly","https://www.googleapis.com/auth/oauth_integrations","https://www.googleapis.com/auth/experimentsandconfigs","https://www.googleapis.com/auth/cclog","https://www.googleapis.com/auth/supportcontent","https://www.googleapis.com/auth/mobile_user_preferences","https://www.googleapis.com/auth/notifications","https://www.googleapis.com/auth/cloud-platform","https://www.googleapis.com/auth/aicode"]),
});
