-- Products the admin flagged as missing (2026-10-16): 飞书/Lark (ByteDance), 秒搭/秒哒 (Baidu), CodeBuddy (Tencent),
-- MAI and Office/Microsoft 365 (Microsoft). Feishu's own site describes itself as "字节跳动旗下AI工作平台"; no X account is
-- linked from feishu.cn or larksuite.com, so none is registered.
INSERT INTO platforms(id,name,type,status,site,company,aliases)
  SELECT 'feishu','字节跳动 飞书 Lark','tool','approved','https://www.feishu.cn','字节跳动',json_array('飞书','Feishu','Lark','Lark Suite','飞书 AI','飞书智能伙伴','aily')
  WHERE NOT EXISTS(SELECT 1 FROM platforms WHERE id='feishu');

UPDATE platforms SET aliases=json_array('文心','文心一言','ERNIE','千帆','文心快码','Comate','秒哒','秒搭','Miaoda','MeDo') WHERE id='baidu';
UPDATE platforms SET aliases=json_array('腾讯云','Tencent Cloud','CodeBuddy','CodeBuddy IDE','CodeBuddy Code','腾讯云代码助手') WHERE id='tencent';
UPDATE platforms SET aliases=json_array('Microsoft Copilot','Copilot App','MAI','MAI-Image-1','MAI-Voice-1','Office 365','Microsoft 365','M365','Microsoft 365 Copilot') WHERE id='microsoft-ai';

-- Official sites: product pages are crawled; microsoft.com blocks automated fetches, so it is registered only.
INSERT OR IGNORE INTO sources(id,platform_id,kind,url,tier,config,enabled,auto_publish)
  SELECT 'feishu-site-feishuai','feishu','web_list','https://www.feishu.cn/product/feishuai','site','{"addedBy":"admin-products-2026-10-16"}',1,0
  WHERE EXISTS(SELECT 1 FROM platforms WHERE id='feishu') AND NOT EXISTS(SELECT 1 FROM sources WHERE url='https://www.feishu.cn/product/feishuai');
INSERT OR IGNORE INTO sources(id,platform_id,kind,url,tier,config,enabled,auto_publish)
  SELECT 'feishu-site-larksuite','feishu','web_list','https://www.larksuite.com','site','{"addedBy":"admin-products-2026-10-16"}',1,0
  WHERE EXISTS(SELECT 1 FROM platforms WHERE id='feishu') AND NOT EXISTS(SELECT 1 FROM sources WHERE url='https://www.larksuite.com');
INSERT OR IGNORE INTO sources(id,platform_id,kind,url,tier,config,enabled,auto_publish)
  SELECT 'baidu-site-miaoda','baidu','web_list','https://www.miaoda.cn','site','{"addedBy":"admin-products-2026-10-16"}',1,0
  WHERE EXISTS(SELECT 1 FROM platforms WHERE id='baidu') AND NOT EXISTS(SELECT 1 FROM sources WHERE url='https://www.miaoda.cn');
INSERT OR IGNORE INTO sources(id,platform_id,kind,url,tier,config,enabled,auto_publish)
  SELECT 'baidu-site-medo','baidu','web_list','https://medo.dev','site','{"addedBy":"admin-products-2026-10-16"}',1,0
  WHERE EXISTS(SELECT 1 FROM platforms WHERE id='baidu') AND NOT EXISTS(SELECT 1 FROM sources WHERE url='https://medo.dev');
INSERT OR IGNORE INTO sources(id,platform_id,kind,url,tier,config,enabled,auto_publish)
  SELECT 'tencent-site-codebuddy-cn','tencent','web_list','https://www.codebuddy.cn','site','{"addedBy":"admin-products-2026-10-16"}',1,0
  WHERE EXISTS(SELECT 1 FROM platforms WHERE id='tencent') AND NOT EXISTS(SELECT 1 FROM sources WHERE url='https://www.codebuddy.cn');
INSERT OR IGNORE INTO sources(id,platform_id,kind,url,tier,config,enabled,auto_publish)
  SELECT 'microsoft-ai-site-m365','microsoft-ai','web_list','https://www.microsoft.com/microsoft-365','site','{"addedBy":"admin-products-2026-10-16"}',0,0
  WHERE EXISTS(SELECT 1 FROM platforms WHERE id='microsoft-ai') AND NOT EXISTS(SELECT 1 FROM sources WHERE url='https://www.microsoft.com/microsoft-365');
