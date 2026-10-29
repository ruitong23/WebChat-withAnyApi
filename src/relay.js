const allowedPaths = /^\/(?:v1\/(?:models|chat\/completions|embeddings)|api\/v[01]\/models(?:\/(?:load|unload|download(?:\/status\/[a-zA-Z0-9_-]+)?))?)$/;
export function normalizeBase(raw) {
  const url = new URL(raw.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入不含账号、查询参数的 HTTP(S) 基础地址');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:api\/v[01]|v1)(?:\/(?:chat\/completions|models))?$/, '');
  return url.href.replace(/\/$/, '');
}
function isPrivate(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/.test(h) || /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h) || h === '::1' || h === '::' || h.includes(':') || /^\d+$/.test(h);
}
export async function relay(request, options = {}) {
  const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  if (request.method !== 'POST') return json({error:{message:'只接受 POST 请求'}},405);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({error:{message:'拒绝来自其他网站的请求'}},403);
  if (!request.headers.get('content-type')?.includes('application/json')) return json({error:{message:'请求必须为 JSON'}},415);
  try {
    if (Number(request.headers.get('content-length')) > 24 * 1024 * 1024) return json({error:{message:'请求附件过大，请控制在 24 MB 内'}},413);
    const data = await request.json();
    const base = normalizeBase(data.baseUrl || '');
    const target = new URL(base);
    if (!options.allowPrivate && isPrivate(target.hostname)) return json({error:{message:'无法连接此地址'}},400);
    const path = data.path;
    if (typeof path !== 'string' || !allowedPaths.test(path)) return json({error:{message:'此接口路径不在支持范围内'}},400);
    const get = path.endsWith('/models') || path.includes('/download/status/');
    const method = get ? 'GET' : 'POST';
    const headers = {'Content-Type':'application/json', 'Accept': path.endsWith('/completions') && data.payload?.stream ? 'text/event-stream' : 'application/json'};
    if (data.apiKey) {
      if (typeof data.apiKey !== 'string' || /[\r\n]/.test(data.apiKey)) throw new Error('API Key 格式不正确');
      headers.Authorization = `Bearer ${data.apiKey}`;
    }
    const signal = path.endsWith('/chat/completions') ? request.signal : AbortSignal.any([request.signal, AbortSignal.timeout(get ? 20000 : 300000)]);
    const response = await (options.fetch || fetch)(base + path, {method, headers, body:get ? undefined : JSON.stringify(data.payload || {}), signal, redirect:'manual'});
    if (response.status >= 300 && response.status < 400) return json({error:{message:'接口返回重定向。请填写重定向后的准确 API 地址。'}},502);
    return new Response(response.body,{status:response.status,headers:{'Content-Type':response.headers.get('content-type') || 'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  } catch(error) {
    const timeout = error.name === 'TimeoutError';
    return json({error:{message:timeout ? '连接超时' : (error.message === 'fetch failed' ? '无法连接 API' : error.message)}}, timeout ? 504 : 502);
  }
}
