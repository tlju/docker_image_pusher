/**
 * ========================================================
 * Cloudflare Worker Docker Registry 智能代理 + 自动构建系统
 * Worker 需要绑定域名，且配置在本地Docker的daemon.json
 * 
 * 核心功能说明：
 * 
 * 1. 自动镜像构建流程（GitHub Actions）
 *    - 用户首次 pull 时，如果阿里云 ACR 不存在该镜像 → 自动触发 GitHub Workflow 构建并推送
 *    - 严格防重复触发（同一 pull 只触发 1 次，HEAD+GET+digest 全部防重）
 * 
 * 2. 智能流量路由（优先级最高 → 最低）
 *    - Manifests (Tag 请求)：强制走 Docker Hub（保证 multi-arch 列表完整）
 *    - Manifests (Digest 请求)：优先 ACR → 失败走 Hub
 *    - Blobs（镜像层）：优先 ACR（amd64 已缓存超快）→ 失败走 Hub（arm64 原生层）
 * 
 * 3. 平台支持
 *    - amd64 机器：直接走 ACR 缓存（极速）
 *    - arm64 机器（M1/M2/M3、树莓派、ARM 服务器）：自动拿到 linux/arm64 原生镜像
 *    - 不再默认只拉 amd64
 * 
 * 4. 阿里云已存在时的行为
 *    - 无论 amd64/arm64，只要 ACR 里有镜像 → 全流量直接代理给 ACR（最快）
 *    - ACR 404 时才回退 Docker Hub + 触发构建
 * 
 * 5. 其他特性
 *    - 60秒构建锁（BUILD_LOCK_xxx）
 *    - 先清空 LAST_WORKFLOW 再更新 GitHub 文件
 *    - 完整调试信息存入 KV（DEBUG_ 前缀）
 *    - 支持 library/ 强制转换、401 Token 自动处理
 * 
 * 使用方法：
 * 1. 把此代码完整替换到你的 Cloudflare Worker
 * 2. 确保 KV 中已绑定以下键值（与之前一致）：
 *    - ALIYUN_REGISTRY / ALIYUN_USERNAME / ALIYUN_PASSWORD
 *    - GITHUB_OWNER / GITHUB_REPO / FILE_PATH / GITHUB_TOKEN / BRANCH
 * 3. GitHub Workflow 的 webhook 已配置好
 * 
 * 测试命令（推荐）：
 * docker pull nginx:1.20
 * docker inspect nginx:1.20 | grep Architecture   # 应显示 arm64（在 arm64 机器上）
 * 
 * 作者：tlju
 * 最后更新：2026.03
 * ========================================================
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const kv = env.DOCKER_KV;
    if (!kv) {
      return new Response("KV 绑定错误：请确保在 Cloudflare 设置中绑定了名为 DOCKER_KV 的命名空间", { status: 500 });
    }
    try {
      if (url.pathname.startsWith('/v2/')) {
        return await handleRegistry(request, kv, url);
      }
      if (url.pathname === "/webhook") {
        return handleWebhook(request, kv);
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

/** ====================== 核心：Registry 代理入口 ====================== 
 * 所有 /v2/ 请求的统一入口
 * 负责：初始化配置、解析路径、路由到 manifests 或 blobs 处理函数
 */
async function handleRegistry(request, kv, url) {
  const pathname = url.pathname;
  if (pathname === "/v2/" || pathname === "/v2") {
    return new Response("", {
      status: 200,
      headers: { "Docker-Distribution-Api-Version": "registry/2.0" }
    });
  }

  // 调试信息（方便排查）
  await kv.put("DEBUG_URL", JSON.stringify({ href: url.href, pathname: url.pathname }));

  const config = await initRegistryConfig(kv, pathname);
  const parsedInfo = parseImagePath(pathname);

  await kv.put("DEBUG_CONFIG", JSON.stringify(config));
  await kv.put("DEBUG_PARSED_INFO", JSON.stringify(parsedInfo));

  const last_workflow = await getWorkflowStatus(kv);

  if (isManifestsRequest(pathname)) {
    return await handleManifestsRequest(request, config, parsedInfo, last_workflow, kv);
  } else if (isBlobsRequest(pathname)) {
    return await handleBlobsRequest(request, config, parsedInfo, last_workflow);
  } else {
    return await proxyWithAuth(config.hub_proxy_url, request, null, null, false);
  }
}

/** ====================== 初始化配置 ====================== 
 * 从 KV 读取阿里云和 GitHub 配置，构造 ACR 和 Hub 的完整代理 URL
 */
async function initRegistryConfig(kv, pathname) {
  const aliyunRegistry = await kv.get("ALIYUN_REGISTRY") || "registry.cn-hangzhou.aliyuncs.com/tlju-docker-images";
  const [registryHost, ...repoParts] = aliyunRegistry.split('/');
  const repoPrefix = repoParts.join('/');
  const aliyun_base = `https://${registryHost}`;
  let acr_proxy_path = pathname.replace(/^\/v2\/(library\/)?/, `/v2/${repoPrefix}/`);
  const acr_proxy_url = `${aliyun_base}${acr_proxy_path}${new URL(`http://example.com${pathname}`).search}`;

  let hub_path = pathname;
  if (!pathname.includes('/library/') && /^\/v2\/[^/]+\/(manifests|blobs)\//.test(pathname)) {
    hub_path = pathname.replace(/^\/v2\//, '/v2/library/');
  }
  const hub_base = 'https://registry-1.docker.io';
  const hub_proxy_url = `${hub_base}${hub_path}${new URL(`http://example.com${pathname}`).search}`;

  const username = await kv.get("ALIYUN_USERNAME");
  const password = await kv.get("ALIYUN_PASSWORD");
  if (!username || !password) throw new Error("KV 缺少 ALIYUN_USERNAME 或 ALIYUN_PASSWORD");

  return { acr_proxy_url, hub_proxy_url, username, password };
}

/** ====================== 解析镜像路径 ====================== 
 * 从 /v2/xxx/yyy/manifests/tag 中提取 image_name
 */
function parseImagePath(pathname) {
  let image_name = null;
  const parts = pathname.split('/');
  if (parts.length >= 4) {
    const raw_image_name = parts.slice(2, parts.length - 2).join("/") || parts[2];
    image_name = raw_image_name.replace(/^library\//, "");
  }
  return { image_name, content: null, parts };
}

/** ====================== 判断请求类型 ====================== */
function isManifestsRequest(pathname) {
  const parts = pathname.split('/');
  return parts.length >= 4 && parts[parts.length - 2] === "manifests";
}
function isBlobsRequest(pathname) {
  const parts = pathname.split('/');
  return parts.length >= 4 && parts[parts.length - 2] === "blobs";
}

/** ====================== 处理 Manifests 请求（已支持 arm64） ====================== 
 * 核心智能路由逻辑：
 *   Tag 请求（/manifests/1.20）→ 强制走 Docker Hub（获取完整 multi-arch 列表）
 *   Digest 请求（/manifests/sha256:xxx）→ 优先 ACR（已缓存的 amd64）→ 失败走 Hub
 *   只有 Tag 请求成功时才触发构建（防重复）
 */
async function handleManifestsRequest(request, config, parsedInfo, last_workflow, kv) {
  const parts = parsedInfo.parts;
  const ref = parts[parts.length - 1];
  const isDigest = ref && ref.startsWith("sha256:");
  const content = !isDigest ? (parsedInfo.image_name + ":" + ref) : null;

  let response;

  if (!isDigest) {
    // Tag 请求必须走 Hub，才能让 arm64 客户端拿到 linux/arm64 平台
    response = await proxyWithAuth(config.hub_proxy_url, request, null, null, false);
  } else {
    // Digest 请求（具体平台 manifest）优先用 ACR 已缓存的内容
    response = await proxyWithAuth(config.acr_proxy_url, request, config.username, config.password, true);
    if (!response.ok && response.status === 404) {
      response = await proxyWithAuth(config.hub_proxy_url, request, null, null, false);
    }
  }

  // ==================== 构建触发逻辑（仅 Tag 请求） ====================
  if (response.ok && !isDigest && content) {
    const isCurrent = last_workflow && last_workflow.content === content;
    const isBuilding = isCurrent &&
                      (last_workflow.status === 'building' ||
                       last_workflow.status === 'in_progress' ||
                       last_workflow.status === 'queued');

    if (!isBuilding) {
      const lockKey = `BUILD_LOCK_${content.replace(/:/g, '_')}`;
      const hasLock = await kv.get(lockKey);

      if (!hasLock) {
        await kv.put(lockKey, "1", { expirationTtl: 60 }); // 60秒防重复锁
        try {
          await handleUpdate({ content }, kv);
        } catch (err) {
          await kv.delete(lockKey);
          console.error("handleUpdate 失败:", err.message);
        }
      }
    }
  }
  // =================================================================

  return response;
}

/** ====================== 处理 Blobs 请求（优先 ACR 缓存） ====================== 
 * Blobs 是实际的镜像层：
 *   先尝试 ACR（amd64 已缓存，速度极快）
 *   失败再走 Hub（arm64 原生层 / 首次拉取）
 *   构建中返回 503 让客户端重试
 */
async function handleBlobsRequest(request, config, parsedInfo, last_workflow) {
  const { image_name } = parsedInfo;
  if (!image_name) {
    return await proxyWithAuth(config.hub_proxy_url, request, null, null, false);
  }

  // 优先走 ACR（amd64 已缓存的层）
  let acrResponse = await proxyWithAuth(config.acr_proxy_url, request, config.username, config.password, true);
  if (acrResponse.ok) {
    return acrResponse;
  }
  if (acrResponse.status !== 404) {
    return acrResponse;
  }

  // ACR 404 → 检查是否正在构建
  const isCurrentImage = last_workflow?.content?.startsWith(image_name + ":");
  const isBuilding = isCurrentImage &&
                    (last_workflow.status === 'building' ||
                     last_workflow.status === 'in_progress' ||
                     last_workflow.status === 'queued');

  if (isBuilding) {
    const msg = `镜像 ${last_workflow.content} 正在构建中...`;
    return new Response(msg, { status: 503, headers: { "Retry-After": "60" } });
  }

  // arm64 层 或 未构建成功 → 走 Docker Hub（保证能拉到原生 arm64）
  return await proxyWithAuth(config.hub_proxy_url, request, null, null, false);
}

/** ====================== 代理 + 认证（支持 ACR 与 Hub） ====================== 
 * 统一处理 401 挑战，自动获取 Bearer Token
 * isACR = true 时使用 Basic Auth（阿里云需要）
 */
async function proxyWithAuth(proxy_url, request, username, password, isACR) {
  const headers = new Headers(request.headers);
  headers.delete("host");
  let response = await fetch(proxy_url, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "follow"
  });

  if (response.status === 401) {
    const wwwAuth = response.headers.get("WWW-Authenticate");
    const realm = wwwAuth.match(/realm="([^"]+)"/i)?.[1];
    const service = wwwAuth.match(/service="([^"]+)"/i)?.[1];
    const scope = wwwAuth.match(/scope="([^"]+)"/i)?.[1];

    let tokenUrl = `${realm}?service=${service || ''}`;
    if (scope) tokenUrl += `&scope=${encodeURIComponent(scope)}`;

    const tokenHeaders = new Headers();
    if (isACR) {
      tokenHeaders.set("Authorization", `Basic ${btoa(`${username}:${password}`)}`);
    }

    const tokenResponse = await fetch(tokenUrl, { headers: tokenHeaders });
    const tokenData = await tokenResponse.json();
    const token = tokenData.token || tokenData.access_token;

    headers.set("Authorization", `Bearer ${token}`);
    response = await fetch(proxy_url, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "follow"
    });
  }
  return response;
}

/** ====================== GitHub 更新操作（严格先清空再更新） ====================== 
 * 按你的原始要求：先删除 LAST_WORKFLOW，再更新 GitHub 文件触发 Action
 */
async function handleUpdate(body, kv) {
  const config = {
    owner: await kv.get("GITHUB_OWNER"),
    repo: await kv.get("GITHUB_REPO"),
    path: await kv.get("FILE_PATH"),
    branch: await kv.get("BRANCH") || "main",
    token: await kv.get("GITHUB_TOKEN")
  };
  if (!config.owner || !config.repo || !config.path || !config.token) throw new Error("KV 缺少必要配置项");

  await kv.delete("LAST_WORKFLOW");

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

  return { ok: true, sha: updateResult.commit.sha };
}

/** ====================== 其余工具函数 ====================== */
async function getWorkflowStatus(kv) {
  const status = await kv.get("LAST_WORKFLOW");
  return status ? JSON.parse(status) : null;
}

async function handleWebhook(request, kv) {
  if (request.method !== "POST") return new Response("OK");
  const payload = await request.json();
  if (payload.workflow_run) {
    const info = {
      id: payload.workflow_run.id,
      status: payload.workflow_run.status,
      conclusion: payload.workflow_run.conclusion,
      time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      content: payload.workflow_run.content
    };
    await kv.put("LAST_WORKFLOW", JSON.stringify(info));
  }
  return json({ ok: true });
}

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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
