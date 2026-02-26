// aggregate.js
// BOSS Aggregator — Main Script
// Reads all 5 microservices, applies tier+label decision matrix,
// decides BOSS version bump, updates version.json

const fs = require('fs');
const https = require('https');

const config = JSON.parse(fs.readFileSync('./config/services-config.json', 'utf8'));
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// ─── Decision Matrix ────────────────────────────────────────────────────────
// Tier x Label → BOSS bump level
// Priority: major > minor > patch > none
function decideBump(tier, label) {
  if (tier === 1 && label === 'breaking-change') return 'major';
  if ((tier === 1 || tier === 2) && (label === 'feature' || label === 'enhancement')) return 'minor';
  if ((tier === 1 || tier === 2) && label === 'bugfix') return 'patch';
  if (tier === 3) return 'patch'; // Tier 3: always patch, regardless of label
  return 'none';
}

// Priority rank: highest wins across all services in the cycle
const priority = { major: 3, minor: 2, patch: 1, none: 0 };

// ─── GitHub API Helper ───────────────────────────────────────────────────────
function githubGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      headers: {
        'User-Agent': 'boss-aggregator',
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    https.get(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON from ${path}: ${data}`));
        }
      });
    }).on('error', reject);
  });
}

// ─── Fetch ALL closed PRs merged to UAT since a given timestamp ─────────────
// Paginates through all pages until we either run out of PRs
// or find PRs that are older than the lastAggregatedAt timestamp
async function getPRsSince(repo, sinceISO) {
  const sinceDate = new Date(sinceISO);
  const allLabels = [];
  let page = 1;
  let keepGoing = true;

  console.log(`  Scanning all PRs merged to uat since ${sinceISO}`);

  while (keepGoing) {
    const prs = await githubGet(
      `/repos/${repo}/pulls?state=closed&base=uat&per_page=100&page=${page}&sort=updated&direction=desc`
    );

    if (!Array.isArray(prs) || prs.length === 0) {
      // No more pages
      break;
    }

    for (const pr of prs) {
      // Only consider PRs that were actually merged (not just closed/rejected)
      if (!pr.merged_at) continue;

      const mergedAt = new Date(pr.merged_at);

      // If this PR was merged BEFORE the last aggregation, stop scanning
      if (mergedAt <= sinceDate) {
        keepGoing = false;
        break;
      }

      // This PR was merged AFTER the last aggregation — collect its labels
      const labels = pr.labels.map(l => l.name);
      console.log(`    PR #${pr.number}: "${pr.title}" | merged: ${pr.merged_at} | labels: [${labels.join(', ') || 'none'}]`);
      allLabels.push(...labels);
    }

    page++;

    // Safety: if the last item on this page was older than sinceDate, stop
    if (!keepGoing) break;

    // If this page had fewer than 100 results, we've hit the last page
    if (prs.length < 100) break;
  }

  return allLabels;
}

// ─── Main Aggregation Logic ──────────────────────────────────────────────────
async function run() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  BOSS Aggregator — Starting Run');
  console.log(`  Timestamp: ${new Date().toISOString()}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const currentVersion = JSON.parse(fs.readFileSync('./version.json', 'utf8'));
  console.log(`  Current BOSS Version: ${currentVersion.bossVersion}`);

  // ─── Read the last aggregation timestamp ──────────────────────────────────
  // This is the anchor point — we only scan PRs merged AFTER this timestamp
  // If it doesn't exist yet (first run), fall back to lastUpdated
  const lastAggregatedAt = currentVersion.lastAggregatedAt || currentVersion.lastUpdated;
  console.log(`  Scanning PRs since:   ${lastAggregatedAt}`);
  console.log('');

  let highestBump = 'none';
  let bumpReason = 'No services changed in this cycle';
  const manifest = {};

  for (const service of config.services) {
    console.log(`──── Checking: ${service.name} (Tier ${service.tier}) ────`);

    // Get latest release from this repo
    let releases;
    try {
      releases = await githubGet(`/repos/${service.repo}/releases?per_page=1`);
    } catch (e) {
      console.log(`  ⚠ Could not fetch releases: ${e.message}`);
      manifest[service.name] = 'fetch-error';
      continue;
    }

    if (!Array.isArray(releases) || releases.length === 0) {
      console.log(`  ℹ No releases found — skipping`);
      manifest[service.name] = 'no-release';
      continue;
    }

    const latestRelease = releases[0];
    manifest[service.name] = latestRelease.tag_name;
    console.log(`  Latest release: ${latestRelease.tag_name}`);

    // ─── SOLUTION 1: Scan ALL PRs merged to UAT since last aggregation ──────
    // Instead of reading only the last PR, we paginate through all closed PRs
    // merged to UAT after lastAggregatedAt and collect ALL their labels.
    let allLabels;
    try {
      allLabels = await getPRsSince(service.repo, lastAggregatedAt);
    } catch (e) {
      console.log(`  ⚠ Could not fetch PRs: ${e.message}`);
      continue;
    }

    if (allLabels.length === 0) {
      console.log(`  ℹ No PRs merged to uat since last aggregation — skipping`);
      console.log('');
      continue;
    }

    console.log(`  All labels collected since last run: [${[...new Set(allLabels)].join(', ')}]`);

    // Apply decision matrix across ALL collected labels — take highest
    let serviceBump = 'none';
    let winningLabel = null;

    // Deduplicate labels before processing
    const uniqueLabels = [...new Set(allLabels)];

    for (const label of uniqueLabels) {
      const bump = decideBump(service.tier, label);
      if (priority[bump] > priority[serviceBump]) {
        serviceBump = bump;
        winningLabel = label;
      }
    }

    // Handle Tier 3: always patch if any label found
    if (service.tier === 3 && uniqueLabels.length > 0 && serviceBump === 'none') {
      serviceBump = 'patch';
      winningLabel = uniqueLabels[0];
    }

    console.log(`  Decision: ${serviceBump.toUpperCase()} ${winningLabel ? `(highest label: "${winningLabel}")` : ''}`);

    // Update global highest bump
    if (priority[serviceBump] > priority[highestBump]) {
      highestBump = serviceBump;
      bumpReason = `${service.name} (Tier ${service.tier}) — label: "${winningLabel}"`;
    }

    console.log('');
  }

  // ─── Calculate New BOSS Version ────────────────────────────────────────────
  let [major, minor, patch] = currentVersion.bossVersion.split('.').map(Number);

  if (highestBump === 'major') { major++; minor = 0; patch = 0; }
  else if (highestBump === 'minor') { minor++; patch = 0; }
  else if (highestBump === 'patch') { patch++; }

  const newVersion = highestBump === 'none'
    ? currentVersion.bossVersion
    : `${major}.${minor}.${patch}`;

  // ─── Write version.json ────────────────────────────────────────────────────
  // NOTE: lastAggregatedAt is set to NOW so the NEXT run knows where to start from
  const runTimestamp = new Date().toISOString();
  const output = {
    bossVersion: newVersion,
    previousVersion: currentVersion.bossVersion,
    bumpType: highestBump,
    bumpReason,
    lastUpdated: runTimestamp,
    lastAggregatedAt: runTimestamp,   // ← The new anchor point for next run
    services: manifest
  };

  fs.writeFileSync('./version.json', JSON.stringify(output, null, 2));

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  BOSS Version: ${currentVersion.bossVersion} → ${newVersion}`);
  console.log(`  Bump Type:    ${highestBump.toUpperCase()}`);
  console.log(`  Reason:       ${bumpReason}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (highestBump === 'none') {
    console.log('  ℹ No changes detected — BOSS version unchanged');
  } else {
    console.log(`   version.json updated successfully`);
  }
}

run().catch(err => {
  console.error(' Aggregation failed:', err);
  process.exit(1);
});
