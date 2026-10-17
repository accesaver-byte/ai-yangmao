-- Four sources added on 2026-10-16 could not be read by the crawler although the sites open in a browser:
-- trae.ai/rss.xml is advertised by trae.ai but serves the site's HTML shell; z.ai and trae.cn are JavaScript apps
-- (59 / 149 visible characters, Jina 403 / 422); github.blog/feed is 1.5 MB of every GitHub post and timed out.
-- Their domains stay registered (enabled=0) so evidence there still counts as official; readable pages replace them.
UPDATE sources SET enabled=0 WHERE id IN ('trae-rss-trae-ai-rss-xml','trae-site-trae-cn','zhipu-site-z-ai','copilot-rss-github-blog-feed');
INSERT OR IGNORE INTO sources(id,platform_id,kind,url,tier,config,enabled,auto_publish)
  SELECT 'trae-site-blog','trae','web_list','https://www.trae.ai/blog','site','{"addedBy":"source-fix-2026-10-16"}',1,0
  WHERE EXISTS(SELECT 1 FROM platforms WHERE id='trae') AND NOT EXISTS(SELECT 1 FROM sources WHERE url='https://www.trae.ai/blog');
INSERT OR IGNORE INTO sources(id,platform_id,kind,url,tier,config,enabled,auto_publish)
  SELECT 'zhipu-docs-z-ai-release-notes','zhipu','web_list','https://docs.z.ai/release-notes/new-released','docs','{"addedBy":"source-fix-2026-10-16"}',1,0
  WHERE EXISTS(SELECT 1 FROM platforms WHERE id='zhipu') AND NOT EXISTS(SELECT 1 FROM sources WHERE url='https://docs.z.ai/release-notes/new-released');
INSERT OR IGNORE INTO sources(id,platform_id,kind,url,tier,config,enabled,auto_publish)
  SELECT 'copilot-rss-changelog','copilot','rss','https://github.blog/changelog/label/copilot/feed/','site','{"addedBy":"source-fix-2026-10-16"}',1,0
  WHERE EXISTS(SELECT 1 FROM platforms WHERE id='copilot') AND NOT EXISTS(SELECT 1 FROM sources WHERE url='https://github.blog/changelog/label/copilot/feed/');
