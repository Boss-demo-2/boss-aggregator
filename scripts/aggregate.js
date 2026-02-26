// aggregate.js
// BOSS Aggregator — Main Script
//
// Combined Logic (3 layers):
//   1. [priority:critical] commit keyword  → Emergency BOSS MAJOR, bypasses everything
//   2. Version delta comparison            → Floor signal (what technically changed)
//   3. All PR labels since lastAggregatedAt → Business signal (can raise above floor)
//
//   Final per-service bump = HIGHER of (version delta, label bump)
//   Then apply Tier weighting → Take highest across all services → BOSS version

const fs = require('fs');
const https = require('https');

const config = JSON.parse(fs.readFileSync('./config/services-config.json', 'utf8'));
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// ─── Priority Rank ────────────────────────────────────────────────────────────
const priority = { major: 3, minor: 2, patch: 1, none: 0 };

// ─── Tier Weighting ───────────────────────────────────────────────────────────
// Caps the maximum BOSS contribution a service can make based on its tier.
// Tier 1 (Critical)   — no cap, full bump passes through
// Tier 2 (Important)  — MAJOR is capped to MINOR (can't push BOSS MAJOR alone)
// Tier 3 (Supporting) — always PATCH, regardless of how big the change is
function applyTierWeight(tier, bump) {
  if (tier === 1) return bump;
  if (tier === 2) return bump === 'major' ? 'minor' : bump;
  if (tier === 3) return bump === 'none' ? 'none' : 'patch';
  return 'none';
}

// ─── Signal 1: Version Delta Classifier (Floor) ───────────────────────────────
// Compares the stored version (from last run) to the current latest release.
// The version number is a perfect summary of all commits that happened since
// the last aggregation — semantic-release already calculated this precisely.
// This acts as a FLOOR: labels can raise above it but never below it.
function classifyVersionDelta(oldTag, newTag) {
  if (!oldTag || !newTag) return 'none';
  const parse = tag => {
    const m = tag.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
  };
  const o = parse(oldTag);
  const n = parse(newTag);
  if (!o || !n) return 'none';
  if (n.major > o.major) return 'major';
  if (n.minor > o.minor) return 'minor';
  if (n.patch > o.patch) return 'patch';
  return 'none';
}

// ─── Signal 2: Label → Bump Type (Business Classification) ───────────────────
// Maps a PR label to the bump type it should cause, given the service's tier.
function labelToBump(tier, label) {
  if (tier === 1 && label === 'breaking-change') return 'major';
  if ((tier === 1 || tier === 2) && (label === 'feature' || label === 'enhancement')) return 'minor';
  if ((tier === 1 || tier === 2) && label === 'bugfix') return 'patch';
  if (tier === 3 && label) return 'patch';
  return 'none';
}

// ─── GitHub API Helper ────────────────────────────────────────────────────────
function githubGet(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path,
      headers: {
        'User-Agent': 'boss-aggregator',
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    https.get(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed for ${path}: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

// ─── Priority Override Check ──────────────────────────────────────────────────
// Scans the last 5 commits of a repo for [priority:critical] in the commit message.
// If found → the entire aggregation is bypassed and BOSS is force-bumped to MAJOR.
// Use case: emergency security patches, critical hotfixes, P0 incidents.
async function checkPriorityOverride(repo) {
  try {
    const commits = await githubGet(`/repos/${repo}/commits?per_page=5`);
    if (!Array.isArray(commits)) return false;
    for (const c of commits) {
      const msg = ((c.commit && c.commit.message) || '').toLowerCase();
      if (msg.includes('[priority:critical]')) return true;
    }
  } catch (_) { /* skip silently */ }
  return false;
}

// ─── PR Label Scanner (since last aggregation) ───────────────────────────────
// Paginates through ALL closed PRs merged to UAT after lastAggregatedAt.
// Collects every label from every qualifying PR.
// This fixes the "multiple PRs in same repo" gap — we never miss a PR.
async function getPRsSince(repo, sinceISO) {
  const sinceDate = new Date(sinceISO);
  const allLabels = [];
  let page = 1;
  let keepGoing = true;

  console.log(`  Scanning PRs merged to uat since ${sinceISO}`);

  while (keepGoing) {
    let prs;
    try {
      prs = await githubGet(
        `/repos/${repo}/pulls?state=closed&base=uat&per_page=100&page=${page}&sort=updated&direction=desc`
      );
    } catch (e) {
      console.log(`  ⚠ PR fetch error on page ${page}: ${e.message}`);
      break;
    }

    if (!Array.isArray(prs) || prs.length === 0) break;

    for (const pr of prs) {
      if (!pr.merged_at) continue;                     // Reject rejected/closed PRs
      if (new Date(pr.merged_at) <= sinceDate) {       // Older than last run → stop
        keepGoing = false;
        break;
      }
      const labels = pr.labels.map(l => l.name);
      const title = (pr.title || '').substring(0, 60);
      console.log(`    PR #${pr.number}: "${title}" | merged: ${pr.merged_at} | labels: [${labels.join(', ') || 'none'}]`);
      allLabels.push(...labels);
    }

    page++;
    if (prs.length < 100) break;                       // Last page
  }

  return allLabels;
}

// ─── Main Aggregation Logic ───────────────────────────────────────────────────
async function run() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  BOSS Aggregator — Starting Run');
  console.log(`  Timestamp: ${new Date().toISOString()}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const currentVersion = JSON.parse(fs.readFileSync('./version.json', 'utf8'));
  const lastAggregatedAt = currentVersion.lastAggregatedAt || currentVersion.lastUpdated;
  const storedServices = currentVersion.services || {};

  console.log(`  Current BOSS Version : ${currentVersion.bossVersion}`);
  console.log(`  Scanning PRs since   : ${lastAggregatedAt}\n`);

  // ═══════════════════════════════════════════════════════
  // LAYER 1 — Priority Override Check
  // If [priority:critical] is found in any service's recent
  // commits, skip all normal logic and force BOSS MAJOR.
  // ═══════════════════════════════════════════════════════
  console.log('──── Layer 1: Priority Override Check ────');
  let priorityOverride = false;
  let overrideRepo = null;

  for (const service of config.services) {
    const found = await checkPriorityOverride(service.repo);
    if (found) {
      priorityOverride = true;
      overrideRepo = service.name;
      console.log(`  ⚡ [priority:critical] found in ${service.name} — forcing BOSS MAJOR\n`);
      break;
    }
  }
  if (!priorityOverride) console.log('  ✓ No priority override found\n');

  if (priorityOverride) {
    let [major, minor, patch] = currentVersion.bossVersion.split('.').map(Number);
    major++; minor = 0; patch = 0;
    const newVersion = `${major}.${minor}.${patch}`;
    const runTs = new Date().toISOString();

    // Still update service manifest with current versions
    const manifest = {};
    for (const s of config.services) {
      try {
        const rels = await githubGet(`/repos/${s.repo}/releases?per_page=1`);
        manifest[s.name] = Array.isArray(rels) && rels[0] ? rels[0].tag_name : (storedServices[s.name] || 'unknown');
      } catch (_) {
        manifest[s.name] = storedServices[s.name] || 'unknown';
      }
    }

    const output = {
      bossVersion: newVersion,
      previousVersion: currentVersion.bossVersion,
      bumpType: 'major',
      bumpReason: `⚡ Emergency override — [priority:critical] in ${overrideRepo}`,
      lastUpdated: runTs,
      lastAggregatedAt: runTs,
      services: manifest
    };
    fs.writeFileSync('./version.json', JSON.stringify(output, null, 2));

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  BOSS Version: ${currentVersion.bossVersion} → ${newVersion}`);
    console.log('  Bump Type:    MAJOR (EMERGENCY OVERRIDE)');
    console.log(`  Reason:       [priority:critical] in ${overrideRepo}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return;
  }

  // ═══════════════════════════════════════════════════════
  // LAYER 2 + 3 — Normal Aggregation Loop
  // For each service:
  //   Signal 1 (version delta) = Floor
  //   Signal 2 (PR labels)     = Can raise above floor
  //   serviceBump = HIGHER of both → apply Tier weighting
  // ═══════════════════════════════════════════════════════
  let highestBump = 'none';
  let bumpReason = 'No services changed in this cycle';
  const manifest = {};

  for (const service of config.services) {
    console.log(`──── Layer 2+3: ${service.name} (Tier ${service.tier}) ────`);

    // Fetch current latest release
    let releases;
    try {
      releases = await githubGet(`/repos/${service.repo}/releases?per_page=1`);
    } catch (e) {
      console.log(`  ⚠ Could not fetch releases: ${e.message}\n`);
      manifest[service.name] = storedServices[service.name] || 'fetch-error';
      continue;
    }

    if (!Array.isArray(releases) || releases.length === 0) {
      console.log('  ℹ No releases found — skipping\n');
      manifest[service.name] = 'no-release';
      continue;
    }

    const currentTag = releases[0].tag_name;
    const storedTag = storedServices[service.name] || null;
    manifest[service.name] = currentTag;

    console.log(`  Stored version  : ${storedTag || '(first run)'}`);
    console.log(`  Current version : ${currentTag}`);

    // ── Signal 1: Version Delta (Floor) ──────────────────────────────────
    const versionBump = classifyVersionDelta(storedTag, currentTag);
    console.log(`  Signal 1 (version delta)  : ${versionBump.toUpperCase()}`);

    // ── Signal 2: All PR Labels Since Last Run ────────────────────────────
    let labelBump = 'none';
    let winningLabel = null;
    try {
      const allLabels = await getPRsSince(service.repo, lastAggregatedAt);
      const uniqueLabels = [...new Set(allLabels)];

      if (uniqueLabels.length > 0) {
        console.log(`  All labels found: [${uniqueLabels.join(', ')}]`);
        for (const label of uniqueLabels) {
          const bump = labelToBump(service.tier, label);
          if (priority[bump] > priority[labelBump]) {
            labelBump = bump;
            winningLabel = label;
          }
        }
      } else {
        console.log('  No PR labels found since last run');
      }
    } catch (e) {
      console.log(`  ⚠ Could not fetch PRs: ${e.message}`);
    }
    console.log(`  Signal 2 (label)          : ${labelBump.toUpperCase()}${winningLabel ? ` (highest: "${winningLabel}")` : ''}`);

    // ── Combine: Higher of Both Signals ──────────────────────────────────
    const isVersionHigher = priority[versionBump] >= priority[labelBump];
    const rawBump = isVersionHigher ? versionBump : labelBump;
    const signalSource = isVersionHigher
      ? `version delta (${storedTag} → ${currentTag})`
      : `label "${winningLabel}"`;
    console.log(`  Combined (higher wins)    : ${rawBump.toUpperCase()} — driven by ${signalSource}`);

    // ── Apply Tier Weighting (Cap by Tier) ───────────────────────────────
    const serviceBump = applyTierWeight(service.tier, rawBump);
    console.log(`  After tier ${service.tier} weighting  : ${serviceBump.toUpperCase()}`);

    if (serviceBump === 'none') {
      console.log('  → No change — skipping\n');
      continue;
    }

    // Update global highest bump across all services
    if (priority[serviceBump] > priority[highestBump]) {
      highestBump = serviceBump;
      bumpReason = `${service.name} (Tier ${service.tier}) — ${signalSource}`;
    }

    console.log('');
  }

  // ─── Calculate New BOSS Version ───────────────────────────────────────────
  let [major, minor, patch] = currentVersion.bossVersion.split('.').map(Number);
  if (highestBump === 'major') { major++; minor = 0; patch = 0; }
  else if (highestBump === 'minor') { minor++; patch = 0; }
  else if (highestBump === 'patch') { patch++; }

  const newVersion = highestBump === 'none'
    ? currentVersion.bossVersion
    : `${major}.${minor}.${patch}`;

  // ─── Write version.json ───────────────────────────────────────────────────
  const runTs = new Date().toISOString();
  const output = {
    bossVersion: newVersion,
    previousVersion: currentVersion.bossVersion,
    bumpType: highestBump,
    bumpReason,
    lastUpdated: runTs,
    lastAggregatedAt: runTs,       // ← anchor for next run
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
    console.log('   version.json updated successfully');
  }
}

run().catch(err => {
  console.error(' Aggregation failed:', err);
  process.exit(1);
});
