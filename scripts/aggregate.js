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

// ─── Main Aggregation Logic ──────────────────────────────────────────────────
async function run() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  BOSS Aggregator — Starting Run');
  console.log(`  Timestamp: ${new Date().toISOString()}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const currentVersion = JSON.parse(fs.readFileSync('./version.json', 'utf8'));
  console.log(`  Current BOSS Version: ${currentVersion.bossVersion}`);
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

    // Get latest closed PR merged to uat branch
    let prs;
    try {
      prs = await githubGet(`/repos/${service.repo}/pulls?state=closed&base=uat&per_page=1`);
    } catch (e) {
      console.log(`  ⚠ Could not fetch PRs: ${e.message}`);
      continue;
    }

    if (!Array.isArray(prs) || prs.length === 0) {
      console.log(`  ℹ No closed PRs found targeting uat`);
      continue;
    }

    const pr = prs[0];
    const labels = pr.labels.map(l => l.name);
    console.log(`  Latest PR #${pr.number}: "${pr.title}"`);
    console.log(`  Labels: ${labels.length > 0 ? labels.join(', ') : '(none)'}`);

    // Apply decision matrix for each label — take highest
    let serviceBump = 'none';
    let winningLabel = null;
    for (const label of labels) {
      const bump = decideBump(service.tier, label);
      if (priority[bump] > priority[serviceBump]) {
        serviceBump = bump;
        winningLabel = label;
      }
    }

    // Handle Tier 3: always patch
    if (service.tier === 3 && labels.length > 0 && serviceBump === 'none') {
      serviceBump = 'patch';
      winningLabel = labels[0];
    }

    console.log(`  Decision: ${serviceBump.toUpperCase()} ${winningLabel ? `(label: "${winningLabel}")` : ''}`);

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
  const output = {
    bossVersion: newVersion,
    previousVersion: currentVersion.bossVersion,
    bumpType: highestBump,
    bumpReason,
    lastUpdated: new Date().toISOString(),
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
