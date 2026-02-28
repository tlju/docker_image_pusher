export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/update") {
        return await handleUpdate(request, env);
      }

      if (url.pathname === "/webhook") {
        return await handleWebhook(request, env);
      }

      return jsonResponse({ error: "Not Found" }, 404);
    } catch (err) {
      return jsonResponse(
        { error: err.message || "Internal Error" },
        500
      );
    }
  },
};

//////////////////////////////////////////////////////
// 更新文件接口
//////////////////////////////////////////////////////
async function handleUpdate(request, env) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const body = await safeParseRequestJSON(request);
  if (!body.content) {
    return jsonResponse({ error: "Missing content" }, 400);
  }

  // 1️⃣ 获取当前文件 SHA
  const fileData = await safeGitHubRequest(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${env.FILE_PATH}?ref=${env.BRANCH}`,
    env
  );

  if (!fileData.sha) {
    throw new Error("File not found or no permission");
  }

  // 2️⃣ 更新文件
  const updateResult = await safeGitHubRequest(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${env.FILE_PATH}`,
    env,
    {
      method: "PUT",
      body: JSON.stringify({
        message: "auto update images.txt",
        content: base64Encode(body.content),
        sha: fileData.sha,
        branch: env.BRANCH,
      }),
    }
  );

  return jsonResponse({
    message: "Update triggered",
    commit: updateResult.commit?.sha,
  });
}

//////////////////////////////////////////////////////
// Webhook 接收接口
//////////////////////////////////////////////////////
async function handleWebhook(request, env) {
  if (request.method !== "POST") {
    return new Response("OK");
  }

  const signature = request.headers.get("x-hub-signature-256");
  const rawBody = await request.text();

  const valid = await verifySignature(
    rawBody,
    signature,
    env.WEBHOOK_SECRET
  );

  if (!valid) {
    return jsonResponse({ error: "Invalid signature" }, 401);
  }

  const payload = JSON.parse(rawBody);

  if (
    payload.action === "completed" &&
    payload.workflow_run
  ) {
    const run = payload.workflow_run;

    return jsonResponse({
      workflow: run.name,
      status: run.status,
      conclusion: run.conclusion,
      commit: run.head_sha,
    });
  }

  return jsonResponse({ message: "Ignored event" });
}

//////////////////////////////////////////////////////
// GitHub 请求封装（安全 JSON 解析）
//////////////////////////////////////////////////////
async function safeGitHubRequest(url, env, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "cloudflare-worker",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`GitHub 返回非 JSON 响应:\n${text}`);
  }

  if (!response.ok) {
    throw new Error(
      `GitHub API 错误 ${response.status}:\n${JSON.stringify(data, null, 2)}`
    );
  }

  return data;
}

//////////////////////////////////////////////////////
// 安全解析请求 JSON
//////////////////////////////////////////////////////
async function safeParseRequestJSON(request) {
  const text = await request.text();

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

//////////////////////////////////////////////////////
// HMAC SHA256 验证
//////////////////////////////////////////////////////
async function verifySignature(body, signature, secret) {
  if (!signature) return false;

  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(body)
  );

  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const expected = `sha256=${hash}`;

  return expected === signature;
}

//////////////////////////////////////////////////////
// Base64 编码（UTF-8 安全）
//////////////////////////////////////////////////////
function base64Encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

//////////////////////////////////////////////////////
// JSON Response Helper
//////////////////////////////////////////////////////
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
