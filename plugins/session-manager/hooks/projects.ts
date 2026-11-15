// Sidebar sections for /organize and the auto-file hook. Edit this list to add or rename projects.
// Order matters: the first project whose pattern matches wins.
// aliases: existing section names that count as this project (an existing "DP1" section is reused for dp-web-ui).
// patterns: case-insensitive regular expressions, tested against the session title, branch and folder.

export type Project = { section: string; aliases: string[]; patterns: string[] }

export const PROJECTS: Project[] = [
  {
    section: "Security",
    aliases: [],
    patterns: ["security", "vulnerab", "\\bvulns?\\b", "\\bcve\\b", "pen ?test"],
  },
  {
    section: "InventoryFeeds",
    aliases: ["IF", "Inventory Feeds"],
    patterns: ["inventory ?feeds?", "\\bfeeds?\\b", "\\bif-\\d+", "azure functions?", "\\bftp\\b"],
  },
  {
    section: "project-neo",
    aliases: ["NEO", "Neo"],
    patterns: ["project-neo", "\\bneo\\b", "\\bneo-\\d+", "primeng"],
  },
  {
    section: "dp-web-ui",
    aliases: ["DP1"],
    patterns: ["dp-web-ui", "dpweb", "\\bdp1\\b", "\\bdp1-\\d+", "angularjs", "legacy (ui|frontend)"],
  },
  {
    section: "Admin Dashboard",
    aliases: ["ADM"],
    patterns: ["admin ?dashboard", "dealerpulladmindashboard", "blazor", "\\badm-\\d+"],
  },
  {
    section: "dealerpull-api",
    aliases: ["API"],
    patterns: ["dealerpull-api", "\\bapi\\b", "backend", "\\.net\\b", "endpoint", "swagger", "ef core", "migration", "hotfix", "quickbooks", "webhook", "auth0", "stripe", "\\bsql\\b"],
  },
  {
    section: "Product",
    aliases: [],
    patterns: ["\\bprd\\b", "\\bspec\\b", "\\bpro-\\d+", "roadmap", "discovery", "feature request", "prototype", "cycle plan"],
  },
  {
    section: "Plugins & tooling",
    aliases: ["Tooling"],
    patterns: ["plugin", "\\bmods?\\b", "\\bskills?\\b", "chief of staff", "claude", "\\bsessions?\\b", "\\bhooks?\\b", "personal-plugins"],
  },
]
