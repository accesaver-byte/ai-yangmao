-- RSS direct fetch failed 15 times because safe-fetch rejected github.blog's public 192.0.66.2.
-- Keep the source ID and official publisher; the page reader has a verified readable fallback.
-- Do not clear failure history: only a real successful collection resets source health.
UPDATE sources SET kind='web_list', url='https://github.blog/changelog/label/copilot/',
  config=json_set(config,'$.repair','copilot-changelog-page-2026-10-20')
WHERE id='copilot-rss-changelog' AND kind='rss'
  AND url='https://github.blog/changelog/label/copilot/feed/';
