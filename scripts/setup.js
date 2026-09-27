// Downloads the Stockfish engine and the board piece images.
// Run once with: npm run setup
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin');
const PIECES = path.join(ROOT, 'public', 'pieces');
const SF_TAG = 'sf_19';

function assetName() {
  const p = process.platform;
  const a = process.arch;
  if (p === 'win32') return a === 'arm64' ? 'stockfish-windows-arm64-universal.zip' : 'stockfish-windows-x86-64-universal.zip';
  if (p === 'darwin') return 'stockfish-macos-universal.tar.gz';
  if (p === 'linux') return a === 'arm64' ? 'stockfish-linux-arm64-universal.tar.gz' : 'stockfish-linux-x86-64-universal.tar.gz';
  throw new Error(`Unsupported platform ${p}/${a}. Install Stockfish yourself and set STOCKFISH_PATH.`);
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function findExe(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findExe(full);
      if (hit) return hit;
    } else if (/^stockfish/i.test(entry.name) && !/\.(zip|gz|md|txt|sh|cpp|h)$/i.test(entry.name)) {
      return full;
    }
  }
  return null;
}

async function setupStockfish() {
  fs.mkdirSync(BIN, { recursive: true });
  const existing = fs.existsSync(path.join(BIN, 'stockfish')) && findExe(path.join(BIN, 'stockfish'));
  if (existing) {
    console.log(`Stockfish already installed: ${path.relative(ROOT, existing)}`);
    return;
  }
  const name = assetName();
  const url = `https://github.com/official-stockfish/Stockfish/releases/download/${SF_TAG}/${name}`;
  const archive = path.join(BIN, name);
  console.log(`Downloading ${name} (about 80 MB)...`);
  await download(url, archive);
  console.log('Extracting...');
  // Windows 10+ ships bsdtar as System32\tar.exe, which reads zip files.
  const tarCmd = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tarCmd, ['-xf', archive, '-C', BIN], { stdio: 'inherit' });
  fs.unlinkSync(archive);
  const exe = findExe(path.join(BIN, 'stockfish'));
  if (!exe) throw new Error('Could not find the Stockfish executable after extracting.');
  if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
  console.log(`Stockfish ready: ${path.relative(ROOT, exe)}`);
}

async function setupPieces() {
  fs.mkdirSync(PIECES, { recursive: true });
  const names = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP', 'bK', 'bQ', 'bR', 'bB', 'bN', 'bP'];
  const missing = names.filter((n) => !fs.existsSync(path.join(PIECES, `${n}.svg`)));
  if (!missing.length) {
    console.log('Piece images already installed.');
    return;
  }
  // "cburnett" piece set by Colin M.L. Burnett, CC BY-SA 3.0, via the Lichess repository.
  console.log('Downloading piece images (cburnett set, CC BY-SA 3.0)...');
  for (const n of missing) {
    await download(`https://raw.githubusercontent.com/lichess-org/lila/master/public/piece/cburnett/${n}.svg`, path.join(PIECES, `${n}.svg`));
  }
  console.log('Piece images ready.');
}

(async () => {
  try {
    await setupStockfish();
  } catch (e) {
    console.error(`Stockfish setup failed: ${e.message}`);
    process.exitCode = 1;
  }
  try {
    await setupPieces();
  } catch (e) {
    console.error(`Piece download failed (the board will fall back to text pieces): ${e.message}`);
  }
})();
