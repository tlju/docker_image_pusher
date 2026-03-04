export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const kv = env.DOCKER_KV;
    if (!kv) {
      return new Response("KV 绑定错误：请确保在 Cloudflare 设置中绑定了名为 DOCKER_KV 的命名空间", { status: 500 });
    }
    try {
      if (url.pathname === "/login") {
        return handleLogin(request, kv);
      }
      if (url.pathname === "/logout") {
        return handleLogout();
      }
      if (url.pathname === "/status") {
        const ok = await isAuthenticated(request, kv);
        if (!ok) return json({ error: "Unauthorized" }, 401);
 
        const status = await kv.get("LAST_WORKFLOW");
        return json({ status: status ? JSON.parse(status) : null });
      }
      if (url.pathname === "/ui") {
        const ok = await isAuthenticated(request, kv);
        if (!ok) return loginPage();
        return uiPage(kv);
      }
      if (url.pathname === "/update") {
        const ok = await isAuthenticated(request, kv);
        if (!ok) return json({ error: "Unauthorized" }, 401);
        return handleUpdate(request, kv);
      }
      if (url.pathname === "/webhook") {
        return handleWebhook(request, kv); // 处理 webhook 请求
      }
      // 根目录自动跳转到 /ui
      if (url.pathname === "/") {
        return Response.redirect(`${url.origin}/ui`, 302);
      }
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      return json({
        error: "Worker 内部错误",
        message: err.message,
        stack: err.stack
      }, 500);
    }
  }
};
//////////////////////////////////////////////////////
// 登录与鉴权逻辑
//////////////////////////////////////////////////////
async function handleLogin(request, kv) {
  if (request.method !== "POST") {
    return loginPage();
  }
  const form = await request.formData();
  const username = form.get("username");
  const password = form.get("password");
  const [kvUser, kvPass, secret] = await Promise.all([
    kv.get("UI_USERNAME"),
    kv.get("UI_PASSWORD"),
    kv.get("SESSION_SECRET")
  ]);
  if (!kvUser || !kvPass || !secret) {
    return loginPage("系统未初始化：请在 KV 中设置 UI_USERNAME, UI_PASSWORD 和 SESSION_SECRET");
  }
  if (username === kvUser && password === kvPass) {
    const token = await signValue(username, secret);
    return new Response(null, {
      status: 302,
      headers: {
        "Location": "/ui",
        "Set-Cookie": `session=${token}; HttpOnly; Path=/; SameSite=Strict; Secure`
      }
    });
  }
  return loginPage("用户名或密码错误");
}
function handleLogout() {
  return new Response(null, {
    status: 302,
    headers: {
      "Location": "/ui",
      "Set-Cookie": "session=deleted; Path=/; Max-Age=0"
    }
  });
}
async function isAuthenticated(request, kv) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/session=([^;]+)/);
  if (!match) return false;
  const token = match[1];
  const secret = await kv.get("SESSION_SECRET");
  if (!secret) return false;
 
  return verifyValue(token, secret);
}
//////////////////////////////////////////////////////
// UI 页面 (HTML)
//////////////////////////////////////////////////////
async function uiPage(kv) {
// 获取阿里云镜像源配置
const aliyunRegistry = await kv.get("ALIYUN_REGISTRY");
return html(`
<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>Docker 控制台</title>
<style>
body{font-family:system-ui;background:#f4f6fb;padding:20px}
.card{background:#fff;padding:24px;border-radius:12px;max-width:750px;margin:auto;box-shadow:0 10px 30px rgba(0,0,0,.05)}
textarea{width:100%;height:120px;border:1px solid #ddd;border-radius:8px;padding:12px;font-family:monospace}
button{padding:10px 20px;border:none;border-radius:8px;background:#5562ff;color:white;cursor:pointer;font-weight:bold}
button:disabled{background:#ccc}
pre{background:#1e1e1e;color:#d4d4d4;padding:15px;border-radius:8px;font-size:13px;overflow-x:auto}
.success{border-left:4px solid #52c41a}
.fail{border-left:4px solid #ff4d4f}
.running{border-left:4px solid #1890ff}
.cmd{background:#000;color:#52c41a;padding:12px;border-radius:8px;font-family:monospace}
.copyBtn{margin-top:5px;font-size:12px;background:#222}
</style>
</head>
<body>
<div class="card">
<h2>Docker 镜像更新</h2>
<textarea id="content" placeholder="输入新的镜像标签..."></textarea>
<div style="margin-top:10px">
<button id="submitBtn" onclick="submitUpdate()">提交更新</button>
<a href="/logout" style="float:right;color:#666;text-decoration:none;font-size:14px;margin-top:10px">退出登录</a>
</div>
<h3 style="margin-top:30px">Workflow 状态</h3>
<pre id="workflowStatus">等待提交...</pre>
<div id="pullSection" style="display:none;margin-top:20px">
<h3>可执行命令</h3>
<div class="cmd" id="pullCmd"></div>
<button class="copyBtn" onclick="copyCmd()">复制命令</button>
</div>
</div>
<script>
let polling = null;
let currentWorkflowId = null;
async function submitUpdate(){
  const content = document.getElementById("content").value.trim();
  if(!content){ alert("请输入内容"); return; }
  document.getElementById("workflowStatus").textContent="已提交，等待 workflow 创建...";
  document.getElementById("pullSection").style.display="none";
  await fetch("/update",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({content})
  });
  startPolling();
}
function startPolling(){
  if(polling) clearInterval(polling);
  polling = setInterval(checkStatus, 4000);
}
async function checkStatus(){
  const res = await fetch("/status");
  if(!res.ok) return;
  const data = await res.json();
  if(!data.status) return;
  const statusBox = document.getElementById("workflowStatus");
  statusBox.textContent = JSON.stringify(data.status,null,2);
  if(!currentWorkflowId){
    currentWorkflowId = data.status.id;
  }
  if(data.status.id !== currentWorkflowId){
    return; // 不是本次提交的workflow
  }
  if(data.status.status !== "completed"){
    statusBox.className="running";
    return;
  }
  clearInterval(polling);
  if(data.status.conclusion === "success"){
    statusBox.className="success";
    showPullCommand();
  } else {
    statusBox.className="fail";
  }
}
function showPullCommand(){
  const image = document.getElementById("content").value.trim();
  const registry = "${aliyunRegistry}";
 
  // 去除可能的重复斜杠进行安全拼接
  const cleanRegistry = registry.endsWith("/") ? registry.slice(0, -1) : registry;
  const cleanImage = image.startsWith("/") ? image.slice(1) : image;
  const cmd = "docker pull " + cleanRegistry + "/" + cleanImage;
  document.getElementById("pullCmd").textContent = cmd;
  document.getElementById("pullSection").style.display="block";
}
function copyCmd(){
  const cmd = document.getElementById("pullCmd").textContent;
  navigator.clipboard.writeText(cmd);
  alert("已复制");
}
</script>
</body>
</html>
`);
}
function loginPage(msg="") {
  return html(`
<html>
<body style="font-family:system-ui;background:#f4f6fb;display:flex;height:90vh;align-items:center;justify-content:center">
<div style="background:#fff;padding:40px;border-radius:12px;width:100%;max-width:350px;box-shadow:0 10px 25px rgba(0,0,0,.05)">
  <h2>控制台登录</h2>
  <form method="POST" action="/login">
    <input name="username" placeholder="用户名" required style="width:100%;padding:12px;margin-bottom:15px;border:1px solid #ddd;border-radius:6px;box-sizing:border-box"><br>
    <input type="password" name="password" placeholder="密码" required style="width:100%;padding:12px;margin-bottom:15px;border:1px solid #ddd;border-radius:6px;box-sizing:border-box"><br>
    <button type="submit" style="width:100%;padding:12px;background:#5562ff;color:#fff;border:none;border-radius:6px;font-weight:bold;cursor:pointer">登录</button>
  </form>
  ${msg ? `<p style="color:#ff4d4f;font-size:14px">${msg}</p>` : ""}
</div>
</body>
</html>
`);
}
//////////////////////////////////////////////////////
// GitHub API 更新操作
//////////////////////////////////////////////////////
async function handleUpdate(request, kv) {
  const body = await request.json();
  const config = {
    owner: await kv.get("GITHUB_OWNER"),
    repo: await kv.get("GITHUB_REPO"),
    path: await kv.get("FILE_PATH"),
    branch: await kv.get("BRANCH") || "main",
    token: await kv.get("GH_TOKEN")
  };
  if (!config.owner || !config.repo || !config.path || !config.token) {
    return json({ error: "KV 缺少必要配置项" }, 500);
  }
  const getUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}?ref=${config.branch}`;
  const fileData = await safeGitHubRequest(getUrl, config.token);
  const putUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}`;
  const updateResult = await safeGitHubRequest(putUrl, config.token, {
    method: "PUT",
    body: JSON.stringify({
      message: "Update via Worker UI",
      content: base64Encode(body.content),
      sha: fileData.sha,
      branch: config.branch
    })
  });
  await kv.delete("LAST_WORKFLOW");
  return json({ ok: true, sha: updateResult.commit.sha });
}
//////////////////////////////////////////////////////
// Webhook 处理
//////////////////////////////////////////////////////
async function handleWebhook(request, kv) {
  if (request.method !== "POST") return new Response("OK");
  const payload = await request.json();
  if (payload.workflow_run) {
    const info = {
      id: payload.workflow_run.id,
      name: payload.workflow_run.name,
      status: payload.workflow_run.status,
      conclusion: payload.workflow_run.conclusion,
      head_branch: payload.workflow_run.head_branch,
      updated_at: payload.workflow_run.updated_at,
      time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    };
    await kv.put("LAST_WORKFLOW", JSON.stringify(info));
  }
  return json({ ok: true });
}
//////////////////////////////////////////////////////
// 工具函数
//////////////////////////////////////////////////////
async function safeGitHubRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "Cloudflare-Worker-Docker-Updater",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = JSON.parse(text);
  if (!response.ok) throw new Error(data.message || "GitHub API Error");
  return data;
}
function base64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  const binString = String.fromCharCode(...bytes);
  return btoa(binString);
}
async function signValue(value, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return value + "." + btoa(String.fromCharCode(...new Uint8Array(sig)));
}
async function verifyValue(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const valid = await signValue(parts[0], secret);
  return valid === token;
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
function html(content) {
  return new Response(content, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
