export interface MergedPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  mergedAt: string;
}

// Runs at build time only. The daily Pages rebuild keeps it fresh, so the browser never calls the GitHub API.
export async function fetchMergedPrs(user: string, limit = 6): Promise<{ total: number; items: MergedPr[] }> {
  const query = encodeURIComponent(`author:${user} is:pr is:merged -user:${user}`);
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const res = await fetch(`https://api.github.com/search/issues?q=${query}&sort=updated&order=desc&per_page=${limit}`, { headers });
    if (!res.ok) return { total: 0, items: [] };
    const body = (await res.json()) as { total_count: number; items: Array<{ number: number; title: string; html_url: string; repository_url: string; pull_request?: { merged_at?: string } }> };
    const items = body.items.map((item) => ({
      repo: item.repository_url.replace('https://api.github.com/repos/', ''),
      number: item.number,
      title: item.title,
      url: item.html_url,
      mergedAt: item.pull_request?.merged_at ?? '',
    }));
    return { total: body.total_count, items };
  } catch {
    return { total: 0, items: [] };
  }
}

export type OssProjects = Record<string, { what: string; doing: string }>;

// Same source as the GitHub profile README, so both stay in sync. Falls back to the copy in the repo.
export async function fetchOssProjects(fallback: OssProjects): Promise<OssProjects> {
  try {
    const res = await fetch('https://raw.githubusercontent.com/vinirib/vinirib/master/.github/oss-projects.json');
    if (!res.ok) return fallback;
    const data = (await res.json()) as OssProjects;
    for (const p of Object.values(data)) p.what = p.what.replaceAll('`', '');
    for (const p of Object.values(data)) p.doing = p.doing.replaceAll('`', '');
    return data;
  } catch {
    return fallback;
  }
}
