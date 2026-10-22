// 在图表库下载前发起公开查询；每个结果均捕获失败，避免等待应用启动时产生未处理拒绝。
window.YM_INITIAL_REQUESTS = new Map([
  '/api/platforms',
  '/api/offers?view=all&valuation=v2&schema=valuation-v2-public-inputs&lifecycle=approved-contract-v1&models=models-v1-2026-10-19',
  '/api/meta?schema=partial-fetch-v1',
  '/api/coverage?schema=partial-fetch-v1',
  '/api/memberships',
].map(path => [path, (async () => {
  try {
    const response = await fetch(path, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`${path} ${response.status}`);
    return { ok: true, value: await response.json() };
  } catch (error) { return { ok: false, error }; }
})()]));
