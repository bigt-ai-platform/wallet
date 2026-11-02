#!/usr/bin/env node
/**
 * make-p2p-tiktok.mjs — render a vertical TikTok/Reels demo of the P2P flow.
 *
 * Real UI only: every step is one of the Chinese Android screenshots already
 * produced by `e2e/capture-p2p-android-cny.mjs`, so amounts, statuses and
 * account details are the app's own pixels (no AI-hallucinated UI text).
 *
 * Output (docs/p2p-demo/assets/tiktok/):
 *   p2p-tiktok.zh.mp4          1080x1920, 30 fps, ~33 s, captions burned in
 *   p2p-tiktok.zh.srt          sidecar captions (upload as TikTok subtitles)
 *   p2p-tiktok.zh-cover.png    vertical cover frame
 *
 * Usage:
 *   node e2e/make-p2p-tiktok.mjs
 *   FFMPEG=/usr/bin/ffmpeg node e2e/make-p2p-tiktok.mjs
 *   node e2e/make-p2p-tiktok.mjs --silent   # no ambient bed (add sound in TikTok)
 *
 * ffmpeg must exist on PATH, or set FFMPEG. A static bundle also works:
 *   npm i --no-save ffmpeg-static && FFMPEG=$(node -p "require('ffmpeg-static')") \
 *     node e2e/make-p2p-tiktok.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = join(ROOT, 'docs/p2p-demo/assets/screenshots');
const OUT_DIR = join(ROOT, 'docs/p2p-demo/assets/tiktok');
const FONT_DIR = '/usr/share/fonts/opentype/noto';
const FONT = 'Noto Sans CJK SC';
const W = 1080;
const H = 1920;
const FPS = 30;
const HOOK = 3;
const PROBLEM = 3;
const STEP = 3;
const CTA = 3;
const STEPS_START = HOOK + PROBLEM;
const CTA_START = STEPS_START + STEP * 8;
const TOTAL = CTA_START + CTA;

const require = createRequire(import.meta.url);
function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  try { return require('ffmpeg-static'); } catch {}
  return 'ffmpeg';
}
const FFMPEG = findFfmpeg();

const STEPS = [
  { shot: 'p2p-cny-wechat-02-order-zh.png', cap: '1/8 卖家挂单：10,000 BIG = 100 CNY' },
  { shot: 'p2p-cny-wechat-03-match-zh.png', cap: '2/8 买家下单，锁定金额和收款地址' },
  { shot: 'p2p-cny-wechat-06-escrow-locked-zh.png', cap: '3/8 BIG 锁进 2-of-3 托管' },
  { shot: 'p2p-cny-wechat-08-instructions-zh.png', cap: '4/8 买家拿到金额和专属备注码' },
  { shot: 'p2p-cny-wechat-10-payment-claimed-zh.png', cap: '5/8 买家付款并提交微信流水号' },
  { shot: 'p2p-cny-wechat-11-seller-confirm-zh.png', cap: '6/8 卖家核对金额、备注、流水号' },
  { shot: 'p2p-cny-wechat-13-escrow-released-zh.png', cap: '7/8 卖家释放，平台共同签名' },
  { shot: 'p2p-cny-wechat-14-completed-zh.png', cap: '8/8 完成：BIG 到买家，人民币到卖家' },
];

const HOOK_SHOT = 'p2p-cny-wechat-02-order-zh.png';
const PROBLEM_SHOT = 'p2p-cny-wechat-11-seller-confirm-zh.png';
const CTA_SHOT = 'p2p-cny-wechat-14-completed-zh.png';

function run(args) {
  try {
    execFileSync(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e.stderr?.toString().trim().split('\n').slice(-8).join('\n') || e.message;
    throw new Error(`ffmpeg failed:\n${err}`);
  }
}

function ts(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function srtTs(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/** Plain-text cues for the .srt upload. */
function srtCues() {
  const cues = [
    [0, HOOK, 'BIG → CNY\\n无需银行 · 2 分钟完成'],
    [HOOK, HOOK + PROBLEM, '担心付款后对方不放币？\\n2-of-3 托管：谁都不能单独动钱'],
  ];
  for (let i = 0; i < STEPS.length; i++) {
    const a = STEPS_START + i * STEP;
    cues.push([a, a + STEP, STEPS[i].cap]);
  }
  cues.push([CTA_START, TOTAL, '全程链上托管 · 平台不碰你的钱\\n打开钱包 → P2P · 演示非投资建议']);
  return cues;
}

function buildAss() {
  const event = (a, b, style, text, extra = '') =>
    `Dialogue: 0,${ts(a)},${ts(b)},${style},,0,0,0,,{\\fad(160,160)${extra}}${text}`;
  const lines = [];
  lines.push('[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`,
    'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '', '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding');
  lines.push(
    `Style: Cap,${FONT},40,&H00FFFFFF,&H000000FF,&H00101010,&H99000000,-1,0,0,0,100,100,0,0,3,10,0,7,36,36,164,1`,
    `Style: Chip,${FONT},30,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,7,0,0,0,1`,
    `Style: Hook,${FONT},136,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: HookSub,${FONT},54,&H0062D4A8,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: HookSmall,${FONT},32,&H00DDDDDD,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: Problem,${FONT},94,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: ProblemSub,${FONT},44,&H0062D4A8,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: Cta,${FONT},92,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: CtaSub,${FONT},54,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: CtaLink,${FONT},58,&H0062D4A8,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: CtaSmall,${FONT},30,&H00AAAAAA,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: Brand,${FONT},28,&H00888888,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,9,0,0,0,1`,
    '', '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  );
  lines.push(event(0, HOOK, 'Hook', 'BIG → CNY', '\\pos(540,760)'));
  lines.push(event(0.15, HOOK, 'HookSub', '无需银行 · 2 分钟完成', '\\pos(540,910)'));
  lines.push(event(0.3, HOOK, 'HookSmall', 'P2P 场外交易 · 链上托管', '\\pos(540,1010)'));
  lines.push(event(HOOK, HOOK + PROBLEM, 'Problem', '担心付款后\\N对方不放币？', '\\pos(540,760)'));
  lines.push(event(HOOK + 0.15, HOOK + PROBLEM, 'ProblemSub', '2-of-3 托管：谁都不能单独动钱', '\\pos(540,980)'));
  lines.push(event(HOOK + 0.3, HOOK + PROBLEM, 'HookSmall', '平台只做共同签名', '\\pos(540,1050)'));
  lines.push(event(STEPS_START, CTA_START, 'Brand', 'bigt.ai', '\\pos(1030,62)'));
  for (let i = 0; i < STEPS.length; i++) {
    const a = STEPS_START + i * STEP;
    lines.push(event(a, a + STEP, 'Chip', `{\\c&H62D4A8&}●{\\c&HFFFFFF&} P2P 演示 · ${i + 1}/8`, '\\pos(44,62)'));
    lines.push(event(a, a + STEP, 'Cap', STEPS[i].cap));
  }
  lines.push(event(CTA_START, TOTAL, 'Cta', '全程链上托管', '\\pos(540,780)'));
  lines.push(event(CTA_START + 0.15, TOTAL, 'CtaSub', '平台不碰你的钱', '\\pos(540,930)'));
  lines.push(event(CTA_START + 0.3, TOTAL, 'CtaLink', '打开钱包 → P2P', '\\pos(540,1060)'));
  lines.push(event(CTA_START + 0.45, TOTAL, 'CtaSmall', '演示 · 非投资建议', '\\pos(540,1160)'));
  return lines.join('\n') + '\n';
}

function segment(shot, seconds, dark, out) {
  const frames = Math.round(seconds * FPS);
  const img = join(SHOTS, shot);
  const vf = dark
    ? `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
      `gblur=sigma=60,eq=brightness=-0.72:saturation=0.45,` +
      `zoompan=z='min(1.0+0.0005*on,1.04)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},format=yuv420p[v]`
    : `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
      `gblur=sigma=40,eq=brightness=-0.35:saturation=0.7[bg];` +
      `[0:v]scale=-2:${H}[fg];` +
      `[bg][fg]overlay=(W-w)/2:0,` +
      `zoompan=z='min(1.0+0.0006*on,1.06)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},format=yuv420p[v]`;
  run(['-y', '-loop', '1', '-i', img, '-filter_complex', vf, '-map', '[v]',
    '-frames:v', String(frames), '-r', String(FPS), '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', out]);
}

function main() {
  const silent = process.argv.includes('--silent');
  try { execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' }); }
  catch { throw new Error(`ffmpeg not found (${FFMPEG}); set FFMPEG or install ffmpeg-static`); }
  for (const s of STEPS) {
    try { statSync(join(SHOTS, s.shot)); }
    catch { throw new Error(`missing screenshot ${s.shot}; run the Chinese Android capture first`); }
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'p2p-tiktok-'));
  const segs = [];
  const push = (name, shot, seconds, dark) => {
    const out = join(tmp, `${name}.mp4`);
    segment(shot, seconds, dark, out);
    segs.push(out);
    console.log(`· ${name} (${seconds}s)`);
  };
  push('00-hook', HOOK_SHOT, HOOK, true);
  push('01-problem', PROBLEM_SHOT, PROBLEM, true);
  STEPS.forEach((s, i) => push(`1${i}-step-${i + 1}`, s.shot, STEP, false));
  push('30-cta', CTA_SHOT, CTA, true);

  const list = join(tmp, 'segments.txt');
  writeFileSync(list, segs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const base = join(tmp, 'base.mp4');
  run(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', base]);

  const ass = join(tmp, 'captions.ass');
  writeFileSync(ass, buildAss());
  const srt = join(OUT_DIR, 'p2p-tiktok.zh.srt');
  writeFileSync(srt, srtCues().map(([a, b, text], i) =>
    `${i + 1}\n${srtTs(a)} --> ${srtTs(b)}\n${text.replace(/\\[Nn]/g, '\n')}\n`).join('\n'));

  // Top scrim + stepped progress bar while the 8 steps run.
  const stepEnd = CTA_START;
  const filters = [
    `drawbox=x=0:y=0:w=${W}:h=150:color=0x0B1714:t=fill:enable='between(t,${STEPS_START},${stepEnd})'`,
    `drawbox=x=0:y=147:w=${W}:h=3:color=0x00E0A4@0.8:t=fill:enable='between(t,${STEPS_START},${stepEnd})'`,
    `drawbox=x=0:y=0:w=${W}:h=8:color=white@0.14:t=fill:enable='between(t,${STEPS_START},${stepEnd})'`,
  ];
  for (let i = 0; i < 8; i++) {
    const at = STEPS_START + i * STEP;
    const w = Math.round((W / 8) * (i + 1));
    filters.push(`drawbox=x=0:y=0:w=${w}:h=8:color=0x00E0A4@0.95:t=fill:enable='gte(t,${at})*lt(t,${stepEnd})'`);
  }
  filters.push(`subtitles=${ass.replace(/([:'\\])/g, '\\$1')}:fontsdir=${FONT_DIR}`, 'format=yuv420p');
  const mp4 = join(OUT_DIR, 'p2p-tiktok.zh.mp4');
  const args = ['-y', '-i', base];
  if (!silent) {
    const bed = `sine=frequency=110:duration=${TOTAL}:sample_rate=48000`;
    const bed2 = `sine=frequency=164.81:duration=${TOTAL}:sample_rate=48000`;
    const bed3 = `sine=frequency=220:duration=${TOTAL}:sample_rate=48000`;
    args.push('-f', 'lavfi', '-i', bed, '-f', 'lavfi', '-i', bed2, '-f', 'lavfi', '-i', bed3);
    const mix = `[1:a][2:a][3:a]amix=inputs=3:normalize=0,tremolo=f=0.14:d=0.35,lowpass=f=900,volume=0.4,` +
      `afade=t=in:d=1.2,afade=t=out:st=${TOTAL - 2}:d=2[a]`;
    args.push('-filter_complex', `[0:v]${filters.join(',')}[v];${mix}`, '-map', '[v]', '-map', '[a]',
      '-c:a', 'aac', '-b:a', '128k');
  } else {
    args.push('-vf', filters.join(','), '-map', '0:v', '-an');
  }
  args.push('-t', String(TOTAL), '-r', String(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', '16',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4);
  run(args);

  const caption = join(OUT_DIR, 'p2p-tiktok.zh.caption.txt');
  writeFileSync(caption, [
    '标题：BIG → CNY，2 分钟看懂 P2P 法币交易',
    '',
    '8 步看懂：卖家挂单 → 买家下单 → BIG 锁进 2-of-3 托管 → 买家拿到付款信息 → 买家付款并提交流水号 → 卖家核对账单 → 卖家释放 → 完成。',
    '全程链上托管，平台不碰你的钱。演示非投资建议。',
    '',
    '#Bigtangle #P2P #加密货币 #法币 #Web3 #金融科技 #BIG #CNY',
    '',
  ].join('\n'));
  const cover = join(OUT_DIR, 'p2p-tiktok.zh-cover.png');
  run(['-y', '-ss', '0.8', '-i', mp4, '-frames:v', '1', cover]);

  const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(1) + ' MB';
  console.log(`\n✓ ${mp4} (${mb(mp4)})`);
  console.log(`✓ ${cover}`);
  console.log(`✓ ${srt}`);
  console.log(`✓ ${caption}`);
  console.log(`duration ${TOTAL}s · ${W}x${H} · ${FPS}fps${silent ? ' · silent' : ''}`);
  rmSync(tmp, { recursive: true, force: true });
}

try { main(); } catch (e) { console.error('\nmake-p2p-tiktok failed:', e.message); process.exit(1); }
