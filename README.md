# vinirib.github.io

Personal site of Vinícius Ribeiro, Senior Backend Engineer. Live at https://vinirib.github.io

Built with Astro and a Preact island. The payment system playground runs on a small deterministic simulation in `src/playground/engine.ts`.

```bash
npm ci
npm run dev     # local server
npm test        # simulation and narration tests
npm run build   # static site in dist/
```

Requires Node 22.23 or newer. Deployed to GitHub Pages by `.github/workflows/deploy.yml` on every push and once a day, which refreshes the open source pull request feed.
