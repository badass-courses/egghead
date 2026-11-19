// Rails feed routes took an optional format suffix, so `/feed.rss` and
// friends were live URLs (app.egghead.io/feed.rss answered 200 RSS). These
// rewrites serve the suffixed form from the same handlers; the query string
// (user_email, user_token, tech) passes through unchanged.
//
// egghead-next's /i/:slug/rss.xml has no suffixed form (rss.rss is a 404).

export const FEED_RSS_SUFFIX_REWRITES = [
  { source: "/feed.rss", destination: "/feed" },
  { source: "/lessons/feed.rss", destination: "/lessons/feed" },
  { source: "/lessons/pro_feed.rss", destination: "/lessons/pro_feed" },
  { source: "/courses/:course/course_feed.rss", destination: "/courses/:course/course_feed" },
  { source: "/playlists/:id/playlist_feed.rss", destination: "/playlists/:id/playlist_feed" },
  { source: "/instructors/:id/feed.rss", destination: "/instructors/:id/feed" },
] as const;
