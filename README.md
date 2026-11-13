# Rosia website

A static site: no build step. It is published from the public repository `xorosiaxo/xorosiaxo.github.io` at
https://xorosiaxo.github.io (the app's own code stays in the private `xorosiaxo/rosia`).

To publish a new version of this folder, from the project root:

```bash
git push site "$(git commit-tree HEAD:site -m 'Website')":refs/heads/main --force
```

## "Try her now in your browser"

The buttons read their address from `try.json`. While `url` is empty they stay hidden.

1. In the app, Settings, Share with friends: choose **Their own private space**, then **Start sharing**, then **Copy**.
2. Paste the address into `try.json`:

   ```json
   { "url": "https://your-link.trycloudflare.com" }
   ```

3. Commit and push. The site picks it up on the next page load.

A quick Cloudflare link changes every time sharing is started again, so step 2 is needed after each restart. A named
Cloudflare tunnel on your own domain keeps one address for good.

## Download buttons

They point at `DOWNLOAD_URL` at the top of `site.js`: the latest release of `xorosiaxo/xorosiaxo.github.io`. Publish the
installer there (Releases, Draft a new release, attach `Rosia_<version>_x64-setup.exe`).
