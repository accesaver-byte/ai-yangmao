-- Platform aliases and parent companies (2026-10-15).
-- aliases: product names that identify the platform in leads (e.g. "ZCode" -> zhipu); before this, a lead that only
-- named the product could not be tied to its platform and sat in manual review ("未能确认发放平台").
-- company: parent company used to group product platforms in public lists; platform IDs, offers and review history are
-- unchanged, so this is a display/matching layer only.
ALTER TABLE platforms ADD COLUMN company TEXT;
ALTER TABLE platforms ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]';

-- Parent companies (only companies with more than one platform need a group).
UPDATE platforms SET company='阿里巴巴' WHERE id IN ('aliyun','modelscope','qoder','qwen','qwenwork');
UPDATE platforms SET company='字节跳动' WHERE id IN ('coze','doubao','doubao-work','dreamina','jimeng','trae','volc');
UPDATE platforms SET company='腾讯' WHERE id IN ('tencent','tencent-hy','workbuddy');
UPDATE platforms SET company='微软' WHERE id IN ('azure','copilot','github','microsoft-ai');
UPDATE platforms SET company='亚马逊' WHERE id IN ('aws','kiro');
UPDATE platforms SET company='Google' WHERE id IN ('google','gcloud');
UPDATE platforms SET company='MiniMax' WHERE id IN ('minimax','hailuo');
UPDATE platforms SET company='Cognition' WHERE id IN ('devin','windsurf');

-- Shorter display names inside a company group; the old wording stays matchable through aliases.
UPDATE platforms SET name='海螺 AI' WHERE id='hailuo' AND name='海螺 AI（MiniMax）';
UPDATE platforms SET name='Qoder' WHERE id='qoder' AND name='阿里 Qoder（CN / International）';
UPDATE platforms SET name='通义千问 Qwen' WHERE id='qwen' AND name LIKE '阿里 Qwen%';
UPDATE platforms SET name='豆包 Doubao' WHERE id='doubao' AND name='字节跳动 豆包 Doubao';
UPDATE platforms SET name='腾讯混元' WHERE id='tencent-hy' AND name='腾讯混元 HY（含 WorkBuddy）';

-- Product aliases. Model family names (GLM, GPT, Seedream, Veo...) are deliberately excluded: other platforms serve them.
UPDATE platforms SET aliases=json_array('百炼','Bailian','阿里云','Model Studio','DashScope') WHERE id='aliyun';
UPDATE platforms SET aliases=json_array('魔搭') WHERE id='modelscope';
UPDATE platforms SET aliases=json_array('Qoder CN','Qoder International') WHERE id='qoder';
UPDATE platforms SET aliases=json_array('通义千问','通义','千问','Tongyi','Qwen Code','Qwen Chat','千问 App') WHERE id='qwen';
UPDATE platforms SET aliases=json_array('千问办公','Qwen Work','QwenWork') WHERE id='qwenwork';
UPDATE platforms SET aliases=json_array('扣子','Coze') WHERE id='coze';
UPDATE platforms SET aliases=json_array('豆包','Doubao','豆包 App') WHERE id='doubao';
UPDATE platforms SET aliases=json_array('豆包工作') WHERE id='doubao-work';
UPDATE platforms SET aliases=json_array('即梦','即梦AI','Jimeng') WHERE id='jimeng';
UPDATE platforms SET aliases=json_array('火山方舟','火山引擎','Volcengine','Volcano Engine') WHERE id='volc';
UPDATE platforms SET aliases=json_array('TRAE','TRAE SOLO') WHERE id='trae';
UPDATE platforms SET aliases=json_array('腾讯云','Tencent Cloud','CodeBuddy') WHERE id='tencent';
UPDATE platforms SET aliases=json_array('混元','Hunyuan','腾讯混元') WHERE id='tencent-hy';
UPDATE platforms SET aliases=json_array('WorkBuddy') WHERE id='workbuddy';
UPDATE platforms SET aliases=json_array('Azure OpenAI','Azure AI Foundry') WHERE id='azure';
UPDATE platforms SET aliases=json_array('Microsoft Copilot','Copilot App') WHERE id='microsoft-ai';
UPDATE platforms SET aliases=json_array('GitHub Copilot','Copilot Pro') WHERE id='copilot';
UPDATE platforms SET aliases=json_array('GitHub Models') WHERE id='github';
UPDATE platforms SET aliases=json_array('Amazon Bedrock','Bedrock','Amazon Q') WHERE id='aws';
UPDATE platforms SET aliases=json_array('Gemini','AI Studio','Google AI Studio','Gemini CLI','Jules','Antigravity','NotebookLM') WHERE id='google';
UPDATE platforms SET aliases=json_array('GCP','Vertex AI') WHERE id='gcloud';
UPDATE platforms SET aliases=json_array('海螺','海螺AI','Hailuo','Hailuo AI') WHERE id='hailuo';
UPDATE platforms SET aliases=json_array('MiniMax Agent','星野','Talkie') WHERE id='minimax';
UPDATE platforms SET aliases=json_array('Cognition') WHERE id='devin';
UPDATE platforms SET aliases=json_array('Codeium') WHERE id='windsurf';
UPDATE platforms SET aliases=json_array('ChatGPT','Codex','Sora','OpenAI API') WHERE id='openai';
UPDATE platforms SET aliases=json_array('Claude','Claude Code','Claude.ai') WHERE id='anthropic';
UPDATE platforms SET aliases=json_array('ZCode','BigModel','智谱清言','ChatGLM','GLM Coding Plan','CodeGeeX') WHERE id='zhipu';
UPDATE platforms SET aliases=json_array('Kimi','月之暗面','Kimi Code') WHERE id='moonshot';
UPDATE platforms SET aliases=json_array('文心','文心一言','ERNIE','千帆','文心快码','Comate','秒哒') WHERE id='baidu';
UPDATE platforms SET aliases=json_array('阶跃','跃问','StepFun') WHERE id='stepfun';
UPDATE platforms SET aliases=json_array('Grok','SuperGrok') WHERE id='xai';
UPDATE platforms SET aliases=json_array('Llama','Meta AI') WHERE id='meta';
UPDATE platforms SET aliases=json_array('MiMo','Xiaomi MiMo') WHERE id='xiaomi-mimo';
UPDATE platforms SET aliases=json_array('可灵','Kling','KlingAI') WHERE id='kling';
UPDATE platforms SET aliases=json_array('WPS AI','WPS 灵犀','灵犀') WHERE id='lingxi';
UPDATE platforms SET aliases=json_array('日日新','SenseNova','商量','小浣熊') WHERE id='sensenova';
UPDATE platforms SET aliases=json_array('LongCat') WHERE id='meituan';
UPDATE platforms SET aliases=json_array('LiblibAI','LibTV','哩布哩布') WHERE id='liblibtv';
UPDATE platforms SET aliases=json_array('云知声','Token Hub','U2 Flash') WHERE id='unisound';
UPDATE platforms SET aliases=json_array('基元律动') WHERE id='tokenrhythm';
UPDATE platforms SET aliases=json_array('华为云','Huawei Cloud','ModelArts') WHERE id='huaweicloud';
UPDATE platforms SET aliases=json_array('v0') WHERE id='vercel';
UPDATE platforms SET aliases=json_array('Gitee AI') WHERE id='moark';

-- ZCode / Z.ai official X accounts (ZCode's Weekend Build rounds are announced there).
UPDATE platforms SET x_handles=json_array('@Zai_org','@zcode_ai') WHERE id='zhipu' AND x_handles='[]';
